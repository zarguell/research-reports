---
title: "Analyzing Zer0Vuln"
date: 2026-05-21
type: codebase-analysis
status: complete
source: https://github.com/0giv/Zer0Vuln-Community-Edition
tags: [python, sanic, siem, soar, edr, ai, security-monitoring, osint, self-hosted, opensearch, ollama, docker]
---

# Analyzing Zer0Vuln

> **Source:** [0giv/Zer0Vuln-Community-Edition](https://github.com/0giv/Zer0Vuln-Community-Edition) @ [`2ff82e7`](https://github.com/0giv/Zer0Vuln-Community-Edition/commit/2ff82e7701b27eeed6e7b535fb977bf7b374d2bb)

## Overview

Zer0Vuln is a self-hosted SOC-in-a-box — SIEM log ingestion, file integrity monitoring, vulnerability scanning, SOAR playbook orchestration, and autonomous AI triage — all behind a single `docker compose up`. It targets small-to-mid teams that don't have a dedicated security operations center. The "AI" is a local Ollama model (default `llama3.2:3b`) running in the same stack. Logs never leave the host.

This analysis covers the Community Edition (AGPLv3), examining its architecture, the AI pipeline, the custom TCP ingest protocol, the SOAR engine, and the cross-platform agent.

## Key Findings

### How It Works

Zer0Vuln is a hub-and-spoke system. A lightweight PyInstaller-bundled agent runs on each endpoint (Windows or Linux), collecting telemetry across 16 data domains (SIEM events, FIM, processes, network connections, Docker containers, hardware inventory, etc.). Agents push data to a central server over a custom TCP binary protocol. The server persists to per-agent MySQL databases, indexes everything in OpenSearch, and publishes security events into RabbitMQ for three parallel AI workers to triage. The AI workers talk to a local Ollama instance, producing structured verdicts that feed both a human-accessible analysis UI and an autonomous SOAR engine that can `BLOCK_IP`, `KILL_PROCESS`, `ISOLATE_HOST`, and more — all without phoning home.

### Architecture

The server-side component structure (after a 2026-04 reorganization) is three entry points sharing a common library layer:

```
Zer0Vuln-Server/
├── app.py             Sanic REST API (271 KB) + React SPA
├── server.py          Async TCP ingest on port 5001
├── ai_worker.py       Triple-role AI worker fleet (WORKER_TYPE selects role)
├── ai/
│   ├── utils.py       LLM call helpers, AI cache, SOAR action queueing
│   └── intel.py       AlienVault OTX + VirusTotal enrichment
├── core/
│   ├── mq.py          RabbitMQ publisher (aio-pika)
│   └── opensearch.py  OpenSearch index/search helpers
├── scanners/
│   └── vuln.py        Server-side OSV vulnerability scanner (moved off agent)
├── modules/db.py      Legacy PostgreSQL module (unused, kept for compat)
├── frontend/          React 18 + TypeScript SPA
└── init.sql           Per-agent DB schema (17+ tables)
```

The container topology is eight services:

| Service | Role |
|---|---|
| `app` (:8000) | Sanic REST API + React UI |
| `ingest` (:5001) | TCP binary log collector |
| `db` (:3307) | MySQL 8.0 (userdb + per-agent `<name>_db` schemas) |
| `rabbitmq` | Job queues for AI workers |
| `ollama` + `ollama-init` | Local LLM runtime, auto-pulls model |
| `ai-worker-*` (3x) | Automation, Manual, Defensive workers |
| `opensearch` (:9200) | Full-text log search |
| `opensearch-dashboards` (:5601) | Kibana-style explorer |

### The Spine

The data flow for a typical security event passes through six stages:

1. **Detection** — Agent's local `log_extractor` (journald / Windows Event Log) matches a YAML rule in `conf/rules.yaml`. A row lands in the local `events_alert` table.

2. **Shipment** — The agent's background shipper opens a TCP connection to `server.py:5001`. The binary protocol transmits: `agent_name_len(4B) + agent_name + public_ip_len(4B) + ip + os_info_len(4B) + os_info + filename_len(4B) + filename + data_size(8B) + json_data`. Hostname and MAC address are encoded into the `os_info` field as `|HOST=...|MAC=...` tail tokens, parsed back by `_parse_os_info_tail`.

3. **Ingestion** — `server.py` dynamically creates a per-agent database (`<sanitized_name>_db`) if it doesn't exist, runs `init.sql` against it, inserts the data with SHA-256 fingerprint-based dedup, and publishes to RabbitMQ for AI triage.

4. **AI Triage** — The automation worker pulls from `ai_automation_queue`, sends the log to `llama3.2:3b` with a strict SOC-analyst prompt that demands structured JSON output (`{"verdict","severity","confidence","indicator","summary","recommended_action"}`). Only CRITICAL or SUSPICIOUS verdicts with confidence above configurable thresholds are saved; everything else is silently reviewed.

5. **Defensive Decision** — The defensive worker evaluates the same events from `ai_soar_queue`. When its verdict is `ACT` with confidence >= `AI_AUTO_ACT_CONF` (default 0.75) and the recommended action is on a safe-list of 11 actions, it auto-dispatches by writing a `pending` row to the agent's `automations` table.

6. **Enforcement** — The agent polls `/automations/pending`, executes the action (iptables rule, process kill, registry change, etc.), and reports results back via `/automations/<task_id>/report`.

### Key Patterns

**Per-Agent Database Isolation.** Each agent gets its own MySQL database (`<sanitized_name>_db`) with identical schema. This provides natural tenant isolation and makes data pruning simple (`DROP DATABASE IF EXISTS dead_host_db`). The agent name is sanitized with `[^A-Za-z0-9_]` replaced by `_` to handle Windows hostnames like `DESKTOP-EVS8H9J`.

**Fingerprint-Based Dedup.** Two tiers of dedup: (1) a content-based SHA-256 fingerprint on each row (`ingest_fingerprint` table) prevents duplicate inserts for tables like `siem_events` and `packages`; (2) an in-memory AI dedup (`RECENT_AI_TASKS` dict with 30-second window) prevents redundant LLM calls for near-identical log entries. When the dict exceeds 1000 entries it's cleared entirely — a pragmatic memory safety valve.

**Fernet Field-Level Encryption.** Sensitive columns (paths, IPs, command lines, usernames, serial numbers) are encrypted at rest on the agent using a per-tenant Fernet key bootstrapped from the server. The server decrypts them during vulnerability scanning. Key rotation propagates without agent reinstall via periodic refresh (default 600 seconds).

**Triple-Worker AI Multiplexer.** A single `ai_worker.py` entry point serves three roles via `WORKER_TYPE` env var. Each has a purpose-tuned prompt template with distinct JSON output schemas. An `asyncio.Semaphore(1)` serializes processing per worker, preventing Ollama overload on small models. A prompt-hash cache in MySQL avoids re-analyzing identical logs.

**SOAR via Polling + Push.** The server attempts a direct push to the agent's HTTP inbound endpoint (`/soar/execute`). If the agent is unreachable, the agent polls `/automations/pending` on its next cycle (30 seconds). Two delivery paths, one reliable outcome.

**Idempotent Schema Migration.** Every `ALTER TABLE` that might fail (column already exists, table doesn't exist yet) is wrapped in `try/except pass`. This is pervasive throughout `server.py` and `ai/utils.py` — a pragmatic pattern for a system that must work across fresh installs and upgrades without explicit migration scripts.

**Permissive Agent Auth Fallback.** When no `AGENT_MASTER_SECRET` is configured, the agent accepts any non-empty `X-Agent-Key` header and logs a warning. Strict mode activates automatically when the env var is set. This means default deployments are trivially open to any agent that knows a hostname — but also that a first-time user won't hit auth roadblocks before they configure secrets.

### Non-Obvious Details

**Hostname/MAC in OS_INFO.** Rather than extending the TCP binary protocol, the agent appends `|HOST=<hostname>|MAC=<mac_address>` to the `os_info` string. The server's `_parse_os_info_tail` extracts them. This is clever backward-compatible encoding — no wire format change needed.

**VNC Replaced by JPEG WebSocket.** The original TightVNC dependency was replaced with `mss` + `Pillow` for screen capture, served over a WebSocket that the Sanic server proxies. No VNC client, no TightVNC install, just a stream of JPEG frames. Tunable via `?fps=10&q=60&w=1280`.

**Lazy LLM Answer Detection.** The defensive worker's `_lazy()` function checks for "insufficient information", "cannot determine", "not enough information", and similar patterns that small models default to. When detected, it rebuilds a useful note from the actual log fields (source, severity, message) rather than passing the model's non-answer through.

**Queue Starvation Avoidance.** The `ingest_fingerprint` table uses `INSERT IGNORE` + `rowcount` check, not `SELECT ... WHERE EXISTS`. This avoids a read-before-write race under concurrent inserts while being trivially idempotent.

**No Migration Files.** Unlike typical Django/Rails systems, Zer0Vuln has zero migration files. Schema changes are done at runtime via `try/except ALTER TABLE` in the application code. This works but means schema drift across versions is invisible without a diff against `init.sql`.

> [!note]
> Comments and docstrings in some legacy agent modules (`init.sql`, `find_vulns`, etc.) are in Turkish. The architecture doc notes this explicitly. All operator-facing UI strings and logs are in English as of 2026-04.

**Agent Runs as Root.** The agent intentionally runs as root/Administrator because SOAR actions (iptables, firewall rules, process termination, registry writes) require it. It only opens outbound connections and one `127.0.0.1` local control endpoint. This is a design trade-off: you should be as comfortable running it as you would an EDR.

## Assessment

**Strengths:**

- **Impressive scope for a single `compose up`.** SIEM, FIM, vuln scanning, SOAR, AI triage, remote desktop — this replaces 3-5 separate tools for a small team.
- **Air-gap first.** Default config uses local Ollama, bundled fonts, no required external API calls. OSV scanning gracefully degrades to a mirror or no-ops.
- **Fingerprint-based dedup is well-thought-out.** Two tiers (persistent for DB, in-memory for AI) with clear boundaries and memory bounding.
- **AI autonomy is bounded.** The safe-list of 11 auto-dispatchable actions is thoughtful; destructive operations like `DELETE_FILE` or `RUN_CMD` are always advisory.
- **Reliable delivery for SOAR.** Push-to-agent + polling fallback is a solid pattern for unreliable endpoints.

**Concerns:**

- **271 KB Sanic monolith.** `app.py` at 7100+ lines handles routing, auth, agent enrollment, SOAR playbooks, AI config, audit logs, email notifications, LDAP, file serving, and more. This is the biggest risk factor for maintainability and security reviews.
- **Default auth is wide open.** Unconfigured `AGENT_SHARED_SECRET` generates an ephemeral token silently. Combined with `CORS_ORIGINS=*` and permissive agent auth fallback, a default deployment is trivially insecure. The `.env.example` ships `DB_PASSWORD=my-secret-pw`.
- **No migration system.** Runtime `ALTER TABLE` with silent failures means different agent versions can have different schemas. A long-running deployment may have columns the `init.sql` doesn't know about, or vice versa.
- **sql injection surface.** Agent names are sanitized but the `_sanitize_db_name` regex is used in `CREATE DATABASE IF NOT EXISTS` via f-string (`f"CREATE DATABASE IF NOT EXISTS `{db_name}`"`). Container-based deployments reduce impact (MySQL is inside the compose network), but it's a pattern that would fail a security audit.
- **AI throughput bottleneck.** `asyncio.Semaphore(1)` per worker + 600-second Ollama timeout means a slow model blocks the entire queue. For a 50-agent fleet with high event volume, this will backlog.

**Recommendations:**

- Split `app.py` into domain modules (auth, agents, playbooks, vulns, config, admin) — the 2026-04 reorganization already started the pattern with `ai/` and `core/` packages. `app.py` should follow.
- Ship with hard-coded default credentials disabled. Force a password change on first login with no ephemeral fallback.
- Add a `CHECKSUM` table that records the expected schema hash so drift is detectable.
- Consider a connection pool or per-worker semaphore that allows concurrent LLM requests when the model and hardware support it.

## Related

- [[analyzing-wazuh]] — Comparable open-source SIEM/XDR platform with agent-based telemetry collection
- [[analyzing-falco]] — Runtime security monitoring (complementary detection layer)
- [[analyzing-velociraptor]] — Endpoint visibility and DFIR platform (overlapping agent capabilities)
- [[analyzing-misp]] — Threat intelligence platform (Zer0Vuln's intel.py integrates with OTX/VT similarly)
