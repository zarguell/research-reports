---
title: "Analyzing OpenHuman"
date: 2026-05-20
type: codebase-analysis
status: complete
source: https://github.com/tinyhumansai/openhuman
tags: [rust, typescript, react, tauri, ai-agent, desktop, memory-tree, tokenjuice, mcp, local-first]
---

# Analyzing OpenHuman

> **Source:** [tinyhumansai/openhuman](https://github.com/tinyhumansai/openhuman) @ [`094d482`](https://github.com/tinyhumansai/openhuman/commit/094d482210bdf6ce7b6ef8ffc48ca1a1d2dad843)

## How It Works

OpenHuman is an open-source desktop AI assistant built for communities — it runs a Rust core in-process with the Tauri v2 desktop shell, combines a dense feature surface (118+ one-click OAuth integrations, memory trees, a real-time WebSocket infrastructure, an MCP tool protocol, a managed Node.js runtime for skill tool helpers, and a token-compression engine called TokenJuice) with a strong local-first stance where all user data lives in SQLite on-device.

The mental model is a **persistent AI agent that owns its own lifecycle**. The Rust core runs as an Axum HTTP/JSON-RPC server embedded as a tokio task inside the Tauri desktop host — there is no sidecar. A per-launch bearer token (`OPENHUMAN_CORE_TOKEN`) authenticates every RPC request from the React frontend. On a 20-minute loop, the core's auto-fetch system polls every connected integration (Gmail, Notion, GitHub, Slack, etc.) and folds incoming data into memory trees — hierarchically summarized Markdown chunks stored in SQLite and mirrored as `.md` files in an Obsidian-compatible vault. This means the agent accumulates context continuously rather than starting cold each session.

What makes it architecturally distinctive is the **dual-runtime design**: a Rust core that owns all business logic, RPC dispatch, persistence, and long-running connections (WebSocket, cron, voice), paired with a managed Node.js runtime for skill tool helpers. The QuickJS embedded runtime has been removed entirely — skill execution now flows through a shared runtime bridge that delegates to Node.js for tool execution, while the Rust core remains authoritative for the tool registry, MCP protocol, and all I/O.

## Architecture

```
                         ┌───────────────────────────────────┐
                         │       React Frontend (Vite)        │
                         │  Redux Toolkit | Socket.io Client  │
                         │  MCP Transport | BootCheckGate     │
                         └───────────────┬───────────────────┘
                                         │ Tauri IPC
                         ┌───────────────▼───────────────────┐
                         │     Tauri Shell (CEF Desktop)      │
                         │  core_rpc_relay | core_rpc_token   │
                         │  window_state | dictation_hotkeys  │
                         │  process_kill | process_recovery   │
                         └───────────────┬───────────────────┘
                                         │ HTTP (127.0.0.1:<port>/rpc)
                                         │ Bearer Auth
                         ┌───────────────▼───────────────────┐
                         │     Rust Core Engine (in-process)  │
                         │                                    │
                         │  ┌────────────┐ ┌──────────────┐  │
                         │  │ Axum HTTP  │ │ Socket.io    │  │
                         │  │ JSON-RPC   │ │ (tokio-      │  │
                         │  │ Server     │ │ tungstenite) │  │
                         │  └───────┬────┘ └──────┬───────┘  │
                         │          │               │         │
                         │  ┌───────▼───────────────▼───────┐ │
                         │  │    all.rs Controller Registry  │ │
                         │  │    ~60 domain modules routed   │ │
                         │  └───────┬───────────────────────┘ │
                         │          │                         │
                         │  ┌───────▼───────────────────────┐ │
                         │  │ Domain Modules                │ │
                         │  │ agent | memory | inference    │ │
                         │  │ channels | cron | credentials │ │
                         │  │ tools | skills | tokenjuice  │ │
                         │  │ voice | meet | encryption    │ │
                         │  │ vault | integrations | ...   │ │
                         │  └───────┬───────────────────────┘ │
                         │          │                         │
                         │  ┌───────▼───────────────────────┐ │
                         │  │ Node.js Runtime Bridge         │ │
                         │  │ (managed/bundled Node v22)    │ │
                         │  │ for skill tool helpers        │ │
                         │  └───────────────────────────────┘ │
                         │                                    │
                         │  SQLite (rusqlite) | OS Keychain   │
                         │  AES-256-GCM + Argon2id           │
                         └───────────────────────────────────┘
```

## The Spine

### Entry Points

There are two distinct entry paths:

1. **Desktop app** (`app/src-tauri/src/main.rs`): The Tauri main function checks `args[1]` — if it's `"core"`, it delegates to the Rust core CLI; otherwise it launches the Tauri desktop shell, which spawns the core as an in-process tokio task via `CoreProcessHandle`.

2. **CLI-only** (`src/main.rs`): The standalone `openhuman-core` binary loads `.env`, initializes Sentry, and delegates to `core::cli::run_from_cli_args`, which dispatches to subcommands: `run`/`serve` (start the HTTP server), `call` (one-shot RPC), namespace commands (e.g. `openhuman memory search`), and the MCP server.

### Request Lifecycle

A typical user action (e.g., "summarize my unread emails") flows through:

1. **React UI** dispatches a Redux action → Socket.io `mcp:*` event or HTTP JSON-RPC POST to `http://127.0.0.1:<port>/rpc` with `Authorization: Bearer <token>`
2. **axum rpc_handler** (`src/core/jsonrpc.rs`) receives the JSON-RPC 2.0 request, extracts method + params, calls `invoke_method`
3. **Controller registry** (`src/core/all.rs`) routes the method string to the appropriate domain handler (e.g., `openhuman.memory_search`)
4. **Domain handler** (e.g. `src/openhuman/memory/ops.rs`) performs the action — queries SQLite, calls OpenAI embeddings, folds into memory trees
5. **Result** flows back through the RPC envelope as a JSON-RPC 2.0 response, possibly wrapped in `RpcOutcome` with log metadata

For real-time features like the mascot, Google Meet agent, or chat channels, **Socket.io** (Rust-native via `tokio-tungstenite` + custom Engine.IO/Socket.IO framing) provides a persistent connection that survives app backgrounding and operates independently of the WebView.

### Core Models

The central domain abstractions are spread across ~60 modules in `src/openhuman/`:

| Module | Role |
|---|---|
| `memory` | Ingestion pipeline, chunker, vector+FTS5 hybrid search, tree summarization, Obsidian vault sync |
| `inference` | LLM provider abstraction with model routing (reasoning/fast/vision), cost tracking, retry with backoff |
| `agent` | Agent loop, task board, multimodal handling, profiles, cost accounting |
| `channels` | Messaging platform integrations (Discord, Telegram, Slack, WhatsApp, Matrix, etc.) |
| `cron` | 5-second tick loop scheduler for background tasks |
| `tokenjuice` | Terminal output compaction engine (Rust port) — reduces tool output tokens by up to 80% |
| `encryption` | AES-256-GCM + Argon2id for at-rest memory encryption |
| `tools` | Native tool implementations (filesystem, git, web, screen, voice, etc.) |
| `mcp_client` / `mcp_server` | MCP (Model Context Protocol) client and server surfaces |
| `socket` | Rust-native Socket.io client with reconnect and shared event routing |
| `integrations` | 118+ third-party OAuth connector definitions and auto-fetch pipelines |

## Key Patterns

### Controller-Registry Dispatch

All RPC methods are registered in `src/core/all.rs` through a declarative macro system. Each domain module exposes a pair of functions (`all_controller_schemas` + `all_registered_controllers`) that list their method schemas and handler functions. The legacy `rpc::dispatch::try_dispatch` shim always returns `None` — the registry is authoritative. This gives the system a single discoverable surface of every RPC method with typed inputs, which the CLI uses for autocomplete and validation.

### In-Process Core with Stale-Listener Guard

The core runs as a tokio task **inside** the Tauri host process — there is no sidecar. This means no orphaned processes on Cmd+Q, no port conflicts across hot-reloads, and the core's lifetime is naturally tied to the window. `CoreProcessHandle::ensure_running` includes a stale-listener probe: if something is already listening on the configured port, it probes `GET /` to check if it's an OpenHuman core. If so, it kills it (graceful signal → force-kill with PID revalidation) before spawning a fresh server.

### Structured RPC Errors

Domain handlers emit errors via `StructuredRpcError`, a JSON envelope with `message`, optional `data`, and `expected_user_state` flag. The transport boundary in `rpc_handler` decodes this envelope to determine Sentry reporting policy — `expected_user_state` errors (session expiry, stale thread refs) are logged but never sent to Sentry, keeping the error dashboard clean.

### TokenJuice Compaction

Every tool call output, scrape result, email body, and search payload passes through TokenJuice before entering the LLM context window. The engine has a three-layer rule overlay (builtin → user config → project config), compressing HTML to Markdown, shortening URLs, deduplicating verbose tool output, and reducing tokens by up to 80% while preserving CJK and emoji graphemes.

### Memory Tree + Obsidian Wiki

The memory system ingests user data from every connected integration, chunks it into ≤3k-token Markdown fragments with 64-token overlap, scores them, and folds them into hierarchical summary trees stored in SQLite. The same chunks land as `.md` files in an Obsidian vault on the filesystem. Search is hybrid: 70% vector similarity (OpenAI `text-embedding-3-small`) + 30% SQLite FTS5 full-text. A Neo4j knowledge graph tracks entity relationships.

## Non-Obvious Details

- **Sentry defense-in-depth**: The `before_send` filter in `main.rs` drops 5 categories of noise (transient provider failures, budget events, max-iteration caps, stale session expirations, backend API transients) — each backed by a dedicated `is_*` classifier. This keeps Sentry actionable despite thousands of daily events from the provider and channel subsystems.

- **CEF re-exec and Windows subsystem chicanery**: On the CEF runtime, the main binary is re-exec'd as renderer/GPU/utility subprocesses. A `#[tauri::cef_entry_point]` macro short-circuits `main()` when CEF passes `--type=<role>`. On Windows, the binary uses `windows_subsystem = "windows"` to suppress console windows for CEF helpers, then `AttachConsole(ATTACH_PARENT_PROCESS)` to re-attach when invoked as `openhuman core ...` from a shell.

- **macOS overlay window via runtime class reclassification**: The overlay window that floats above fullscreen apps uses `object_setClass` to reclass an `NSWindow` into an `NSPanel` at runtime, then applies `NonactivatingPanel` + `CanJoinAllSpaces` + `Transient` collection behavior. This works where 5 previous approaches (CGShieldingWindowLevel, private CGS APIs, etc.) failed.

- **Proactive stale-pid guard with revalidation**: When killing a stale core process, the code re-reads `/proc/<pid>/cmdline` (or equivalent) *after* the kill signal to confirm the PID still belongs to an OpenHuman process — guarding against PID reuse races where the original process exits and a new one grabs the same PID before the force-kill completes.

- **`html2md` removal**: A profiling session on real Gmail inboxes revealed `html2md::walk` allocating ~894 MB peak heap on a 10 KB HTML input (Otter.ai-style deeply-nested table layout). Replaced with a linear-time tag-and-entity stripper (`fast_html_to_text`). The rationale is documented as a comment in `Cargo.toml` — a rare example of production profiling data embedded in dependency declarations.

- **Battery-aware scheduler**: The `scheduler_gate` module uses `starship-battery` to probe battery level on laptops and throttle background LLM work when running on battery — a thoughtful operational detail for a desktop app that runs continuously.

## Assessment

**Strengths:**
- **Architectural clarity**: The in-process core + controller-registry dispatch + typed RPC schema system is clean and forces good module boundaries. ~60 domain modules with consistent structure.
- **Local-first by design**: All data in SQLite, encrypted at rest, OS keychain for credentials. The Obsidian vault mirror is a clever power-user feature.
- **Extremely well-instrumented**: Sentry with multi-layer noise filtering, structured error types, dedicated `sentry-test` CLI command, and observability at every boundary.
- **Cross-platform desktop done right**: Rust + Tauri v2 with CEF gives native performance and binary size advantages over Electron, with real attention to platform details (CEF re-exec, macOS overlay, Windows console attach).
- **TokenJuice is a genuinely useful innovation**: Compressing tool output before it reaches the LLM is the kind of pragmatic optimization most agent frameworks overlook.

**Concerns:**
- **Surface area risk**: 118+ integrations, ~60 domain modules, managed Node.js runtime, MCP server, real-time sockets, voice, vision — this is an enormous attack surface for a desktop app. Even with sandbox features (`sandbox-landlock`, `sandbox-bubblewrap`), the complexity is daunting.
- **Battery-aware scheduler is fragile**: The `starship-battery` crate is a maintained fork of an abandoned crate. On unsupported hardware it silently fails to throttle.
- **CEF dependency chain**: Vendored CEF sources through `git submodule update --init --recursive` plus `pnpm install` is a heavy prerequisite for contributors (CMake, Ninja, ripgrep, platform build tools).
- **Frontend ships multiple outdated stubs**: Several Tauri commands (check_core_update, apply_core_update) are no-op stubs kept for frontend compatibility — technical debt that makes the API surface misleading.

**Recommendations:**
- The crypto-community heritage (`wallet`, `ethers-core` deps, `billing`) feels increasingly vestigial given the current positioning. Consider deprecating the wallet/billing modules unless they're actively used.
- The `e2e-test-support` feature flag that exposes a destructive `test_reset` RPC is good hygiene — but a defensive check at the transport layer (e.g., block it unless running on `127.0.0.1`) would add defense-in-depth.
- The frontend stubs should be tracked with a tech-debt issue rather than accumulated as dead code.

## Related

- [[analyzing-hermes-agent]] — another open-source agent framework with a learning loop and multi-surface architecture
- [[analyzing-picoclaw]] — a Claude Code-based agent that similarly runs as a persistent desktop assistant
- [[market-ai-coding-agent-index-2026]] — landscape context for open-source AI agent projects
