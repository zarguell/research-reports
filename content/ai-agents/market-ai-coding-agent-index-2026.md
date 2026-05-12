---
title: "Analyzing Artificial Analysis Coding Agent Index"
date: 2026-05-12
type: technical-deep-dive
status: complete
source: https://artificialanalysis.ai/agents/coding-agents
tags: [ai-agents, coding-assistant, benchmark, swebench, terminal-bench, artificial-analysis, cursor, claude-code, codex, opencode]
---

## Overview

Artificial Analysis (artificialanalysis.ai) publishes a **Coding Agent Index** — one of the few benchmarks that evaluates coding agents as complete systems (harness + model) rather than models in isolation. This report analyzes their methodology, what their data actually shows, and where the index is and isn't useful for tool selection.

The index is live and frequently updated. The data discussed here reflects the state as of May 2026.

## Key Findings

### The Index Composition — Three Complementary Benchmarks

The composite score averages pass@1 across three benchmarks:

- **SWE-Bench-Pro-Hard-AA** (150 questions) — code generation and bug-fixing on tasks not in public training data
- **Terminal-Bench v2** (84 questions) — agentic terminal use: shell navigation, multi-step CLI workflows, error recovery
- **SWE-Atlas-QnA** (124 questions) — technical Q&A testing repository understanding and architectural reasoning

This is a deliberate design choice. Each benchmark stresses a different capability: writing patches, navigating a shell, and understanding codebases. An agent can score well on one and poorly on another, which is why AA explicitly recommends reading per-benchmark breakdowns rather than relying solely on the composite.

> [!tip] This three-benchmark approach is genuinely better than SWE-bench Verified alone. Verified tests one thing (Python bug-fix patches) on potentially contaminated data. AA's mix covers implementation, terminal workflows, and codebase comprehension — closer to what real developers do.

### What the Index Actually Measures — Harnesses, Not Just Models

The most important insight from AA's work is their **harness comparison**, which holds the model constant (Claude Opus 4.7) and compares performance across different agent frameworks:

**Same model, different harness → dramatically different results.**

Independent studies confirm this:

- Claude Opus scored 77% in Claude Code vs 93% in Cursor — a 16-point swing from harness tuning alone
- CORE-Bench found Claude Opus went from 42% (minimal scaffold) to 78% (full Claude Code harness) — a 36-point range
- Across multiple studies, harness quality produces a **5 to 40 percentage point spread** on identical models

This is the key finding that most commentary misses. The benchmark isn't measuring "which model is smartest" — it's measuring the combined system of scaffolding, tool descriptions, system prompts, and context management. Cursor reportedly employs people whose full-time job is rewriting system prompts and tool descriptions every time a new model ships.

### Token Usage and Cost — The Hidden Variable

AA tracks four cost dimensions:

- **Input tokens** (non-cached) — prompts, instructions, tool/task context
- **Cached input tokens** — reused prompt tokens billed through provider caching
- **Output tokens** — model's visible response
- **Cache hit rate variability** — some providers route across backend replicas that don't share cache state, materially changing effective cost

> [!warning] Cache hit rates are a real problem. AA explicitly notes they do NOT add relay headers or affinity controls to force higher cache reuse, making results "representative of typical user setups." This means the same agent can cost significantly different amounts depending on provider routing — a factor no pricing page will tell you.

The cost data reveals that Claude Code consumes **3–4x more tokens per task** than Codex CLI for equivalent work. At API rates, this compounds fast. A subscription masks this, but heavy users on Max plans still hit caps.

### Execution Time — What's Measured and What's Not

AA measures agent wall-clock runtime only: reasoning time, tool calls, file I/O, shell execution, model response waiting. It explicitly excludes environment startup, verifier/judge time, and harness overhead.

This is fair for comparing agents against each other, but underrepresents the real-world time developers experience. Environment startup and harness initialization can add 30–60 seconds per session that don't show up in the benchmark.

### Partial Credit and Rubric Scoring

SWE-Atlas-QnA uses rubric-based scoring with partial credit, not binary pass/fail. This matters because:

- A task counts as "solved" only when it **passed AND received a positive score**
- Partial credit captures useful progress that strict pass-fail would miss
- An agent that gets 70% of the way on hard tasks may score similarly to one that fully solves easy tasks — the composite doesn't distinguish these patterns

### The Model-Level Coding Index (Separate from Agent Index)

AA also publishes a model-level **Coding Index** (415 models evaluated) that differs from the agent index. Top scores as of May 2026:

- GPT-5.5 (xhigh): 59.1
- GPT-5.4 (xhigh): 57.3
- Gemini 3.1 Pro Preview: 55.5
- Claude Opus 4.7 (Non-reasoning, High): 53.1
- GPT-5.3 Codex (xhigh): 53.1

> [!note] Claude Opus 4.7 scores higher in non-reasoning mode (53.1) than adaptive reasoning (52.5) on the Coding Index. This is counterintuitive — reasoning should help — and suggests the benchmark's tasks may favor speed and directness over chain-of-thought deliberation.

**Best value:** DeepSeek V4 Flash (Reasoning, Max) at $0.175/M tokens scores 38.7 — roughly 2/3 of GPT-5.5's performance at 1/64th the cost. For budget-sensitive workloads, this is the standout data point.

## Assessment

### Strengths

- **Multi-benchmark composite** is more informative than any single benchmark. Testing patches, terminal workflows, and codebase understanding separately reveals genuine capability differences.
- **Harness isolation** (holding model constant) is the most valuable contribution. It proves that the agent framework matters as much as the model — sometimes more.
- **Cost transparency** with cache hit rate analysis exposes a real-world variable that other benchmarks ignore.
- **Methodology honesty** — AA is explicit about limitations, partial credit semantics, and why the index shouldn't be treated as a timeless absolute score.

### Concerns

- **The page is JS-rendered with interactive charts** — the actual numeric scores are not available in a static, citable format. You can't link to a specific agent's score at a point in time. This undermines reproducibility.
- **Limited agent coverage** — the harness comparison currently covers Claude Code, Cursor, and OpenCode. Aider, Cline, Continue, Devin, and others are absent. The model-level index covers 415 models, but the agent-level data is sparse.
- **No longitudinal tracking** — scores update as agents improve, but there's no versioned history. A score you cite today may be different tomorrow with no changelog.
- **Equal weighting is arbitrary** — the three benchmarks contribute equally to the composite, but they have very different task counts (150, 84, 124) and difficulty levels. A simple average may not reflect real-world task distributions.
- **Terminal-Bench dominance** — for teams whose workflow is primarily IDE-based (not terminal), the Terminal-Bench v2 component overweights a capability they may not need.

### What the Index Gets Right That Others Don't

Most coding benchmarks measure models. SWE-bench Verified measures models. LiveCodeBench measures models. AA's Coding Agent Index measures **systems** — the harness, the prompts, the tool descriptions, the context management, the error recovery. That's what developers actually deploy. The data proves this matters: up to 40 points of performance come from the harness, not the model.

The three-benchmark split also forces honest assessment. An agent that aces SWE-Bench-Pro-Hard-AA but fails Terminal-Bench is telling you something important about its real-world autonomy. The composite masks this, but the per-benchmark breakdown reveals it.

## Related

- [[analyzing-hermes-agent]]
- [[analyzing-claude-octopus]]
- [[comparing-bifrost-vs-litellm]]
