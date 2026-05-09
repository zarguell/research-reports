---
title: "Analyzing DockFlare"
date: 2026-05-09
type: codebase-analysis
status: complete
source: https://github.com/ChrispyBacon-dev/DockFlare
tags: [cloudflare, docker, tunnel, reverse-proxy, networking]
---

# Analyzing DockFlare

> **Source:** [ChrispyBacon-dev/DockFlare](https://github.com/ChrispyBacon-dev/DockFlare) @ [`19abaf6`](https://github.com/ChrispyBacon-dev/DockFlare/commit/19abaf6b3232fb4c4f18451171ef58b33767d6d1)

## How It Works

DockFlare is a self-hosted control plane that automates Cloudflare Tunnel configuration from Docker container labels. Instead of manually creating DNS records, tunnel ingress rules, and Access policies in the Cloudflare dashboard, you add labels like `dockflare.enable=true`, `dockflare.hostname=app.example.com`, and `dockflare.service=http://container:8080` to your containers. DockFlare watches for Docker events, reconciles desired state against Cloudflare's actual state, and applies the delta — creating DNS CNAME records pointing to your tunnel, configuring tunnel ingress rules, and provisioning Cloudflare Access applications for authentication.

The mental model is **declarative labels → reconciliation loop → Cloudflare API calls**. A background reconciler scans all containers, computes differences between local state (persisted in JSON) and what Cloudflare reports, and applies changes. Containers that disappear get a grace period before their rules are cleaned up.

## Architecture

DockFlare is a Python (Flask) monolith with several satellite components:

| Component | Stack | Role |
|-----------|-------|------|
| **DockFlare Master** | Python 3.13 / Flask / Waitress | Web UI, reconciliation, Cloudflare API orchestration |
| **Mail Manager** | Python / FastAPI / SQLite | Sovereign email backend (optional) |
| **Webmail** | Vue 3 / TypeScript | PWA mail client (optional) |
| **Redis** | — | Caching, pub/sub for state events, rate limiter storage |
| **cloudflared** | Cloudflare binary | Tunnel connector, managed as a Docker container by DockFlare |

The Python backend totals ~19K lines across ~25 source files. The largest file is `api_v2_routes.py` at ~2,900 lines — a single blueprint handling all REST endpoints for the web UI and agent APIs.

**Data flow:**

1. Docker labels define desired hostname→service mappings
2. Docker event listeners fire on container start/stop
3. The reconciler scans containers, computes deltas against `managed_rules` (in-memory dict persisted to JSON on disk)
4. Tunnel ingress config is pushed to Cloudflare via REST API
5. DNS CNAME records are created/updated
6. Cloudflare Access applications are provisioned if access labels are present
7. State changes are broadcast to UI via Redis pub/sub (with an in-process queue fallback)

## The Spine

**Entry point:** `main.py` → `main_application_entrypoint()` — loads encrypted config from disk (Fernet-encrypted `dockflare_config.dat`), initializes tunnel state, performs initial container scan, then starts background threads (event listeners, cleanup, agent status updater) and the Waitress WSGI server.

**Core modules (in dependency order):**

1. **`config.py`** — Environment-driven configuration with sensible defaults. Static config (ports, intervals) from env vars; dynamic config (API tokens, zone IDs) loaded from encrypted file at startup.
2. **`state_manager.py`** (~900 lines) — The central state store. In-memory dicts (`managed_rules`, `access_groups`, `agents`, `identity_providers`) protected by an `RLock`. Serialized to a JSON file at `STATE_FILE_PATH`. All state mutations go through `state_lock`.
3. **`cloudflare_api.py`** (~900 lines) — Low-level Cloudflare REST API wrapper with retry logic, rate-limited DNS operations via semaphore, and zone ID caching.
4. **`docker_handler.py`** (~660 lines) — Docker event listeners (start/stop/die), container label parsing, service URL validation. Fires reconciliation when containers change.
5. **`reconciler.py`** (~690 lines) — The reconciliation engine. Scans containers for labels, compares against `managed_rules`, creates/updates/deletes rules with grace periods, triggers tunnel config and DNS updates.
6. **`tunnel_manager.py`** (~715 lines) — Tunnel lifecycle (create/find via API, manage cloudflared container, push ingress config).
7. **`access_manager.py`** (~545 lines) — Cloudflare Access application CRUD, policy binding, reusable policy management.

**Request lifecycle (web UI):**
Flask routes → session/OAuth auth → API v2 blueprint → reads/mutates `state_manager` globals → triggers reconciliation or direct Cloudflare API calls → publishes state events → returns JSON to UI.

## Key Patterns

**Label-driven configuration.** The `dockflare.` label prefix (configurable) mirrors Traefik's approach but targets Cloudflare Tunnels. Multi-hostname support uses indexed labels: `dockflare.0.hostname`, `dockflare.1.hostname`. Access control is label-driven too: `dockflare.access.group`, `dockflare.access.policy`, with fine-grained options for session duration, IdP restrictions, and custom rules.

**Reconciliation loop.** The reconciler is the architectural heart. It's idempotent by design — safe to re-run. It handles three rule sources: `docker` (labels), `manual` (UI-created), and `agent` (remote hosts). Rules marked for deletion get a configurable grace period before actual removal.

**Thread-per-concern.** The application spawns daemon threads for Docker event listening, periodic cleanup, agent status polling, and reconciliation. Coordination is via `threading.Event` (stop signals), `threading.RLock` (state access), and Redis pub/sub (UI updates). There's no async/await — everything is synchronous threading.

**Encrypted config at rest.** Sensitive credentials (Cloudflare API token, OAuth secrets) are stored in a Fernet-encrypted file. The encryption key lives on disk beside it (`dockflare.key`). A "Pre-Flight" mode exists for initial setup before credentials are configured.

**Multi-agent architecture.** Remote Docker hosts run lightweight agents that poll the master for commands and report container state. Agent communication is secured via Cloudflare Zero Trust service tokens, removing the need for VPNs. Agent enrollment can require manual approval.

## Non-Obvious Details

> [!note] The `api_v2_routes.py` mega-file
> At ~2,900 lines, this single blueprint handles everything: manual rule CRUD, agent registration/heartbeat, auth settings, DNS zone management, backup/restore, service token management, and more. It's the largest file in the codebase by a wide margin.

**Legacy label migration.** The reconciler contains automatic migration paths: `dockflare.access.policy=bypass` → `dockflare.access.group=public-default-bypass`, and similar for `authenticate`. This handles upgrades from older label schemas without user intervention.

**Auto-restore for agent rules.** When `AUTO_RESTORE_AGENT_RULES` is enabled, the master will re-create rules reported by agents if those rules were previously deleted from master state — a self-healing mechanism with per-agent cooldowns to prevent flapping.

**DNS concurrency control.** DNS operations are rate-limited via `threading.Semaphore(MAX_CONCURRENT_DNS_OPS)` (default 5), preventing API rate-limit issues when reconciling many hostnames simultaneously.

**Auth bypass for API endpoints.** The `request_loader` in Flask-Login automatically authenticates API v2 endpoints (excluding auth routes and UI-only allowlisted endpoints) as `api_user` — effectively making the API accessible without session auth, relying on network-level access control (Cloudflare Access) instead.

> [!question] CSRF exemptions
> Multiple blueprints (`api_v2_bp`, `setup_bp`, `email_bp`, `auth_callback`) are exempted from CSRF protection. For an API-first design this is expected, but the setup routes exemption is worth noting.

## Assessment

**Strengths:**

- **Solves a real pain point.** Manually managing Cloudflare Tunnel configs for dynamic Docker workloads is tedious. DockFlare automates the full lifecycle — DNS, ingress, Access policies — from simple labels.
- **Feature depth.** Beyond basic label-to-tunnel mapping, it covers Access application management, reusable policies, multi-host agents, sovereign email, identity provider sync, backup/restore, and i18n (13 languages). This is a comprehensive control plane, not a thin wrapper.
- **Security posture is reasonable.** Encrypted config at rest, Docker socket proxy recommended, non-root container, scoped API tokens, optional Zero Trust for agents. The project includes third-party security audit reports in the repo.
- **Reconciliation design.** Idempotent reconciliation with grace periods, multi-source rules (docker/manual/agent), and auto-restore for agent rules is a solid operational model.

**Concerns:**

- **Monolithic single-file routes.** `api_v2_routes.py` at ~2,900 lines is a maintenance burden. Splitting by domain (rules, agents, auth, DNS, email) would improve readability and review.
- **In-memory state with file persistence.** All state lives in Python dicts serialized to a JSON file. No transaction guarantees, no atomic writes visible. A crash during `save_state()` could corrupt state. For single-instance deployments this is acceptable, but it limits horizontal scaling.
- **Synchronous threading model.** The entire backend uses threading (not async). For a tool primarily doing I/O (Docker API, Cloudflare API, Redis), an async model would be more efficient, though the current approach works at typical self-hosted scale.
- **Global mutable state.** Module-level dicts (`managed_rules`, `access_groups`, etc.) mutated under a lock is a classic pattern that works but is fragile. The `state_lock` RLock is held during long reconciliation blocks, which could block UI reads.
- **No test suite visible.** The repository doesn't contain unit or integration tests for the core reconciliation logic. The "SECURITY AUDIT" folder contains external penetration test results, but there are no automated tests for the application itself.

**Recommendations:**

- Split `api_v2_routes.py` into domain-specific route modules.
- Add atomic file writes (write-to-temp + rename) for state persistence.
- Consider extracting the reconciliation engine into a testable, stateless function that takes current state + desired state and returns a plan of mutations.
- Add unit tests, particularly for the label parsing and reconciliation delta logic — these are the most critical and complex paths.

## Related

- [[analyzing-traefik]] — Similar label-driven reverse proxy model; DockFlare is to Cloudflare Tunnels what Traefik is to direct proxying
- [[analyzing-sablier]] — Another Docker-aware dynamic proxy tool
- [[analyzing-step-ca]] — Complementary PKI for zero-trust environments
