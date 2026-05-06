---
title: "Analyzing GhidraMCP"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/LaurieWired/GhidraMCP
tags: [java, python, mcp, reverse-engineering, ghidra, ai-agents, llm-tool-use]
---

# Analyzing GhidraMCP

> **Source:** [LaurieWired/GhidraMCP](https://github.com/LaurieWired/GhidraMCP) @ [`27f316f`](https://github.com/LaurieWired/GhidraMCP/commit/27f316f80139e2d5dec882519a1bdf4aa46ac04c) · 8.8k ⭐ · Apache-2.0

## How It Works

GhidraMCP bridges Ghidra's reverse engineering capabilities to LLMs via the Model Context Protocol (MCP). It is a two-part system: a **Ghidra plugin** (Java) that embeds an HTTP server inside the Ghidra GUI, and a **Python MCP bridge** (`bridge_mcp_ghidra.py`) that translates MCP tool calls into HTTP requests against that server. The LLM sees ~25 tools for reading and mutating the Ghidra program database — decompiling functions, renaming symbols, setting comments, cross-referencing addresses, listing strings, and so on. An LLM connected via Claude Desktop, Cline, or any MCP client can drive an interactive reverse engineering session entirely through natural language.

The system is deliberately simple. There is no authentication, no state management beyond Ghidra's own program database, and no abstraction layer between the MCP tool definitions and the raw HTTP endpoints. Every MCP tool is a thin wrapper that calls `safe_get` or `safe_post` against the Ghidra HTTP server and returns the plain-text response.

## Architecture

```
┌──────────────┐       stdio/SSE        ┌─────────────────────┐       HTTP        ┌──────────────────┐
│  MCP Client   │ ◄──────────────────► │ bridge_mcp_ghidra.py │ ◄──────────────► │ GhidraMCPPlugin   │
│ (Claude, etc) │                       │   (FastMCP server)    │                   │  (HttpServer in    │
└──────────────┘                       └─────────────────────┘                   │   Ghidra JVM)      │
                                                                                   └────────┬─────────┘
                                                                                            │
                                                                                   ┌────────▼─────────┐
                                                                                   │  Ghidra Program   │
                                                                                   │  Database API     │
                                                                                   └──────────────────┘
```

**Ghidra Plugin (Java, 1651 LOC):** A single-file Ghidra extension (`GhidraMCPPlugin.java`) that extends Ghidra's `Plugin` class. On construction, it starts a `com.sun.net.httpserver.HttpServer` on a configurable port (default 8080). It registers ~20 HTTP context handlers (`/decompile`, `/renameFunction`, `/xrefs_to`, `/strings`, etc.) that directly call Ghidra's internal APIs — `DecompInterface`, `FunctionManager`, `SymbolTable`, `ReferenceManager`, `HighFunctionDBUtil`. Mutating operations are wrapped in Ghidra transactions and dispatched to the Swing EDT via `SwingUtilities.invokeAndWait()`.

**MCP Bridge (Python, 338 LOC):** A single-file MCP server built on `FastMCP` from the `mcp` Python SDK. It defines ~25 `@mcp.tool()` decorated functions that map 1:1 to the HTTP endpoints. Two helper functions (`safe_get`, `safe_post`) handle all HTTP communication with a 5-second timeout. Supports both `stdio` (default, for Claude Desktop) and `sse` transport modes.

**Build system:** Maven with system-scoped Ghidra JARs (8 JARs copied from a local Ghidra installation into `lib/`). The assembly plugin packages the plugin as a ZIP extension for Ghidra's `Install Extensions` mechanism. CI downloads Ghidra 11.3.2, copies the required JARs, builds, and uploads the artifact.

## The Spine

A typical reverse engineering request follows this path:

1. **LLM generates tool call** → MCP client serializes the call (e.g., `decompile_function(name="FUN_140001000")`)
2. **MCP bridge receives it** → `safe_post("decompile", name)` → HTTP POST to `http://127.0.0.1:8080/decompile`
3. **Ghidra HTTP handler** → `decompileFunctionByName(name)` → creates a `DecompInterface`, looks up the `Function` object, calls `decompileFunction()`, returns the decompiled C pseudocode as plain text
4. **Response flows back** → Python returns the text string → MCP serializes it → LLM reads the decompiled code and reasons about it

For mutating operations (rename, set comment, set type), the Java side wraps everything in a Ghidra transaction on the EDT. The `AtomicBoolean` + `invokeAndWait` pattern is used consistently to bridge the HTTP handler thread to Ghidra's Swing threading model.

## Key Patterns

**Single-file monolith in both languages.** The entire Java plugin is one 1651-line class. The entire Python bridge is one 338-line script. No modules, no packages, no internal architecture beyond methods grouped by functionality with comment banners.

**No serialization format — plain text everywhere.** The HTTP server returns raw newline-delimited text. No JSON, no structured error codes. The Python bridge splits GET responses by newlines (`response.text.splitlines()`) and joins them back for tools that return strings. POST responses are returned as-is stripped strings. Error responses are strings prefixed with `"Error {status_code}:"` or `"Request failed:"`.

**Pagination as manual offset/limit.** Every listing endpoint accepts `offset` and `limit` query parameters. The Java side materializes the *entire list into memory first*, then slices with `subList()`. For a binary with thousands of functions, `/list_functions` (the unpaged variant) returns everything — the Ghidra API is fully iterated into a `StringBuilder` before pagination is applied.

**Swing EDT dispatch for all mutations.** Every write operation (rename, comment, type change) uses the `SwingUtilities.invokeAndWait()` + `AtomicBoolean` + transaction pattern. This is correct for Ghidra — its program database is not thread-safe and must be modified from the EDT. But it means every mutation blocks the HTTP handler thread until the EDT is free.

**Windows reverse engineering bias.** The data type resolver in `resolveDataType()` handles Windows-style types like `DWORD`, `WORD`, `PVOID`, and `__int64`. The `P` prefix heuristic (strip leading `P` to get the pointer base type) is a Windows convention. This reflects the author's (LaurieWired) focus on Windows malware analysis.

## Non-Obvious Details

**Duplicated tool definitions.** The bridge has overlapping tools: `list_methods()` vs `list_functions()`, `decompile_function()` (POST by name) vs `decompile_function_by_address()` (GET by address). The older name-based endpoints (`/methods`, `/decompile`, `/renameFunction`) use POST and different parameter conventions than the newer address-based endpoints (`/list_functions`, `/decompile_function`, `/rename_function_by_address`). This is evolution, not design — the older API was extended rather than replaced.

**`checkFullCommit` is copy-pasted from Ghidra internals.** The method (lines 675–700) has a comment: "Copied from AbstractDecompilerAction.checkFullCommit, it's protected." It compares the `HighFunction`'s prototype with the `Function`'s stored parameters to decide whether a full commit is needed before renaming a variable. This is a necessary hack because the original method isn't accessible from a plugin.

**The `searchByNameInAllCategories` method is O(n).** It iterates *every* data type in the manager to find by name. The case-insensitive fallback at line 1523 makes the case-sensitive check at line 1519 redundant — both branches return on first match, and `equalsIgnoreCase` is always checked. For large programs with many types, this could be slow, but it's called per-type-change, not per-function.

**No input sanitization on addresses.** Address strings are passed directly to `program.getAddressFactory().getAddress()`. While Ghidra's address factory is reasonably safe, there's no validation that the address string is well-formed hex before it reaches Ghidra.

**The `safe_get`/`safe_post` helpers silently swallow errors.** Every HTTP error or connection failure is returned as a plain string starting with `"Error"` or `"Request failed"`. The MCP tools declare return types as `str` or `list`, so the LLM receives error messages as normal tool output — it must reason about whether the response is actual data or an error message.

**`server.setExecutor(null)` runs handlers on the HttpServer's default thread.** With no executor set, `com.sun.net.httpserver` creates a new thread per request. Combined with the `invokeAndWait` calls, this means mutating operations block an HTTP thread while waiting for the EDT — fine for single-user use, but could deadlock under concurrent requests.

## Assessment

**Strengths:**

- The project does exactly what it promises with minimal complexity. Two files, ~2000 LOC total, and you have a fully functional LLM-driven reverse engineering tool.
- Correct Ghidra integration patterns — EDT dispatch, transaction management, proper use of `DecompInterface` and `HighFunctionDBUtil`.
- The tool surface area is well-chosen for LLM-driven RE: enough read operations to build understanding (decompile, disassemble, xrefs, strings) and enough write operations to progressively annotate the binary (rename, comment, set types).
- Good CI setup that downloads Ghidra and builds the extension automatically.

**Concerns:**

- **Zero authentication.** The HTTP server binds to a configurable address (not just localhost) with no auth. Anyone who can reach the port can decompile your binary, rename symbols, or set arbitrary comments. For a tool that modifies the program database, this is a significant risk in shared environments.
- **Plain-text protocol with no structured errors.** The LLM must parse error messages from regular output. A JSON response format would make tool results unambiguous.
- **Full list materialization before pagination.** Listing endpoints materialize entire collections before slicing. For binaries with tens of thousands of functions, this wastes memory and adds latency for simple paginated queries.
- **Duplicated/evolved API surface.** Two parallel naming conventions (name-based vs address-based) for the same operations create confusion. The LLM must choose between `decompile_function` and `decompile_function_by_address` without clear guidance on when to use which.
- **JUnit 3.8.1 in `pom.xml`.** The test dependency is ancient and the actual test class (`AppTest.java`) is a Maven archetype stub — there are no real tests.

**Recommendations:**

- Add at minimum a local-only bind default and optionally a shared secret header for the HTTP server.
- Migrate to JSON responses with explicit `{ "success": bool, "data": ..., "error": ... }` structure.
- Consolidate the two API styles into one consistent interface (address-based is strictly more general).
- Add a streaming pagination approach or server-side cursor instead of materializing full lists.
- Replace the placeholder test with actual integration tests that exercise the HTTP endpoints.
