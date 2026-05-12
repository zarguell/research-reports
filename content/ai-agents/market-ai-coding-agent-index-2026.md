---
title: "AI Coding Agent Index & Performance Analysis"
date: 2026-05-12
type: market-research
status: complete
tags: [ai-agents, coding-assistant, market-research, benchmark, swebench, cursor, claude-code, copilot, aider, cline]
---

## Overview

The AI coding agent market has become the fastest-growing segment in developer tooling history. As of early 2026, the market is worth $12.8 billion, with 84–91% of professional developers using AI coding tools daily and 51% of all code committed to GitHub being AI-generated or AI-assisted. This report indexes the major players, compares their benchmark performance, pricing, and market position, and analyzes the real trade-offs behind the selection decision.

## Landscape

The field has fractured into five recognizable categories:

- **Closed IDE forks** — Cursor, Windsurf: VS Code forks with deep AI integration
- **Terminal-native agents** — Claude Code, Aider, Codex CLI, Gemini CLI, OpenCode: CLI-first, model-agnostic (except Claude Code)
- **VS Code extensions** — Cline, Roo Code, Kilo Code, Continue.dev: bring-your-own-key extensions inside existing VS Code
- **Enterprise platforms** — GitHub Copilot, Amazon Q, JetBrains AI: deep organizational integration
- **Autonomous agents** — Devin, Replit Agent: hands-off task delegation

The top three — GitHub Copilot, Cursor, and Claude Code — hold over 70% combined market share. Revenue concentration is extreme: Claude Code reportedly hit $2.5B ARR and Cursor reached $2B ARR by early 2026, while most other tools remain under $100M.

### Market Share (Feb 2026)

- Cursor: 31% (down from 34% in Mar 2025)
- GitHub Copilot: 24% (down from 28%)
- Claude Code: 22% (up from 12%)
- Windsurf: 8% (up from ~3%)
- JetBrains AI: 4% (new entrant)
- Other/None: 11%

> [!note] 53% of developers now use 2+ AI coding tools. The most common combination: Cursor + Claude Code (14% of all respondents).

## Comparison

### Benchmark Performance

SWE-bench has become the de facto standard for evaluating coding agents, though the field is learning its limitations. Verified (500 tasks) is approaching saturation; Pro (1,865 tasks) is the emerging gold standard.

**SWE-bench Verified (model-level, mini-SWE-agent, April 2026):**

- Claude Opus 4.7: 87.6%
- GPT-5.5: 82.6%
- Claude Opus 4.5: 80.9%
- GPT-5.2: 80.0%
- MiniMax M2.5: 80.2%
- DeepSeek V4: 76.2%

**SWE-bench Pro (agent-system level, harder tasks, May 2026):**

- Claude Mythos Preview: 77.8%
- GPT-5.3 Codex (CLI): 57.0%
- Claude Code (Opus 4.5): 55.4%
- Auggie (Opus 4.5): 51.8%
- Cursor (Opus 4.5): 50.2%
- GPT-5.4 (xHigh): 59.1% (SEAL standardized)

> [!warning] The gap between Verified and Pro is enormous — the same model scoring 80%+ on Verified drops to 23–46% on Pro. Verified is contaminated; Pro is contamination-resistant by design. Use Pro numbers for real-world expectations.

### Agent Comparison Matrix

**Form Factor & License:**

- **Cursor** — VS Code fork, proprietary, $20/mo Pro. Best-in-class inline editing, Composer 2 agent mode, 72% completion acceptance rate. 360K+ paying users.
- **Claude Code** — Terminal CLI, source-available, $20–200/mo. Highest reasoning quality. 1M context window on Opus 4.7. Deepest MCP integration. Model-locked to Claude.
- **GitHub Copilot** — IDE extension, proprietary, $10–39/mo. Largest user base (20M+). Strongest enterprise features. Agent Mode catching up.
- **Cline** — VS Code extension, Apache 2.0, free + API costs. Human-in-the-loop approval for every action. 61K GitHub stars, 4M+ installs. Model-agnostic.
- **Aider** — Terminal CLI, Apache 2.0, free + API costs. Git-native auto-commits. Architect/editor split. 44K stars. Supports 75+ providers. Writes ~70% of its own code.
- **OpenCode** — Terminal + desktop + IDE, MIT, free + API costs. Highest GitHub stars (128K). 75+ providers. Client/server architecture.
- **Continue.dev** — VS Code + JetBrains, Apache 2.0, free + API costs. Only agent supporting both VS Code and JetBrains natively. 501 contributors — highest contributor density.
- **Windsurf** — VS Code fork, proprietary, $15/mo Pro. Cascade agent. Acquired by Google ($2.4B acqui-hire). Best value at $15/mo.
- **Codex CLI** — Terminal, open-source, free + API costs. 67K stars. Cloud-isolated task execution. 240+ tok/s.
- **Devin** — Cloud agent, proprietary, $20/mo + $2.25/ACU. Most autonomous. 67% PR merge rate on defined tasks.

### Pricing Comparison

- **$0 (BYOK):** Aider, Cline, OpenCode, Continue, Codex CLI, Gemini CLI, Roo Code, Kilo Code
- **$10/mo:** GitHub Copilot Pro
- **$15/mo:** Windsurf Pro
- **$20/mo:** Cursor Pro, Claude Code (Pro tier), GitHub Copilot Pro+
- **$39/mo:** GitHub Copilot Pro+
- **$60/mo:** Cursor Pro+
- **$100–200/mo:** Claude Code Max tiers, Cursor Ultra

### Developer Satisfaction (Feb 2026 survey, 400 respondents)

- Claude Code: 84% satisfied (56% "very satisfied")
- Windsurf: 78% satisfied
- Cursor: 78% satisfied
- JetBrains AI: 73% satisfied
- GitHub Copilot: 52% satisfied (18% "dissatisfied" — lowest)

## Key Findings

### Finding 1: Model Choice Matters More Than Tool Choice

Cline's task success rate varied from 58% (GPT-4o) to 79% (Claude 3.5 Sonnet) depending on the model. Claude Code's 82% first-try success rate is partly the tool, mostly Opus 4.7. The practical implication: pair any decent agent scaffold with a frontier model and you get comparable results to the market leaders.

### Finding 2: SWE-bench Verified Is Saturated — Watch Pro Instead

Claude Opus 4.7 hit 87.6% on Verified. Claude Mythos Preview hit 93.9%, effectively solving the benchmark (audits suggest ~40% of remaining "failures" are broken tests, not model limitations). Meanwhile, Pro scores sit at 23–59% — a 30+ point gap. Verified rewards scaffolding and potential training-data contamination; Pro tests genuine generalization with copyleft-licensed and proprietary code.

### Finding 3: Open Source Is Winning on Adoption

By GitHub stars: OpenCode (128K), Gemini CLI (99K), Claude Code (81K), OpenHands (70K), Codex (67K), Cline (61K), Aider (44K). Five of the top six are open source. But contributor density tells a different story — Continue (15.7 contributors/1K stars) and Goose (12.0) show the healthiest community engagement, while Claude Code (0.6) is effectively closed development with public source.

### Finding 4: The Multi-Tool Standard

53% of developers now use 2+ tools. The winning pattern: Cursor or Windsurf for IDE-integrated daily work, Claude Code for complex multi-file reasoning and autonomous refactors, and a BYOK tool (Aider/Cline) for budget control or specific workflows. No single tool covers all use cases well.

### Finding 5: Revenue Growth Is Unprecedented

Cursor went from $0 to $1B ARR in 24 months. Claude Code went from $0 to $2.5B ARR in ~5 months. GitHub Copilot generates ~$2B ARR. The entire category reached $12.8B in 2026. This is the fastest category creation in software history — faster than cloud infrastructure, faster than mobile.

### Finding 6: The Autonomy Spectrum Is the Real Decision Axis

Tools cluster along a supervision axis: supervised pair-programming (Cursor, Claude Code, Cline) → semi-autonomous (Codex Desktop, Windsurf Cascade) → fully autonomous (Devin, Replit Agent). Most engineering teams in 2026 still default to supervised. Fully autonomous agents require strong eval and rollback discipline that most teams lack.

## Assessment

### Strengths

- The market has matured rapidly: real products, real revenue, real benchmarks
- Open-source options are viable — Aider + Claude API delivers parity with Cursor on most tasks
- MCP (Model Context Protocol) is becoming table stakes, enabling agent extensibility
- Multi-agent workflows (background agents, parallel sessions) shipped across all major tools in Feb 2026

### Concerns

- **Benchmark contamination.** SWE-bench Verified scores are inflated by potential training-data overlap. The 30+ point drop to Pro is the contamination tax.
- **Lock-in risk.** Cursor's credit-pool pricing makes heavy usage unpredictable. Claude Code is model-locked. Enterprise contracts create organizational inertia.
- **The productivity paradox.** A July 2025 METR study found experienced developers using AI tools completed tasks 19% slower, even as they believed they were 20% faster. The benchmark scores don't capture this.
- **Aider's velocity.** 25 commits/month vs. 600+ for OpenCode/Codex. A single maintainer (Paul Gauthier) built something remarkable, but can't outship Google and OpenAI. The community is worried.

### Recommendations

- **For senior engineers in complex codebases:** Claude Code Pro/Max ($20–100/mo) with Opus 4.7. Pair with Cursor for IDE work.
- **For teams standardizing on one tool:** Cursor Business ($40/seat) or GitHub Copilot Enterprise ($39/seat). Cursor for feature velocity; Copilot for compliance and Microsoft ecosystem.
- **For budget-conscious developers:** Aider or Cline (free) + Claude API. Comparable output quality at fraction of subscription cost.
- **For enterprise compliance:** GitHub Copilot Enterprise (IP indemnification, SOC 2) or Tabnine (air-gapped deployment).

What would change my mind: if SWE-bench Pro scores cross 70% (from current ~59%), that signals genuine autonomous capability. If open-source models (DeepSeek V4, Qwen3) close the gap to <5 points on Pro, the BYOK tools become the obvious choice. If Cursor's credit pricing stabilizes into transparent per-token billing, it becomes the clear single-tool default.

## Related

- [[analyzing-hermes-agent]]
- [[analyzing-claude-octopus]]
- [[analyzing-bifrost]]
