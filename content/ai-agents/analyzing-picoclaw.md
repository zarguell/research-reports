---
title: "Analyzing PicoClaw"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/sipeed/picoclaw
tags: [go, react, ai-agent, multi-platform, llm, mcp, tool-calling, plugin-system, embedded, open-source]
---

# Analyzing PicoClaw

> **Source:** [sipeed/picoclaw](https://github.com/sipeed/picoclaw) @ [`81a0505`](https://github.com/sipeed/picoclaw/commit/81a0505)

## How It Works

PicoClaw is an ultra-lightweight personal AI assistant written entirely in Go, designed to run on $10 embedded hardware (RISC-V, ARM, MIPS) with <10MB RAM and sub-second boot. It acts as a universal bridge between 30+ LLM providers and 18+ messaging channels, with built-in tool execution, MCP support, voice I/O, and a web UI launcher. The project has 28K+ GitHub stars, 210 contributors, and has shipped 14 releases since its February 2026 launch.

The system is a single Go binary with zero CGO dependencies — even SQLite is a pure-Go implementation (`modernc.org/sqlite`). This enables cross-compilation to 9+ architectures including MIPS, RISC-V, and LoongArch. The web frontend (React + TanStack Router + Tailwind) is bundled into a separate launcher binary that embeds the React app and serves it over HTTP. Two binaries, no runtime dependencies — just copy and run.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   picoclaw-launcher                  │
│  ┌─────────────┐  ┌──────────────────────────────┐  │
│  │ React SPA   │  │  Go REST API (embedded)       │  │
│  │ (TanStack)  │←→│  Config, Channels, Providers  │  │
│  └─────────────┘  └──────────┬───────────────────┘  │
└──────────────────────────────┼───────────────────────┘
                               │ spawns / proxies
┌──────────────────────────────┼───────────────────────┐
│                    picoclaw gateway                  │
│  ┌──────────────────────────────────────────────┐   │
│  │              AgentLoop (event loop)           │   │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────┐  │   │
│  │  │ MessageBus│→ │ Pipeline │→ │ HookMgr    │  │   │
│  │  └──────────┘  └──────────┘  └────────────┘  │   │
│  └──────────────────────┬───────────────────────┘   │
│              ┌──────────┴──────────┐                 │
│  ┌───────┐  │  ┌─────────┐  ┌──────────┐           │
│  │Channels│←→  │ Providers│  │ToolReg+MCP│           │
│  │18+     │   │ 30+      │  │Sandboxed  │           │
│  └───────┘   └─────────┘  └──────────┘           │
└─────────────────────────────────────────────────────┘
```

**Tech stack:** Go 1.25 (core), TypeScript/React (web), cobra CLI, zerolog structured logging, pure-Go SQLite, JSONL session storage, GNU Make with cross-compilation.

## The Spine

### Entry Points

Two binaries built from the same repo:

- **`cmd/picoclaw/main.go`** — CLI agent with cobra subcommands: `picoclaw gateway`, `picoclaw agent`, `picoclaw onboard`, `picoclaw mcp`
- **`web/backend/main.go`** — Web UI launcher that serves the React SPA and exposes a REST API for configuration

### Request Lifecycle (Gateway Mode)

The full path for an inbound message:

```
Channel (e.g., Telegram bot receives message)
  → Channel.Start() polling/websocket handler
  → Normalizes to bus.InboundMessage
  → bus.MessageBus.PublishInbound()
  → AgentLoop.Run() receives on InboundChan()
  → Session key resolution + TOCTOU-safe turn claiming via sync.Map.LoadOrStore
  → Worker goroutine (bounded by workerSem semaphore)
  → runTurnWithSteering() → runTurn()
  → Pipeline.SetupTurn(): routing, context assembly, prompt building
  → Pipeline.ExecuteLLM(): model selection → FallbackChain.Chat() → LLMProvider.Chat()
  → Pipeline.ExecuteTools(): tool call extraction → ToolRegistry.Execute() → tool execution
  → Loop until final response (max_iterations or no tool calls)
  → Pipeline.FinalizeTurn(): summarization, response publishing
  → bus.MessageBus.PublishOutbound()
  → Channel.Send() → platform API call
```

### Core Types

- **`AgentLoop`** (`pkg/agent/agent.go`) — Central coordinator holding the message bus, config, agent registry, context manager, fallback chain, channel manager, hook manager, MCP runtime, and steering queue. `Run()` dispatches inbound messages to worker goroutines with per-session serialization.
- **`Pipeline`** (`pkg/agent/pipeline.go`) — Per-turn runtime dependency container. Four phases: `SetupTurn`, `ExecuteLLM`, `ExecuteTools`, `FinalizeTurn`.
- **`MessageBus`** (`pkg/bus/bus.go`) — Channel-based broker with typed channels (inbound, outbound, media, audio, voice). Buffer size 64. Thread-safe close via `sync.Once` with `WaitGroup` drain.
- **`LLMProvider`** (`pkg/providers/types.go`) — Minimal interface: `Chat() → (*LLMResponse, error)`. Extended via optional interfaces: `StreamingProvider`, `ThinkingCapable`, `NativeSearchCapable`, `StatefulProvider`.
- **`Channel`** (`pkg/channels/base.go`) — Interface with `Start()`, `Stop()`, `Send()`, `IsAllowed()`. Optional capability interfaces layered via type assertion: `TypingCapable`, `MessageEditor`, `ReactionCapable`, `StreamingCapable`.
- **`FallbackChain`** (`pkg/providers/fallback.go`) — Wraps provider candidates with cooldown tracking, rate limiting, and error classification. Non-retriable errors (format, context overflow) short-circuit fallback.

## Key Patterns

### Plugin Registration via `init()`

Both channels and tools use self-registration. Each channel subpackage calls `channels.RegisterFactory()` in its `init()`. The gateway imports all channels via blank imports (`_ "github.com/sipeed/picoclaw/pkg/channels/telegram"`). Adding a new channel is one file + one import + one `init()` call. Build tags (`whatsapp_native`, `bedrock`, etc.) control conditional inclusion.

### Event-Driven Architecture

35+ typed event kinds cover agent turns, LLM requests/responses, tool execution, channel lifecycle, gateway state, and MCP server lifecycle. Events flow through `runtimeevents.Bus` with subscription filtering. This provides a comprehensive audit trail foundation.

### Hook System (Observers / Interceptors / Approval)

Three hook types: **observers** (fire-and-forget), **interceptors** (can modify/short-circuit), **approval hooks** (require confirmation). Hooks execute at defined lifecycle points (pre/post turn, pre/post tool).

### Steering Queue

A steering queue (`steeringQueue`) allows injecting messages into a running agent loop between tool-call iterations. This enables real-time human-in-the-loop feedback, SubTurn coordination, and interrupt handling.

### Config Split

`config.json` for non-sensitive settings, `.security.yml` for secrets. The `SecureString` type uses reflection-based collection to build a `strings.Replacer` that filters secrets from logs. Config supports hot-reload via file polling.

### Process-Level Sandboxing

`pkg/isolation/` provides process-level sandboxing for tool execution. On Linux, it uses mount namespaces to restrict filesystem access. On Windows, per-instance user environment redirection.

### Concurrency Model

Per-session turn serialization via `sync.Map.LoadOrStore` with placeholder sentinels. Global concurrency bounded by `workerSem` channel. Panic recovery in every worker. Graceful shutdown via context cancellation with drain.

## Non-Obvious Details

### TOCTOU-Safe Session Claiming

`activeTurnStates` uses a two-phase `sync.Map` pattern: first `LoadOrStore` with a placeholder `turnState`, then the real turn replaces it. This prevents the race where two messages for the same session both pass the `Load` check before either registers. The comment explicitly documents this.

### Media Cleanup Disabled

In `agent.go`, deferred media cleanup is commented out with a TODO: "Currently disabled because files are deleted before the LLM can access their content." This is a known resource leak — media files accumulate indefinitely.

### Provider Factory is a Giant Switch

`CreateProviderFromConfig()` is a ~270-line switch statement with 30+ protocol cases. Many share identical HTTP provider construction but are listed individually. A table-driven approach would halve this code.

### Discord Fork

`go.mod` replaces `bwmarrin/discordgo` with a fork (`yeongaori/discordgo-fork`), suggesting upstream issues requiring a custom patch.

### Chinese Comma Support

`FlexibleStringSlice.UnmarshalText()` handles both English `,` and Chinese `，` commas — a localization detail signaling the project's primary user base.

### Seahorse: Embedded FTS Engine

`pkg/seahorse/` is a full-text search engine built on SQLite FTS5 with BM25 ranking, compaction, and retrieval — used for skill and context search without external dependencies.

### Context Budget System

`pkg/agent/context_budget.go` manages token budget allocation between system prompt, history, and tools. Essential for models with small context windows on embedded hardware.

## Assessment

### Code Quality: Good

Strong Go idioms throughout: small interfaces, interface segregation via optional capability interfaces, functional options pattern, proper error wrapping, table-driven tests. The dependency graph is well-organized — `pkg/bus/` is intentionally leaf-level to avoid circular imports between `pkg/agent/` and `pkg/channels/`.

### Architecture Fitness: Excellent for Target

The architecture is well-suited for resource-constrained hardware. Single binary, no runtime dependencies, compile-time feature stripping via build tags, JSONL session storage, and the Pipeline pattern keeps turn logic modular without framework overhead. The event/hook/steering systems provide extensibility without bloat.

### Security Posture: Moderate, Improving

**Strengths:** Secret/config separation, `SecureString` log filtering, process isolation sandboxing, PID singleton enforcement, auth tokens for endpoints, provider-side rate limiting.

**Concerns:**
- Shell tool execution is inherently dangerous; the isolation sandbox is Linux-only in its full form
- No input sanitization for LLM-generated shell commands beyond workspace restriction
- `IsAllowed()` on channels is the primary access control — misconfiguration could expose the bot publicly
- Media file leak is a disk exhaustion vector
- No rate limiting on inbound messages (only outbound/provider-side)
- README explicitly warns of unresolved security issues pre-v1.0

### Developer Experience: Good

Clear cobra CLI, web UI launcher, `picoclaw onboard` setup wizard, hot-reload for config changes, MCP CLI for tool servers. The Makefile is exceptional — covers every platform including MIPS ELF flag patching via `dd`.

### Operational Concerns

1. **Memory growth** — README admits 10-20MB vs <10MB target due to rapid PR merges; no automated memory regression testing
2. **Single-process architecture** — no clustering or horizontal scaling; gateway is a single point of failure
3. **File-based session storage** — works for single-instance but won't scale to multi-instance
4. **No observability exporters** — comprehensive event system exists but no Prometheus/OpenTelemetry integration

### Verdict

PicoClaw is an impressively engineered system that delivers on its core promise — a capable AI assistant running on commodity embedded hardware. The architecture is clean, modular, and extensible. The main risks are security (inherent to LLM tool execution), operational maturity (monitoring, scaling), and the tension between rapid feature velocity and the original lightweight mission. For a pre-1.0 project with 210 contributors and 28K stars, the code quality is notably high.

## Related

- [[analyzing-hermes-agent]] — another AI assistant framework for comparison
- [[analyzing-caveman]] — lightweight LLM tool-use approach
