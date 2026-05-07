---
title: "Analyzing Claude Octopus"
date: 2026-05-07
type: codebase-analysis
status: complete
source: https://github.com/nyldn/claude-octopus
tags: [bash, typescript, ai-agent, multi-platform, llm, tool-calling, claude-code, codex, gemini, mcp, plugin-system]
---

# Analyzing Claude Octopus

> **Source:** [nyldn/claude-octopus](https://github.com/nyldn/claude-octopus) @ [`d092b7f`](https://github.com/nyldn/claude-octopus/commit/d092b7fd0d2902d04f1f89c6937cd9ffcd08a291)

## How It Works

Claude Octopus is a Claude Code plugin that orchestrates up to eight AI providers (Claude, Codex, Gemini, Copilot, Qwen, Ollama, Perplexity, OpenRouter) into structured multi-LLM workflows. It is not a standalone application — it is a *prompt-and-hook layer* that sits inside Claude Code's plugin system and uses shell scripts to invoke external CLIs as subagents. The core mental model: Claude Code is the orchestrator; external provider CLIs are disposable workers dispatched via `codex exec` and `gemini -p ""` in headless mode; shell scripts coordinate the dispatch, collect results, and apply quality gates.

Everything flows through a single 2,964-line bash script — `scripts/orchestrate.sh` — which sources ~50 library files from `scripts/lib/` (26,514 lines total). Commands like `/octo:discover`, `/octo:embrace`, and `/octo:debate` are Claude Code slash commands defined as markdown files in `.claude/commands/`. Each command instructs Claude to invoke `orchestrate.sh` with a specific subcommand (`probe`, `grasp`, `tangle`, `ink`, `embrace`, `grapple`, `squeeze`) via the Bash tool. The orchestrate script detects available providers, builds provider-specific CLI invocations with the right model flags, runs them in parallel or sequence, writes results to `~/.claude-octopus/results/`, and returns synthesis output.

The plugin enforces a four-phase "Double Diamond" methodology: Discover → Define → Develop → Deliver, with configurable quality gates between phases (default 75% consensus threshold). A 75% consensus gate means if providers disagree significantly, the workflow flags it rather than silently proceeding. The "Dark Factory" mode (`/octo:embrace`) chains all four phases autonomously — spec in, software out. A blind-spot library (`config/blind-spots/`) contains domain-specific checklists triggered by keyword matching, injected into provider prompts to counter known LLM weaknesses.

## Architecture

```
User → Claude Code Session
         ├─ .claude/commands/*.md     (48 slash commands — intent routing)
         ├─ .claude/skills/*.md       (52 skills — reusable workflow modules)
         ├─ .claude/agents/*.md       (10 agents — role-specific subagents)
         ├─ hooks/                    (~50 shell hooks — PreToolUse, SessionStart, etc.)
         └─ scripts/orchestrate.sh    (central dispatcher, 2964 lines)
              ├─ scripts/lib/*.sh      (50 library files, 26K lines)
              ├─ scripts/scheduler/    (cron/daemon job scheduler)
              └─ scripts/state-manager.sh (JSON state persistence)
                   
Parallel paths for other platforms:
  mcp-server/src/index.ts   → MCP protocol (Cursor, any MCP client)
  openclaw/src/index.ts     → OpenClaw extension API
  .gemini/commands/*.toml   → Gemini CLI custom commands
  commands/octo-*.md        → Codex/OpenCode skill symlinks
  agents/droids/*.md        → Factory AI Droid agent definitions
  .github/agents/*.md       → GitHub Copilot agent definitions
```

The architecture has three layers: **presentation** (commands, skills, agents — all markdown with YAML frontmatter that Claude interprets as instructions), **coordination** (orchestrate.sh + lib/* — pure bash), and **adapter** (provider-specific CLI invocation in `lib/dispatch.sh`, `lib/providers.sh`). State is stored as JSON in `~/.claude-octopus/state.json` and as markdown in `.octo/STATE.md` within project directories.

## The Spine

A request enters through one of three paths:

1. **Slash command** (`/octo:discover "topic"`): Claude reads the command markdown, which contains an "EXECUTION CONTRACT" instructing it to call a specific skill via `Skill()`.
2. **Smart router** (`/octo:auto "topic"` or just `octo topic`): The `auto.md` command contains a keyword-matching intent classifier with three priority tiers. It routes to the appropriate command.
3. **Auto-invoke hook**: The `UserPromptSubmit` hook (`hooks/user-prompt-submit.sh`) fires on every prompt, classifies intent, and can inject routing context or auto-invoke workflows when `OCTOPUS_AUTO_ROUTER_MODE=invoke`.

Once routed, the skill markdown instructs Claude to call `orchestrate.sh <subcommand> <prompt>` via the Bash tool. PreToolUse hooks intercept this call — `provider-routing-validator.sh` validates the target, and prompt-type hooks inject cost-awareness warnings. The orchestrate script runs providers in parallel (background subprocesses), collects results to `~/.claude-octopus/results/`, applies quality gates, and returns synthesis. PostToolUse hooks trigger `quality-gate.sh` for develop-phase calls and `telemetry-webhook.sh` if configured.

For MCP clients (Cursor, etc.), the path is: MCP tool call → `mcp-server/src/index.ts` → `runOrchestrate()` → spawns `orchestrate.sh` as a child process with a 300s timeout, forwarding only whitelisted environment variables.

## Key Patterns

**Markdown-as-code**: Every command, skill, and agent is a markdown file with YAML frontmatter. Claude interprets these as instructions. This is the entire "programming model" — there is no traditional code path for workflow logic beyond orchestrate.sh. The frontmatter defines triggers, aliases, effort levels, tool permissions, and validation gates.

**Execution contracts**: Skills use mandatory "EXECUTION CONTRACT" sections with imperative language ("You MUST execute...", "PROHIBITED from...") to prevent Claude from shortcutting the multi-LLM orchestration. The `embrace.md` command explicitly states: "If you used only Claude-native tools, you executed incorrectly."

**Validation gate pattern**: Skills declare `validation_gates: [orchestrate_sh_executed, synthesis_file_exists]` in frontmatter. After dispatch, they verify result files exist via `find ~/.claude-octopus/results/ -name "probe-synthesis-*" -mmin -10` rather than trusting the process succeeded silently.

**Provider-agnostic routing with role-based model mapping**: Roles (architect, code-reviewer, implementer, researcher, etc.) map to specific models per provider. Since v9.29, the architect role defaults to Claude Opus 4.7, code-reviewer to GPT-5.4, researcher to Gemini 3.1 Pro. This mapping lives in `lib/dispatch.sh` and `lib/model-resolver.sh`, with graceful fallback when the preferred CLI is unavailable.

> [!tip]
> Cache-aligned prompt structure: `probe_single_agent()` in `lib/workflows.sh` explicitly structures prompts with stable prefixes first and variable suffixes last — "enables Claude's cached-token discount on repeated prefix content." A non-obvious cost optimization.

**Hook-driven guard rails**: The `hooks.json` defines ~30 hooks across 15+ event types. Notable: `careful-check.sh` intercepts any Bash call matching destructive patterns (`rm`, `git push`, `DROP TABLE`, `sudo`); `freeze-check.sh` blocks all Edit/Write when `OCTO_FREEZE_MODE=on`; `codex-exec-guard.sh` validates Codex invocations before execution.

## Non-Obvious Details

**The plugin name must stay "octo"** — not "claude-octopus". This is locked by `PLUGIN_NAME_LOCK.md` and enforced by a pre-commit hook and test. Changing it breaks command prefixes (`/octo:*`) and the `/plugin` UI identity. The npm package name (`package.json`) is `claude-octopus`, but the plugin name (`plugin.json`) is `octo`.

**MCP server is disabled by default**. The `mcp-server/src/index.ts` exits immediately unless `OCTO_CLAW_ENABLED=true` is set. This prevents a permanent "failed" status in Claude Code's `/mcp` listing for users who don't need MCP access.

**Credential isolation is explicit**. The MCP server maintains a `BLOCKED_ENV_VARS` set that prevents MCP clients from overriding security-governing env vars (`OCTOPUS_SECURITY_V870`, `CLAUDE_OCTOPUS_AUTONOMY`, sandbox modes). Only an allowlist of API keys and `OCTOPUS_*` vars are forwarded to `orchestrate.sh`.

**The monolith decomposition is recent**. v9.7.x extracted functions from the 2,964-line `orchestrate.sh` into ~50 lib files. Some libs use `2>/dev/null || true` (silent failure) while critical ones like `providers.sh` use strict sourcing. This inconsistency creates fragile implicit dependencies.

> [!warning]
> Provider CLIs have undocumented flag changes. The debate skill warns: "Flags that DO NOT EXIST: `codex -q`, `codex --quiet`, `codex -y`" — removed in Codex v0.101.0. Gemini's `-y` was replaced by `--approval-mode yolo`. These breaking changes are only documented inside skill markdown, not in any changelog.

**Remote session auto-detection**. When `CLAUDE_CODE_REMOTE=true` or `CLAUDE_CODE_WEB=true` is set, Octopus automatically switches to autonomous mode, skips provider probes, and uses a minimal statusline — no user configuration needed.

## Assessment

**Strengths**: The scope is genuinely impressive — 48 commands, 52 skills, 32 personas, 8 providers, 146 tests, and deep Claude Code integration via 15+ hook event types. The multi-platform adapter strategy (Claude Code plugin + MCP server + OpenClaw extension + Gemini TOML commands + Codex skills + GitHub Copilot agents + Factory Droid agents) is thorough. The cost-awareness design (visual indicators per provider, per-query cost estimates, free-tier routing for Qwen/Ollama/Copilot) shows real user empathy. The validation gate pattern that prevents Claude from silently falling back to single-provider mode is a smart solution to a real LLM reliability problem.

**Concerns**: The 26,500-line bash codebase is a maintenance risk. The monolith decomposition is incomplete — `orchestrate.sh` still sources 50+ files with inconsistent error handling (some silent, some strict). The "markdown-as-code" approach means workflow correctness depends entirely on Claude following imperative instructions, which is inherently unreliable — the execution contracts and validation gates exist specifically because Claude *doesn't* always follow them. The version at v9.36.1 suggests extremely rapid iteration, which raises questions about regression coverage despite 146 tests. The `scripts/token-extraction/` subtree appears to be an entire design-token extraction tool unrelated to the core orchestration — dead weight.

**Recommendations**: The bash monolith should be gradually replaced with the TypeScript MCP server as the primary execution path — it already has the security model (credential isolation, blocked env vars, path traversal guards) and could absorb orchestrate.sh logic. The skill markdown files should be simplified to declare *what* to do rather than *how to not do it wrong* — the current execution contracts are fighting Claude's tendency to shortcut, suggesting the routing layer needs to be more rigidly programmatic rather than prompt-based. The token-extraction subtree should be extracted to a separate repository.

## Related

- [[analyzing-bifrost]] — AI agent orchestration and multi-platform support
- [[analyzing-caveman]] — Claude Code plugin architecture patterns
- [[analyzing-hermes-agent]] — Alternative AI agent orchestration approach
