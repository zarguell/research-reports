---
title: "Analyzing DefenseClaw"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/cisco-ai-defense/defenseclaw
tags: [go, typescript, python, ai-security, guardrail-proxy, prompt-injection, llm-safety, claude-code, codex, mcp, opa, cisco, sidecar]
---

# Analyzing DefenseClaw

> **Source:** [cisco-ai-defense/defenseclaw](https://github.com/cisco-ai-defense/defenseclaw) @ [`e15ac85`](https://github.com/cisco-ai-defense/defenseclaw/commit/e15ac859ed5e8a9d9a72943d014e4535e9c49edd)

## How It Works

DefenseClaw is an open-source AI security proxy and guardrail gateway from Cisco's AI Defense team. It sits between coding agents (Claude Code, OpenAI Codex, Cline/Roo Code) and their LLM backends, intercepting every tool call and LLM response to scan for secrets, PII, prompt injection, command injection, cognitive tampering, and enterprise data exfiltration. Think of it as a WAF, but for AI agent actions rather than HTTP requests.

The system runs as a local sidecar daemon with two HTTP servers: a **guardrail proxy** (default port 4000) that mediates all LLM API traffic, and an **API server** (default port 18970) that exposes inspection endpoints. Connectors for each supported agent framework handle the integration — rewriting config files to route traffic through the proxy, installing hook scripts, and registering event handlers. When a tool call arrives, it passes through a multi-stage pipeline: regex-based rule matching, secret scanning, PII redaction, prompt-injection detection, and optionally an LLM-as-judge layer. Verdicts are enforced (block, alert, or allow) based on severity and policy configuration, with a HILT (Human-in-the-Loop Ticket) approval system for ambiguous cases.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Agent Frameworks                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │Claude Code│  │OpenAI Codex│  │Cline/Roo│  │Bedrock │  │
│  └────┬─────┘  └────┬──────┘  └────┬──────┘  └───┬────┘  │
│       │              │              │             │        │
└───────┼──────────────┼──────────────┼─────────────┼────────┘
        │              │              │             │
┌───────┼──────────────┼──────────────┼─────────────┼────────┐
│       ▼              ▼              ▼             ▼        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Connector Layer                          │  │
│  │  ClaudeCodeConnector  CodexConnector  BedrockExt     │  │
│  │  (env vars + hooks)  (TOML rewrite)  (TS fetch int) │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                    DefenseClaw Sidecar                     │
│  ┌──────────────────────┼───────────────────────────────┐  │
│  │              Guardrail Proxy (:4000)                  │  │
│  │  ┌───────────────────────────────────────────────┐  │  │
│  │  │              EventRouter (1,677 LOC)           │  │  │
│  │  │  dispatch → GuardrailInspector → PolicyEngine  │  │  │
│  │  └───────────┬──────────┬───────────┬────────────┘  │  │
│  │              ▼          ▼           ▼                │  │
│  │  ┌────────────┐ ┌─────────────┐ ┌───────────────┐  │  │
│  │  │  Scanners   │ │  LLM Judge  │ │  HILT Manager │  │  │
│  │  │  26 files   │ │  (GPT-4o)   │ │  (human ATP)  │  │  │
│  │  └────────────┘ └─────────────┘ └───────────────┘  │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                         ▼                                 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Audit Layer                              │  │
│  │  SQLite Store + Splunk HEC + OTel + HTTP JSONL       │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Codebase Stats

| Metric | Value |
|--------|-------|
| **Go** | 169,351 LOC across 21 internal packages |
| **Python** | 79,107 LOC (CLI, packaging, extensions) |
| **TypeScript** | 9,270 LOC (IDE extensions, fetch interceptor) |
| **YAML** | 7,877 LOC (53 guardrail rule files + config) |
| **Scanner modules** | 26 Go files (secrets, PII, injection, malware, vuln) |
| **Connector implementations** | Claude Code, Codex, OpenClaw, ZeptoClaw, plugin loader |
| **Guardrail rule packs** | 8 categories (c2, cognitive, commands, enterprise-data, secrets, sensitive-paths, trust-exploit, local-patterns) |
| **License** | Apache 2.0 (Cisco Systems, Inc.) |

## Inspection Pipeline

The core security loop lives in `internal/gateway/inspect.go` (566 LOC) and `internal/gateway/guardrail.go` (1,857 LOC). When a tool call arrives at `POST /api/v1/inspect/tool`, the pipeline runs in phases:

1. **Scan** — Regex-based scanners match the tool input and output against YAML rule packs. Each rule has an ID, pattern, severity (CRITICAL/HIGH/MEDIUM/LOW/INFO), confidence score, and tags. Results aggregate into a `ScanResult` with multiple `Finding` entries.

2. **Redact** — PII detected in tool outputs is redacted. Clients can request unredacted responses via the `X-DefenseClaw-Reveal-PII` header. The redaction engine lives in `internal/redaction/` and handles per-sink redaction (audit logs see different redaction levels than the agent).

3. **Verify** — The `GuardrailInspector` runs the full verdict evaluation chain: regex findings are weighted by confidence, and optionally an LLM-as-judge (configurable, defaults to GPT-4o) provides a second opinion on ambiguous findings. Verdicts aggregate into `TriageSignal` levels: `HIGH_SIGNAL` (block), `NEEDS_REVIEW` (HILT approval), `LOW_SIGNAL` (allow with alert).

4. **Enforce** — The `PolicyEngine` (`internal/enforce/policy.go`, 233 LOC) maps verdicts to actions. CRITICAL findings → block the tool call entirely. MEDIUM/HIGH → alert but allow (observe mode) or block (action mode). LOW/INFO → allow silently. The system can operate in **observe mode** (log-only, no blocking) or **action mode** (active enforcement).

The fallback behavior is deliberately permissive: if every scanner and the LLM judge fail, the system returns `allowVerdict("fallback")` with severity "NONE" rather than blocking by default. This prevents the security system itself from becoming a denial-of-service vector.

## Guardrail Rule Packs

The 8 rule categories contain 80+ rules covering the major AI agent threat classes:

**Commands** (22 rules, `commands.yaml`) — Reverse shells (bash, Python, netcat, socat), download-and-execute (`curl | sh`, `wget | sh`), base64 decode pipes, `rm -rf /`, `mkfs`, `dd` disk writes, privilege escalation (`chmod 777`, `chown root`, `sudo`), persistence (`crontab`, `systemctl enable`), exfiltration (`curl --upload-file`, `wget --post-data`), environment dumps (`env`, `printenv`).

**Trust Exploit** (22 rules, `trust-exploit.yaml`) — Prompt injection patterns including authority claims ("I am your creator"), fake mode activation ("debug mode enabled"), safety override attempts, "ignore previous instructions" variants, jailbreak attempts (DAN mode), identity override ("pretend you are unrestricted"), system prompt extraction, delimiter hijacking (`<|im_end|>`, `[/INST]`), forced encoding to bypass filters, payload splitting, and persona adoption ("act as a hacker").

**Cognitive Tampering** (8 rules, `cognitive.yaml`) — Agent identity file access: `SOUL.md`, `IDENTITY.md`, `MEMORY.md`, `CLAUDE.md`, `TOOLS.md`, `AGENTS.md`, `openclaw.json`, `gateway.json`. These are the files that define agent behavior — modifying them is equivalent to rewriting the agent's system prompt.

**Secrets** (`secrets.yaml` + `clawshield_secrets.go`) — 14 provider-specific API key patterns: OpenAI (`sk-...`), Anthropic (`sk-ant-...`), AWS (`AKIA...`/`AIDA...`), Azure, GCP, GitHub (`ghp_...`/`ghs_...`), GitLab (`glpat-...`), Slack (`xoxb-...`/`xoxp-...`), Salesforce, Mailchimp, Twilio, Stripe (`sk_live_...`/`rk_live_...`), Discord, and Discord webhooks.

**Enterprise Data** (15 rules, `enterprise-data.yaml`) — PII and regulated data: SSN (with/without hyphens), credit card numbers (Visa, MC, Amex, Discover), IBAN, phone numbers, email addresses, passport numbers, medical record numbers, dates of birth, NHS numbers, and bulk data patterns (CSV headers with PII columns, JSON fields with PII keys). Several lower-confidence rules are disabled by default to reduce false positives.

**Sensitive Paths** (16 rules, `sensitive-paths.yaml`) — File system access to credentials: SSH keys and directory, AWS credentials/config, Kubernetes config, Docker config, GPG keyring, npm/PyPI tokens, Git credentials, `.netrc`, `.env` files, `/etc/passwd` (with obfuscation tolerance for "etc passwd", "etc slash passwd", URL-encoded variants), `/etc/shadow`, `/etc/sudoers`, `/proc/self/environ`, and shell history files.

## Connectors

Each agent framework gets a dedicated connector in `internal/gateway/connector/`:

**Claude Code** (`claudecode.go`, 939 LOC) — Sets `ANTROPIC_BASE_URL` to route LLM traffic through the proxy. Installs hooks in `~/.claude/settings.json` pointing to `claude-code-hook.sh` which calls `/api/v1/claude-code/hook`. Covers 20+ event types including PreToolUse, PostToolUse, and component scanning. Uses `ToolModeBoth` (inspects both pre-execution input and post-execution response).

**OpenAI Codex** (`codex.go`, 1,480 LOC) — Rewrites `[model_providers.*].base_url` in `~/.codex/config.toml` to route through the proxy, snapshotting original upstreams for request synthesis. Handles reserved provider IDs (`openai`, `ollama`, `lmstudio`) that Codex 5.x rejects if present in model_providers — uses `openai_base_url` top-level override instead. Installs inline TOML `[hooks]` for tool inspection. Includes loopback bypass detection for security audit.

**OpenClaw** (`openclaw.go`) — WebSocket-based connector for OpenClaw agent sessions, using session keys for event correlation.

**ZeptoClaw** (`zeptoclaw.go`) — Lightweight connector variant for constrained environments.

**Plugin Loader** (`plugin_loader.go`) — Runtime plugin system for extending connector support without recompilation.

## HILT Approval System

The Human-in-the-Loop Ticket (HILT) system (`internal/gateway/hilt.go`, 252 LOC) handles cases where automated verdicts are ambiguous. When a finding triggers `NEEDS_REVIEW`, the `HILTApprovalManager` sends a structured approval request to the agent's chat session (via the OpenClaw session protocol). The message includes the action, severity, reason, and a unique ticket ID. The human responds with `approve <id>` or `deny <id>`. Pending approvals have a configurable timeout (default 60s) after which they auto-deny.

Connector-native approval surfaces (like Claude Code's built-in PreToolUse hooks) bypass HILT entirely — they use the connector's native "ask" mechanism instead, providing a more integrated UX.

## LLM Judge

The LLM-as-judge system (`internal/gateway/llm_judge.go`) provides a second opinion layer on top of regex-based scanners. When enabled, ambiguous findings are sent to a configurable LLM (defaults to GPT-4o) with the tool call context, the regex findings, and a prompt asking for a severity assessment. The judge's verdict is combined with regex findings in the triage signal aggregator. This catches sophisticated attacks that evade pattern matching — for example, encoded instructions, multi-turn manipulation, or context-dependent data exfiltration that regex alone can't detect.

## Audit and Observability

The audit system (`internal/audit/store.go`, 2,418 LOC) uses SQLite as the primary store with a rich `Event` schema that includes correlation IDs (request ID, session ID, trace ID, agent instance ID, policy ID). Events are emitted to multiple sinks in parallel:

- **SQLite** — Local persistent store with full schema including agent name, run ID, session clustering
- **Splunk HEC** — With exponential backoff retry and circuit breaker (PR #220, the most recent commit)
- **OpenTelemetry** — Standard OTel export for integration with existing observability stacks
- **HTTP JSONL** — Generic JSON Lines sink for custom downstream consumers

The audit system ties every event to a session context so downstream consumers (Splunk dashboards, SIEM integration) can fold tool-call, approval, and verdict events into per-session timelines.

## Assessment

**Strengths:** DefenseClaw addresses a real and growing gap — as coding agents gain access to shell commands, file systems, and network resources, there's no standard security layer between the agent's intent and the system it operates on. The multi-layer approach (regex rules + LLM judge + human approval) is pragmatic: regex catches the obvious attacks cheaply, the LLM judge handles nuance, and HILT provides a safety net for edge cases. The connector architecture cleanly separates agent-specific integration logic from the core security pipeline. The rule pack format (YAML with severity/confidence/tags) is extensible and the 80+ default rules cover the major threat classes well. The observe/action mode toggle lets teams start in monitoring mode before enforcement.

**Weaknesses:** The fallback-to-allow behavior, while preventing DoS, means a misconfigured or crashed scanner pipeline silently permits all traffic. The regex-based rules are fundamentally limited — sophisticated encoding tricks, multi-turn manipulation across conversation boundaries, and context-dependent attacks will evade pattern matching. The LLM judge adds latency and cost to every ambiguous finding, and itself becomes an attack surface (adversarial inputs designed to confuse the judge model). The cognitive tampering rules guard specific filenames but don't verify file integrity — an attacker who can modify `CLAUDE.md` has likely already compromised the agent's environment. The 169K LOC Go codebase is substantial for a security-critical system — the attack surface of the proxy itself (HTTP parsing, config loading, plugin loading) is non-trivial.

**Notable design decision:** DefenseClaw runs as a local sidecar, not a cloud service. This keeps API keys and tool-call content on the developer's machine — important for enterprises that can't send agent traffic to a third-party security service. But it also means each developer's setup must be individually configured and updated, and a compromised local machine can bypass the proxy entirely.

## Related

- [[analyzing-picoclaw]] — Lightweight AI agent framework that DefenseClaw could protect
