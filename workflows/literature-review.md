# Workflow: Literature Review

## Goal

Summarize and synthesize a set of papers, documentation, or reference material on a topic. The reader should understand the current state of knowledge, key debates, and open questions.

## Process

### Phase 1: Source Gathering

- Find the primary sources (papers, RFCs, official docs, spec documents)
- Prefer primary sources over secondary summaries
- If the user provides a specific paper, start there and branch to related work
- Note publication dates — recency matters

### Phase 2: Read and Annotate

For each source:
- What's the core claim or contribution?
- What's the methodology or evidence?
- What are the limitations the authors acknowledge?
- How does it relate to the other sources?

### Phase 3: Synthesize

- Where is there consensus? Where is there disagreement?
- What's the arc of progress on this topic?
- What are the open questions?

## Report Structure

```markdown
---
title: "<topic>"
date: YYYY-MM-DD
type: literature-review
status: complete
source: <primary source URL(s)>
tags: []
---

# <topic>

## Overview

Why this topic matters and what sources were reviewed.

## Key Sources

Structured summary of each significant source.

## Synthesis

What the field agrees on, where it disagrees, and what's emerging.

## Open Questions

What we still don't know.

## Related

- [[]]
```

## Anti-Patterns to Avoid

- Don't fabricate citations — only reference sources you actually read
- Don't just summarize each paper sequentially — synthesize across them
- Don't present speculation as fact — clearly distinguish claims from evidence
