---
title: "Analyzing PageIndex"
date: 2026-05-10
type: codebase-analysis
status: complete
source: https://github.com/VectifyAI/PageIndex
tags: [rag, reasoning, document-index, retrieval, llm, ai-agents]
---

## Overview

PageIndex is an open-source Python library from Vectify AI that implements a **vectorless, reasoning-based RAG** system. Instead of relying on vector similarity search and document chunking — the standard approach in most RAG pipelines — PageIndex transforms PDF and Markdown documents into a hierarchical tree index (analogous to a structured table of contents) and then uses LLM reasoning to navigate that tree for retrieval. The project claims 98.7% accuracy on FinanceBench, positioning it as a compelling alternative to traditional vector-based RAG for long, structured professional documents.

The codebase is compact at **~2,900 lines of Python** across 8 source files, plus Jupyter cookbooks, tutorial documentation, and example scripts. It is licensed under MIT and uses LiteLLM for multi-provider LLM access.

## Key Findings

### Architecture

The system operates in two distinct phases:

1. **Indexing** — A PDF or Markdown document is converted into a hierarchical tree structure with node IDs, page ranges, summaries, and (optionally) full text per node.
2. **Retrieval** — An LLM agent navigates the tree structure using three tools: `get_document()`, `get_document_structure()`, and `get_page_content()`, reasoning over which sections are relevant before fetching actual content.

The core source files (`pageindex/`) break down as:

| File | Lines | Purpose |
|------|-------|---------|
| `page_index.py` | 1,153 | PDF indexing pipeline: TOC detection, extraction, transformation, verification, and recursive node subdivision |
| `utils.py` | 710 | LLM wrappers (sync/async via LiteLLM), JSON extraction, tree utilities, token counting, config loader |
| `page_index_md.py` | 341 | Markdown indexing: header-based node extraction, tree building, thinning |
| `client.py` | 234 | `PageIndexClient` class with workspace persistence and lazy-loading |
| `retrieve.py` | 137 | Retrieval tools: document metadata, tree structure, page content extraction |
| `__init__.py` | 4 | Public API exports |

### PDF Indexing Pipeline (`page_index.py`)

The PDF pipeline is the most complex part of the codebase. It follows a multi-stage strategy:

**TOC Detection** (`check_toc`, `find_toc_pages`): Scans the first N pages (default 20) using LLM calls to detect whether the document has a table of contents and whether that TOC includes page numbers.

**Three Processing Modes** (`meta_processor`):
- **`process_toc_with_page_numbers`** — Uses an existing TOC with page references. Extracts the TOC, transforms it to JSON, computes a page offset between TOC page numbers and physical PDF page indices, and maps sections to physical pages.
- **`process_toc_no_page_numbers`** — Has a TOC but no page references. Transforms the TOC to JSON, then uses LLM calls to match section titles against page text to locate physical indices.
- **`process_no_toc`** — No TOC at all. Groups pages into token-bounded batches and uses LLM calls to extract a hierarchical structure directly from the document text.

**Verification and Self-Correction** (`verify_toc`, `fix_incorrect_toc`): After initial extraction, the system samples sections and verifies that each title actually appears on its assigned page using LLM calls. If accuracy exceeds 60%, it attempts to fix incorrect entries with up to 3 retries. If accuracy is below 60%, it falls back to a less sophisticated mode (e.g., from `process_toc_with_page_numbers` to `process_toc_no_page_numbers` to `process_no_toc`).

**Recursive Subdivision** (`process_large_node_recursively`): Nodes exceeding page or token limits are recursively subdivided into sub-trees, creating deeper hierarchy for large documents.

This fallback chain is a notable design choice — the system progressively degrades from relying on document structure to raw LLM extraction, with self-verification at each step.

### Markdown Indexing (`page_index_md.py`)

The Markdown pipeline is simpler and deterministic: it parses `#`-prefixed headers to build a flat node list with levels, associates text between headers to each node, and then constructs a tree. An optional **tree thinning** pass merges small nodes below a token threshold into their parents. Summaries are generated via LLM for leaf nodes, while parent nodes get `prefix_summary` fields.

### Retrieval and Agent Integration

The `PageIndexClient` provides three tool functions designed for agentic use:

- `get_document(doc_id)` — returns metadata (name, description, page/line count)
- `get_document_structure(doc_id)` — returns the tree index without text fields (saves tokens)
- `get_page_content(doc_id, pages)` — returns actual text for specified pages/lines, supporting range formats like `"5-7"`, `"3,8"`, or `"12"`

The demo in `examples/agentic_vectorless_rag_demo.py` shows integration with the OpenAI Agents SDK, where an LLM agent uses these three tools to reason over the tree structure, identify relevant sections, then fetch only the needed page content. This is the "human-like retrieval" pattern — analogous to how a person would scan a table of contents, then turn to specific pages.

The client supports **workspace persistence**: indexed documents are saved as individual JSON files with a `_meta.json` index, enabling lazy-loading of structure and page data on demand.

### LLM Integration

All LLM calls go through LiteLLM (`litellm.completion` / `litellm.acompletion`), enabling multi-provider support. The default model is `gpt-4o-2024-11-20`. A separate `retrieve_model` config (defaulting to `gpt-5.4`) can be used for the retrieval agent, allowing cheaper models for indexing and stronger models for reasoning.

Token counting also uses LiteLLM's built-in counter. The system retries failed LLM calls up to 10 times with 1-second delays.

### Configuration

`pageindex/config.yaml` provides defaults:

```yaml
model: "gpt-4o-2024-11-20"
retrieve_model: "gpt-5.4"
toc_check_page_num: 20
max_page_num_each_node: 10
max_token_num_each_node: 20000
if_add_node_id: "yes"
if_add_node_summary: "yes"
if_add_doc_description: "no"
if_add_node_text: "no"
```

The `ConfigLoader` class merges user overrides with these defaults and validates unknown keys.

### Tree Structure Output

The output is a JSON tree where each node contains:

- `title` — section heading
- `node_id` — zero-padded 4-digit ID (e.g., `"0003"`)
- `start_index` / `end_index` — physical page range (PDF) or line range (MD)
- `summary` — LLM-generated summary of the node's content
- `text` — full text content (optional)
- `nodes` — child nodes

### Code Quality

**Strengths:**
- The self-correcting verification loop (`verify_toc` → `fix_incorrect_toc` → retry or fallback) is a thoughtful pattern that increases robustness.
- Concurrent async operations (`asyncio.gather`) are used for parallel LLM calls during verification and summary generation.
- The `PageIndexClient` with workspace persistence and lazy-loading is well-designed for production use.

**Concerns:**
- The codebase has very little error handling in the traditional sense — most functions assume happy paths and rely on the LLM retry loop in `llm_completion`. A JSON parse failure silently returns `{}`.
- Type hints are absent throughout. Function signatures use bare `model=None` parameters with no documentation of expected formats.
- Some functions are long and tightly coupled. `page_index.py` at 1,153 lines handles TOC detection, extraction, transformation, verification, fixing, and tree building all in one file.
- The `import os` appears twice in `page_index.py` (lines 1 and 8).
- Bare `except:` clauses in `utils.py` (e.g., `extract_json` at line 125) swallow all exceptions.
- No test suite exists in the repository. The only validation is manual via cookbooks and the demo script.
- The `llm_acompletion` function in `utils.py` logs the full prompt on failure, which could leak sensitive document content or API keys in production logs.

### Testing and CI

There are **no unit tests** in the repository. CI consists solely of:
- CodeQL scanning for GitHub Actions (`.github/workflows/codeql.yml`)
- Dependency review on PRs
- Automated issue management (duplicate detection, auto-close labeled issues)

The lack of tests is significant given the complexity of the PDF parsing pipeline — the verification/fixing loop and page offset calculation are particularly testable pieces that would benefit from unit coverage.

### Dependencies

The dependency footprint is minimal (`requirements.txt`):

- `litellm==1.83.7` — multi-provider LLM access
- `PyPDF2==3.0.1` — PDF text extraction
- `pymupdf==1.26.4` — alternative PDF parser
- `python-dotenv==1.2.2` — environment variable loading
- `pyyaml==6.0.2` — configuration
- `openai-agents` — optional, for the agentic demo

## Assessment

**Strengths:**
- The core insight — replacing vector similarity with LLM reasoning over a structured tree index — is well-executed and theoretically sound for structured professional documents. The "similarity ≠ relevance" argument is compelling.
- The self-correcting pipeline with progressive fallback modes is sophisticated and pragmatic.
- The public API is clean: `PageIndexClient.index()` → `get_document()` / `get_document_structure()` / `get_page_content()`.
- The tree structure output is interpretable and debuggable — a significant advantage over opaque vector embeddings.
- Minimal dependencies and a compact codebase make it easy to understand and integrate.

**Concerns:**
- **LLM cost and latency.** The indexing pipeline makes extensive LLM calls: TOC detection per page, TOC extraction, transformation, page number mapping, verification (sampling), and fixing. For a 100-page PDF, this could easily require 20-50+ LLM calls during indexing alone. Summaries add more. This makes indexing expensive and slow compared to embedding-based approaches.
- **No test coverage.** A complex pipeline with multiple fallback modes, recursive subdivision, and self-correction logic desperately needs automated tests.
- **Error handling gaps.** Silent JSON parse failures, bare except clauses, and minimal input validation mean edge cases in real-world PDFs could produce silently corrupted output.
- **PDF parsing quality.** The open-source version uses PyPDF2 for text extraction, which struggles with complex layouts. The project acknowledges this and directs users to their cloud service for enhanced OCR. This means the self-hosted version may produce poor results on many real-world PDFs.
- **Prompt engineering fragility.** Many LLM prompts use f-strings with raw document text injected directly, which could break with unusual characters, very long content, or adversarial inputs.

**Recommendations:**
- Add a test suite covering at minimum: JSON extraction, tree construction, page offset calculation, the verification/fixing loop, and the client's workspace persistence.
- Add type hints and input validation to public API surfaces.
- Consider rate-limiting or batching for LLM calls during indexing to manage costs.
- Extract prompts into a separate module or template system rather than embedding them inline in Python code.

## Related

- [[analyzing-litellm]] — PageIndex uses LiteLLM as its LLM abstraction layer for multi-provider support
- [[analyzing-bifrost]] — Alternative LLM gateway; similar role in RAG pipeline infrastructure
- [[analyzing-graphify]] — Agent framework; complementary to PageIndex's agentic retrieval pattern
- [[analyzing-zeroshot]] — AI tool in the infrastructure layer; related to automated reasoning approaches
