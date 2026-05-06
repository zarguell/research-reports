---
title: "Analyzing Hermes Agent"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/NousResearch/hermes-agent
tags: [python, ai-agent, multi-platform, llm, tool-calling, plugin-system, terminal-ui]
---

# Analyzing Hermes Agent

> **Source:** [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) @ [`b62a82e`](https://github.com/NousResearch/hermes-agent/commit/b62a82e0c3fbcdf219824c1512de180bae8a125c)

## How It Works

Hermes Agent is an open-source AI agent framework by Nous Research that runs a persistent, tool-calling LLM loop in your terminal, messaging platforms, and IDEs. At 135k GitHub stars and ~350k lines of Python source (plus 959 test files), it's one of the largest and most active open-source agent projects.

The system's mental model is straightforward: **a conversation loop that dispatches tools and accumulates knowledge**. An `AIAgent` instance (`run_agent.py`) holds an OpenAI-format message history, a system prompt assembled from identity + skills + memory, and a set of registered tools. On each turn, it calls the LLM, dispatches any tool calls through the registry, appends results, and loops until the model returns a text response. This core loop is shared across every surface — CLI, Telegram gateway, cron jobs, subagent delegation, and ACP server.

What makes it architecturally distinct from Claude Code or Codex is the **learning loop**: a `MemoryManager` persists user preferences and lessons learned across sessions, a `skill_manager_tool` lets the agent create/update SKILL.md documents after complex tasks, and a `curator` periodically reviews and improves those skills autonomously. The agent literally gets better at your specific workflows over time by reading its own accumulated knowledge.

## Architecture

```
                         ┌──────────────────────────────┐
                         │        User Interfaces        │
                         │  CLI (prompt_toolkit)          │
                         │  Gateway (20+ platforms)       │
                         │  ACP Server (IDE integration)  │
                         │  Web TUI (React)               │
                         └──────────┬───────────────────┘
                                    │
                         ┌──────────▼───────────────────┐
                         │         AIAgent               │
                         │  (run_agent.py)               │
                         │                               │
                         │  ┌─ Prompt Builder ────────┐  │
                         │  │ identity + skills +     │  │
                         │  │ memory + context files  │  │
                         │  └────────────────────────┘  │
                         │  ┌─ Context Engine ────────┐  │
                         │  │ auto-compression at     │  │
                         │  │ token threshold         │  │
                         │  └────────────────────────┘  │
                         │  ┌─ Credential Pool ───────┐  │
                         │  │ multi-key rotation      │  │
                         │  └────────────────────────┘  │
                         └──────────┬───────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
              ┌─────▼─────┐  ┌─────▼─────┐  ┌──────▼──────┐
              │  Tools     │  │ Transport │  │   Memory    │
              │  Registry  │  │  Layer    │  │   Manager   │
              │            │  │           │  │             │
              │ 60+ tools  │  │ Anthropic │  │ Built-in    │
              │ self-reg   │  │ Bedrock   │  │ Honcho      │
              │ via        │  │ Gemini    │  │ Mem0        │
              │ registry.  │  │ OpenAI    │  │ plugin      │
              │ register() │  │ Codex     │  │ providers   │
              └────────────┘  └───────────┘  └─────────────┘
```

## The Spine

**Entry points:**

- `hermes` CLI command → `hermes_cli/main.py` → `cli.py` (interactive TUI) or `hermes chat -q` (one-shot)
- `hermes gateway run` → `gateway/run.py` → `GatewayRunner` starts platform adapters, each wrapping `AIAgent` per-session
- `hermes acp` → `acp_adapter/server.py` → ACP protocol server for IDE integration
- `cron/scheduler.py` → fires scheduled jobs by spawning `AIAgent` instances with isolated sessions

**Request lifecycle (CLI):**

1. User message enters via `prompt_toolkit` input in `cli.py`
2. `cli.py` calls `AIAgent.run_conversation()` in `run_agent.py`
3. `_build_system_prompt()` assembles identity, loaded skills, memory content, and context files (AGENTS.md, SOUL.md)
4. `MemoryManager.prefetch_all()` injects relevant memory into the context
5. LLM call goes through provider transport layer — messages/tools converted to provider-native format
6. If tool calls returned, `handle_function_call()` dispatches through `tools/registry.py` → individual tool handlers
7. Tool results appended to message history, loop continues
8. On text response, `MemoryManager.sync_all()` persists new learnings
9. `ContextEngine.should_compress()` checked — if near token limit, middle turns summarized via auxiliary model
10. Response rendered to user via CLI display or gateway delivery

**Request lifecycle (Gateway):**

Same agent loop, but `GatewayRunner` maintains a cache of `AIAgent` instances keyed by session (up to 128, with 1-hour idle TTL eviction). Platform adapters in `gateway/platforms/` implement a `BasePlatformAdapter` ABC — they normalize incoming messages into a common format, feed them to the shared agent loop, and deliver responses back through the platform's API.

## Key Patterns

**Self-registering tool architecture.** Tools declare themselves via `registry.register()` at module import time, providing schema, handler, toolset membership, and a `check_fn` for conditional availability. `model_tools.py` triggers discovery by importing all modules in `tools/`, then serves as the query layer. The registry uses AST inspection (`_module_registers_tools()`) to determine which files contain tools before importing — a clever optimization that avoids side effects from importing helper modules.

**Provider transport abstraction.** Instead of provider-specific code scattered throughout, each provider has a `ProviderTransport` in `agent/transports/` that handles four things: `convert_messages()`, `convert_tools()`, `build_kwargs()`, `normalize_response()`. The internal format is always OpenAI-compatible — transports convert to/from provider-native formats. This is why adding a new provider doesn't require touching the agent loop at all.

**Credential pooling with automatic rotation.** `CredentialPool` stores multiple API keys per provider, tracks exhaustion state and rate limits, and rotates automatically. It supports both API keys and OAuth tokens (with JWT expiry detection for Codex). When a key hits a 429 or 401, the pool marks it exhausted and tries the next one.

**Context compression as a pluggable engine.** `ContextEngine` is an ABC with the built-in `ContextCompressor` as default. It uses an auxiliary (cheaper) model to summarize middle conversation turns while protecting the head (system prompt + first turns) and tail (recent turns) via token-budget fencing. The engine is configurable — plugins can swap in alternatives.

**Prompt injection scanning in context files.** Before injecting AGENTS.md, SOUL.md, or other context files into the system prompt, `prompt_builder.py` runs regex-based scanning for common injection patterns (invisible Unicode chars, "ignore previous instructions", credential exfiltration attempts). This is a pragmatic defense for a system that explicitly loads user-controlled files into the prompt.

**Platform adapter registry pattern.** Platform adapters register via `PlatformEntry` dataclasses with factory functions, `check_fn` for dependency gating, optional `validate_config` and `is_connected` callbacks, and env var declarations. This lets the setup wizard (`hermes gateway setup`) dynamically enumerate available platforms without hardcoding.

## Non-Obvious Details

**Lazy OpenAI import for startup speed.** The OpenAI SDK adds ~240ms to import time. Hermes uses a `_OpenAIProxy` class that defers the actual import until first use, preserving `patch("run_agent.OpenAI", ...)` test patterns. This matters because `run_agent.py` is imported from many entry points — the lazy load shaves noticeable startup latency.

**Persistent event loops for tool execution.** Tools often use `httpx.AsyncClient` and `AsyncOpenAI`. Creating and destroying event loops per tool call caused "Event loop is closed" errors during garbage collection. The fix: `_get_tool_loop()` maintains a single long-lived `asyncio` event loop per thread, and `_get_worker_loop()` provides thread-local loops for `delegate_task`'s `ThreadPoolExecutor` workers.

**Tool call parsers for model-specific quirks.** Different LLMs format tool calls differently. The `environments/tool_call_parsers/` directory has 12 parsers for DeepSeek, GLM, Kimi K2, LLaMA, Mistral, Qwen, LongCat, and others. Each parser handles model-specific formatting issues (e.g., Kimi K2 puts reasoning in `message.reasoning` with empty `content`). This is the kind of compatibility shimming you only discover by running against many providers in production.

**Curator runs as a forked sub-agent.** The skill curator (`agent/curator.py`) spawns a separate `AIAgent` instance in a fork to review and improve skills without contaminating the main conversation. It runs on a configurable interval (default: weekly) and can use a different (cheaper) model for reviews.

**Git worktree isolation for parallel agents.** The `--worktree` flag spawns Hermes in an isolated git worktree, allowing multiple agents to work on the same repo simultaneously without conflicts. The worktree is automatically created and cleaned up.

**MCP tool discovery via AST.** The `tools/mcp_tool.py` dynamically discovers tools from MCP servers and converts them into Hermes's native tool format. MCP OAuth bidirectional auth (`tools/mcp_oauth.py`) handles the case where both Hermes and the MCP server need to authenticate to each other.

> [!question] The test count (959 files) and source LOC (~350k) suggest the project has grown significantly. Some areas like the `environments/` directory (RL training environments, SWE benchmarks) appear to be for Nous Research's internal evaluation pipelines and may not be relevant to typical users.

## Assessment

**Strengths:**

- **Genuinely provider-agnostic.** The transport abstraction works — 20+ providers without provider-specific logic leaking into the agent loop. The credential pool with automatic rotation is production-grade.
- **Impressive platform coverage.** 20+ messaging platforms with a clean adapter pattern. The gateway is battle-tested (the main author runs it daily across Telegram, Discord, etc.).
- **The learning loop is real and useful.** Skills that self-improve, memory that persists, a curator that reviews — this is a meaningful differentiator from other agent frameworks that start from zero every session.
- **Test coverage is thorough.** 959 test files covering tool implementations, agent loop edge cases, gateway platform adapters, and CLI interactions. CI runs tests with parallel execution via pytest-xdist.
- **Pragmatic security.** Prompt injection scanning for context files, path security checks, tool guardrails, and a Tirith security module for website access control.

**Concerns:**

- **Monolithic Python codebase.** At 350k LOC in a single repository with no package boundaries, navigating the code requires institutional knowledge. The `agent/` directory alone has 60+ files with sometimes unclear separation of concerns (e.g., `prompt_builder.py` vs `context_engine.py` vs `context_compressor.py`).
- **Dependency pinning is tight.** Every dependency is pinned to major.minor ranges with upper bounds. This limits supply chain risk but makes dependency updates painful — especially for fast-moving packages like `openai` and `anthropic` SDKs.
- **No typed config schema.** Configuration uses a loose dict (`load_config()` returns `dict`) rather than a Pydantic model or dataclass. Type safety on config access is ad hoc via `cfg_get()`.
- **Single-threaded gateway concurrency.** Platform adapters run in an `asyncio` event loop. While adequate for messaging volumes, the architecture doesn't horizontally scale — one gateway process per machine.

**Recommendations:**

- The project is production-ready for individual and small-team use. The gateway + cron system can automate real workflows end-to-end.
- For organizations considering adoption, the skill system and memory architecture are the killer features — they compound value over time in ways that stateless agents (Claude Code, Codex) cannot.
- The `environments/` directory (RL training, SWE benchmarks) is an interesting sign that Nous uses Hermes for their own model evaluation, which suggests the framework is robust enough for research-grade workloads.
