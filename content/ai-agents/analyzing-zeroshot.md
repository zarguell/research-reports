---
title: "Analyzing Zeroshot"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/covibes/zeroshot @ 0edf068
tags: [javascript, nodejs, multi-agent, ai-orchestration, claude-code, codex, gemini, opencode, sqlite, rust, ratatui, cli]
---

# Analyzing Zeroshot

> **Source:** [covibes/zeroshot](https://github.com/covibes/zeroshot) @ [`0edf068`](https://github.com/covibes/zeroshot/commit/0edf0680b61c346af1960e88a6587e5460ac74fa)

## How It Works

Zeroshot is a multi-agent orchestration engine that runs autonomous engineering workflows by coordinating multiple AI coding agents (Claude Code, Codex, Gemini, OpenCode) through a message-passing architecture backed by SQLite. You point it at a GitHub issue (or paste a description), and it spawns a cluster of agents that plan, implement, and validate code changes in a loop — until the work is verified or rejected with actionable failure reports.

The core abstraction is the **cluster**: a bounded, parameterized workflow with typed agents communicating over a pub/sub message bus. Each agent runs as a subprocess that shells out to a provider CLI, captures structured tool-use events from stdout, and publishes results back to the ledger. The orchestrator is the single process that owns all clusters, persists state to SQLite, and provides crash recovery via a lock file mechanism.

## Architecture

The system has four main layers:

**CLI layer** (`cli/`) — Entry point. Parses user input (issue keys, free text, flags), detects issue providers from git remotes, resolves TUI binaries, and delegates to the task library.

**Task library** (`task-lib/`) — Thin command wrappers around the orchestrator. Exposes `run`, `resume`, `kill`, `status`, `logs`, etc.

**Core engine** (`src/`) — The orchestrator, message bus, ledger, agent wrappers, logic engine, isolation manager, providers, and issue provider integrations. This is where the work happens.

**UI layer** — Two TUI implementations: a legacy Node.js TUI and a new Rust TUI (`tui-rs/`) built with Ratatui, driven by a TypeScript backend (`src/tui-backend/`).

```
User input (issue key / text)
        ↓
    CLI (cli/index.js)
        ↓
    Task Library (task-lib/runner.js)
        ↓
Orchestrator (src/orchestrator.js) ← owns clusters Map
        ↓
Message Bus (src/message-bus.js) ← EventEmitter + SQLite ledger
        ↓
Agent Wrappers (src/agent-wrapper.js) — one per agent
        ↓
Provider CLIs (claude, codex, gemini, opencode)
        ↓
SQLite Ledger (src/ledger.js) ← append-only event log
```

## The Spine

### Cluster initialization

`orchestrator.js` is the main module. On `zeroshot run <issue>`, it:

1. Resolves the issue via the detected provider (GitHub/GitLab/Jira/Azure DevOps).
2. Loads a cluster template (e.g., `full-workflow.json` or `conductor-bootstrap.json`).
3. Classifies the task via the conductor (or directly if no conductor is used).
4. Creates a new `Orchestrator` instance, initializes the SQLite ledger, message bus, and isolation manager.
5. For each agent in the template, spawns an `AgentWrapper`.
6. Publishes an `ISSUE_OPENED` message to kick off the workflow.

### Agent execution loop

Each `AgentWrapper` runs a state machine: `idle → evaluating → building_context → executing → idle`. The agent subscribes to the message bus and, for each incoming message, evaluates its trigger logic via the `LogicEngine`. Triggers are JavaScript snippets evaluated in a `vm.Script` sandbox (1-second timeout, prototype-frozen). When a trigger matches, the agent:

1. Builds a context by querying the ledger (messages since last task end).
2. Injects guidance (queued user messages).
3. Spawns the provider CLI subprocess with a constructed prompt.
4. Streams stdout through a provider-specific parser, capturing tool-use events.
5. Publishes results back to the bus.

### Message bus and ledger

`message-bus.js` is a thin pub/sub layer over `EventEmitter`. Every published message is also appended to the SQLite ledger via `ledger.js`. The ledger is an append-only event log with indexed queries. It uses WAL mode for concurrent reads and supports LRU-cached queries. This dual in-memory/SQLite approach gives real-time subscriptions and durable persistence.

### Isolation modes

`isolation-manager.js` manages three isolation levels:
- **None**: Agents run in the host process directory.
- **Git worktree**: Each agent gets its own worktree branch.
- **Docker**: Agents run in containers with mounted credentials and workspace.

Docker isolation uses a custom base image (`zeroshot-cluster-base`) and injects provider auth tokens and git credentials as environment variables.

### Provider abstraction

Each provider (Anthropic/Claude, OpenAI/Codex, Google/Gemini, OpenAI/OpenCode) has its own module under `src/providers/`. The abstraction is minimal: each provider implements `isAvailable()`, `buildCLI()` (constructing the CLI invocation), and `parseEvent()` (parsing structured stdout into tool-use events). The `modelLevel` system (`level1`/`level2`/`level3`) abstracts model selection across providers.

### Two-tier conductor

The `conductor-bootstrap.json` template uses a junior/senior conductor pattern. The junior conductor (always `level2`) classifies tasks on two axes — **complexity** (TRIVIAL/SIMPLE/STANDARD/CRITICAL/UNCERTAIN) and **taskType** (INQUIRY/TASK/DEBUG) — then routes to a cluster template via `helpers.getConfig()`. CRITICAL tasks escalate to a senior conductor (level3). This is a cost control mechanism: most tasks default to STANDARD and run on cheaper models.

## Key Patterns

**Immutable event log.** The ledger is append-only. Agents never mutate past messages; all state is derived from the log. This makes the system fully auditable and resumable — any cluster can be reconstructed from its ledger.

**Sandboxed trigger evaluation.** Logic engine scripts run in a `vm.Script` context with frozen prototypes and a 1-second timeout. The sandboxed API exposes a `ledger` query helper scoped to the cluster, preventing cross-cluster leakage.

**Blind validation.** Validators are configured with `blind: true`, which strips context before passing it to the validator agent. The validator never sees the implementer's code history or implementation notes — only the task description and the changed files.

**Operational chain.** Agents can publish `CLUSTER_OPERATIONS` messages to dynamically spawn/remove agents or reload configs. This enables truly emergent multi-agent workflows beyond static templates.

**TUI v2 Rust architecture.** The new TUI uses a pure MVU (Model-View-Update) pattern in Rust. `app::update()` is pure and returns effects; `ui::render()` performs no IO. The TypeScript backend communicates via a JSON-RPC-over-stdio protocol (`src/tui-backend/protocol/`). The Rust side has separate screens (Launcher, FleetRadar, ClusterCanvas, AgentMicroscope) with a "disruptive zoom stack" navigation model.

## Non-Obvious Details

**Prototype pollution protection in the sandbox.** The logic engine freezes `Object.prototype` and `Array.prototype` inside the sandbox context to prevent prototype pollution attacks from malicious trigger scripts. This is a meaningful security boundary since trigger scripts come from template definitions (not user input directly, but still important).

**Ledger WAL + busy_timeout tuning.** The ledger uses WAL mode with a configurable `busy_timeout` (default 5 seconds) and autocheckpoint size (default 1000 pages). This is tuned for network filesystems and Kubernetes PVs where the default SQLite settings cause contention.

**Message buffering while busy.** `message-buffer.js` buffers messages arriving during agent execution (when the state machine is not in `idle`). These are drained after the current task completes, preventing message loss during execution.

**Two-stage validation.** The `full-workflow.json` template supports a two-stage validation gate: first the quick validators, then heavy validators run only if quick validation passes. This avoids running expensive security/performance validators on code that fails basic checks.

**Rate limit backoff.** The agent task executor implements exponential backoff with jitter for rate limit errors, configurable via settings. Validators get a Docker isolation fallback retry: if a validator fails, it retries in a Docker container to rule out environment-specific issues.

**GUIDANCE_TOPICS as a separate mailbox.** User guidance messages are published to dedicated topics (`USER_GUIDANCE_CLUSTER`, `USER_GUIDANCE_AGENT`) and stored in a separate SQLite table (`guidance_mailbox`). This lets the orchestrator inject guidance into running agents without polluting the main event log.

## Assessment

**Strengths:**
- The immutable ledger + SQLite approach is architecturally sound for crash recovery and auditability.
- Sandboxed trigger evaluation with prototype protection is a well-considered security boundary.
- Blind validation is a strong correctness feature — validators can't be biased by implementation context.
- Multi-provider abstraction with model-level cost ceilings prevents runaway API spend.
- The conductor two-tier pattern is pragmatic cost control.
- Rust TUI v2 follows clean MVU principles with proper separation of update/render.

**Concerns:**
- The logic engine sandbox blocks `fs`, `net`, and `child_process`, but `require` is not blocked — Node.js built-ins are still accessible. A malicious template could theoretically DoS the process via CPU-intensive built-in operations (though the 1-second timeout limits damage).
- The cluster templates are JSON with embedded JavaScript strings. Large templates like `full-workflow.json` (43KB) become hard to maintain and validate.
- Docker isolation mounts credentials into containers — this is necessary but increases the blast radius if the container escapes.
- The TUI v2 is still being developed alongside the legacy Node TUI — maintaining two UIs in parallel is a tax on the project.

**Recommendations:**
- Consider moving template trigger logic to a typed DSL or schema-validated JSON rather than embedded JS strings.
- Add time budgets per agent (separate from global timeout) to prevent a single validator from consuming disproportionate resources.
- The Rust TUI backend should stabilize soon to allow sunsetting the legacy Node TUI and reducing maintenance burden.

## Related

- [[analyzing-hermes-agent]] — This project (Hermes Agent) shares similar multi-agent coordination concepts but takes a different architectural approach.
- [[analyzing-caveman]] — Another multi-agent orchestration framework, worth comparing to Zeroshot's ledger-based approach.
