---
title: "Analyzing Ship Safe"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/asamassekou10/ship-safe
tags: [javascript, typescript, security, devsecops, cli, static-analysis, owasp, llm-security, supply-chain]
---

# Analyzing Ship Safe

> **Source:** [asamassekou10/ship-safe](https://github.com/asamassekou10/ship-safe) @ [`e4810a0`](https://github.com/asamassekou10/ship-safe/commit/e4810a00a86bf2cb47e86319131bcbbb1dec560b)

## How It Works

Ship Safe is a zero-config CLI security scanner that runs 23 parallel agents against a codebase, then scores the results across 8 OWASP-weighted categories. It targets the "vibe coding" audience — developers who move fast and may not be security experts. The core loop: discover files → run all agents concurrently → deduplicate → score → present interactive remediation.

The tool works in three tiers. Offline (default): pure regex/static analysis across 80+ vulnerability classes with no API key. With an LLM provider (`--provider`): findings are enriched via LLM classification and taint analysis, false positive reduction, and natural-language fix explanations. As a Claude Code hook: real-time secret blocking at write time, before secrets hit disk.

The architecture is intentionally flat — no AST parsing, no dependency graphs, no type inference. Every agent is a collection of regex patterns with metadata (CWE, OWASP mapping, severity, fix suggestion). This makes agents trivially composable and additive, but limits depth of analysis compared to tools like Semgrep or CodeQL.

## Architecture

```
cli/bin/ship-safe.js          ← CLI entry point (Commander.js)
  └── cli/commands/            ← ~30 subcommands (audit, agent, ci, diff, …)
        ├── audit.js           ← Main orchestrator command (1177 lines, the spine)
        └── agent.js           ← Interactive fix loop
  └── cli/agents/              ← 23 agent classes + 4 post-processors
        ├── base-agent.js      ← Abstract base: file discovery, finding factory
        ├── orchestrator.js    ← Parallel execution engine (concurrency=6, 30s timeout)
        ├── index.js           ← Agent registry + buildOrchestrator()
        └── <agent>.js         ← Each agent: patterns[] + analyze(context)
  └── cli/providers/           ← LLM abstraction (Anthropic, OpenAI, Gemini, Ollama, custom)
  └── cli/utils/               ← patterns.js (1122 lines), entropy, caching, PDF gen
  └── cli/hooks/               ← Claude Code pre/post-tool-use hooks
  └── cli/__tests__/           ← 1955 lines of unit tests (node:test)
```

Companion projects live alongside the CLI: a Next.js webapp, a VS Code extension, VPS deployment tooling, and a Claude Code plugin.

## The Spine

The primary user flow is `npx ship-safe audit .`, which traces through:

1. **Entry**: `cli/bin/ship-safe.js` → Commander parses `audit` subcommand → `audit.js` imports `buildOrchestrator()` from agents index
2. **Recon**: `ReconAgent` scans the project structure — detects framework (Next.js, FastAPI, etc.), language, and file inventory. This feeds into `shouldRun()` on each agent so irrelevant scans auto-skip
3. **Secret scan**: 50+ regex patterns from `patterns.js` scan all files, enriched with Shannon entropy scoring via `entropy.js` to reduce false positives on short/high-entropy strings
4. **Agent parallel execution**: `Orchestrator.runAll()` runs agents with `Promise.race()` per agent (30s timeout) and a sliding-window concurrency of 6. Each agent receives `{ rootPath, files, recon, options }` and returns `Finding[]`
5. **Post-processing**: `VerifierAgent` checks secret liveness, `DeepAnalyzer` runs LLM-powered taint analysis if provider is configured, `ScoringEngine` computes a 0–100 score across 8 weighted categories
6. **Output**: HTML report, SARIF for CI, JSON, or interactive terminal display with `ora` spinners

The interactive fix loop (`agent` command) adds: preview diff → confirm → write → verify fix → log for undo.

## Key Patterns

**Agent pattern as a data structure.** Every agent is a class extending `BaseAgent` with a `PATTERNS` array of `{ rule, title, regex, severity, cwe, owasp, description, fix }` objects. The `analyze()` method iterates files, applies patterns, and returns `Finding[]`. This is consistent across all 23 agents — from `InjectionTester` to `HermesSecurityAgent`. The pattern is:

```javascript
class InjectionTester extends BaseAgent {
  constructor() { super('InjectionTester', 'Detects injection vulns', 'injection'); }
  async analyze(context) {
    // glob files → iterate → apply PATTERNS regex → return findings
  }
}
```

**Recon-driven filtering.** `ReconAgent` produces a `recon` object with framework detection, language, and file inventory. Each agent's `shouldRun(recon)` decides whether to skip. A Python-only project skips the Next.js config auditor; a project with no `.env` files skips some secret patterns. This keeps scan times reasonable despite having 23 agents.

**Scoring as a deduction model.** `ScoringEngine` starts at 100 and subtracts per-category deductions based on finding severity and count. Weights are mapped to OWASP Top 10 2025 categories: secrets (15%), injection (15%), auth (15%), deps (13%), supply-chain (12%), API (10%), AI/LLM (12%), config (8%). The engine also tracks historical scores in `SecurityMemory` for trend visualization.

**LLM as an optional enrichment layer.** The `LLMProvider` abstraction supports Anthropic, OpenAI, Gemini, Ollama, and any OpenAI-compatible endpoint. When configured, it classifies findings (REAL vs FALSE_POSITIVE), performs taint analysis in `DeepAnalyzer`, and generates natural-language fix plans. The tool is fully functional without it — LLM is a quality booster, not a dependency.

**Claude Code hooks as a runtime defense.** `pre-tool-use.js` reads JSON from stdin per the Claude Code hooks protocol. It scans Write/Edit/Bash tool calls for secrets before they execute, blocking with exit code 2 and explaining why. This is the most novel integration — shifting from "scan after commit" to "block at write time."

## Non-Obvious Details

**The 36K-line codebase has a single contributor.** This is a solo project by asamassekou10, which explains some inconsistencies — the supply chain agent hardcodes the TeamPCP/CanisterWorm incident IOCs (litellm 1.82.7, axios 1.8.2, telnyx 2.1.5) which will go stale, and several agents have overlapping detection scopes.

**`patterns.js` is 1122 lines of raw regex.** This is the largest single file and the backbone of the entire tool. It contains all secret detection patterns (AWS keys, GitHub tokens, Stripe keys, private keys, etc.) plus the skip lists for directories, extensions, and filenames. Maintenance here is critical — a bad regex means either missed secrets or noise.

**The `HermesSecurityAgent` and `Claude ManagedAgentScanner` are marketing-targeted agents.** They scan for Hermes Agent and Claude Code specific configurations. This is unusual — most security scanners don't include agents for specific competitor products. It signals the project's positioning toward the AI-agent-developer niche.

**No AST parsing anywhere.** All detection is regex-based. This means the tool will miss vulnerabilities that require understanding data flow across files, control flow, or type information. For example, a SQL injection where user input flows through three function calls before reaching a query won't be caught — only direct interpolations in template literals or string concatenation within the same line/expression are detected.

**`ScoringEngine` weights don't sum to 100% deductively.** The weights represent the *maximum possible deduction per category*, not a direct percentage. A project with no dependency issues still "loses" 13 points from the deps category weight. The actual math is more nuanced — each severity level has its own deduction cap per category.

**The test suite is comprehensive for what it tests.** 1955 lines of tests covering pattern matching, scoring, deduplication, and ReDoS safety. But tests only verify individual agent patterns against crafted temp files — there are no integration tests running the full audit pipeline end-to-end.

**Supply chain IOCs are hardcoded, not fetched.** The `COMPROMISED_PACKAGES` list in `supply-chain-agent.js` contains specific versions from real incidents but is baked into the source. There's a `threat-intel.js` utility and an `update-intel` command, but the default offline experience relies on a static list that will become stale.

> [!question] The `vps/` directory contains Docker/Nginx orchestration for running the tool as a hosted service, but the README doesn't document this. Unclear if this is used in production or is aspirational.

## Assessment

**Strengths:**
- Zero-config DX is excellent. `npx ship-safe audit .` works immediately with no setup, no account, no config files. This lowers the barrier to security scanning dramatically.
- The recon-driven auto-skip pattern is well-designed — scanning 23 agents against a Python-only project would waste time and produce noise, and this is handled automatically.
- Scoring aligned to OWASP categories with weighted deductions provides a meaningful, auditable metric rather than just a finding count.
- Claude Code hooks integration is genuinely novel — blocking secrets at write time is a meaningful shift left from the traditional "scan after commit" approach.
- The LLM layer is properly optional. The tool is fully functional offline, and LLM enrichment is additive rather than required.

**Concerns:**
- **Regex-only analysis is a fundamental ceiling.** Without AST parsing or data flow analysis, the tool can only detect vulnerability *patterns*, not actual *vulnerabilities*. A SQL injection split across multiple statements will be missed. This is fine for catching low-hanging fruit but won't replace Semgrep, CodeQL, or dedicated SAST tools.
- **Solo contributor, 36K lines, rapid versioning** (9.2.4 in 21 releases). Velocity is impressive but sustainability is a concern. The hardcoded IOCs, overlapping agent scopes, and 1122-line patterns file suggest maintenance debt.
- **Agent overlap and false positives.** Multiple agents can flag the same line for different reasons (e.g., a secret in a prompt triggers both `ConfigAuditor` and `LLMRedTeam`). Deduplication exists but partial overlap increases noise.
- **No semantic versioning discipline.** The project went from v1 to v9 in ~21 releases, suggesting each minor feature bumps the major version. This makes lockfile pinning unreliable.

**Recommendation:** Ship Safe is well-suited as a fast, developer-friendly first pass — the "security linting" layer that catches obvious problems before code reaches CI. It's not a replacement for dedicated SAST (Semgrep, CodeQL) or secret scanning (Gitleaks, TruffleHog) in production environments, but it fills a real gap for small teams and individual developers who wouldn't otherwise run security tools at all.

## Related

- [[analyzing-datadog-guarddog]] — Python-based supply chain security scanner (different approach: sandboxed execution vs regex patterns)
- [[analyzing-packj]] — Supply chain scanner with dynamic analysis (strace-based), contrast with Ship Safe's static-only approach
- [[analyzing-hijagger]] — DNS/WHOIS-based typosquatting detection, a subset of what Ship Safe's supply chain agent covers
