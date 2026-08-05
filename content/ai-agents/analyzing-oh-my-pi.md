---
title: "Analyzing oh-my-pi (omp)"
date: 2026-08-05
type: codebase-analysis
status: complete
source: https://github.com/can1357/oh-my-pi
tags: [typescript, rust, ai-agent, coding-agent, bun, pi-fork, reverse-engineering]
---

# Analyzing oh-my-pi (omp)

> **Source:** [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) @ [`1e492d6`](https://github.com/can1357/oh-my-pi/commit/1e492d6ff9b8d4412591942b11fe06e1395ae80f) · v17.2.9 · MIT

## How It Works

oh-my-pi (omp) is a fork of Mario Zechner's [Pi](https://github.com/badlogic/pi-mono) by Can Boluk that turns Pi from a coding-agent CLI into a complete, self-contained agent system. Where upstream Pi is a reusable agent + AI package with a thin CLI consumer, omp forks the entire stack and adds ~80K lines of Rust native code, 31 built-in tools, 60+ provider integrations, a TUI with differential rendering, in-process ripgrep/shell/coreutils, LSP and DAP integration, subagent orchestration, browser automation, collaboration relay, and time-traveling stream rules — all in a single Bun workspace with a Rust-native core.

The key architectural distinction from both Pi and OpenClaw: **omp doesn't shell out to anything.** Grep, find, sort, sed, ls, even jq — all vendored into the process via the `pi-natives` Rust crate and the `brush` shell (a Rust `bash` replacement with 46 built-in coreutils). The same binary that runs your agent is also your grep, your shell, your LSP proxy, and your debugger frontend. This fork-exec elimination is the performance thesis.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    omp TypeScript Layer                            │
│                                                                   │
│  packages/coding-agent  ── Main CLI (omp)                        │
│    ├── agent loop, tools, providers, TUI, memory                 │
│    ├── 31 tool implementations (read, write, edit, bash, ...)    │
│    ├── subagent orchestration (task tool)                        │
│    └── /collab relay, code review, commit automation             │
│                                                                   │
│  packages/agent  ── Agent runtime (forked from Pi)               │
│  packages/ai     ── Multi-provider LLM client (forked from Pi)   │
│  packages/catalog ── Bundled model database (1000+ models)       │
│  packages/tui    ── Differentially-rendered terminal UI          │
│  packages/natives ── NAPI bindings to Rust crates                │
│  packages/omptype ── ArkType-compatible schema validation         │
│  packages/utils  ── Logger, streams, temp files, paths           │
│  packages/wire   ── Internal protocol/transport                   │
│  packages/mnemopi ── Memory backend (Hindsight-compatible)       │
│  packages/stats  ── Local observability dashboard                │
│  packages/snapcompact ── Transcript compaction                   │
└──────────────────────────────────────────────────────────────────┘
         │
         │ NAPI-rs bindings (in-process, no shelling out)
         ▼
┌──────────────────────────────────────────────────────────────────┐
│                 Rust Native Layer (~80K LOC)                      │
│                                                                   │
│  crates/pi-natives  ── Performance text/grep/walk ops            │
│    ├── ripgrep (in-process, not subprocess)                      │
│    ├── glob/explore (in-process walker)                          │
│    └── task::blocking wrapper for async-work                     │
│                                                                   │
│  crates/pi-shell    ── brush: Rust bash replacement              │
│  crates/pi-uu-grep  ── grep built-in                             │
│  crates/pi-uu-diff  ── diff built-in                             │
│  crates/pi-uutils-ctx ── coreutils context (46 builtins)         │
│  crates/pi-ast      ── AST-grep (tree-sitter queries)            │
│  crates/pi-voice    ── TTS voice processing                      │
│  crates/pi-walker   ── Filesystem walker                         │
│  crates/pi-iso      ── Date/time ISO parsing                     │
│  crates/vendor/     ── brush-core, brush-builtins (vendored)     │
└──────────────────────────────────────────────────────────────────┘
```

## The Spine

A typical omp session: `omp` from the terminal.

1. **Launch** — `packages/coding-agent/src/cli.ts` is the entrypoint. It declares itself as worker host, parses flags, loads config, initializes the TUI, and starts the agent loop.

2. **Tool dispatch** — The agent loop calls tools through a unified dispatch. Tools are registered in `packages/coding-agent/src/tools/`. The read/write/edit triad handles all file ops. `bash` runs through the in-process brush shell (vendored `pi-shell` crate), not `/bin/bash`. `grep` runs through in-process `pi-natives`, not `rg`.

3. **Subagent orchestration** — The `task` tool fans out to worker subagents in isolated worktrees. Each worker gets its own tool surface. Results return as schema-validated typed objects — no prose to parse.

4. **Advisor model** — A second model (configurable, typically cheaper) watches every turn inline. Its notes appear as amber "Advisor N note (concern)" cards in the TUI. The main agent reads the note and decides whether to course-correct.

5. **Time-traveling stream rules** — Rules defined in config sit dormant until a regex match triggers them mid-stream. The token generation is aborted, the rule injected as a system reminder, and the model retries from the same point. Injections survive compaction.

6. **Memory** — The agent writes facts mid-run via `retain`, captures lessons via `learn`, pulls them back via `recall`. Backend is configurable: local filesystem, Hindsight, or Mnemopi.

## Key Patterns

- **Everything in-process, no fork/exec.** Ripgrep, shell, grep, diff, coreutils — all vendored Rust linked via NAPI-rs. The same omp binary works on macOS, Linux, and Windows without WSL. This is the defining architectural bet.

- **Content-hash editing (Hashline).** The `edit` tool addresses lines by content hash, not line number. Edits against stale files are rejected before they corrupt anything. Reduces output tokens by 61% on Grok 4 Fast.

- **AST-grep for structural rewrites.** `ast_edit` runs tree-sitter pattern matching from the `pi-ast` crate, previews replacements, stages them, and writes them atomically via `xd://resolve`. The model sees a `(proposed)` card before the change lands.

- **Stream rules with compaction survival.** Most agent constraint systems lose injected rules when the transcript compacts. omp's stream rules survive compaction because they're re-evaluated from the rule store, not from the transcript.

- **Dual kernel eval.** The `eval` tool runs persistent Python and JavaScript kernels. Either kernel can call back into the agent's own tools (`read`, `search`, `task`) over a loopback bridge.

- **Internal URL scheme.** 16 internal schemes (`pr://`, `issue://`, `agent://`, `skill://`, `ssh://`, `conflict://`) resolve transparently inside every FS-shaped tool. `read pr://1428` returns the same shape as `read src/foo.ts`.

## Non-Obvious Details

- **v17.2.9 — version consistency across all packages.** Every `@oh-my-pi/*` package is pinned to exactly 17.2.9 in the workspace catalog. The Cargo.toml workspace also declares version 17.2.9. This is a monorepo with lockstep versioning across TypeScript and Rust.

- **~80K LOC of Rust for the native layer, but the Cargo.toml workspace has only 9 crates.** The crate count is small but each is dense: `pi-natives` alone bundles in-process ripgrep, glob, walker, and async-work utilities. `pi-shell` is the entire brush shell + 46 vendored coreutils.

- **Three patched dependencies in package.json.** `@ark/schema@0.56.2`, `puppeteer-core@25.3.0`, and `@agentclientprotocol/sdk@1.2.1` all have local patches. The puppeteer patch is notable — omp drives a real browser.

- **Bazel build system.** The repo has `.bazelversion`, `BUILD.bazel`, and `MODULE.bazel` files alongside the Bun workspace. This is unusual — Bazel is heavy infrastructure for a CLI tool.

- **The AGENTS.md is a development style guide, not runtime instructions.** Unlike most AI-agent repos that ship AGENTS.md as runtime instructions for the agent loop, omp's AGENTS.md is a 283-line developer convention doc: code style (no `ReturnType<>`, no `private` keyword, `Promise.withResolvers()`), Bun-over-Node preferences, testing guidance, changelog format, and generated file warnings.

- **42 release profiles in Cargo.toml.** `release`, `ci`, `local`, `dev`, and `dev.package.*` each with different LTO, debug, and optimization settings. The release profile uses `lto = "fat"` and `codegen-units = 1` for maximum optimization at the cost of build time.

- **`panic = "unwind"` in release profile** — intentionally not abort. The comment in Cargo.toml explains the Rust unwind boundary through napi-rs async work callbacks. Panics inside vendored code or native tasks are caught at the `task::blocking` wrapper so they surface as rejected JS Promises, not process aborts.

- **opentelemetry instrumentation.** The package.json workspace catalog includes `@opentelemetry/api`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-proto`, and friends — production-grade observability.

## Assessment

**Strengths:**

- **Everything in-process is a genuinely novel thesis.** No other coding agent ships an in-process ripgrep, shell with 46 coreutils, and debugger frontend in the same binary. The performance advantage vs subprocess-spawning agents (Codex CLI, Claude Code) is real and measurable.
- **Tool surface is the deepest in the ecosystem.** 31 built-in tools including real LSP renames, DAP debugging, AST structural rewrites, browser automation, code review, subagent orchestration, and collision-free git commits.
- **Stream rules with compaction survival is an elegant solution** to the problem every agent system faces: injected constraints that vanish on transcript compaction.
- **Single binary, no external dependencies.** No Docker, no Python runtime, no language-specific toolchain needed. Works on macOS, Linux, and Windows natively.
- **OpenTelemetry instrumentation** out of the box — unusually production-ready for an open-source agent CLI.

**Concerns:**

- **Vast surface area to maintain.** 31 tools, 60+ providers, 46 vendored coreutils, browser automation, DAP integration, collaboration relay, and a custom shell — all in one repo. Each integration is a maintenance vector that needs to stay compatible with upstream changes (browser versions, LSP protocol revisions, provider API changes).
- **Bun runtime is a dependency.** Unlike Go or Rust CLI tools that produce a truly static binary, omp depends on the Bun runtime. The `bun install -g @oh-my-pi/pi-coding-agent` path is the recommended install; the standalone binary is also published but Bun is the primary distribution.
- **Bazel + Bun workspace is unusual infrastructure.** Most open-source CLI tools pick one build system; omp mixes Bun workspaces with Bazel, which adds cognitive overhead for contributors.
- **Fork velocity risk.** As a fork of Pi, omp diverges from upstream significantly (Rust native layer, 31 tools vs Pi's minimal surface). Upstream Pi improvements to the agent loop or AI packages may be hard to merge back in.
- **README is 662 lines of marketing.** The README is a product landing page, not a technical document. It's well-written but hard to navigate for someone who wants to understand architecture rather than features.

**Use when:** You want a single binary that replaces your agent CLI, your grep, your shell, your LSP, and your debugger — and you're comfortable with Bun as the runtime. The in-process everything thesis is most valuable on constrained machines (no Docker, limited disk, single binary deployment).

**Don't use when:** You need strict isolation between tools (each exec in a separate process), you're allergic to large monorepos, or you want a minimal agent where you bring your own tools.

## Related

- [[deep-dive-building-on-pi]] — Architecture guide for building on top of Pi. omp is the extreme fork path: instead of consuming Pi's packages, it forked the entire agent + AI layer and added a Rust-native substrate.
- [[analyzing-openclaw-pi]] — The other major Pi fork. OpenClaw took Pi in a gateway/channel direction; omp took it in a native-tools/performance direction. Comparisons between the fork strategies are instructive.
- [[market-ai-coding-agent-index-2026]] — Landscape context for how omp compares to Codex CLI, Claude Code, Cursor, and other coding agents.
