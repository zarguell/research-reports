---
title: "Analyzing Caveman"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/JuliusBrussee/caveman
tags: [python, javascript, llm, token-optimization, cli, devtools]
---

# Analyzing Caveman

> **Source:** [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) @ [`ef6050c`](https://github.com/JuliusBrussee/caveman/commit/ef6050c5e1848b6880ff47c32ade1a608a64f85e)

## How It Works

Caveman is a token-compression skill for AI coding agents. It works on a simple but effective principle: inject a system prompt that instructs the LLM to strip filler words, articles, pleasantries, and hedging from its output while preserving all technical content exactly. The result is ~65% output token reduction (benchmarked) with no loss in technical accuracy.

The system has two distinct halves:

1. **Output compression** (the core idea): A carefully crafted SKILL.md file is injected as system context into the agent. It defines rules for dropping articles, filler phrases, and pleasantries, with intensity levels ranging from "lite" (just cut hedging) to "ultra" (abbreviate everything possible). The agent follows these rules for every response.

2. **Input compression** (`caveman-compress`): A Python CLI that rewrites project memory files (CLAUDE.md, etc.) into caveman-speak using the Anthropic API. This saves ~46% of input tokens on every subsequent session start since those files are loaded into context.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    User triggers /caveman                │
└─────────────────────┬───────────────────────────────────┘
                      │
          ┌───────────▼───────────┐
          │  caveman-mode-tracker  │  ← UserPromptSubmit hook
          │  Parses command,      │
          │  writes flag file     │
          └───────┬───────┬───────┘
                  │       │
     ┌────────────▼─┐  ┌──▼──────────────────┐
     │ .caveman-    │  │ Per-turn reinforcement│
     │ active flag  │  │ injected into context │
     └──────────────┘  └──────────────────────┘

Session Start:
     ┌──────────────────────┐
     │  caveman-activate     │  ← SessionStart hook
     │  Reads SKILL.md,      │
     │  emits full ruleset   │
     └──────────────────────┘

CLI:
     ┌──────────────────────┐
     │  caveman-compress     │  ← Python CLI
     │  File → Anthropic API │
     │  → validate → fix     │
     └──────────────────────┘
```

The project is split across multiple directories that are duplicated for different agent ecosystems — `skills/`, `caveman/`, `caveman-compress/`, `plugins/`, and per-agent rule files (`.clinerules`, `.cursor/rules`, `.windsurf/rules`, `.codex/`). All contain the same SKILL.md content adapted for each agent's conventions.

## The Spine

### Output compression path

1. **SessionStart hook** (`hooks/caveman-activate.js`): On every Claude Code session start, reads `skills/caveman/SKILL.md`, filters it to the active intensity level, and emits it as hidden context. Writes a flag file at `~/.claude/.caveman-active`.

2. **UserPromptSubmit hook** (`hooks/caveman-mode-tracker.js`): On every user message, reads the flag file. If caveman is active, injects a one-line reinforcement reminder into the model's context via `hookSpecificOutput.additionalContext`. Also handles `/caveman`, `/caveman-stats`, and natural-language activation/deactivation.

3. **Config resolution** (`hooks/caveman-config.js`): Three-tier priority — `CAVEMAN_DEFAULT_MODE` env var → `~/.config/caveman/config.json` → hardcoded default of `full`. All flag file operations go through symlink-safe `safeWriteFlag`/`readFlag` using `O_NOFOLLOW`, atomic temp+rename, uid verification, and size caps.

### Input compression path (caveman-compress)

1. `cli.py` → detects file type via `detect.py` (extension-based + content heuristic)
2. `compress.py` → sends file content to Anthropic API with compression prompt
3. `validate.py` → compares original vs compressed: checks headings, code blocks, URLs, paths, bullets, inline code
4. On validation failure → sends both original + compressed + error list to API for targeted fix
5. Up to 2 retry cycles. On total failure → restores original and deletes backup.

## Key Patterns

**Prompt engineering as product.** The entire output compression system is a ~70-line markdown file (SKILL.md). The sophistication is in the prompt design — not the code. The rules define exactly what to drop, what to keep, and when to revert to normal prose (security warnings, irreversible actions, ambiguous multi-step sequences). The "auto-clarity" safety valve is well-designed: it prevents dangerous terseness without requiring user intervention.

**Defense-in-depth for flag files.** `caveman-config.js` implements thorough symlink protection. Flag reads enforce `O_NOFOLLOW`, a 64-byte size cap (longest legitimate value is "wenyan-ultra" at 12 bytes), and a VALID_MODES whitelist. Writes use atomic temp+rename with 0600 permissions. Parent directory symlinks are followed but verified for uid ownership (Unix) or home-directory containment (Windows). This is paranoid but appropriate — the flag file content gets injected into model context, so a symlink to `~/.ssh/id_rsa` would be a data exfiltration vector.

**Multi-agent distribution by duplication.** The same SKILL.md content is copy-pasted into ~8 locations with minor format adaptations (Claude plugin, Cursor `.mdc` rules, Cline `.clinerules`, Windsurf rules, Codex config, AGENTS.md, Gemini extension, etc.). The installer (`install.sh`, 783 lines) handles detection and deployment for 30+ agents via a provider matrix. It's a brute-force approach but effective given the fragmented agent ecosystem.

**Compress-validate-fix loop.** The input compression pipeline uses a two-stage approach: compress, then validate structural fidelity (headings, code blocks, URLs), then fix only what broke. The validator is regex-based and checks six dimensions. The fix prompt is carefully constrained — it receives both original and compressed, but is instructed to *only* fix listed errors, never re-compress.

**Benchmarked claims.** Unlike most LLM tools that cite made-up numbers, Caveman includes a real benchmark suite (`benchmarks/run.py`) that runs prompts through Claude with and without the caveman system prompt, measuring actual output token counts across multiple trials. The 65% savings figure comes from median across 10 coding tasks.

## Non-Obvious Details

**Per-turn reinforcement is critical.** The SessionStart hook injects the full ruleset once, but the project found that models "drift back to verbose mid-conversation, especially after context compression pruned it away." The `caveman-mode-tracker.js` hook injects a single reinforcement line on every user message. Without this, caveman mode degrades over long sessions.

**The `compress` tool ships your files to Anthropic.** The input compression CLI sends file contents to the Anthropic API. The code acknowledges this explicitly and implements a sensitive-path denylist (`.env`, `credentials.*`, `.ssh/`, `.aws/`, key files, anything with "secret"/"password"/"token" in the name). It refuses rather than silently stripping. Files over 500KB are also rejected.

**Only "full" mode has benchmark data.** The stats system (`caveman-stats.js`) has a hardcoded compression ratio of 0.65 for the `full` mode. Lite, ultra, and wenyan modes show "no savings estimate" because they haven't been benchmarked yet. Lifetime aggregation is stored in a JSONL history file.

**Windows compatibility is non-trivial.** The installer has a separate PowerShell version (`install.ps1`). The statusline has both `.sh` and `.ps1` versions. The CLI forces UTF-8 on stdout/stderr at import time to handle emoji on Windows cp1252 consoles. The symlink-safe flag operations degrade gracefully on Windows (uid checks unavailable, falls back to home-directory containment).

**Code duplication is intentional.** Multiple directories contain the same SKILL.md and compress scripts. This isn't lazy — each agent ecosystem has its own conventions for how skills/rules/plugins are discovered. A symlink would break plugin packaging.

## Assessment

**Strengths:**
- The core idea is elegant and the execution is remarkably thorough for what amounts to "a well-written system prompt"
- Security posture on the flag files is beyond what most projects bother with
- The compress-validate-fix loop with automatic rollback is well-designed
- Benchmarks are real and reproducible, not hand-waved
- The auto-clarity safety valve shows mature thinking about when terseness becomes dangerous

**Concerns:**
- 53K GitHub stars for a project whose core logic is a single prompt file speaks to marketing more than technical depth — the code quality of the surrounding tooling (hooks, installer, compress CLI) is genuinely good, but the value proposition is fragile. Any agent that adopts built-in terseness controls makes this moot.
- The installer supports 30+ agents but many are "soft-detected" via config directory presence, which could false-positive on stale directories. The `--dry-run` flag exists but isn't the default.
- Input compression depends on Anthropic's API specifically. The `call_claude()` function tries the Anthropic SDK first, then falls back to the `claude` CLI — no support for other providers. The `CAVEMAN_MODEL` env var defaults to `claude-sonnet-4-5`.
- No test coverage for the core SKILL.md behavior — tests cover the compress CLI, hooks, and flag operations, but the actual prompt effectiveness is only validated through benchmarks run manually.

**Recommendations:**
- Worth using if you're a heavy Claude Code user — the output compression is free (no API cost) and the per-turn reinforcement is well-engineered
- The input compression tool is useful for large CLAUDE.md files but be mindful it sends content to Anthropic; the sensitive-path denylist is thorough but heuristic-based
- Skip `ultra` and `wenyan` modes unless you're comfortable with the reduced readability — the project itself hasn't benchmarked them
