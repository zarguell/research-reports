---
title: "Analyzing Graphify"
date: 2026-05-07
type: codebase-analysis
status: complete
source: https://github.com/safishamsi/graphify
tags: [python, tree-sitter, knowledge-graph, llm, claude-code, mcp, community-detection, networkx, ai-agents]
---

# Analyzing Graphify

> **Source:** [safishamsi/graphify](https://github.com/safishamsi/graphify) @ [`ef1050b`](https://github.com/safishamsi/graphify/commit/ef1050b0e4134df0bd59956b0f900dc3c83e8184)

## How It Works

Graphify converts any folder of code, docs, papers, images, or video into a queryable knowledge graph. The tool is designed as a Claude Code skill — invoked by typing `/graphify .` inside an AI coding assistant — but the Python library underneath is fully usable standalone. The core idea: instead of grepping through files or relying on RAG chunk retrieval, build a structured graph of entities and relationships that captures *how things connect*, then let the LLM navigate that graph to answer questions.

The pipeline has two extraction paths that run in parallel. **Structural extraction** (AST) uses tree-sitter to parse code files locally — no API calls, no network. It extracts classes, functions, imports, and call relationships with deterministic accuracy. **Semantic extraction** (LLM) sends documents, papers, and images through an AI model to extract concepts, rationale, citations, and cross-cutting relationships that AST can't find. The two outputs merge into a single graph where every edge carries a confidence label: `EXTRACTED` (explicit in source), `INFERRED` (reasonable deduction), or `AMBIGUOUS` (uncertain).

Community detection (Leiden algorithm) then groups related nodes, producing "god nodes" (most-connected entities), surprising connections (cross-community bridges), and suggested questions. The final outputs are three files: an interactive HTML visualization, a `GRAPH_REPORT.md` audit trail, and a `graph.json` for programmatic access.

## Architecture

```
detect() → extract() → build_graph() → cluster() → analyze() → report() → export()
```

Each stage is a single function in its own module, communicating through plain Python dicts and NetworkX graphs. There is no shared state, no database, and no side effects outside the `graphify-out/` directory.

```
graphify/
├── __init__.py          lazy-attr re-exports (for fast `graphify install`)
├── __main__.py          CLI entry, install/platform config, hooks
├── detect.py            file discovery, type classification, .graphifyignore
├── extract.py           AST extraction via tree-sitter (~5000 lines)
├── build.py             graph assembly, dedup, merge
├── dedup.py             MinHash/LSH + Jaro-Winkler entity dedup
├── cluster.py           Leiden community detection
├── analyze.py           god nodes, surprising connections, questions
├── report.py            GRAPH_REPORT.md generation
├── export.py            JSON, HTML, SVG, GraphML, Neo4j, Obsidian vault
├── serve.py             MCP stdio server
├── llm.py               direct LLM backend (Gemini, Claude, Kimi, OpenAI, Ollama)
├── cache.py             SHA256-based per-file extraction cache
├── security.py          URL validation, SSRF protection, label sanitization
├── validate.py          extraction schema validation
├── skill.md             Claude Code skill prompt (1029 lines)
└── skill-*.md           platform-specific skill variants (15 files)
```

## The Spine

There are three distinct entry points:

1. **Skill invocation** (`/graphify`): The primary path. `skill.md` is a 1000+ line prompt that instructs the Claude Code agent through a step-by-step pipeline — detect files, run AST extraction, dispatch parallel LLM subagents for semantic extraction, merge results, build the graph, cluster, analyze, and export. The skill is the orchestrator; the Python library is the worker.

2. **CLI** (`graphify install`, `graphify extract`, `graphify query`, `graphify serve`): The `__main__.py` module handles platform installation (copying skill files to 15+ platform-specific directories), hook management, and direct commands for headless CI usage. `graphify extract . --backend gemini` bypasses the skill entirely, calling the LLM backend directly.

3. **MCP server** (`python -m graphify.serve`): Loads `graph.json` into memory and exposes seven tools — `query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path` — via stdio JSON-RPC. This is how agents get structured graph access rather than reading the raw JSON.

## Key Patterns

**Dual extraction, single graph.** AST and semantic extraction are architecturally separate but converge at `build_from_json()`. AST nodes go first, semantic nodes overwrite by ID (NetworkX is idempotent on `add_node`). This means semantic labels take precedence for the same entity — intentional, since LLM output is richer.

**LanguageConfig dataclass.** Rather than 28 separate extraction functions, `extract.py` uses a `LanguageConfig` dataclass that declares node types, import types, call types, and naming conventions per language. A generic `_extract_generic()` function drives all languages — adding a new language means filling in the dataclass, not writing a new parser. There are currently 28+ tree-sitter grammars as hard dependencies.

**Confidence scoring as a first-class concept.** Every edge carries `confidence` (EXTRACTED/INFERRED/AMBIGUOUS) and `confidence_score` (a float). The skill prompt enforces a discrete rubric (0.55, 0.65, 0.75, 0.85, 0.95) rather than continuous values, because production data showed models collapsing to a bimodal distribution when given free-range floats. Analysis, reporting, and query all use these labels to filter and rank.

**Three-layer deduplication.** Entity dedup happens at three levels: within-file (AST tracker), between-file (label normalization + edge rewriting in `build.py`), and semantic (MinHash/LSH blocking → Jaro-Winkler verification → union-find merge in `dedup.py`). The semantic layer uses Shannon entropy gating to avoid false positives on short labels like "run" or "parse".

**Per-file SHA256 cache.** Both AST and semantic extractions are cached by content hash in `graphify-out/cache/`. Markdown files strip YAML frontmatter before hashing, so metadata-only edits don't invalidate the cache. The `--update` flag only re-extracts changed files.

## Non-Obvious Details

**The skill.md IS the application.** The 1029-line `skill.md` is not documentation — it's executable instructions for the Claude Code agent. It contains shell commands to run, JSON schemas to output, merging logic to execute, and even conditional branching (skip semantic extraction for code-only corpora, different prompt strategies for video). The Python library is a toolkit; the skill is the orchestrator. This means the "program" runs inside an LLM context window, with all the brittleness that implies.

**SSRF protection via socket monkey-patching.** `security.py` patches `socket.getaddrinfo` during HTTP fetches to catch DNS rebinding attacks — validate the URL against a public IP, then the DNS server swaps to a private IP for the actual connection. This TOCTOU fix is done via a context manager, not thread-safe by design (graphify is single-threaded).

**`_resolve_js_module_path` mirrors Vite's resolver.** The JS/TS import resolver tries 5 strategies in order: exact file, TS ESM convention (`.js` → `.ts`), full filename extension append, then directory index lookup. This prevents phantom nodes when imports omit extensions — a common source of lost edges in JavaScript project graphs.

**Graph merge driver for git.** `graphify hook install` sets up a git merge driver for `graph.json` that union-merges nodes and edges instead of leaving conflict markers. Two developers committing in parallel get their graphs merged automatically.

**`_CLAUDE_MD_MARKER` injection.** When installing for Claude Code, graphify injects a `## graphify` section into `~/.claude/CLAUDE.md` that tells the agent to always read `GRAPH_REPORT.md` before answering codebase questions. The Claude hook fires on every `grep`/`find`/`rg` bash command, reminding the agent the graph exists. This is a surprisingly effective pattern for steering LLM behavior at the IDE level.

## Assessment

**Strengths.** The dual AST+semantic extraction is genuinely useful — AST gives precision, LLM gives coverage, and the confidence labels let consumers filter by trust level. The 28-language tree-sitter support is thorough. The deduplication pipeline (MinHash → Jaro-Winkler → union-find) is sophisticated and well-tested (~7200 lines of tests). The security model (SSRF protection, label sanitization, path guards) is stronger than most developer tools. The `.graphifyignore` implementation properly handles negation patterns and nested configs matching gitignore semantics.

**Concerns.** The `skill.md`-as-orchestrator pattern is inherently fragile. The "application" is a 1000-line prompt executed by an LLM, meaning any refactor of the prompt can subtly change behavior. There's no integration testing of the full skill pipeline — only unit tests for individual modules. The `extract.py` file at 5000 lines is a monolith despite the LanguageConfig abstraction; the generic extraction function plus 28 language configs and all the import handlers create significant complexity in a single file. The `__main__.py` at 2445 lines mixes CLI logic, platform installation, hook generation, and version management.

**Recommendations.** The extract module would benefit from splitting language-specific import handlers into separate files (e.g., `extract_python.py`, `extract_js.py`) while keeping the generic walker in `extract.py`. The skill.md should ideally be generated from a template with the Python library, reducing the risk of drift between documented and actual behavior. For the `__main__.py`, the platform config table and hook/gemini/antigravity install functions could move to an `install.py` module.
