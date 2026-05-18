---
title: "Analyzing SmallCode"
date: 2026-05-18
type: codebase-analysis
status: complete
source: https://github.com/Doorman11991/smallcode
tags: [ai-agents, javascript, typescript, coding-agent, llm, harness, small-models, marrowscipt, bonescript, mcp]
---

# Analyzing SmallCode

> **Source:** [Doorman11991/smallcode](https://github.com/Doorman11991/smallcode) @ [`b69a513`](https://github.com/Doorman11991/smallcode/commit/b69a513b15eeeec98db27678ed77c786c4a4dcf9)

## Overview

SmallCode is a terminal-native AI coding agent built from the ground up for small LLMs (≤20B parameters, with key benchmarks run on a ~4B-active model). While mainstream coding agents like OpenCode and Claude Code assume frontier models with 128k+ context and perfect tool calling, SmallCode treats those assumptions as bugs and designs around them — introducing context budget management, forgiving tool-call parsing, 2-stage tool routing, Bayesian tool scoring, and a hard-fail governor that refuses to deliver broken code.

The project is written in JavaScript (Node.js 18+) with a split architecture: a **runtime bootstrap** in plain Node.js (`bin/` directory) and a **reference implementation** in MarrowScript (`.ms` files) — a custom DSL that appears to be the project's own language for self-hosting. It ships as an npm package (`smallcode`) with two companion projects — [BoneScript](https://github.com/Doorman11991/BoneScript) for backend generation and [budget-aware-mcp](https://github.com/Doorman11991/budget-aware-mcp) for token-limited code intelligence.

The headline claim is **87% single-file task success with a 4B-active parameter model** — outperforming OpenCode and Pi Agent running on models 3-4x larger, purely through harness engineering.

## Key Findings

### How It Works

SmallCode is a **harness-first coding agent** — the scaffolding around the model matters more than the model itself. The core loop in `bin/smallcode.js` (~2,252 lines) and `src/core/session.ms` handles:

1. **User input arrives** → complexity-estimated by multi-model router (`src/model/router.js`)
2. **TODO planner decomposes** multi-step tasks into atomic steps (`src/planner/planner.ms`)
3. **Agent loop runs** → model generates, tool calls are parsed and executed, results fed back
4. **Governor verifies** each write — lint/compile check determines accept, retry, or hard fail
5. **Context budget tracks** token usage, evicts tool results first when tight

Every subsystem is optimized for models with 8-16k effective context and unreliable JSON output.

### Architecture

The project has two parallel implementations — the runtime bootstrap in Node.js and the reference implementation in MarrowScript:

```
bin/                          # Node.js runtime bootstrap
├── smallcode.js              # Entry point + TUI + agent loop
├── governor.js               # Tool scoring + verifier
├── escalation.js             # Cloud model fallback
├── commands.js               # TUI slash commands
├── tui.js                    # Classic TUI renderer
└── bonescript_guide.js       # BoneScript syntax reference

src/                          # MarrowScript ref implementation
├── core/                     # Config, sessions, event bus, MCP server
├── context/                  # Budget engine, compactor, file cache, working memory
├── tools/                    # Registry, router, executor, validator, 15 built-in tools
├── model/                    # Adapter, profiles, streaming, templates, multi-model router
├── governor/                 # Tool scorer (Bayesian), verifier, hard fail, escalation
├── tui/                      # Fullscreen alternate-buffer UI (app, input, output, diff)
├── plugins/                  # Plugin loader, skill system
├── intel/                    # Code graph indexer, search, summarizer
├── planner/                  # TODO decomposition, validation
├── hooks/                    # Pre/post tool hooks
├── git/                      # Auto-commit, snapshots, LSP validation
└── session/                  # Persistence, undo, tokens, git context
```

**The MarrowScript (.ms) files are the project's distinctive architectural choice** — SmallCode is being built in its own DSL, and the Node.js `bin/` files exist as the runtime until the MarrowScript compiler (via BoneScript) can produce a standalone binary.

### The Spine — A User Request Through the System

Tracing a typical "fix the bug in main.ts" request:

1. **Entry** → `bin/smallcode.js` parses args, checks model availability (Ollama/LM Studio), starts code graph MCP
2. **TUI** → Fullscreen alternate-buffer UI captures input, creates `Session` via `src/core/session.ms`
3. **Planning** → Planner heuristic-checks if decomposition needed (keywords: "fix", "refactor", length >200 chars)
4. **Agent Loop** → `Session.agentLoop()` builds messages with system prompt + working memory + conversation history
5. **Tool Routing** → 2-stage: model picks a category (read/search/run), then gets that category's tools only
6. **Tool Execution** → `ToolExecutor` parses arguments via `repairJson()`, executes, caps output via budget
7. **Governor** → `HardFailPolicy.checkOutput()` verifies the edit compiles — on failure, retries up to 2× with escalating model
8. **Context Management** → If <500 tokens remaining, `Compactor` compresses conversation history

### Key Patterns

**Context Budget Engine (`src/context/budget.ms`)**

The single most important architectural decision. SmallCode tracks token usage across four buckets: system prompt, working memory, conversation, and tool results. It uses simple character-count estimation (4 chars ≈ 1 token) — not a tokenizer — because small models don't need sub-token precision. Eviction is priority-ordered: tool results first, then oldest conversation. This prevents the context overflow that silently breaks small models.

**2-Stage Tool Routing (`src/tools/router.ms`)**

Solves a problem unique to small models: sending all 15+ tool schemas can consume 30-50% of an 8k context window. Instead, the model first picks a category from six options (read/write/search/run/plan/web) — only ~200 tokens of category descriptions — then receives only that category's schemas. Three modes: `direct` (models with 16k+ context and native tool calling), `two_stage` (limited context but tool support), `text` (no native tool calling — embeds everything in system prompt).

**Bayesian Tool Scorer (`src/governor/tool_scorer.ms`)**

ARK-inspired: tracks success/failure per tool per task type with Laplace-smoothed confidence scoring. Unknown tools get an exploration bonus (+0.15). Tools with <35% confidence after 3+ calls are `shouldAvoid()`. Scores persist across sessions via `.smallcode/tool_scores.json`. This is adaptive learning: if `write_file` keeps failing on TypeScript tasks (because the model truncates output), it gets demoted in favor of `patch`.

**Hard Fail Protection (`src/governor/hard_fail.ms`)**

After max retries (2), if verification still fails, SmallCode *refuses to claim success*. It emits a `HardFail` with the compilation errors. This is a correctness guarantee that most coding agents don't make — OpenCode and Claude Code will happily say "done" with broken code. The system even supports escalating to a stronger cloud model for the retry.

**Forgiving Tool Call Parser**

The `parseFromText()` method in `ToolRouter` tries five formats in order: JSON, Hermes `<tool_call>`, `TOOL_CALL` text format, XML `<use_tool>`, and plain text. The `repairJson()` function in the validator auto-fixes common mistakes: unquoted keys, trailing commas, mismatched quotes, missing braces. This is critical because small models produce messy output on 30-50% of tool calls.

**TODO-Driven Planning (`src/planner/planner.ms`)**

Complex tasks get decomposed into atomic steps by a separate model call. The TODO file is written to `.smallcode/todo.json` and the model reads it each turn to know where it is. Each step is validated before progression. The planner has heuristics for detecting multi-step tasks (keywords like "implement", "refactor", "create", "build") and handles failures with retry logic (max retries, then skip).

**Multi-Model Router (`src/model/router.js`)**

When multiple models are configured, task complexity determines which tier handles the request: `fast` (simple: typos, explains, small edits), `default` (most tasks), `strong` (complex: refactors, multi-file changes, full-stack). Escalation to cloud models (Claude, GPT, DeepSeek) happens only on hard-fail — not as the primary path.

### Non-Obvious Details

**MarrowScript as a self-hosting strategy.** The `.ms` files aren't plain documentation or a vaporware roadmap — they're a genuine reference implementation in SmallCode's own DSL. The project is effectively being built in itself. The Node.js `bin/` bootstrap exists because the MarrowScript compiler (BoneScript) isn't yet capable of producing a standalone binary from the .ms codebase. When it is, SmallCode will become a self-hosting agent — written in the language it uses to generate code.

**Code graph startup is non-blocking.** The `initCodeGraph()` function (line 173 in smallcode.js) starts `budget-aware-mcp` as a child process and attempts indexing. But if initialization fails — no MCP binary found, timeout, or error — the agent continues running with code graph disabled. It degrades gracefully to grep-based search. This is deliberate: small-model users may not have `budget-aware-mcp` installed, and the agent should still work.

**Exploration bonus prevents lock-in.** The ToolScorer gives unknown tools a base score of 0.65 (0.5 + 0.15 exploration). This means a new tool gets several chances before the Bayesian confidence converges. Without this, the first tool the model tried would dominate forever.

**Model profiles are toml files, not code.** `profiles/qwen2.5-coder-14b.toml`, `profiles/qwen3-8b.toml`, `profiles/devstral-small.toml` — you can add a new model by writing a TOML file with context length, tool format, chat template, stop sequences, and declared strengths/weaknesses. The system adapts its prompting strategy based on the profile.

**Early-stop detection caps runaway output.** The `model.early_stop` event fires when the model starts repeating or producing gibberish. This is detected by measuring output entropy — small models under 7B frequently spin after 500+ tokens of generation. The event bus signals the TUI to abort generation and return what was produced so far, rather than wasting tokens on the full context window.

### Assessment

**Strengths**

- **Coherent design philosophy.** Every feature directly addresses a specific limitation of small models. There's no feature creep or "because everyone else does it."
- **Honest failure.** Hard fail protection is genuinely novel among coding agents. Most tools will tell you "done" with broken code. SmallCode refuses.
- **Measurable claims.** The 87% benchmark on a 4B-active model is specific, replicable, and honest about the model used. The COMPARISON.md explicitly calls out where OpenCode/Pi win instead of dismissing them.
- **Modular, well-structured code.** Despite the dual-implementation complexity, the architecture is clean. The event bus pattern keeps subsystems decoupled. Profiles are external TOML files, not hardcoded enums.
- **Innovation density.** Bayesian tool scoring, 2-stage routing, hard fail, MarrowScript self-hosting — multiple genuinely novel ideas in one project.

**Concerns**

- **Dual codebase maintenance.** The Node.js `bin/` and MarrowScript `src/` coexist but aren't equivalent. `bin/smallcode.js` is ~2,252 lines of monolithic bootstrap while `src/core/main.ms` is a clean MarrowScript implementation. If MarrowScript compiler development stalls, the .ms files become architecture documentation rather than runnable code.
- **Small ecosystem.** New project, small community. OpenCode has 151k+ stars and battle-tested contributor base. SmallCode's plugin/skill systems are documented but unproven at scale.
- **Benchmark transparency.** The 87% claim is on a *specific* model (Gemma 4 E4B abliterated) with *specific* tasks. The comparison estimates for OpenCode/Pi are explicitly described as estimates. The multi-file results (46%) are more realistic — but the BoneScript boost to 60%+ is contingent on your project fitting BoneScript's model.
- **Single-session only.** No multi-session, no parallel agents, no desktop app. This is fine for local-first use but limits advanced workflows.
- **No LSP integration.** OpenCode auto-loads language servers per file type. SmallCode relies on the `bash` tool for compilation checks, which is heavier and less precise.

**Recommendations**

SmallCode is most valuable for:
- **Local-first developers** who run models on consumer hardware (7B-20B) and want privacy
- **Resource-constrained environments** (laptops without GPUs, CPU-only inference)
- **Developers exploring small-model workflows** who want to understand how far harness engineering can go

It is less suitable for:
- **Team/enterprise use** (no multi-session, no desktop, small community)
- **Developers who already have Claude Code or OpenCode** and are happy with cloud costs
- **Projects that don't fit BoneScript** for the fullstack generation advantage

The project is worth watching — if BoneScript matures to self-host the entire SmallCode codebase, it becomes a genuinely unique self-hosting agent. Until then, it's an impressively engineered harness that extracts remarkable performance from hardware most agents treat as beneath notice.

## Related

- [[market-ai-coding-agent-index-2026]] — Artificial Analysis coding agent benchmark methodology
- [[analyzing-oh-my-opencode]] — OpenCode, a primary competitor
- [[analyzing-picoclaw]] — PicoClaw, another lightweight agent
- [[analyzing-jcode]] — JCode, Rust-based multi-agent harness
