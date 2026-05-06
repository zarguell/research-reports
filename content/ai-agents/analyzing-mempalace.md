---
title: "Analyzing MemPalace"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/MemPalace/mempalace
tags: [python, ai-memory, vector-search, mcp, local-first, claude-code, knowledge-graph]
---

# Analyzing MemPalace

> **Source:** [MemPalace/mempalace](https://github.com/MemPalace/mempalace) @ [`f0d2360`](https://github.com/MemPalace/mempalace/commit/f0d236019abc8cda09b621045511799720a4c6f7)

## How It Works

MemPalace is a local-first AI memory system that stores conversation history and project files as **verbatim text** — no summarization, no paraphrasing, no lossy compression of user data. It uses a spatial metaphor borrowed from the ancient method of loci: content is organized into Wings (people/projects), Rooms (topics), and Drawers (verbatim chunks). A compressed symbolic index layer called AAAK lets an LLM scan thousands of entries in ~900 tokens to find which drawers to open for deep search.

The system runs entirely on your machine. The only runtime dependency beyond Python is ChromaDB (vector store). No API keys are required for core functionality — search, indexing, mining, and the knowledge graph all work offline. Optional LLM integration (for entity refinement or search reranking) is explicitly opt-in with a privacy consent gate.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                 CLI / MCP Server (29 tools)              │
│         mempalace (CLI)    mempalace-mcp (stdio)         │
└──────────┬──────────────────────┬────────────────────────┘
           │                      │
     ┌─────▼─────┐         ┌─────▼──────┐
     │  Searcher  │         │  Knowledge │
     │ BM25+Vec  │         │   Graph    │
     │  Hybrid   │         │  (SQLite)  │
     └─────┬─────┘         └────────────┘
           │
     ┌─────▼──────────────────────────┐
     │    Backend (RFC 001, pluggable) │
     │  BaseBackend → ChromaBackend   │
     └─────┬────────────┬────────────┘
          Drawers      Closets
       (verbatim)     (AAAK index)
```

**Memory is loaded in four layers:**
- **L0 (Identity):** ~100 tokens — always loaded, user-defined
- **L1 (Essential Story):** ~500–800 tokens — top moments auto-selected by importance score
- **L2 (On-Demand):** ~200–500 tokens — wing/room-filtered retrieval
- **L3 (Deep Search):** unlimited — full hybrid BM25+vector semantic search

Wake-up cost (L0+L1) is ~600–900 tokens, leaving 95%+ of context window free for the actual task.

## The Spine

The primary entry points are the **CLI** (`mempalace/cli.py`, 12 commands) and the **MCP server** (`mempalace/mcp_server.py`, 29 tools over hand-rolled JSON-RPC 2.0 on stdio — no SDK dependency).

**Mining flow:** `mempalace mine <path>` → scan files (respecting `.gitignore`) → normalize → chunk (800 char, 100 overlap) → compute deterministic drawer IDs (SHA-256 of source+index+content) → upsert to ChromaDB → build AAAK closet index.

**Search flow:** `mempalace search "query"` → vector query (ChromaDB HNSW cosine) → optional BM25 union expansion via FTS5 → Okapi-BM25 re-ranking (k1=1.5, b=0.75) → convex fusion (60% vector, 40% BM25) → optional neighbor expansion (±radius chunks for context).

**MCP tool call:** Claude Code sends JSON-RPC `tools/call` → argument whitelisting + type coercion → dispatch to handler function → write-ahead log (content redacted) → return result.

## Key Patterns

**Pluggable backends (RFC 001).** An abstract `BaseBackend` and `BaseCollection` interface in `backends/base.py` defines the storage contract. ChromaDB is the default implementation, but any backend can be swapped in by subclassing and registering. Typed result objects (`QueryResult`, `GetResult`) replace raw dicts, and an error hierarchy (`BackendError`, `PalaceNotFoundError`, `DimensionMismatchError`) gives structured failure modes.

**AAAK compression dialect.** The `dialect.py` module compresses verbatim drawer content into a structured symbolic format designed to be natively readable by both humans and LLMs — no decoder needed. Each entry encodes entities (3-char codes), topic keywords, a key quote, importance weight, emotion codes (28 emotions), and semantic flags (ORIGIN, CORE, SENSITIVE, PIVOT, etc.). This achieves ~30x size reduction on the index layer while preserving semantic searchability.

**Deterministic deduplication.** Drawer IDs are SHA-256 hashes of `source_file + chunk_index + normalize_version + content[:200]`. Re-mining the same file atomically deletes old drawers before inserting new ones. A version counter (`NORMALIZE_VERSION = 2`) ensures schema changes trigger silent rebuilds.

**Corruption resilience.** The system has multiple defensive layers: cross-platform file locking (fcntl/msvcrt) with fork-safety via PID tracking, HNSW corruption auto-detection that falls back to BM25-only search via FTS5, write-ahead logging with sensitive content redaction, and per-collection ChromaDB locking with re-entrant acquisition.

**Temporal knowledge graph.** SQLite-backed entity-relationship graph with `valid_from`/`valid_to` time windows on every triple. Queries use range-overlap patterns that handle four cases: always-valid, forward-valid, windowed, and invalidated facts. Auto-creates entities when adding triples.

## Non-Obvious Details

**Hand-rolled MCP server.** Rather than depending on the official MCP SDK, the server implements JSON-RPC 2.0 directly over stdio. This gives them tight control over argument whitelisting, type coercion, protocol version negotiation (supporting 4 MCP protocol versions), and stdio FD management (saving real stdout before redirecting stderr). The `TOOLS` dict maps tool names to `{description, input_schema, handler}` — adding a tool means writing a handler function and a dict entry.

**Sentinel registration.** Files that produce zero mineable chunks get a `_reg_` sentinel entry in ChromaDB, preventing them from being re-scanned on every mine run. This is a subtle but important optimization for codebases with many small or binary files.

**BM25 IDF over candidates, not corpus.** The hybrid search computes BM25 IDF over the candidate set returned by the vector query, not the full corpus. This is the correct approach for re-ranking: you're scoring how well the query terms discriminate among the *already-retrieved* candidates, not among all documents.

**`_vector_disabled` flag.** When ChromaDB's HNSW index segments diverge from the SQLite metadata (a known corruption mode), the search silently switches to BM25-only mode using ChromaDB's FTS5 trigram index. The user sees degraded performance but never loses access to their data. This is detected automatically, not requiring manual repair.

**Entity disambiguation via Wikipedia.** The entity registry has a three-tier knowledge hierarchy: onboarding (user-told) > learned (inferred) > researched (Wikipedia API). The Wikipedia lookup checks for name indicator phrases ("given name", "Irish name") vs. place indicators ("city in", "capital of") to classify unknown words. Network access is opt-in and gated behind `allow_network=True`.

**Privacy-by-architecture enforcement.** The WAL log redacts `content`, `query`, and `text` fields before writing. External API keys are only loaded from environment variables after an explicit consent gate in the init flow. The CLAUDE.md design principles explicitly reject telemetry, phone-home, and any feature requiring API keys for core memory operations.

## Assessment

**Strengths:**
- Remarkably lean dependency footprint — 2 runtime deps (chromadb, pyyaml). No heavy ML frameworks.
- Privacy architecture is genuinely local-first, not "local-first but..." — zero external calls unless explicitly enabled.
- The AAAK compression format is clever: ~30x reduction on the index layer while remaining LLM-readable without a decoder. The emotion coding and entity abbreviation system is well-thought-out.
- Corruption resilience is production-grade: HNSW fallback, write-ahead logging, re-entrant locking, graceful degradation at every layer.
- 85% test coverage floor with 74 test files covering every subsystem. Test organization mirrors source structure.
- The 4-layer memory stack is a practical solution to the context window problem — 900 tokens for wake-up leaves most of the budget for actual work.

**Concerns:**
- The MCP server at 2,171 lines is the largest single file and growing. 29 tools with inline handlers in one dict makes the file hard to navigate. A plugin/handler registration pattern would scale better.
- AAAK compression is lossy and regex-based — the emotion detection and flag detection rely on keyword matching, which won't handle nuance, sarcasm, or non-English text well despite i18n support for entity detection.
- The `mempalace init` command runs 5 passes including optional LLM calls, making it heavy for first-time setup. The deprecation of `--llm` (now on by default, opt-out with `--no-llm`) is a subtle breaking change.
- No obvious migration path between vector embedding models — the `EmbedderIdentityMismatchError` exists but the resolution path (delete and rebuild) is destructive.
- 51k GitHub stars for a project that launched recently is unusually high and worth verifying for legitimacy. The repo's own scam alert (`mempalace.tech` is an impostor) underscores this.

**Recommendations:**
- Worth investigating as a memory layer for Claude Code or similar agent workflows — the hook integration and MCP server are purpose-built for this. The `wake-up` command producing a 900-token context injection is immediately usable.
- The verbatim-only design philosophy is a genuine differentiator vs. summarization-based approaches (Mem0, Zep). Evaluate whether the storage cost tradeoff is acceptable for your use case.
- Test with real conversation data before committing — the entity detection and room routing are heuristic and may need tuning for domain-specific jargon or multilingual content.
