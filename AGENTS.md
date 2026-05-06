# AGENTS.md — Research Reports Workflow

This document instructs AI agents (Hermes) on how to produce research reports for this vault.

## Overview

This repo is an Obsidian vault of research reports, published as a static site via Quartz. When the user asks for research, the agent writes a structured markdown report and commits it here.

## Vault Structure

```
content/           ← Obsidian vault root (this is what Quartz builds from)
  templates/       ← Report templates
  .obsidian/       ← Obsidian config (do not modify)
workflows/         ← Per-type methodology guides
AGENTS.md          ← This file (repo root, not in vault)
```

## Report Writing Process

### 1. Determine Report Type

Match the request to one of these types (set in frontmatter `type` field):

| Type | When to Use | Methodology |
|------|-------------|-------------|
| `codebase-analysis` | Analyzing a codebase — how it works, patterns, architecture | `workflows/codebase-analysis.md` |
| `market-research` | Market landscape, competitive analysis, comparisons | `workflows/market-research.md` |
| `technical-deep-dive` | Focused exploration of a specific topic/framework | `workflows/technical-deep-dive.md` |
| `literature-review` | Summarizing papers, docs, or reference material | `workflows/literature-review.md` |

**Before starting, read the relevant workflow file for the detailed methodology.**

### 2. Research

- **Codebase analysis:** Clone the repo (shallow), inspect structure, read key files, analyze patterns.
- **Market/technical research:** Use web search and web_extract to gather information from primary sources.
- **Literature review:** Find and read primary sources. Never fabricate citations.
- Be thorough but not verbose. Aim for substance over length.

### 3. Write the Report

Create the report at `content/<report-name>.md` with:

**Required frontmatter:**
```yaml
---
title: "Descriptive Title"
date: YYYY-MM-DD
type: <one of the types above>
status: complete
source: <URL or identifier of what was analyzed>  # omit if N/A
tags: [<relevant, tags>]
---
```

**Required sections:**
- `## Overview` — what was researched and why
- `## Key Findings` — the main takeaways (use sub-sections)
- `## Assessment` — strengths, concerns, recommendations
- `## Related` — `[[wikilinks]]` to related reports (if any exist)

**Writing standards:**
- Write in clear, direct prose. No filler or hedging.
- Use `[[wikilinks]]` to reference other reports in this vault.
- Use Obsidian callouts (`> [!note]`, `> [!warning]`, `> [!tip]`) for important callouts.
- Include code snippets, tables, and structured data where useful.
- Mark uncertain claims with `> [!question]` callouts.
- Target ~500-1500 words depending on complexity.

### 4. Create Branch and Open PR

**Do NOT push directly to `main`.** Each report gets its own branch and pull request for review.

```bash
cd /opt/data/repos/research-reports
git checkout main
git pull
BRANCH="report/<report-name>"
git checkout -b "$BRANCH"
git add content/<report-name>.md
git commit -m "Add report: <short title>"
git push -u origin "$BRANCH"
gh pr create --title "Add report: <short title>" --body "## Report: <short title>

**Type:** <type>
**Source:** <source URL or N/A>

<1-2 sentence summary of what was researched and key takeaway.>"
```

### 5. Handle Review Feedback

- If the user requests edits: checkout the PR branch, make changes, push, and request re-review.
- Do not merge PRs yourself — wait for explicit approval from the user.
- Once the user approves and merges, the site will auto-deploy via CI.

## File Naming Convention

- Use kebab-case: `analyzing-foo-bar.md`
- Include a descriptive prefix: `analyzing-`, `market-`, `deep-dive-`, `review-`
- Example: `analyzing-fastapi-realworld.md`, `market-vector-databases-2026.md`

## Tags Convention

Use existing tags when possible. Check current tags:

```bash
grep -rh "^tags:" content/ | sort -u
```

## DO NOT

- Modify files in `content/.obsidian/`
- Delete or rename existing reports
- Fabricate data, citations, or findings
- Add reports to directories outside `content/`
