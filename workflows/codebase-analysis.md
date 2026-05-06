# Workflow: Codebase Analysis

## Goal

Deconstruct a codebase and explain *how it works* — not just what files exist, but the underlying mechanics, conventions, and design decisions that make it tick. The reader should walk away understanding the mental model of the system.

## Process

### Phase 1: Orient

- Read the README, CONTRIBUTING guide, and any architecture docs
- Skim the project structure (tree view, top-level directories)
- Check `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` for dependencies, scripts, project metadata
- Identify the framework(s) and runtime in play

Output: A one-paragraph summary of what this project is and what stack it uses.

### Phase 2: Find the Spine

Every codebase has a "spine" — the main entry point and the path data takes through the system. Find it.

1. **Entry points** — CLI args, HTTP routes, message consumers, cron jobs, event handlers
2. **Core models/types** — the domain abstractions everything revolves around
3. **Data layer** — database schema, ORM models, migrations, storage patterns
4. **Service/business logic** — where the actual work happens (not just routing/pass-through)

Map the data flow: *request comes in → hits X → transforms through Y → persists to Z → returns W*

> [!tip]
> The best way to find the spine is to trace one complete request from entry to exit. Pick the most important user action and follow it through the code.

### Phase 3: Identify the Patterns

Once you understand the spine, catalog the repeated patterns:

- **Architectural pattern** — MVC, event-driven, hexagonal, CQRS, monolith vs services, etc.
- **State management** — how is state created, mutated, and shared?
- **Error handling** — what's the convention? Exceptions, Result types, middleware?
- **Configuration** — env vars, config files, feature flags, how is it layered?
- **Dependency injection** — manual, framework-provided, or ad hoc?
- **Code organization** — by feature, by layer, by technical concern?
- **Naming conventions** — what do the filenames and function names tell you about the authors' mental model?

### Phase 4: Spot the Non-Obvious

This is where the report adds real value — things that aren't in the README:

- **Implicit contracts** — unspoken assumptions between modules (e.g., "all services receive a `ctx` object with user info")
- **Clever hacks** — non-obvious implementations that are critical to correctness or performance
- **Tight coupling points** — changes here cascade everywhere
- **Undocumented requirements** — behavior you can only discover by reading tests or issue threads
- **The "interesting files"** — files that are small but carry outsized weight in the system

### Phase 5: Assess

Brief evaluation across these dimensions (don't pad — only note what's noteworthy):

- **Code quality** — readable? consistent? well-tested?
- **Architecture fitness** — does the structure match the problem?
- **Operational concerns** — logging, monitoring, error recovery, graceful degradation
- **Security posture** — obvious issues? auth patterns sound?
- **DX/ergonomics** — is this easy to develop on? good docs? clear conventions?

## Report Structure

```markdown
---
title: "Analyzing <project>"
date: YYYY-MM-DD
type: codebase-analysis
status: complete
source: <repo URL>
tags: [<language>, <framework>, ...]
---

# Analyzing <project>

## How It Works

The core explanation. 2-4 paragraphs that give the reader the mental model.
Think: "if you only read one section, read this."

## Architecture

High-level structure, data flow diagram (ASCII or described), key modules.

## The Spine

Entry points and request lifecycle. How a request flows through the system.

## Key Patterns

Conventions, architectural decisions, repeated structures.

## Non-Obvious Details

The stuff you only learn by reading the code. Implicit contracts, critical files, clever implementations.

## Assessment

Strengths, concerns, and recommendations. Be direct.
```

## Anti-Patterns to Avoid

- **Don't just list files** — the reader can run `tree` themselves
- **Don't paraphrase the README** — add insight beyond what's documented
- **Don't pad the assessment** — if something is fine, say "no concerns" or skip it
- **Don't dump dependency lists** — only mention dependencies that are architecturally relevant
- **Don't guess** — if you're unsure about something, mark it with `> [!question]` and say what you'd need to verify
