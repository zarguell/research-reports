---
title: "Analyzing Knowledge Graph-Based Hybrid RAG System"
date: 2026-05-15
type: codebase-analysis
status: complete
source: https://github.com/safishamsi/Knowledge-Graph-Based-Hybrid-RAG-System
tags: [rag, knowledge-graph, neo4j, langchain, langgraph, embeddings, faiss, academic-search, python]
---

## Overview

This repo is an MSc dissertation project from the University of Birmingham (supervised by Prof. Paolo Missier, 2025) that builds a hybrid RAG system for academic research discovery. It combines a Neo4j knowledge graph (61,945 papers, 189,972 authors from Scopus data) with semantic embeddings (SBERT + FAISS) and LLM synthesis (Claude 3.5 Sonnet via LangChain/LangGraph) to produce research recommendations, collaborator discovery, and trend analysis. The project claims 50% better search relevance (NDCG@10: 0.814), 57.5% reduction in citation bias, and 67% fewer hallucinations compared to traditional approaches.

The analysis covers commit `34ca0c2` on `main`.

## Key Findings

### Architecture

The system has four layers:

1. **Data ingestion** (`scopusscraping/`) — Scopus API → JSON → Neo4j via `kgbuilder.py`
2. **Knowledge graph** (`Neo4jKG/`) — Four node types (Document, Author, Publication, Affiliation) with five relationship types (AUTHOR_OF, CO_AUTHOR, AFFILIATED_WITH, DOC_PUBLISHED_IN, AUTH_PUBLISHED_IN)
3. **RAG pipeline** (`RAG/`, `embeddings/`) — `enhancedretrieval.py` combines keyword search, graph traversal, and FAISS semantic search with a weighted scoring function. `retrievalqueries.py` provides author/institution-specific queries. `collaboration.py` adds community detection and trend analysis via NetworkX.
4. **LLM orchestration** (`LLMpoweredRAG.py`) — A LangGraph `StateGraph` with five sequential nodes: `search_papers` → `find_researchers` → `analyze_networks` → `analyze_trends` → `synthesize`. Each populates a field in `ResearchState`, and the final node prompts Claude 3.5 Sonnet to produce a natural-language synthesis.

### Knowledge Graph Construction

`kgbuilder.py` is the most substantial file (~600 lines). It handles:

- Batched node/relationship creation with deduplication (MERGE for Documents, UPSERT pattern for Authors with iterative affiliation accumulation)
- Constraint enforcement (UNIQUE on `eid` for Documents, `authid` for Authors, `affid` for Affiliations, `pubid` for Publications)
- Retry logic with exponential backoff for Neo4j transient errors
- Relationship provenance: Document IDs are stored on each relationship edge so the origin can be traced

The schema is clean and well-suited for academic data. The CO_AUTHOR relationship creates a natural collaboration network.

### Hybrid Retrieval

`enhancedretrieval.py` implements the core hybrid approach:

```python
# Weighted scoring across three retrieval methods
final_score = (
    0.3 * normalized_keyword_score +
    0.4 * normalized_graph_score +
    0.3 * normalized_semantic_score
)
```

- **Keyword search**: Case-insensitive Cypher `CONTAINS` on titles and abstracts
- **Graph search**: Traverses AUTHOR_OF, CO_AUTHOR, AFFILIATED_WITH relationships starting from a query-expanded set of author/institution nodes
- **Semantic search**: SBERT (`all-MiniLM-L6-v2`) embeddings with FAISS `IndexFlatL2`, returning similarity scores normalized to [0,1]

The 40% weight on graph traversal is the distinguishing feature — it surfaces papers through author and collaboration relationships, not just text similarity.

### LLM Orchestration

The LangGraph pipeline is a simple linear chain (no conditional branching or cycles). Each node catches exceptions and writes error messages into state rather than propagating failures. The synthesize node constructs a detailed prompt from all four preceding outputs and invokes Claude with `temperature=0.1` and `max_tokens=4000`.

### Hardcoded Credentials and Institutional Scope

The Neo4j connection uses a hardcoded password (`12345678`) and the system is tightly scoped to University of Birmingham affiliations. The `kgbuilder.py` constructor defines Birmingham-specific institutions and the `SmartResearchAssistant` prompt explicitly frames output around Birmingham strengths. This is appropriate for a dissertation but limits reusability.

### Code Quality

- No tests, CI, linting, or type checking (beyond `TypedDict` hints)
- No `requirements.txt` at the project root — dependencies are scattered across three `requirements-*.txt` files in subdirectories
- `LLMpoweredRAG.py` references module-level variables (`rag`, `research_assistant`, `collab_trend_analyzer`) that must be imported from other files, but there's no `__init__.py` or documented import order. The `create_smart_assistant()` function would fail without prior imports
- The `embeddings/` module exports a class meant for Jupyter notebook use (uses `display(HTML(...))` from IPython) — not standalone-script compatible
- No environment variable validation beyond the Anthropic API key check
- Several bare `except: pass` clauses in the database cleanup code

### Data Pipeline

The Scopus scraping module (`scopusscraping/scopusscrap.ipynb`) is a Jupyter notebook — not a reusable script. It queries Scopus by University of Birmingham affiliation IDs and writes results to JSON. The `kgbuilder.py` then ingests these JSON files. The data directory contains only a CSV of Birmingham affiliation IDs and `.gitkeep` placeholders, so the system cannot be built without Scopus API access and pre-existing Neo4j data.

## Assessment

**Strengths:**

- The hybrid retrieval concept is sound — combining graph traversal (40% weight) with keyword and semantic search addresses real weaknesses in pure vector search for academic data, where author relationships and institutional context matter as much as text similarity
- The knowledge graph schema is well-designed for academic data, with clean provenance tracking on relationships
- The LangGraph orchestration provides a clear, extensible pipeline structure
- The collaboration detection and trend analysis features add genuine value beyond simple search

**Concerns:**

- **Not reproducible.** There are no tests, no Docker setup, no root-level requirements file, and the data pipeline requires Scopus API credentials plus pre-populated Neo4j data. A researcher cloning this repo cannot run the system without significant manual setup
- **Hardcoded credentials.** Neo4j password in plaintext. The Anthropic API key is at least read from an environment variable
- **No configuration layer.** Birmingham institutions, Neo4j connection details, model parameters, and retrieval weights are all hardcoded. Making this work for another university or dataset would require edits across multiple files
- **Single LLM call for synthesis.** The entire pipeline funnels into one Claude invocation. There's no chain-of-thought, self-critique, or iterative refinement. For a system claiming to reduce hallucinations, the verification step is the LLM itself — a circular argument
- **Missing abstractions.** The "Fixed" class naming (`FixedAcademicRAGSystem`, `semantic_search_with_authors_fixed`) suggests iterative debugging without proper versioning. Module-level globals in `LLMpoweredRAG.py` create fragile initialization order dependencies

**Recommendations for anyone building on this:**

- Parameterize the institution scope, Neo4j connection, and model configuration via a single config file or environment variables
- Add integration tests with a small fixture dataset (even 50–100 papers would validate the pipeline)
- Replace the single-synthesize pattern with a multi-step LLM chain that cross-checks graph evidence against generated claims
- Containerize with Docker Compose (Neo4j + Python service) for reproducibility
- Extract the hybrid scoring weights into a tunable configuration — the 0.3/0.4/0.3 split deserves empirical validation

## Related

- [[analyzing-hermes-agent]]
- [[analyzing-litellm]]
