# Workflow: Market Research

## Goal

Produce a clear, structured analysis of a market, technology landscape, or competitive space. The reader should walk away with an understanding of the key players, trade-offs, and a defensible point of view.

## Process

### Phase 1: Define the Scope

Confirm the boundaries of the research. What's the question being answered? Example: "Which vector database should I use for my RAG pipeline?" or "What's the state of open-source LLM orchestration frameworks?"

If the request is vague, narrow it before proceeding.

### Phase 2: Gather Primary Sources

- Search for recent comparison posts, benchmarks, and documentation
- Check GitHub repos (stars, activity, issues for pain points)
- Look for pricing pages and positioning from vendors
- Find community discussions (Hacker News, Reddit, Discord) for unfiltered opinions
- Check for recent funding rounds or acquisition news as signals

### Phase 3: Build the Comparison Matrix

For each player/option, capture:
- What it is (one sentence)
- Key differentiator
- Pricing model
- Strengths
- Weaknesses
- Community momentum (stars, contributors, last release)

### Phase 4: Analyze Trade-offs

Go beyond the matrix. What are the actual decision axes?
- What trade-off does each option make?
- What's the ecosystem lock-in risk?
- What's the trajectory (growing, stagnating, declining)?
- What would I pick and why?

## Report Structure

```markdown
---
title: "<topic>"
date: YYYY-MM-DD
type: market-research
status: complete
tags: []
---

# <topic>

## The Question

What we're trying to answer and why it matters.

## Landscape

Overview of the space. How many players? Is it consolidating or fragmenting?

## Comparison

Structured comparison of the key options. Table + narrative.

## Trade-offs

The real decision axes beyond feature lists.

## Recommendation

What I'd pick, under what conditions, and what would change my mind.
```

## Anti-Patterns to Avoid

- Don't just list features — explain *why* they matter or don't
- Don't rely on a single source — cross-reference claims
- Don't present a false equivalence — if one option is clearly better, say so
- Don't ignore pricing — it's often the real differentiator
