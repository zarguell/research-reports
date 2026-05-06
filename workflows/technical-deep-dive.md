# Workflow: Technical Deep-Dive

## Goal

Focused exploration of a specific technology, technique, or framework. The reader should understand how it works under the hood, when to use it, and what the gotchas are.

## Process

### Phase 1: Scope

What exactly are we diving into? A specific library? A design pattern? A protocol? A technique?

### Phase 2: Understand the Fundamentals

- Read the official documentation and spec (if applicable)
- Find the canonical examples and tutorials
- Identify the core abstraction — what's the primitive everything builds on?
- Understand the mental model the authors intended

### Phase 3: Probe the Edges

- What breaks? What are the documented limitations?
- What are common misconceptions?
- What are the performance characteristics?
- What does the community complain about?

### Phase 4: Synthesize

Connect the pieces. When should someone use this? When shouldn't they? What's the "gotcha" that bites everyone?

## Report Structure

```markdown
---
title: "<topic>"
date: YYYY-MM-DD
type: technical-deep-dive
status: complete
tags: []
---

# <topic>

## What It Is

Core concept in 2-3 sentences.

## How It Works

The fundamental mechanism. Build up from simple to complex.

## The Mental Model

How you should think about it. The abstraction that makes everything click.

## When to Use It (and When Not To)

Clear guidance with examples.

## Gotchas

The things that bite people. Common mistakes and how to avoid them.

## Related

- [[]]
```
