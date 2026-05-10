---
title: "Analyzing Symphony"
date: 2026-05-10
type: codebase-analysis
status: complete
source: https://github.com/openai/symphony
tags: [openai, ai-agents, orchestration, autonomous-coding]
---

# Analyzing Symphony

> **Source:** [openai/symphony](https://github.com/openai/symphony) @ [58cf97d](https://github.com/openai/symphony/commit/58cf97da06d556c019ccea20c67f4f77da124bf3)

## How It Works

Symphony is a long-running daemon that bridges an issue tracker (Linear) with autonomous coding agents (Codex in app-server mode). It polls the tracker on a fixed cadence, picks up issues in active states, creates isolated filesystem workspaces for each, and launches a Codex subprocess per issue. The system manages bounded concurrency, retries with exponential backoff, stall detection, and reconciliation — when an issue moves to a terminal state mid-run, Symphony kills the active agent and cleans up the workspace. The entire behavior is configured through a single `WORKFLOW.md` file checked into the target repository, which combines YAML front matter (runtime config) with a Liquid-compatible prompt template.

The mental model is a polling loop with an in-memory state machine. Every tick: validate config, fetch candidate issues from Linear, reconcile currently-running issues against tracker state, then dispatch new issues up to concurrency limits. Each dispatched issue gets its own BEAM Task process running the `AgentRunner`, which creates a workspace, runs lifecycle hooks (`before_run`, `after_run`), and drives the Codex app-server via JSON-RPC 2.0 over stdio. Agent updates (token counts, events) stream back to the orchestrator via Erlang messages. On normal completion, the orchestrator schedules a short-delay "continuation check" — if the issue is still active, it re-dispatches with an incrementing attempt counter.

The reference implementation is Elixir/OTP, built on GenServer, Task.Supervisor, and Phoenix PubSub. But the repo also ships a language-agnostic `SPEC.md` (2,169 lines) that rigorously defines the protocol — entity schemas, error classes, dispatch gating rules, and configuration resolution — so that Symphony can be reimplemented in any language. The spec explicitly states that implementations "MUST document their trust and safety posture," acknowledging that this is a high-trust tool running autonomous code agents.

## Architecture

```
WORKFLOW.md ──► WorkflowStore (GenServer, polls file for changes)
                     │
                     ▼
              Config/Schema (Ecto embedded schemas for validation)
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
   Tracker ◄──── Orchestrator ───► AgentRunner
  (behaviour)    (GenServer)      (Task per issue)
       │             │                 │
  Linear.Adapter     │                 ▼
  Linear.Client      │           Codex.AppServer
       │             │           (JSON-RPC 2.0 over stdio)
       ▼             ▼
   Linear API    StatusDashboard   Workspace
                  (Terminal TUI)   (filesystem isolation)
                       │
                  PhoenixLiveView (web dashboard)
```

Key modules and their roles:

- **Orchestrator** — The brain. GenServer owning all runtime state: running issues, claimed set, retry queue, token totals. ~1,655 lines of careful concurrent state management.
- **AgentRunner** — Thin execution wrapper. Creates workspace, runs hooks, drives Codex turns in a loop until issue goes inactive or `max_turns` is reached.
- **Codex.AppServer** — JSON-RPC 2.0 client over stdio ports. Handles `initialize` → `thread/start` → `turn/start` lifecycle, with approval request handling and dynamic tool execution.
- **Workspace** — Filesystem lifecycle manager with path safety (symlink escape detection, canonicalization). Supports both local and remote (SSH) workers.
- **Config/Schema** — Uses Ecto embedded schemas to parse and validate YAML front matter into typed structs. Novel use of Ecto without a database.
- **WorkflowStore** — Caches the last-known-good `WORKFLOW.md` and hot-reloads on file change (1-second poll, mtime+size+hash stamp).

## The Spine

The entry point is `SymphonyElixir.CLI.main/1`, which requires an explicit `--i-understand-that-this-will-be-running-without-the-usual-guardrails` flag. It sets the workflow path, starts the OTP application, and blocks on the supervisor.

**Request lifecycle (per issue):**

1. **Orchestrator tick** fires (`handle_info({:tick, ...})`), schedules a poll cycle.
2. **Poll cycle** (`:run_poll_cycle`) calls `maybe_dispatch/1`: validates config, fetches candidates from Linear, reconciles running issues, sorts by priority/age, dispatches up to concurrency limits.
3. **Dispatch** (`dispatch_issue/3`) revalidates the issue against the tracker (freshness check), selects a worker host (local or SSH remote), and spawns a Task via `Task.Supervisor`.
4. **AgentRunner.run/3** creates the workspace, runs `before_run` hook, starts a Codex session (initialize → thread/start), then loops through turns (turn/start → stream events → turn/complete).
5. **Turn loop**: Each turn streams JSON-RPC events. Token deltas and codex updates are sent back to the orchestrator as `{:codex_worker_update, ...}` messages. On turn completion, rechecks issue state; if still active and under `max_turns`, starts another turn with continuation guidance.
6. **Completion**: Agent process exits, orchestrator receives `{:DOWN, ...}` via process monitor. On `:normal`, schedules a 1-second continuation retry. On error, schedules exponential backoff retry.
7. **Reconciliation**: Every tick, running issues are checked against tracker state. If an issue moved to terminal, the agent is killed and workspace cleaned up. Stalled agents (no codex activity for `stall_timeout_ms`) are restarted with backoff.

## Key Patterns

**Spec-first design.** The `SPEC.md` is the authoritative contract. The Elixir implementation tracks it closely, and the AGENTS.md explicitly states "implementation must not conflict with the spec." Test helpers expose internal functions suffixed `_for_test` for spec-aligned testing.

**In-memory state, no persistence.** The orchestrator holds all state in a GenServer struct. On restart, it reconciles against the tracker. Completed sets, retry queues, and token totals are ephemeral. This is intentional: the spec calls for "tracker/filesystem-driven restart recovery without requiring a persistent database."

**Ecto as config validator, not DB layer.** The `Config.Schema` module uses Ecto embedded schemas and changesets purely for struct creation and validation — no database involved. This gives them `cast/validate_number/validate_inclusion` for free on config parsing.

**Hot-reloadable configuration.** `WorkflowStore` polls `WORKFLOW.md` every second with a mtime+size+hash stamp. Config changes (poll interval, concurrency limits) take effect at the next tick without restart. The orchestrator calls `refresh_runtime_config/1` at every tick boundary.

**Path safety as a first-class concern.** `PathSafety.canonicalize/1` manually resolves symlinks segment-by-segment (not using `File.cwd!` or OS realpath). Both `Workspace` and `AppServer` validate that workspace paths stay under the configured root and detect symlink escapes. The spec calls this out explicitly.

**Two-tier concurrency control.** Global `max_concurrent_agents` cap plus per-state `max_concurrent_agents_by_state` limits. Issues are sorted by priority (1-4, then default 5), then creation age, then identifier.

**Hook lifecycle as shell scripts.** Workspace hooks (`after_create`, `before_run`, `after_run`, `before_remove`) are arbitrary shell commands from `WORKFLOW.md` front matter, run via `sh -lc` in the workspace directory with configurable timeout.

## Non-Obvious Details

> [!note] Continuation is not retry
> When an agent completes normally (`:normal` exit), the orchestrator does not mark the issue done. Instead it schedules a 1-second "continuation retry" — a re-dispatch with `attempt` incremented. This is because Codex may complete a turn while the Linear issue is still in an active state, meaning work remains. The `AgentRunner` re-validates issue state between turns, but the orchestrator also does a post-exit check as a safety net.

> [!warning] Todo-blocked-by dispatch gating
> Issues in "Todo" state are skipped if *any* blocker has a non-terminal state, even if the blocker's state is unknown. The `todo_issue_blocked_by_non_terminal?/2` function treats blockers with `nil` state as blocking (the `_ -> true` catch-all). This is conservative but could starve issues if blocker data is incomplete.

> [!tip] Dynamic tools injected into Codex
> `Codex.DynamicTool` provides tool specs that are injected into the `thread/start` JSON-RPC call. The app-server client handles `tool/call` requests from Codex and dispatches them through a configurable `tool_executor`. This is how Symphony extends Codex's capabilities without modifying Codex itself.

> [!note] SSH worker support is first-class
> The entire system supports dispatching agents to remote machines via SSH. `SSH.start_port/3` wraps the Codex command in `ssh -T host 'bash -lc ...'`. Workspace operations (create, hooks, remove) all have remote variants. The `worker_host` field threads through almost every module.

> [!question] Approval policy passthrough
> Codex approval policy (`approval_policy`, `thread_sandbox`, `turn_sandbox_policy`) is treated as opaque config passed straight to the Codex app-server. When `approval_policy == "never"`, the client auto-approves all requests. Otherwise, approval-required events error out. There's no human-in-the-loop approval flow in the orchestrator itself.

## Assessment

**Strengths:**

- **Spec-driven architecture** is excellent. The 2,169-line SPEC.md with RFC 2119 language makes this the most precisely specified AI agent orchestrator I've seen. Any team can reimplement it.
- **OTP is the right choice.** GenServer + Task.Supervisor + process monitors give them concurrent agent management with proper supervision trees for free. The `{:DOWN, ref, :process, pid, reason}` pattern for tracking agent completion is idiomatic and robust.
- **Workspace isolation is serious.** Custom symlink-resolving path canonicalization, escape detection, and the invariant that "Codex never runs in the source repo" are strong security fundamentals.
- **Hot-reloadable config** with last-known-good fallback is operationally mature — bad `WORKFLOW.md` edits don't crash the running system.

**Concerns:**

- **Single-process bottleneck.** The orchestrator is one GenServer handling all state. With 10+ concurrent agents streaming token updates at high frequency, the message queue could become a bottleneck. The code already acknowledges this with `refresh_runtime_config/1` calls on every info message.
- **No persistence, limited observability.** All state is ephemeral. After a restart, running agents are orphaned (their BEAM processes die). Token totals and retry history are lost. The status dashboard is terminal-only (with a Phoenix web view) — there's no metrics export (Prometheus, OpenTelemetry).
- **Shell injection surface.** Hooks are shell commands from `WORKFLOW.md` run via `sh -lc`. While the workspace is isolated, the hook scripts run with full user privileges. The spec says implementations "MUST document their trust and safety posture" but doesn't mandate sandboxing hooks themselves.
- **Linear-only.** The tracker is hard-coded to Linear's GraphQL API. The `Tracker` behaviour and `memory` adapter show intent for extensibility, but no other tracker implementations exist.

**Recommendations:**

- Add metrics export (token usage, dispatch latency, retry rates) for production observability.
- Consider a persistent log of run attempts for audit trail — currently `completed` is a transient MapSet.
- The `SPEC.md` should explicitly document the continuation retry pattern; it's a core behavioral contract that's only visible from reading the orchestrator code.
- Investigate whether the orchestrator GenServer should shard or delegate update processing under high concurrency.

Related: [[analyzing-hermes-agent]] — both systems orchestrate autonomous coding agents, though Symphony is daemon-based with issue tracker integration while Hermes operates as a conversational agent. [[analyzing-caveman]] shares the theme of autonomous code execution systems.
