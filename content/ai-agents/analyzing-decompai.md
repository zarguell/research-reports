---
title: "Analyzing DecompAI"
date: 2026-05-10
type: codebase-analysis
status: complete
source: https://github.com/louisgthier/decompai
tags: [python, reverse-engineering, langgraph, gradio, docker, binary-analysis]
---

# Analyzing DecompAI

> **Source:** [louisgthier/decompai](https://github.com/louisgthier/decompai) @ [`0c2398c`](https://github.com/louisgthier/decompai/commit/0c2398c09e318be1bb6f6a52d13e572fac7c519b)

## How It Works

DecompAI is a chat-based binary reverse engineering assistant. You upload an ELF binary through a Gradio web interface; the system hashes it with SHA-256 to create a persistent session directory, disassembles it with `objdump` inside a Kali Linux Docker container, and then hands the disassembly to an LLM-powered ReAct agent built on LangGraph. If the disassembly fits within half the model's context window, the full assembly is injected into the conversation; otherwise, a structured summary (sections, headers, symbols) is provided instead.

The agent has ~20 tools at its disposal: disassembly of individual functions and sections via `objdump`, memory dumps and string reads via `radare2`, headless Ghidra decompilation through a custom Java script, stateful and stateless `r2` shells, arbitrary Python script execution, and file management tools for reading/writing within a sandboxed workspace. All tool execution happens inside short-lived or persistent Docker containers running a custom Kali image packed with `gdb`, Ghidra, `radare2` with `r2dec`/`r2ghidra` plugins, and the full Kali headless toolset. The Gradio UI streams tool calls and LLM responses in real time, and session state (conversation history, workspace files) persists across re-uploads of the same binary.

The architecture is a two-container Docker-in-Docker pattern: the app container runs the Python/Gradio server and orchestrates the agent, while the runner container (built from `Dockerfile.runner` on top of `kalilinux/kali-rolling`) executes all binary analysis commands. The app mounts the host Docker socket (`/var/run/docker.sock`) so it can spawn and manage runner containers on the fly.

## Architecture

The project is organized into four layers:

- **Entry point** (`run.py`): Creates a Gradio `Blocks` app and delegates UI construction to `src/main.py`. This is ~11 lines — just enough to configure and launch the server.
- **Agent graph** (`src/main.py`): The monolithic core. Defines the LangGraph ReAct agent, wires ~20 tools, configures the LLM (OpenAI or Gemini via environment variable), builds the Gradio `ChatInterface`, and handles the full streaming message pipeline. At ~590 lines, this file does a lot — agent setup, model selection, session lifecycle, streaming message parsing, and UI wiring are all interleaved.
- **Tools** (`src/tools/`): Two submodules. `tools.py` defines each agent tool as a `@tool`-decorated function, injecting LangGraph state via `InjectedState`. The `sandboxed_shell/` package provides `DockerizedBashProcess` (manages persistent/ephemeral Docker containers) and `SandboxedShellTool` (the LangChain `BaseTool` wrapper).
- **Utilities** (`src/utils/`): `utils.py` contains all binary analysis logic — `objdump` invocation, section/function extraction via regex, memory dumping with `r2`, Ghidra headless orchestration, and session management. `llm.py` handles token counting and message history validation. `docker_env.py` manages Docker mount configuration and runner image building. `gradio_utils.py` is a single escape function for markdown in tool output.

Configuration is centralized in `src/config.py` using `pydantic-settings`, pulling from environment variables and `.env` files.

## The Spine

A request flows through these steps:

1. **Binary upload** → `start_session()` in `src/main.py` hashes the file, creates a session directory under `ANALYSIS_SESSIONS_ROOT`, copies the binary (both to the session root and an `agent_workspace` subdirectory), runs `objdump -ds` inside a runner container, and decides whether to inject full disassembly or a summary into the initial message history.

2. **User message** → `process_request()` appends a `HumanMessage` to the LangGraph state, then streams through `graph.astream()` (a `create_react_agent` graph). The LLM decides whether to call tools or respond directly.

3. **Tool execution** → LangGraph's `ToolNode` invokes the relevant `@tool` function. Tools that need shell access route through `CustomSandboxedShellTool`, which lazily creates a persistent Docker container keyed by session path, mounts the workspace, and pipes commands through an interactive bash process. Radare2 tools wrap `r2 -qc` commands; Ghidra tools invoke `analyzeHeadless` with custom Python/Java post-scripts.

4. **Streaming response** → The `astream` loop parses `AIMessageChunk`, `ToolMessageChunk`, and `ToolMessage` events, accumulating them into the Gradio chat history with metadata for collapsible tool-call display.

5. **State persistence** → After the agent finishes, `save_state()` serializes the full LangGraph state (messages, paths, counters) to `state.json` in the session directory using LangChain's `dumps()`. On re-upload, `load_state()` deserializes and restores the conversation.

## Key Patterns

**State injection everywhere.** Tools don't receive the binary path or workspace as arguments — they pull it from LangGraph's injected `State` via `Annotated[State, InjectedState]`. This is clean for the agent (tools have simple signatures) but means every tool is tightly coupled to the state schema.

**Docker-in-Docker for sandboxing.** The app container runs Docker CLI commands against the host socket. Runner containers are `--privileged` to support `gdb` and low-level binary tools. Persistent containers use a UUID-based naming scheme and a sentinel-marker protocol (`echo __COMMAND_DONE__<uuid>`) to delimit command output on the persistent bash pipe.

**Token-aware disassembly.** The system counts tokens in the full disassembly and switches between full injection and structured summary based on half the model's context window. This is the key strategy for handling large binaries without overflowing context.

**Radare2 stateful shell replay.** The `r2_stateful_shell` tool maintains a command history list in state. Each invocation replays the full history from scratch (since `r2` runs as a one-shot `-qc` command), then returns only the new output lines by tracking a line count in state.

**Dynamic tool wrapping.** File management tools from `langchain-community` are dynamically wrapped via `create_tool_function()`, which generates new `@tool`-decorated functions with injected state schemas at import time.

## Non-Obvious Details

> [!warning] Privileged Docker containers
> Runner containers run with `--privileged` and mount workspace directories. The shell tool has no command sanitization — the LLM generates commands freely. This is intentional for flexibility (the agent can run `gdb`, `python3`, arbitrary binaries) but means a compromised or misbehaving LLM could escape the container.

> [!note] Unused graph definition
> `src/main.py` defines a custom `StateGraph` with manual nodes (`agent`, `tools`, `feedback`) and conditional edges, but then overwrites `graph` with `create_react_agent()` on line 220. The manual graph definition appears to be dead code from an earlier iteration. The `request_feedback` node and `should_continue_or_feedback` router are also unused.

> [!note] Gemini null-content workaround
> The code has scattered workarounds for Gemini models returning empty content strings: replacing `""` with `" "` in `call_model`, `prepare_messages`, and streaming handlers. This is a known LangChain/Google API friction point.

> [!tip] Ghidra script bridge
> `src/utils/ghidra_scripts/decompile_function.py` is a Jython 2.7 script that runs inside Ghidra's scripting environment. It uses Ghidra's Java API (`DecompInterface`, `getSymbolTable`) to decompile individual functions. The Python app copies this script into the workspace and passes it to `analyzeHeadless` as a `-postScript`.

> [!question] Broken pipe issues
> A `TODO` comment in `SandboxedShellTool._run` notes `[Errno 32] Broken pipe` errors. The persistent shell model (piping commands to a long-lived `docker exec` bash process via stdin) is inherently fragile — if the container dies, all subsequent commands fail until a new container is created.

## Assessment

**Strengths.** The project solves a real problem — making RE tooling accessible through natural language — with a pragmatic architecture. The Docker sandbox approach is sound in principle: tool execution is isolated from the host, and the Kali runner image provides a batteries-included environment. Session persistence via binary hashing is a clever touch. The LangGraph ReAct pattern gives the agent flexibility to chain tools (e.g., list functions → decompile one → inspect strings → write findings). The codebase is small (~2,500 lines of Python across ~12 files), making it easy to understand and modify.

**Concerns.** The monolithic `src/main.py` (~590 lines) conflates agent setup, model configuration, session management, Gradio UI construction, and streaming message parsing. This makes it hard to test or modify any one concern independently. Error handling is inconsistent — some tools catch all exceptions and return error strings, others let exceptions propagate. The persistent Docker shell mechanism uses stdin/stdout piping with sentinel markers, which is fragile (broken pipes, output buffering issues, no timeout on blocked commands). There's no authentication on the Gradio interface, and no rate limiting on tool execution beyond the LLM-level rate limiter.

**Recommendations.**
- Split `src/main.py` into at least three modules: agent/graph setup, session lifecycle, and Gradio UI. The current file is the single biggest barrier to contribution.
- Add timeouts to the persistent shell's `readline()` loop — a hung command will block the agent forever.
- Consider adding command validation or at least logging for shell tool invocations, especially since they run privileged.
- The dead graph definition (lines 199–211) and commented-out UI code should be removed to reduce confusion.
- The `llm.py` context length lookup is incomplete (only handles `gpt-4o` and `gemini-2.0`); the hardcoded `128e3` fallback may cause incorrect behavior with newer models.
