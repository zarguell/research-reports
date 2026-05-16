---
title: "Analyzing Oh My OpenCode"
date: 2026-05-16
type: codebase-analysis
status: complete
source: https://github.com/code-yeongyu/oh-my-opencode
tags: [ai-agents, typescript, opencode, multi-model, orchestration, bun]
---

# Analyzing Oh My OpenCode

> **Source:** [code-yeongyu/oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) @ [`aead4ae`](https://github.com/code-yeongyu/oh-my-opencode/commit/aead4aebd28abf0be5e17f075d66eb76faacf083)

## Overview

Oh My OpenCode (OMO) is a batteries-included plugin for [OpenCode](https://github.com/sst/opencode) that transforms it from a single-model coding assistant into a multi-model agent orchestration platform. The project describes itself as "oh-my-zsh for OpenCode" — a community framework that layers specialized agents, lifecycle hooks, and crafted tools on top of the OpenCode plugin API. At ~71K lines of TypeScript across 421 files, it is one of the largest and most sophisticated OpenCode plugins in the ecosystem.

OMO was created by a single developer, YeonGyu-Kim (code-yeongyu), who is now building a commercial product, Sisyphus Labs, based on the same orchestration patterns. The project sits at the center of ongoing tensions between Anthropic's Claude Code and the open-source OpenCode ecosystem, having been cited by Anthropic as justification for restricting third-party OAuth access.

## How It Works

The core insight of OMO is that **a single model should not do everything**. Instead of one LLM handling the full stack, OMO deploys 10 specialized agents — each pinned to a specific model (Claude Opus 4.5, GPT-5.2, Gemini 3 Flash, Grok Code) — that are invoked through lifecycle hooks and a custom delegation system. The primary agent, **Sisyphus**, acts as an orchestrator: it receives user requests, classifies them by type and complexity, then delegates implementation work to subagents while reserving verification and coordination for itself.

The plugin hooks into OpenCode's event system at five interception points — chat.message, tool.execute.before, tool.execute.after, event (session lifecycle), and experimental.chat.messages.transform — running 31 hooks that modify agent behavior, inject context, enforce quality gates, and auto-recover from failures. This hook pipeline is the backbone of OMO: it's where the "magic" of automatic AGENTS.md injection, comment checking, delegate-task retry, ralph-loop detection, and the Atlas orchestrator enforcement all happen.

A background task manager (1,346 lines) handles parallel subagent execution with per-provider concurrency limits, idle detection via stability polling, and 30-minute TTL cleanup. The delegate_task tool (1,047 lines) is the primary entry point for parallel work, routing tasks through configurable categories that map to specific models and tool restrictions.

## Architecture

```
User Prompt
  │
  ▼
┌─────────────────────────────────────────────────────┐
│  chat.message hooks (keyword detection, slash cmds)  │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────┐
│  SISYPHUS (Primary Orchestrator Agent)   │
│  Model: Claude Opus 4.5                 │
│  Role: Classify → Plan → Delegate →     │
│         Verify → Report                  │
└─────────────────────────────────────────┘
  │
  ├──→ tool.execute.before hooks (inject, validate)
  │
  ├──→ delegate_task / call_omo_agent
  │      │
  │      ▼
  │   ┌──────────────────────────────────┐
  │   │  BACKGROUND MANAGER              │
  │   │  Concurrency limits per provider │
  │   │  Stability detection (3 polls)   │
  │   │  30m TTL / 3m stale timeout      │
  │   └──────────────────────────────────┘
  │      │
  │      ├──→ oracle (GPT-5.2) — strategy, debugging
  │      ├──→ librarian (big-pickle) — docs, GitHub search
  │      ├──→ explore (GPT-5 Nano) — fast codebase grep
  │      ├──→ multimodal-looker (Gemini 3 Flash) — images/PDFs
  │      ├──→ metis (Sonnet 4.5) — pre-planning analysis
  │      ├──→ momus (Sonnet 4.5) — plan review
  │      ├──→ prometheus (Opus 4.5) — strategic planning
  │      └──→ sisyphus-junior (Sonnet 4.5) — implementation
  │
  └──→ tool.execute.after hooks (truncate, recover, retry)
```

The Atlas hook (773 lines) is a second orchestrator layer that sits *above* Sisyphus, enforcing that the orchestrator never directly modifies project files outside `.sisyphus/`. If it detects direct writes, it injects a stern reminder and a mandatory verification checklist.

## The Spine

OMO's primary entry point is `src/index.ts` (628 lines), which assembles the entire plugin. The initialization sequence is:

1. **Load config** — JSONC config from `.opencode/` directory, validated via Zod schema
2. **Instantiate hooks** — all 31 hooks, each gated by `disabled_hooks` config
3. **Create background manager** — singleton `BackgroundManager` with concurrency limits
4. **Discover skills and MCPs** — from OpenCode global/project dirs, Claude Code dirs, and built-in skills
5. **Wire up the OpenCode plugin interface** — returning `tool`, `chat.message`, `event`, `tool.execute.before`, `tool.execute.after`, and `config` handlers

The `chat.message` handler is the first interception point. It sets the session agent, applies variant overrides, and runs keyword detection (for "ultrawork", "search", "analyze" triggers) before handing control to Sisyphus. The `event` handler manages session lifecycle — tracking the main session ID, attaching tmux sessions, and triggering the session recovery hook on errors.

The `tool.execute.before` pipeline validates and modifies tool inputs before execution. It runs Claude Code compat hooks, directory context injectors (AGENTS.md/README.md), comment checker, and the Atlas orchestrator enforcement. The `tool.execute.after` pipeline handles output modification — truncating large outputs, detecting empty responses, recovering from edit errors, and retrying failed delegations.

## Key Patterns

**Dynamic prompt generation.** Sisyphus's system prompt is not a static string — it's built dynamically at plugin init from agent metadata. Each agent exports `AgentPromptMetadata` (category, cost, triggers, useWhen/avoidWhen), and the `dynamic-agent-prompt-builder` (359 lines) assembles tables for tool selection, delegation routing, and key triggers. Adding a new agent requires no prompt editing — just registering metadata.

**Factory pattern everywhere.** Every agent, hook, and tool follows a consistent `createXxx(config): PluginComponent` factory pattern. Agents return `AgentConfig` objects with model, temperature, thinking budget, and tool restrictions. Hooks return objects with handler functions keyed by event type. This uniformity makes the plugin extensible but also contributes to the boilerplate: 31 hook index.ts files.

**Category-based delegation.** The `delegate_task` tool supports user-defined categories (e.g., "frontend", "backend", "testing") that map to specific agent+model+tool_restriction combinations. Categories can auto-attach skills and prompt appends, creating a reusable delegation taxonomy.

**Claude Code compatibility layer.** OMO has a comprehensive compat layer (src/features/claude-code-*) that loads Claude Code agents, commands, MCP configs, skills, and session state. Combined with the `claude-code-hooks` hook (which intercepts Claude Code settings.json patterns), this provides near-drop-in migration for Claude Code users.

**Session cursor for incremental output.** The `call_omo_agent` tool implements a session cursor (via `shared/session-cursor`) that tracks which messages have already been consumed, returning only *new* output on subsequent polls. This prevents context bloat from repeated full-session reads.

**Boulder state persistence.** The `boulder-state` feature persists TODO lists and plan progress to `.sisyphus/` directory, enabling recovery across sessions. Combined with `todo-continuation-enforcer` (489 lines), this creates a self-driving loop where Sisyphus won't stop until all tasks are checked off.

## Non-Obvious Details

**The Atlas hook is the real "discipline agent."** While Sisyphus gets the branding, Atlas is the hook that enforces orchestrator behavior — it detects file writes outside `.sisyphus/`, injects verification checklists after subagent completion, and reminds agents that "subagents FREQUENTLY LIE about completion." This multi-layered enforcement (Sisyphus prompt instructions + Atlas hook injection) is a defense-in-depth approach to agent reliability.

**Tool restrictions are enforced at the OpenCode API level.** Each agent has explicit tool allowlists or denylists. Oracle can't write files. Explore can't delegate. These aren't just prompt suggestions — they're passed as `tools` parameters to OpenCode's session.prompt API, making them enforceable rather than advisory.

**The ralph-loop is a self-referential development mode.** Named after the project's own logo (a dog), ralph-loop detects special prompt templates and enters a loop where the agent keeps working, checking its own TODO list, and only stops when all tasks are complete or a completion promise is satisfied. It's essentially an autonomous development sprint, triggered by `/ralph-loop "task"` or `/ulw-loop "task"` (ultrawork variant).

**Config is JSONC, not JSON.** The plugin uses `jsonc-parser` to support comments and trailing commas in configuration files. This is a deliberate UX choice — config files are expected to be hand-edited, and JSONC reduces syntax friction for humans while maintaining machine-parseability.

**Platform binaries via optionalDependencies.** OMO distributes 7 platform-specific native binaries as npm `optionalDependencies`. This is a clever pattern: npm automatically installs the correct binary for the user's platform without a postinstall download script — avoiding the security concerns of runtime binary fetching.

## Assessment

### Strengths

- **Multi-model routing is genuinely useful.** The idea of sending grep tasks to a cheap/fast model (GPT-5 Nano) while reserving Opus for architecture decisions directly addresses the cost-quality tradeoff in AI coding.
- **Hook pipeline is well-designed.** The interception points and execution order are clearly documented and follow a sensible sequence. The disabled_hooks config allows users to opt out of specific behaviors.
- **Defense-in-depth for agent reliability.** The combination of prompt instructions, hook enforcement, verification checklists, and tool-level restrictions creates multiple layers of guardrails — no single failure mode can completely compromise behavior.
- **Comprehensive Claude Code compatibility.** The skill/command/MCP loaders and settings.json hook make migration practical for users invested in the Claude Code ecosystem.
- **Strong testing culture.** 99 test files with BDD-style comments (`#given`, `#when`, `#then`) and a mandatory TDD policy in the project's AGENTS.md.

### Concerns

- **Single point of failure.** The entire project is maintained by one developer. While the code is well-organized, bus factor is essentially 1 — and the commercial spinoff (Sisyphus Labs) creates potential for divergent priorities between the open-source plugin and the paid product.
- **Massive plugin surface area.** At 31 hooks across 5 event types, the interaction matrix is enormous. A hook that modifies behavior in `tool.execute.before` can have cascading effects on hooks in `tool.execute.after`. The AGENTS.md file warns against heavy PreToolUse computation, but the sheer number of hooks makes it difficult to reason about emergent behavior.
- **Anthropic ToS tension.** The project has been directly cited by Anthropic in restricting third-party OAuth access. While OMO itself doesn't implement OAuth spoofing, it operates in an ecosystem where that capability exists, creating ongoing legal friction.
- **`call_omo_agent` synchronous polling is primitive.** The sync mode polls every 500ms with a 5-minute timeout and stability detection — a pattern that works but adds latency and burns API credits on status checks. The background mode (via BackgroundManager) is the recommended path but adds complexity.
- **Nil production deployment story.** There's no observability, metrics, or production hardening. The plugin is designed for local developer workstations, and attempting to run it in CI or server environments would require significant adaptation.

### Recommendations

- **Consider a hook interaction test suite.** With 31 hooks, integration tests that verify hook ordering and cross-hook effects would catch regressions that unit tests miss.
- **Extract the background manager as a standalone package.** It's the most sophisticated component and has clear utility beyond OMO.
- **Add a hook performance budget.** The AGENTS.md already warns against heavy PreToolUse hooks, but there's no enforcement. A timing wrapper that logs hooks exceeding a threshold (e.g., 50ms) would help maintain responsiveness.

## Related

- [[analyzing-hermes-agent]] — another multi-model AI agent platform with skill-based orchestration
- [[analyzing-bifrost]] — AI gateway for multi-model routing
- [[analyzing-claude-octopus]] — parallel agent delegation patterns
- [[market-ai-coding-agent-index-2026]] — broader landscape of AI coding agents
- [[comparing-bifrost-vs-litellm]] — multi-model routing infrastructure comparison
