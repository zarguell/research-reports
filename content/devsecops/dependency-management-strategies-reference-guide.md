---
title: "Dependency Management Strategies Across Open Source (v2)"
date: 2025-05-12
type: codebase-analysis
status: complete
source: https://github.com/zarguell/research-reports
tags: [dependencies, renovate, dependabot, supply-chain, sbom, pinning, ci-cd, security, scorecard]
---

> **Source:** Synthesis of 20 open source codebases across two ecosystems. v2 expands the original 14-project survey (CI/CD security tools, infrastructure, platforms) with 6 projects selected specifically for dependency management maturity: Renovate, SLSA GitHub Generator, OpenSSF Scorecard, Vite, Fastify, and Rustls. See Related section for individual reports.

# Dependency Management Strategies Across Open Source

## Overview

Every open source project depends on other people's code. How they manage those dependencies — update them, pin them, audit them, and respond to vulnerabilities — determines whether their supply chain is a strength or a liability.

The original v1 survey of 14 projects revealed an uncomfortable truth: over half had no automated dependency updating. This v2 expands the sample with 6 projects known for supply chain rigor, creating a more balanced view of what's possible. The result is a spectrum from "nothing" to "industrial-grade," and the gap between the two is almost entirely cultural, not technical.

## Key Findings

### 1. The Auto-Updater Spectrum: Four Tiers

Across 20 projects, four distinct tiers emerge:

**Tier 1 — Industrial-grade Renovate (3 projects):** Renovate (self-managing), SLSA GitHub Generator, and Vite use Renovate with sophisticated grouping, pinning strategies, and schedule control.

- **Renovate** eats its own dog food — its `default.json` is the most complex Renovate config in existence (tens of thousands of lines across a monorepo). It manages both `pnpm-lock.yaml` and `pdm.lock` for its dual Node.js/Python stack.
- **Vite** uses a concise, powerful config: `config:recommended`, weekly schedule, `group:allNonMajor` (all minor/patch updates in a single PR), `rangeStrategy: "bump"`, and `postUpdateOptions: ["pnpmDedupe"]`. Custom regex managers track dependencies in non-standard files (`create-vite/src/index.ts`). Selective `ignoreDeps` with inline comments explaining *why* each dep is pinned.
- **SLSA GitHub Generator** extends `config:best-practices` with monthly schedule, `postUpdateOptions: ["gomodTidy", "gomodUpdateImportPaths"]`, and separate grouping for GitHub Actions (SHA-pinned), Go modules, npm dependencies, and npm devDependencies. Vulnerability alerts override the monthly schedule with nightly runs (`* 0-4 * * *`).

**Tier 2 — Mature Dependabot with grouping (3 projects):** Nextcloud, Fastify, and OpenSSF Scorecard use Dependabot with grouping, commit message prefixes, and targeted ignore rules.

- **Fastify** groups Dependabot updates into: production minor/patch, production major, ESLint-related, TypeScript-related, and Ajv-related. Monthly schedule with 10 PR limit.
- **OpenSSF Scorecard** uses Dependabot for Go modules (grouped with exclusion patterns for deps that need manual fixes), GitHub Actions (grouped, excluding build-critical actions), and Docker (grouped by `golang` and `distroless/base` across 8 directories). All groups use `rebase-strategy: disabled` to prevent noise.
- **Nextcloud** runs both Renovate and Dependabot with cooldown periods (4 days default, 8 days for majors).

**Tier 3 — Basic Dependabot (2 projects):** oCIS and ZAP use Dependabot but without grouping or sophistication. oCIS updates Go modules daily (aggressive cadence) with a 2-PR limit.

**Tier 4 — No updater (8 projects):** Traefik, OpenTofu, Gitleaks, Grype, dep-scan, agent-scan, Insomnia, Threat Dragon. Plus Rustls, which has a Renovate config but disables patch updates entirely and disables minor updates for non-0.x versions — effectively making Renovate a major-version notifier only.

Two additional projects use custom workflows instead of Renovate/Dependabot: Minimal (30 hand-crafted update workflows) and Checkov (`pipenv-update.yml`).

> [!warning] 8 of 20 projects have no automated dependency updating. Despite Renovate and Dependabot being free and trivial to enable, adoption remains low outside projects with dedicated platform teams.

### 2. Renovate Config Patterns: Three Philosophies

The Renovate-using projects reveal three distinct configuration philosophies:

**Minimalist (Vite, ~40 lines):** Extends `config:recommended`, sets a schedule, groups all non-major updates, and lists specific ignore rules with inline comments. The config is readable in one screen. This is the highest-ROI approach — 80% of the value in 10% of the config.

**Structured (SLSA, ~60 lines):** Extends `config:best-practices`, adds `postUpdateOptions` for language-specific cleanup (`gomodTidy`, `gomodUpdateImportPaths`), separates groups by ecosystem and update type, and overrides vulnerability alert scheduling. This is the "responsible adult" config — nothing exotic, but every edge case is covered.

**Restrictive (Rustls, ~25 lines):** Extends `config:base`, enables `lockFileMaintenance`, sets `rangeStrategy: "update-lockfile"`, and then *disables* patch and non-0.x minor updates for Cargo. This is the "we review everything manually" approach — Renovate is used only for major versions and lockfile maintenance.

> [!tip] Start with Vite's approach: `config:recommended` + `schedule:weekly` + `group:allNonMajor`. Add `ignoreDeps` with comments as you discover problem packages. Graduate to SLSA's approach when you need per-ecosystem control.

### 3. Dependabot Grouping: Underused but Powerful

Fastify and OpenSSF Scorecard demonstrate Dependabot's grouping capabilities, which many projects don't use:

**Fastify's grouping** separates production deps (minor/patch vs major) from dev deps (ESLint, TypeScript, Ajv). This means a developer reviewing a "dependencies" PR only sees runtime changes, while the "dev-dependencies-eslint" PR is safe to skim.

**Scorecard's grouping** uses `exclude-patterns` to separate deps that need manual intervention (actionlint has breaking changes, osv-scanner influences the Vulnerabilities check, golangci-lint requires linter fixes). This prevents CI failures from auto-merged dep updates that break things.

Both use `commit-message.prefix` for clean git history (`:seedling:` for Scorecard, `chore` for Fastify).

### 4. Minimal's Hand-Crafted Approach: The Gold Standard

Minimal (a Wolfi-based container image builder) remains the most sophisticated dependency management in the survey, despite being the smallest project. For each of its 30+ tracked upstream projects, a dedicated workflow:

1. Checks for new versions daily with semver-filtered tag matching
2. Downloads and verifies SHA256 checksum of the source tarball
3. Updates `melange.yaml` build configs (version, checksum, epoch reset)
4. Creates a PR with auto-merge enabled
5. Detects next major versions and opens GitHub Issues with migration checklists

The major-version issue creation is unmatched by any Renovate or Dependabot feature. When Traefik v4 appears while tracking v3, the workflow creates an issue with a checklist: review migration guide, check Go module path, verify ldflags, update tag filter regex, test image build.

### 5. Supply Chain Attestation: The Security Layer

7 of 20 projects generate supply chain attestations, with clear leaders:

**SLSA GitHub Generator** is itself the tool that *produces* SLSA provenance for other projects. It signs its own releases with cosign and generates provenance across Go, Node.js, Docker, Bazel, Maven, and Gradle builders. The `scorecards.yml` workflow runs OpenSSF Scorecard on every push to main and publishes results to the GitHub Security tab.

**OpenSSF Scorecard** similarly eats its own dog food — it's the scoring tool that runs Scorecard on itself. Docker images are signed and provenanced via GoReleaser.

**ZAP** signs every Docker release variant (main, weekly, live) with Notary and generates provenance.

**Renovate** runs the Scorecard action and publishes SARIF results to code scanning.

5 projects (dep-scan, Grype, Insomnia, oCIS, Minimal) generate attestations at release time. The remaining 8 produce no attestations at all.

### 6. Pinning Philosophies by Ecosystem

**Go (exact pinning):** `go.mod` uses exact versions (`v1.41.6`) with `go.sum` providing transitive integrity. Gitleaks is the leanest with 14 deps; Traefik and oCIS carry 100+. All commit `go.sum`.

**Rust (workspace pinning):** Rustls uses a Cargo workspace with shared `[workspace.dependencies]` using minimum-version ranges (`anyhow = "1.0.73"`). `Cargo.lock` is committed. Renovate's `rangeStrategy: "update-lockfile"` means only the lockfile changes, not `Cargo.toml` — keeping the declared range stable while resolving to newer versions.

**Node.js (caret ranges + lockfile):** Vite uses pnpm with `pnpm-lock.yaml` (497KB). Insomnia uses npm with `package-lock.json` (1101KB). Fastify uses caret ranges with grouped Dependabot updates. The lockfile is always committed and always the source of truth.

**Python (mixed):** dep-scan and agent-scan use minimum-version ranges with `uv.lock`. Checkov uses Pipfile with mixed exact/upper-bounded ranges (`pyyaml = ">=6.0.0,<7.0.0"`). Renovate uses PDM with `pdm.lock`. Wazuh has no lockfile at all.

> [!tip] The lockfile is the real pinning. Declared version ranges in `package.json` or `Cargo.toml` are preferences; the lockfile is reality. Projects without lockfiles (some Python workflows) have non-reproducible builds.

### 7. Vulnerability Response: PR Gate vs Release Gate vs Nothing

**PR gate (5 of 20):** Grype, Threat Dragon, agent-scan, dep-scan, and Minimal run vulnerability scanners on every pull request. The strongest posture — caught before merge.

**Scheduled audit (2 of 20):** Nextcloud runs weekly npm audit across 4 branches (main + 3 stable), auto-creating fix PRs. Minimal runs daily Grype scans against *built container images* and patches Go transitive deps when found.

**Release gate (3 of 20):** oCIS, dep-scan, ZAP scan during release.

**OpenSSF Scorecard integration (3 of 20):** SLSA, Renovate, and Scorecard itself run the Scorecard action on every push to main, publishing SARIF results to GitHub Security. This provides continuous supply chain health monitoring — checking for pinned deps, signed releases, branch protection, and more.

**Nothing (7 of 20):** Traefik, OpenTofu, Gitleaks, Insomnia, Fastify, Vite, and Rustls have no vulnerability scanning in CI.

### 8. Lockfile Commitment

Every project that has a lockfile commits it. This is a universal practice — no exceptions found. The split is only in *which* lockfile format:

- **Go:** `go.sum` — 100% committed
- **Node.js:** `pnpm-lock.yaml` (Vite, Renovate) or `package-lock.json` (Insomnia, Fastify) — 100% committed
- **Rust:** `Cargo.lock` — 100% committed
- **Python:** `uv.lock` (dep-scan, agent-scan), `Pipfile.lock` (Checkov), `pdm.lock` (Renovate) — committed when present. Wazuh is the only project with Python code and no lockfile.

## Assessment

### Champions

- **Minimal** — Hand-crafted version tracking with SHA256 verification, major-version issue creation, and daily vulnerability patching. Still the gold standard for dependency management as engineering discipline.
- **Vite** — The best Renovate config for its simplicity. 40 lines that deliver 80% of the value. Any project can adopt this in 15 minutes.
- **SLSA GitHub Generator** — The most complete supply chain story: Renovate with `config:best-practices`, vulnerability alert scheduling, Scorecard integration, and SLSA provenance on every release.
- **OpenSSF Scorecard** — Dependabot with sophisticated grouping and exclusion patterns. Eats its own dog food by running Scorecard on itself.
- **Nextcloud** — The most comprehensive automated setup: both Renovate and Dependabot, multi-branch npm audit fixes, automerge with CI gating, and cooldown periods.

### What v2 Changed

The expanded sample shifted the story from "nobody does this" to "there's a clear divide." The original 14 projects (selected for CI/CD interest, not dep management) showed 4/14 with auto-updaters. The 6 added projects go 6/6 — all use Renovate or Dependabot. The pattern: projects with platform engineering teams (SLSA, Scorecard, Renovate itself, Vite/Vercel) invest in dependency automation. Security tools and infrastructure projects (Traefik, Gitleaks, Grype) don't, ironically.

### Remaining Gaps Across All 20 Projects

- **7 of 20 have no vulnerability scanning in CI.** Including Vite and Fastify, which otherwise have excellent dep management.
- **SBOM generation remains rare.** Only dep-scan (12 workflows), Insomnia, Minimal, Threat Dragon, and Grype generate SBOMs.
- **No prose attestation.** No project verifies that its own dependency declarations match what's actually built into artifacts. The lockfile is trusted implicitly.
- **Python lockfile fragmentation.** Four different lockfile formats across the sample (`uv.lock`, `Pipfile.lock`, `pdm.lock`, none). The ecosystem needs convergence.

### Recommendations

1. **Start with Vite's Renovate config.** `config:recommended` + `schedule:weekly` + `group:allNonMajor` + selective `ignoreDeps` with comments. 15 minutes to set up, immediate ROI.
2. **Add `postUpdateOptions` for your language.** `gomodTidy` for Go, `pnpmDedupe` for pnpm. These clean up artifacts that update PRs leave behind.
3. **Override vulnerability alert schedules.** SLSA's pattern of `vulnerabilityAlerts: { schedule: "* 0-4 * * *" }` ensures security updates aren't delayed by the normal schedule.
4. **Group Dependabot updates.** Fastify's separation of production/dev/major and Scorecard's exclusion patterns prevent noise while keeping updates flowing.
5. **Run OpenSSF Scorecard.** The action takes 2 minutes to configure and provides continuous monitoring of your supply chain health.
6. **Add vulnerability scanning to PR CI.** `trivy fs --scanners vuln .` takes seconds. No excuse not to.
7. **Commit lockfiles always.** This is universal — no project in the survey skips this.
8. **Pin with upper bounds in Python.** Checkov's `>=X,<Y` pattern prevents silent breakage. Minimum-only ranges trust upstream semver too much.

## Related

- [[best-cicd-implementations-reference-guide]]
- [[open-source-release-engineering-reference-guide]]
- [[container-security-hardening-reference-guide]]
- [[documentation-as-code-patterns-reference-guide]]
- [[github-actions-reusable-patterns-reference-guide]]
- [[analyzing-traefik]]
- [[analyzing-opentofu]]
- [[analyzing-gitleaks]]
- [[analyzing-grype]]
- [[analyzing-ocis]]
- [[analyzing-insomnia]]
- [[analyzing-checkov]]
- [[analyzing-dep-scan]]
- [[analyzing-wazuh]]
- [[analyzing-nextcloud-server]]
- [[analyzing-threat-dragon]]
- [[analyzing-zaproxy]]
