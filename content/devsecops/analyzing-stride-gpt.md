---
title: "Analyzing STRIDE-GPT"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/mrwadams/stride-gpt
tags: [python, streamlit, security, threat-modeling, llm-security, owasp, stride, devsecops]
---

# Analyzing STRIDE-GPT

> **Source:** [mrwadams/stride-gpt](https://github.com/mrwadams/stride-gpt) @ [`9e70871`](https://github.com/mrwadams/stride-gpt/commit/9e70871959c0e88ef5ab1afbf654f0c294968ea6)

## How It Works

STRIDE-GPT is a Streamlit-based tool that uses LLMs to automate threat modeling. The user describes an application (or points it at a GitHub repo), and the tool generates a STRIDE threat model, attack trees, mitigations, DREAD risk scores, and Gherkin test cases — all through LLM prompting rather than any deterministic analysis engine.

The core loop is straightforward: collect application context → build a detailed system prompt → send it to an LLM → parse the structured JSON response → render as markdown. There is no security scanning, no static analysis, no rule engine. The entire value proposition rests on prompt engineering and the LLM's ability to reason about threats.

What differentiates it from a generic "ask GPT to threat model my app" wrapper is the depth of its prompt templates. The tool ships with extensive STRIDE methodology prompts, OWASP LLM Top 10 mappings (LLM01–LLM10), OWASP Agentic AI Top 10 mappings (ASI01–ASI10), and architectural pattern detection for agentic systems (RAG, multi-agent, code execution, MCP tools, persistent memory). These prompts are substantial — the agentic threat model prompt alone runs hundreds of lines, embedding detailed threat taxonomies directly into the LLM context.

## Architecture

```
main.py (1973 lines — Streamlit UI + orchestration)
├── threat_model.py  (924 lines — STRIDE threat generation)
├── attack_tree.py   (779 lines — Mermaid attack tree generation)
├── dread.py         (667 lines — DREAD risk scoring)
├── test_cases.py    (653 lines — Gherkin test case generation)
├── mitigations.py   (485 lines — Mitigation recommendations)
└── utils.py         (167 lines — Mermaid parsing, reasoning extraction, helpers)
```

The architecture is flat — six Python files in a single directory, no packages, no abstractions. `main.py` is the entry point and contains all UI logic, session state management, GitHub repo analysis, and the provider dispatch pattern. The other five files each export one prompt-builder function and seven provider-specific LLM call functions (OpenAI, Anthropic, Google, Mistral, Groq, Ollama, LM Studio).

The data flow is linear and stateless between phases:

```
User Input / GitHub Repo Analysis
  → Threat Model (JSON from LLM)
    → Attack Tree (Mermaid from LLM)
    → Mitigations (Markdown from LLM)
    → DREAD Assessment (JSON from LLM)
    → Test Cases (Gherkin from LLM)
```

Each phase depends on the threat model output stored in `st.session_state`. There is no persistence — everything lives in Streamlit session state.

## The Spine

**Entry point:** `streamlit run main.py` → Streamlit renders a multi-tab UI.

**User input collection** (`get_input()` in main.py): The user optionally provides a GitHub URL, which triggers `analyze_github_repo()` — a function that uses PyGithub to fetch the README and code files, summarizes them via regex-based extraction (imports, classes, functions), and assembles a token-budgeted system description. This description is prepended to the user's manual application description.

**Provider dispatch pattern:** Every generation step follows an identical if/elif chain across seven providers. There are five generation steps × seven providers = 35 near-identical call sites. Each module exports functions like `get_threat_model()`, `get_threat_model_anthropic()`, `get_threat_model_google()`, etc. The only differences between provider variants are the client SDK used and minor parameter handling (e.g., `max_completion_tokens` for OpenAI reasoning models, Extended Thinking for Anthropic).

**Response handling:** LLM responses are expected as JSON (for threat models and DREAD assessments) or raw text (for attack trees, mitigations, test cases). JSON is parsed and converted to markdown tables via `json_to_markdown()` and `dread_json_to_markdown()`. Mermaid diagram code is extracted and cleaned via `extract_mermaid_code()` and rendered using Streamlit's `components.html()` with a Mermaid CDN embed.

## Key Patterns

**Prompt-driven architecture.** The entire system is its prompt templates. There is no domain model, no threat taxonomy data structure, no intermediate representation. The prompts in `threat_model.py` (particularly `create_llm_stride_prompt_section()` and `create_agentic_stride_prompt_section()`) are the most valuable intellectual property in the repo — they encode detailed STRIDE↔OWASP mappings with scenario guidance that steers the LLM's output.

**Multi-provider parity through duplication.** Rather than abstracting behind a common interface, each provider gets its own function. This is the most obvious refactoring opportunity — a single adapter layer could eliminate ~70% of the code.

**Application-type branching.** Three application types drive behavior: "Web Application", "Generative AI application", and "Agentic AI application". The type determines which prompt sections are included and which JSON fields are expected in the response. Agentic apps get the full LLM + ASI prompt treatment; GenAI apps get LLM only; web apps get vanilla STRIDE.

**Session state as database.** All inter-tab communication happens through `st.session_state` keys like `threat_model`, `dread_assessment`, `app_input`, and `app_type`. No validation or schema enforcement on what's stored.

**Regex-based code summarization.** The GitHub repo analyzer extracts imports, functions, and classes using language-specific regex patterns. It's intentionally lossy — a heuristic summary rather than AST parsing — designed to fit within the LLM's context window.

## Non-Obvious Details

**Token budget management in GitHub analysis.** The `analyze_github_repo()` function implements a token-aware file processing pipeline: it reads the README first (up to 70% of the analysis budget), then iterates through code files sorted by importance score until the token budget is exhausted. Files are prioritized by naming convention (main.py > test files > other code). This is a practical approach to the context window problem but the token estimation uses tiktoken's OpenAI encoding even for non-OpenAI models.

**Dead code in the GitHub analyzer.** Line 297 computes `max(int(analysis_token_limit * 0.3), analysis_token_limit - readme_tokens)` but never assigns the result to anything — the value is discarded. This looks like a leftover from refactoring the budget allocation logic.

**Mermaid syntax repair.** `clean_mermaid_syntax()` in utils.py applies multiple regex passes to fix common LLM-generated Mermaid issues: missing brackets around node labels, unquoted labels with spaces, and spacing around arrows. This is pragmatic — LLMs frequently generate slightly malformed Mermaid — but the regex approach is fragile and some fixes are applied in sequence where later passes could undo earlier ones.

**DeepSeek reasoning extraction.** `extract_deepseek_reasoning()` parses the ` Think... ` tags from DeepSeek R1 responses via Groq. The thinking content is extracted and displayed in a Streamlit expander, separate from the final output. This is handled only for Groq's DeepSeek model, not for other reasoning models.

**No output validation against prompt schema.** The JSON response from the LLM is parsed with `json.loads()` but never validated against the schema described in the prompt. If the LLM returns unexpected keys, missing fields, or a completely different structure, the code will either crash or silently produce broken markdown tables. The retry logic catches exceptions but doesn't validate structure.

**Dockerfile follows security best practices.** The Docker image uses a pinned base image SHA, runs as a non-root user (`appuser`), includes a health check, enables XSRF protection, and uses a venv for isolation. This is notably better than typical Streamlit examples.

## Assessment

**Strengths:**
- Comprehensive prompt engineering for AI/ML threat modeling — the STRIDE↔OWASP mappings are detailed and practical
- Multi-provider support with local model options (Ollama, LM Studio) makes it usable in air-gapped or privacy-sensitive environments
- GitHub repo analysis feature provides a low-friction way to bootstrap threat models
- Good Dockerfile security practices

**Concerns:**
- `main.py` at 1,973 lines is a monolith containing UI, business logic, and infrastructure concerns. The provider dispatch pattern (identical if/elif chains repeated 5 times) should be extracted into an adapter.
- No tests. Zero. For a security tool, this is a significant gap — especially given the fragile JSON parsing and regex-based Mermaid cleaning.
- No output schema validation. The tool trusts the LLM to return well-formed JSON matching the expected structure. Malformed responses produce cryptic errors or silently broken output.
- The GitHub analyzer's `summarize_file()` uses regex to extract code structure, which will break on many common patterns (nested functions, decorators, f-strings containing `def`, multiline imports). It's good enough for a rough sketch but could produce misleading summaries.
- Session state has no schema enforcement — any key can hold any type at any time, making bugs hard to trace.
- All application context (descriptions, threat models, API keys) passes through LLM providers. While the README warns about this, the tool's `.env.example` includes keys for six providers, making it easy to accidentally send sensitive architecture details to multiple third parties.

**Recommendations:**
1. Extract the provider dispatch into an adapter pattern — a single `call_llm(provider, model, prompt, **kwargs)` function would eliminate the most egregious duplication.
2. Add Pydantic models for the expected LLM response schemas and validate before rendering.
3. Add at minimum integration tests for the JSON-to-markdown rendering pipeline and the Mermaid cleaning logic.
4. Consider splitting `main.py` into separate UI and logic modules.
