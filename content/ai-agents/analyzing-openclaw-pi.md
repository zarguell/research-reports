---
title: "Analyzing OpenClaw — Pi Under the Shell"
date: 2026-07-15
type: codebase-analysis
status: complete
source: https://github.com/openclaw/openclaw
tags: [typescript, ai-agent, coding-agent, multi-channel, monorepo]
---

# Analyzing OpenClaw — Pi Under the Shell

> **Source:** [openclaw/openclaw](https://github.com/openclaw/openclaw) @ [`57d926b`](https://github.com/openclaw/openclaw/commit/57d926b4fd821088bddcd51b516215b409b5a2b4)
> **Reference:** [earendil-works/pi](https://github.com/earendil-works/pi) @ [`dcfe36c`](https://github.com/earendil-works/pi/commit/dcfe36c79702ec240b146c45f167ab75ecddd205)

## Overview

OpenClaw is a production-grade personal AI assistant gateway, billed as "your own personal AI assistant on any OS, any platform." At 5.8M LOC, 19,659 TypeScript files, 157 extension packages, and 23 internal packages, it looks like a monolith from scratch. It isn't.

The core insight: **OpenClaw is a massive superstructure built on top of Pi**, Mario Zechner's AI agent toolkit. OpenClaw forked Pi's agent loop, agent runtime, and LLM abstraction layer into its own packages, then layered an entire multi-channel gateway platform, plugin SDK, security model, memory system, and 20+ additional subsystems on top. Pi provides the brain; OpenClaw provides the nervous system, the limbs, and the body.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              OpenClaw Gateway & CLI                  │
│  ┌───────────────────────────────────────────────────┤
│  │ Channels    │ Hooks      │ Plugins   │ Cron       │
│  │ (Telegram,  │ (lifecycle │ (SDK for  │ (scheduler)│
│  │  Discord,   │  events)   │  channels,│            │
│  │  WhatsApp…) │            │  providers)│            │
│  ├───────────────────────────────────────────────────┤
│  │ Memory   │ Tools    │ Skills │ Security │ Net-Pol │
│  │ (vector) │ (system) │ (md)   │ (auth,   │ (SSRF)  │
│  │          │          │        │  approvals)│        │
│  ├───────────────────────────────────────────────────┤
│  │        OpenClaw Agent-Core  (fork of Pi)          │
│  │  AgentLoop → LLM Call → Tool Exec → Repeat       │
│  ├───────────────────────────────────────────────────┤
│  │  OpenClaw LLM-Core / AI  (fork of Pi's ai pkg)   │
│  │  Anthropic │ OpenAI │ Google │ Mistral │ Bedrock  │
│  ├───────────────────────────────────────────────────┤
│  │            Pi TUI (direct npm dep)                │
│  └───────────────────────────────────────────────────┘
```

## The Spine

OpenClaw's architecture has two distinct layers:

### Layer 1: The Forked Pi Core

OpenClaw's `packages/agent-core/` is a direct fork of `@earendil-works/pi-agent-core`. The evidence is unmistakable:

- **Identical file layout**: `agent.ts`, `agent-loop.ts`, `types.ts`, `node.ts`, `runtime-deps.ts`, `validation.ts`, and the full `harness/` directory with session management, compaction, and branch summarization — all mirrored from Pi.
- **Identical types**: `AgentMessage`, `AgentTool`, `AgentContext`, `AgentLoopConfig`, `AgentEvent`, `BeforeToolCallContext/Result`, `AfterToolCallContext/Result`, `StreamFn` — all structurally identical to Pi's types.
- **Identical loop logic**: The `runAgentLoop` / `runAgentLoopContinue` functions work exactly as Pi's do — messages in → LLM call → parse tool calls → execute → loop. Even the `defaultConvertToLlm` filter and `EMPTY_USAGE` constants are copied.
- **Custom editor subclass pattern**: OpenClaw copied Pi's `CustomEditor` pattern verbatim for its TUI integration.
- **The only change**: imports were re-pointed from `@earendil-works/pi-ai` to OpenClaw's own `@openclaw/ai` and `@openclaw/llm-core`.

OpenClaw's `packages/ai/` is a parallel fork of `@earendil-works/pi-ai`. Same provider SDK dependencies (Anthropic, OpenAI, Google, Mistral, Bedrock), same streaming runtime, same typebox-based model catalogs. OpenClaw also depends directly on `@earendil-works/pi-tui` at version `0.80.3` via npm.

### Layer 2: The OpenClaw Superstructure

Everything else is what OpenClaw built on top. The entry point (`openclaw.mjs` → `src/entry.ts`) bootstraps a **gateway server** — not a CLI tool. The server:

1. Parses CLI args → determines target (start gateway, run command, onboard)
2. Loads config from `.crabbox.yaml` (OpenClaw's config format)
3. Starts an HTTP/WebSocket server (`src/gateway/`)
4. Loads extensions from `extensions/` directory (157 plugins)
5. Establishes channel connections (Telegram, Discord, etc.)
6. Routes incoming messages through the agent loop
7. Manages sessions, memory, cron jobs, and approvals

The agent loop itself (from Pi) runs as part of request processing — when a message arrives from Telegram, it enters the OpenClaw channel layer, gets hydrated into a session, and then OpenClaw calls into its forked agent-core to process it.

## Key Patterns

### 1. Fork + Layer (Not Rewrite)

OpenClaw didn't reimplement the agent loop. It forked Pi's `agent-core` package, renamed it to `@openclaw/agent-core`, and swapped the import paths to its own LLM layer. The fork is maintained in lockstep — both use the same `typebox`-based tool schemas, the same compaction logic, and the same session storage patterns. OpenClaw's diff against Pi's agent-core is mostly: (a) import path changes, (b) additions like `DeferredToolCallContext`, `turn-interruption.ts`, `reasoning.ts`.

### 2. Plugin-Driven Everything

Where Pi has an extension system for the TUI (hooks into lifecycle events, registers tools/commands), OpenClaw has a **plugin SDK** (`packages/plugin-sdk/`) with formal contracts:

- **Channel plugins**: Telegram, Discord, WhatsApp, Signal, iMessage, IRC, Slack, Matrix, etc.
- **Provider plugins**: Anthropic, OpenAI, Google, Mistral, Bedrock, DeepSeek, Cerebras, etc.
- **Tool plugins**: Browser, codex, MCP, etc.
- Each plugin is a self-contained npm package in `extensions/` with its own `package.json`, `openclaw.plugin.json` manifest, and TypeScript source.

### 3. Gateway Architecture

OpenClaw is fundamentally a server, not a CLI. The gateway (`src/gateway/server.ts`) manages:

- **HTTP API** (REST + WebSocket) for channel connections and control UI
- **Auth** with token-based auth, device pairing, OAuth flows
- **Session management** with SQLite persistence, session tree, compaction
- **Model catalog** with pricing cache, availability checks
- **Cron scheduler** for recurring agent tasks
- **Fleet management** for multi-device deployments

### 4. Hooks as Configuration

The hooks system (`src/hooks/`) uses YAML-frontmatter `.md` files as hook manifests — the same pattern Pi uses for prompts and skills, but extended to lifecycle hooks. A hook file declares its events (`command:new`, `session:start`), OS requirements, binary requirements, and points to a handler module. This makes the hook system discoverable and declarative.

### 5. Memory with Vector Embeddings

`packages/memory-host-sdk/` provides a full persistent memory system with SQLite-backed vector embeddings, multimodal support, and a query runtime. This is a significant expansion beyond Pi's session-only context.

## Non-Obvious Details

### Pi's agent-core is the engine, not the product

OpenClaw uses Pi's agent-core the way a web framework uses an HTTP parser. The agent loop is a library call — OpenClaw calls into it when a channel delivers a user message. Most of OpenClaw's complexity is in the infrastructure *around* the loop: channel adapters, plugin isolation, auth, security boundaries, persistent storage, fleet sync.

### The @mariozechner/* npm compatibility aliases

OpenClaw's extension loader aliases `@mariozechner/pi-*` to `@earendil-works/pi-*`, preserving backward compatibility with extensions written against the older npm namespace.

### Enterprise-grade security posture

OpenClaw has an unusually sophisticated security model for an open-source personal assistant. The `SECURITY.md` is ~36KB with incident response plans, trust boundaries, and SSRF filtering. It has NVIDIA and Tencent as security maintainers. The `net-policy` package implements SSRF protection, IP validation, and URL protocol filtering. The approvals system (`src/gateway/exec-approval-manager.ts`) supports operator approvals for sensitive operations.

### 157 extensions, but many are thin wrappers

Of the 157 extensions in `extensions/`, many are thin provider adapters (10-30 lines) that register an API base URL and model list. The substantive ones are the channel plugins (Telegram, Discord, WhatsApp) and the tool plugins (browser, codex, MCP).

## How OpenClaw Expands on Pi

| Capability | Pi | OpenClaw |
|---|---|---|
| **Agent loop** | `packages/agent-core` | Forked into `packages/agent-core` (same logic) |
| **LLM API** | `packages/ai` | Forked into `packages/ai` + `packages/llm-core` |
| **TUI** | `packages/tui` | Direct npm dep on `@earendil-works/pi-tui` |
| **Interface** | CLI (TUI, print, RPC modes) | **Gateway server** + CLI |
| **Channels** | Terminal only | Telegram, Discord, WhatsApp, Signal, iMessage, Slack, Matrix, IRC, 20+ total |
| **Extensions** | TUI extensions (events, tools, UI) | **Plugin SDK** with channel/provider/tool plugins |
| **Memory** | Session context only | **Persistent vector memory** (SQLite + embeddings) |
| **Security** | None (runs as user) | Full auth, approvals, SSRF, net policy, trust model |
| **Config** | `.pi/config.yaml` | `.crabbox.yaml` with hot-reload |
| **Scheduling** | None | Built-in **cron** |
| **Multi-device** | Single process | **Fleet** management |
| **Desktop apps** | None | macOS, iOS, Android, Linux, Windows Hub |
| **Hooks** | None | YAML-frontmatter lifecycle **hooks** |
| **Tool call repair** | None | `packages/tool-call-repair/` |
| **Media** | PNG image thumbnails only | Image gen, speech, TTS, video gen, real-time audio |
| **Web content** | None | `packages/web-content-core/` |
| **Sponsors** | None | OpenAI, GitHub, NVIDIA, Vercel, Convex |
| **Scale** | ~217K LOC, 829 TS files | ~5.8M LOC, 19,659 TS files |

## Assessment

**Strengths:**
- **Smart fork strategy**: By forking Pi's agent-core instead of wrapping it, OpenClaw got full control over the agent loop without a foreign-function interface tax. When Pi adds features upstream, OpenClaw can cherry-pick.
- **Production-grade**: The gateway architecture, auth model, SSRF protection, cron, and fleet management make this deployable as a real service, not just a dev tool.
- **Incredible breadth**: 20+ messaging channels, 30+ LLM providers, memory, media, speech — this is the most complete open-source personal AI assistant framework.
- **Strong security posture**: Unusual for a personal assistant project, OpenClaw has a mature security model with real maintainers from major security organizations.

**Concerns:**
- **Upstream drift risk**: OpenClaw's agent-core is a fork, not an npm dependency. As Pi evolves (Pi is at 0.80.7, OpenClaw pins pi-tui at 0.80.3), OpenClaw must manually reconcile changes. The forked packages import from `../../llm-core/` via relative paths rather than package names, making extraction/upstreaming harder.
- **Massive surface area**: 5.8M LOC for an assistant is enormous. The extension directory alone has 157 packages. This is a maintenance burden long-term.
- **Pi attribution is invisible**: Nothing in OpenClaw's README, docs, or public-facing materials mentions Pi. Only code-level evidence (imports, forked file structures, the `@mariozechner/*` aliases) reveals the foundation. This is technically allowed by MIT license (which doesn't require attribution), but notable.
- **Over-engineering risk**: The plugin SDK has separate runtimes for account IDs, async locks, browser configs, channel activity, concurrency, deduplication, delivery queues, file access, heartbeats, numbers — each as its own export path. Some of this feels like framework-itis.

**Recommendations:**
- OpenClaw should consider publishing a clear "built on Pi" architectural note — the projects share a common lineage and users of both would benefit from understanding the relationship.
- The forked agent-core should either be extracted as a proper upstream dependency (via npm) or the reconciliation process should be automated.
- The 157 extensions may benefit from consolidation — many single-file provider adapters could be generated from a model catalog rather than maintained as packages.
