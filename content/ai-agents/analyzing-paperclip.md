---
title: "Analyzing Paperclip"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/paperclipai/paperclip
tags: [typescript, express, react, drizzle, ai-orchestration, agent-framework, plugin-system, multi-tenant]
---

# Analyzing Paperclip

> **Source:** [paperclipai/paperclip](https://github.com/paperclipai/paperclip) @ [`d0e9cc7`](https://github.com/paperclipai/paperclip/commit/d0e9cc76f2eb114ed63d398ee0a0185d64bff852)

## How It Works

Paperclip is a control plane for running businesses staffed by AI agents. It models organizations as a hierarchy of *companies → projects → goals → issues*, with agents occupying roles in an org chart and executing work through a heartbeat-based lifecycle.

The mental model: an agent is an employee with a job title, a budget, an org-chart position, and an inbox of tasks. When an agent has work to do, Paperclip "wakes it up" by spawning a run through an *adapter* — a pluggable bridge to an actual AI runtime like Claude Code, Codex, Gemini CLI, or any HTTP endpoint. The adapter launches the agent process, streams output back, and Paperclip records everything: cost events, audit trails, issue comments, and run summaries.

Companies have budgets. Agents have budgets. When a budget threshold is crossed, agents are automatically paused — a hard-stop enforced in the heartbeat scheduler before any run begins. Board members (human operators) govern through approval gates: hiring agents, overriding strategy, and reviewing work products.

The system is designed for *zero-human operation* — set a goal, hire agents, approve strategy, and let it run — but with full observability and control through a React dashboard.

## Architecture

Paperclip is a pnpm monorepo (~430K lines of TypeScript) with seven core packages:

```
server/          Express REST API + orchestration services (~100K LOC)
ui/              React + Vite dashboard (~139K LOC)
packages/db/     Drizzle ORM schema + migrations (~6K LOC)
packages/shared/ Types, constants, validators, API paths
packages/adapters/   Adapter implementations (10 adapters, ~17K LOC)
packages/adapter-utils/  Shared adapter runtime utilities
packages/plugins/  Plugin SDK + example plugins
cli/             CLI tool for managing Paperclip instances
```

**Data flow for a task execution:**

```
Board assigns issue → agent inbox
    ↓
Heartbeat scheduler picks up wakeup request
    ↓
Budget check (hard-stop if exceeded)
    ↓
Adapter resolves agent config + environment + secrets
    ↓
Adapter spawns process (e.g., claude --print) with injected instructions
    ↓
Stdout/stderr streamed → parsed → stored as heartbeat run events
    ↓
Run completes → cost tracked → issue updated → summary posted as comment
    ↓
Liveness classification → continuation decision → next heartbeat scheduled
```

The database is PostgreSQL (or embedded PGlite for dev). Drizzle ORM provides the schema with ~60 tables covering agents, issues, companies, heartbeat runs, budgets, approvals, secrets, routines, plugins, and more.

## The Spine

**Entry point:** `server/src/index.ts` → `createApp()` in `server/src/app.ts`. The Express app mounts ~30 route modules under `/api`, initializes the plugin system (worker manager, event bus, job scheduler, tool dispatcher), and starts background services.

**Core request lifecycle** — tracing a heartbeat run (the most important flow):

1. **Wakeup:** `server/src/services/heartbeat.ts` — `wakeAgent()` creates a `heartbeat_run` row and an `agent_wakeup_request`. This is the canonical entry point, triggered by: manual board action, assignment wake, scheduled timer, or automation webhook.

2. **Checkout:** The run performs an atomic checkout of the agent's next issue. The `issues.checkout_run_id` column is set inside a transaction — no double-work is possible.

3. **Execute:** `getServerAdapter()` resolves the adapter for the agent's type, calls `adapter.execute(ctx)`. The context includes: the agent record, the issue, environment config, secrets (decrypted), and skill instructions.

4. **Stream:** Process stdout is read line-by-line. Each adapter has a `parse-stdout.ts` that converts raw CLI output into structured `TranscriptEntry` objects. Events are persisted to `heartbeat_run_events` and pushed to live SSE subscribers.

5. **Complete:** Run finishes → cost events recorded from parsed usage → budget counters updated → issue status transitions → liveness classification determines if a follow-up heartbeat is needed.

**Key domain models:**

| Table | Role |
|-------|------|
| `companies` | Top-level org boundary. Budget, branding, approval policies. |
| `agents` | AI employees. Adapter type, org chart position, budget, permissions. |
| `issues` | Work items. Single-assignee, linked to project/goal, atomic checkout. |
| `heartbeat_runs` | Execution records. Full lifecycle: queued → running → succeeded/failed. |
| `heartbeat_run_events` | Streamed output. One row per transcript entry. |
| `approvals` | Governance gate. Hire, strategy, budget override decisions. |
| `budget_policies` / `budget_incidents` | Cost control. Thresholds, auto-pause, incident tracking. |
| `routines` / `routine_runs` | Scheduled/cron-like recurring task generation. |

## Key Patterns

**Adapter pattern with runtime polymorphism.** The `ServerAdapterModule` interface defines the contract: `execute()`, `testEnvironment()`, optional `listModels()`, `syncSkills()`, `sessionCodec`, `getConfigSchema()`. Ten built-in adapters implement this — each one knows how to launch and communicate with a specific AI runtime. Adapters are registered in a runtime registry and resolved by agent `adapterType`. The system also supports external adapter plugins loaded from `~/.paperclip/adapter-plugins.json`.

**Company-scoped everything.** Every domain entity has a `company_id` foreign key. Routes enforce company access in middleware. Agent API keys are scoped to a company and hashed at rest. This enables multi-company isolation on a single deployment.

**Actor middleware with dual authentication.** Every request passes through `actorMiddleware()` which resolves the caller as one of: board user (via session, API key, or local implicit), agent (via bearer API key or JWT), or anonymous. The `req.actor` object carries `type`, `companyId`, `agentId`, `userId`, `memberships`, and `isInstanceAdmin`. Two deployment modes: `local_trusted` (auto-board, no auth) and `authenticated` (BetterAuth sessions).

**Budget enforcement as a hard gate.** Before any heartbeat run begins, the budget service checks company and agent spend against configured thresholds. If a hard threshold is breached, the agent is paused and a `budget_incident` is created. This is not advisory — it's enforced at the scheduler level.

**Liveness classification for autonomous continuation.** After each run completes, `classifyRunLiveness()` analyzes what the agent accomplished: did it make progress, is it blocked, did it produce only a plan, or fail? This classification drives whether the issue stays checked out, gets a continuation summary injected, or gets released back to the backlog. This is the core of the "set it and forget it" experience.

**Plugin system with capability-based permissions.** Plugins declare capabilities (e.g., `issues.create`, `agents.invoke`, `events.subscribe`, `ui.sidebar.register`). The host enforces these at runtime. Plugins run in worker processes (Node.js `worker_threads`) and communicate with the host via RPC. UI extensions mount into defined slot types (pages, detail tabs, sidebar panels, dashboard widgets). The system is mature in its spec but still early in implementation — single-tenant, filesystem-based installs only.

**Declarative config layering.** Configuration comes from: `~/.paperclip/config.json` (file), `.env` (project), environment variables (runtime). Env vars override file config. The `Config` interface has ~30 fields covering database, secrets, storage, auth, networking, and heartbeat scheduling.

**Error handling.** A simple `HttpError` class with factory functions (`badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `unprocessable`). The Express `errorHandler` middleware catches these and returns consistent JSON responses. No Result types — exceptions flow through async/await.

## Non-Obvious Details

**The heartbeat service is 9,500 lines.** `server/src/services/heartbeat.ts` is the largest file by far and is the core of the entire system. It handles wakeup, checkout, execution, streaming, cost tracking, liveness classification, continuation logic, session management, and recovery. This is a God service — it does almost everything related to agent execution. Refactoring it into smaller modules would be the highest-impact improvement.

**Atomic issue checkout prevents double-work.** The `checkoutRunId` column on `issues` is set inside a database transaction that also creates the heartbeat run. If two schedulers race, only one wins. This is critical for correctness in a system where multiple timers, webhooks, and manual triggers can all wake the same agent.

**Issue origin kinds encode self-healing behavior.** The `issue.originKind` field includes values like `stale_active_run_evaluation`, `harness_liveness_escalation`, `issue_productivity_review`, and `stranded_issue_recovery`. These are issues *created by the system about itself* — monitoring and recovery loops. Partial unique indexes ensure only one active recovery issue exists per target issue at a time.

**Adapter session codecs enable run-to-run continuity.** The `AdapterSessionCodec` interface lets adapters serialize and restore session state between heartbeats. This means an agent can resume work across multiple wakeup cycles without losing context — critical for long-running tasks.

**The config file supports worktree-aware resolution.** `server/src/worktree-config.ts` handles git worktree scenarios, where Paperclip might be running from a worktree with its own `.env`. This is a sign of real-world usage patterns in the development team.

**Embedded PGlite for zero-config dev.** Leaving `DATABASE_URL` unset gives you an embedded PostgreSQL via PGlite — data stored in `data/pglite/`. This eliminates the "set up Postgres to contribute" barrier. Production uses real Postgres.

**The Docker image installs Claude Code, Codex, and OpenCode globally.** This means a single container can run agents with any built-in adapter without additional setup. The trade-off is a large image (~2GB+) and tight coupling to specific CLI tool versions.

**Cloud tenant provisioning via header-based trust.** The `resolveCloudTenantActor()` function auto-provisions users, companies, and instance admin roles from trusted HTTP headers (`x-paperclip-cloud-tenant-token`, `x-paperclip-cloud-stack-id`). This enables a SaaS hosting model where a reverse proxy vouches for tenant identity.

**40+ unique indexes with partial where clauses.** The `issues` table alone has 15+ indexes, many partial (e.g., only indexing active issues of a specific origin kind). This supports the monitoring/recovery system's need to quickly find "the one active recovery issue for this target" without scanning the full table.

## Assessment

**Strengths:**

The system is unusually well-specified. `doc/SPEC-implementation.md` serves as a concrete build contract, and `AGENTS.md` gives clear instructions for both human and AI contributors. The domain model is rich and internally consistent — companies, agents, issues, goals, and budgets all fit together coherently.

The adapter abstraction is genuinely useful. Supporting Claude Code, Codex, Gemini, OpenCode, Cursor, and generic HTTP/webhook backends from a single interface is ambitious and well-executed. The `getConfigSchema()` and `detectModel()` hooks show mature thinking about UX.

Budget enforcement as a hard gate, not a soft warning, is the right design for autonomous systems. Combined with activity logging for every mutation, this gives operators real governance over AI spending.

The plugin system spec is thorough — capability-based permissions, worker isolation, event subscriptions, scheduled jobs, scoped API routes, and UI extension slots. If implemented fully, this could be a significant differentiator.

**Concerns:**

The 9,500-line heartbeat service is the biggest risk. It contains the entire execution lifecycle and has implicit dependencies across dozens of schema tables. Any bug there affects the core value proposition. It needs decomposition.

The codebase is large (~430K lines) for a project at v2026.428.0 with 90 contributors. Much of the UI code (139K lines) likely mirrors the API surface. The rapid growth suggests some areas may not be as well-tested as the core services — 227 server tests vs. the breadth of the API surface is reasonable but not deep.

Multi-company isolation is company-scoped but not cryptographically enforced between companies. A bug in a route's access check could leak data across company boundaries. The auth middleware is comprehensive but complex, with 7+ resolution paths (local implicit, session, board key, agent key, agent JWT, cloud tenant, none).

> [!question]
> The plugin UI runs as same-origin JavaScript — not sandboxed. The spec acknowledges this explicitly. For a system managing API keys, secrets, and budget credentials, this is a significant trust assumption that limits the plugin ecosystem's growth potential.

**Recommendations:**

1. **Decompose the heartbeat service.** Extract checkout, execution, cost tracking, liveness classification, and continuation logic into focused modules. The current monolith is hard to test in isolation.

2. **Formalize inter-service contracts.** The implicit convention that "all services receive `db: Db` as first arg" works but doesn't encode what mutations each service is allowed to make. A service-layer interface would catch regressions.

3. **Add integration tests for multi-company isolation.** Unit tests cover individual routes, but the risk is in the gaps between middleware composition. Tests that verify agent A in company X cannot see company Y's data would add real assurance.

4. **Plugin UI sandboxing.** Before opening the plugin ecosystem to third parties, implement iframe or Shadow DOM isolation for plugin UI components.
