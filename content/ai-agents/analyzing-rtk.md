---
title: "Analyzing RTK"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/rtk-ai/rtk
tags: [rust, cli, token-optimization, llm, devtools, claude-code, agent-hooks]
---

# Analyzing RTK

> **Source:** [rtk-ai/rtk](https://github.com/rtk-ai/rtk) @ [`2fbc751`](https://github.com/rtk-ai/rtk/commit/2fbc7514f6964acabcfac65501b8bb6b525e3aa8)

## How It Works

RTK (Rust Token Killer) is a CLI proxy that sits between AI coding agents and shell commands, compressing command output before it enters the LLM context window. It achieves 60–90% token reduction on common dev operations (git, test runners, package managers, file reads) through four strategies: smart filtering (removing comments, whitespace, boilerplate), grouping (aggregating similar items), truncation (keeping relevant context, cutting redundancy), and deduplication (collapsing repeated log lines).

The system has three layers:

1. **Command filters** (`src/cmds/`): ~50 specialized Rust modules, one per tool ecosystem. Each knows the structure of its target command's output and applies purpose-built compression — `git.rs` parses diff hunks and collapses them to changed-lines-only, `pytest_cmd.rs` strips pass counts and shows only failures, `npm_cmd.rs` suppresses progress bars and tree output.

2. **Auto-rewrite hooks** (`src/hooks/`): Integrations for Claude Code, Gemini CLI, Cursor, Cline, Codex, Windsurf, Kilo Code, and OpenCode. A shell hook intercepts every `Bash` tool call from the agent, delegates to `rtk rewrite` (which uses the command registry in `src/discover/registry.rs` to map raw commands to their RTK equivalents), and rewrites the tool input in-flight. The hook protocol uses exit codes (0 = auto-allow, 1 = passthrough, 2 = deny, 3 = ask) to integrate with each agent's permission model.

3. **Analytics and learning** (`src/analytics/`, `src/learn/`): SQLite-backed tracking records every filtered command with input/output token counts. The `rtk gain` command shows savings history. The `rtk discover` feature scans past Claude Code session logs to find commands that *could* have been filtered, and `rtk learn` detects repeated CLI mistakes (wrong flags, missing args) and generates Claude Code rules files.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              AI Agent (Claude Code, etc.)                │
│    "Run git status to check changes"                     │
└──────────────────────┬──────────────────────────────────┘
                       │ Bash tool call
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Agent Hook (rtk-rewrite.sh / plugin)                   │
│  Reads command → delegates to `rtk rewrite`              │
│  0: auto-allow  │  1: passthrough  │  2: deny           │
└──────────────────────┬──────────────────────────────────┘
                       │ Rewritten: "rtk git status"
                       ▼
┌─────────────────────────────────────────────────────────┐
│  main.rs (Clap CLI)                                     │
│  Routes to Commands enum → specialized filter module     │
└──────────────────────┬──────────────────────────────────┘
                       │
            ┌──────────▼──────────┐
            │  core::runner       │  Execute child process,
            │  (RunMode enum)     │  capture output, filter
            └──────────┬──────────┘
                       │
            ┌──────────▼──────────┐
            │  core::stream       │  StreamFilter trait or
            │                    │  Fn(&str) → String
            └──────────┬──────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
   Filtered      Streamed      Passthrough
   output         output        (raw)
         │             │             │
         └──────┬──────┘             │
                ▼                    │
   core::tracking::TimedExecution    │
   (records to SQLite)               │
                └────────┬───────────┘
                         ▼
               Filtered output to agent
               (with tee recovery hint on failure)
```

**Key modules** (29K lines total):

| Module | Lines (approx) | Purpose |
|--------|--------|---------|
| `src/cmds/` | 15K | Per-tool filter implementations (git, gh, npm, cargo, pytest, etc.) |
| `src/discover/registry.rs` | 3.5K | Command-to-RTK rewrite rule engine (regex-based) |
| `src/hooks/` | 4K | Hook installation and the `rtk rewrite` / `rtk init` commands |
| `src/core/tracking.rs` | 1.7K | SQLite-backed savings analytics |
| `src/core/filter.rs` | 550 | Source code comment/boilerplate stripping |
| `src/core/stream.rs` | 1K | StreamFilter trait for line-by-line output processing |
| `src/learn/` | 750 | CLI mistake detection from session logs |
| `src/analytics/` | ~800 | Savings dashboards, economics, ccusage integration |

## The Spine

### Direct invocation path

1. `main.rs` parses CLI args via Clap's `Commands` enum (the file is 3K lines because every subcommand variant is declared inline)
2. Match arm dispatches to a filter module — e.g., `Commands::Git { command: GitCommands::Status, .. }` → `git::run(GitCommand::Status, ...)`
3. Filter module calls `core::runner::run()` with either a `RunMode::Filtered(closure)`, `RunMode::Streamed(StreamFilter)`, or `RunMode::Passthrough`
4. `runner::run()` spawns the real child process, captures its stdout/stderr, applies the filter, prints the compressed output, and records metrics via `tracking::TimedExecution`

### Hook auto-rewrite path

1. Agent emits a `Bash` tool call → shell hook (`rtk-rewrite.sh`) intercepts
2. Hook reads `tool_input.command` via `jq`, calls `rtk rewrite "git status"`
3. `rewrite_cmd::run()` checks deny/ask rules (from `hooks/trust.rs`), then calls `registry::rewrite_command()` which matches against a `RegexSet` of ~200 patterns
4. Returns exit code + rewritten command → hook constructs JSON with `permissionDecision` and `updatedInput`

### Filter pipeline (example: `rtk git diff`)

1. Runs `git diff --stat` first for a file-level summary
2. Runs `git diff` (full), feeds through `compact_diff()`
3. `compact_diff()` parses unified diff format: tracks per-file `+N -M` counts, shows first 100 lines of each hunk, truncates the rest with "... (N lines truncated)"
4. On truncation, appends `[full diff: rtk git diff --no-compact]` so the agent knows how to recover

## Key Patterns

**Per-ecosystem specialization over generic compression.** RTK doesn't try to generically compress text. Each tool gets a purpose-built filter that understands its output format. `git diff` gets a unified-diff parser. `pytest` gets a test-result parser that extracts failures by test name and traceback. `npm install` gets a progress-bar stripper. This is why the savings rates are so high — the filter can throw away entire categories of output that are structurally predictable.

**Fallback-first error handling.** The universal pattern is: run the real command, capture its output, then filter. If filtering fails for any reason, the raw output is printed unchanged. Exit codes are always propagated via `std::process::exit(code)`. The `core::runner::run()` function has `skip_filter_on_failure` — if the child process exits non-zero, some filters skip filtering entirely and show raw stderr for debugging.

**Tee recovery on failure.** When a filtered command fails and the output was non-trivial (>500 bytes), `core::tee::tee_and_hint()` saves the raw output to `~/.local/share/rtk/tee/<command>.log` and appends a hint like `[full output: ~/.local/share/rtk/tee/git-diff.log]` to the filtered output. This is a well-designed safety net — the agent can recover the full output when RTK's compression was too aggressive.

**RegexSet for fast command classification.** The command registry (`discover/registry.rs`) compiles ~200 rewrite patterns into a `lazy_static RegexSet` at startup. Classification is a single `RegexSet::matches()` call — O(n) where n is the number of patterns, with no branching until a match is found. This keeps `rtk rewrite` under 10ms.

**Three-tier filtering for custom commands.** Beyond the built-in Rust filters, RTK supports user-defined TOML filters in `.rtk/filters.toml` (project-local) and `~/.config/rtk/filters.toml` (global). These define `match_command` regex patterns with `strip_ansi`, `strip_lines_matching`, `max_lines`, and `on_empty` directives — no Rust required.

**No async, no threads.** The project is explicitly single-threaded by design. The `stream.rs` module uses `std::process::Command` with piped stdout/stderr, reading via `BufReader` on the main thread. This eliminates concurrency bugs and keeps startup under 10ms.

## Non-Obvious Details

**The hook only intercepts Bash tool calls.** Claude Code's built-in tools (`Read`, `Grep`, `Glob`) bypass hooks entirely. RTK's documentation acknowledges this and provides direct `rtk read`, `rtk grep`, and `rtk find` commands, but agents don't always use them. This is a fundamental limitation — a significant fraction of an agent's tool usage may never be filtered.

**`init.rs` is 4K lines because it embeds full instruction text.** The `rtk init` command writes agent-specific configuration files (CLAUDE.md, AGENTS.md, settings.json hooks). The legacy `--claude-md` mode embeds a ~3K-line RTK instruction block directly into the project's CLAUDE.md. Most of the file size is string literals, not logic.

**Token counting is a heuristic, not exact.** RTK estimates tokens as `chars / 4` (a rough approximation for English text). The `tracking.rs` module records these estimates, and `rtk gain` reports based on them. Real LLM tokenizers vary significantly — for code-heavy output, `chars / 4` likely overestimates savings since code tokenizes more efficiently.

**The `learn` module reads Claude Code session logs.** It scans `~/.claude/projects/` JSONL files, extracts `Bash` tool calls with error output, and pattern-matches against known error signatures (unknown flag, command not found, permission denied, etc.). It then finds corrections — subsequent successful invocations of the same base command — and generates Claude Code rules files. The confidence scoring is heuristic-based and may produce false positives for commands that fail for reasons other than syntax errors.

**The name collision with Rust Type Kit is a real deployment problem.** `rtk` is already taken on crates.io by a different project. The install docs warn about this prominently. Users who `cargo install rtk` get the wrong binary. The project uses `rtk gain` as a post-install verification step.

**Telemetry is opt-in with GDPR consent tracking.** The `telemetry.rs` module requires explicit `consent_given: true` in `config.toml` before sending any data. The URL and auth token are compile-time options (`option_env!`), so the open-source builds have no telemetry endpoint compiled in. The 23-hour ping interval uses a local marker file.

**`git diff` re-inserts `--` separator.** Clap's `trailing_var_arg = true` silently consumes `--` when it's the first positional argument. The `normalize_diff_args()` function re-inserts it by checking if remaining arguments look like paths (start with `.` or `~`, contain `/`, or exist on disk). This fixes a real bug (#1215) where `rtk git diff -- src/main.rs` would fail with "ambiguous argument."

## Assessment

**Strengths:**
- The per-ecosystem filter approach is genuinely effective — purpose-built parsers beat generic compression every time, and the 60–90% savings claims are credible given the output types being filtered
- Fallback-first architecture is well-designed: if anything goes wrong, the raw command runs normally. No silent failures
- Tee recovery is a thoughtful UX detail that prevents the worst-case scenario of the agent losing important error context
- The `discover` and `learn` features add real value beyond basic filtering — scanning session history to find optimization opportunities and generating rules from repeated mistakes is clever
- Single-threaded, zero-dependency-on-async design keeps the binary fast and simple
- Hook integration covers 8+ agents, and the rewrite protocol (exit codes + JSON output) is clean and extensible

**Concerns:**
- 42K stars for v0.39 is extraordinary for a CLI tool — the project is 7 months old. The growth is driven by the "save money on Claude Code" value proposition, which is real but also somewhat fragile as agents build in their own output optimization
- The `main.rs` file is 3,008 lines with every CLI variant declared inline. Clap's derive macros generate a lot of boilerplate, but the file is still hard to navigate. The `automod` crate is used for sub-modules but not for splitting the Commands enum
- Token counting via `chars / 4` is crude. For code (which is most of what RTK filters), real tokenizers like tiktoken produce significantly different counts. The savings percentages reported by `rtk gain` are systematically inaccurate
- No test coverage for the actual filter quality — there are unit tests for individual parsers and snapshot tests, but no integration tests that verify "the filtered output contains all information the agent needs." A filtered `git diff` that drops a file change would be invisible to the test suite
- The `learn` module's correction detection is heuristic and could generate incorrect rules — a command that fails, then succeeds on retry for reasons unrelated to syntax, would still be captured as a "correction"

**Recommendations:**
- Worth using if you're a heavy Claude Code or similar agent user — the savings on common dev commands are real and the fallback guarantees no data loss
- The TOML filter system is underutilized — most users stick with built-in filters, but custom `.rtk/filters.toml` files for project-specific noisy tools could add significant value
- Don't trust `rtk gain` percentages as exact — they're useful for relative comparison but not for calculating actual API costs saved
- The `rtk discover` command is worth running on existing projects to see what you're missing

## Related

- [[analyzing-caveman]] — Another token optimization approach (prompt-based output compression via system prompt injection), takes the complementary angle of compressing agent *responses* rather than command *inputs*
