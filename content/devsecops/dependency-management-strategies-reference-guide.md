---
title: "Dependency Management Strategies Across Open Source"
date: 2025-05-12
type: codebase-analysis
status: complete
source: https://github.com/zarguell/research-reports
tags: [dependencies, renovate, dependabot, supply-chain, sbom, pinning, ci-cd, security]
---

> **Source:** Synthesis of 14 open source codebases analyzed in this vault. See Related section for individual reports.

# Dependency Management Strategies Across Open Source

## Overview

Every open source project depends on other people's code. How they manage that dependency — update it, pin it, audit it, and respond to vulnerabilities — determines whether their supply chain is a strength or a liability. This report surveys dependency management patterns across 14 mature open source projects, spanning Go (Traefik, OpenTofu, Gitleaks, Grype, oCIS), Python (Checkov, dep-scan, agent-scan), Node.js (Insomnia, Threat Dragon, Nextcloud), and mixed ecosystems (Wazuh, ZAP, Minimal).

The key finding: the most sophisticated dependency management isn't from the biggest projects — it's from Minimal, a small Wolfi-based image builder that hand-crafts version tracking workflows with SHA256 verification, major-version issue creation, and auto-merge. Meanwhile, major projects like Traefik and Gitleaks have zero automated dependency updating.

## Key Findings

### 1. The Auto-Updater Landscape: Renovate vs Dependabot vs Custom

Only 4 of 14 projects use automated dependency updaters:

**Dependabot (4 projects):**
- **Checkov** — GitHub Actions only, with `open-pull-requests-limit: 0` (effectively disabled for new PRs, only security updates)
- **Nextcloud** — The most comprehensive Dependabot config: composer (7 directories), npm (3 directories), GitHub Actions, across both `main` and stable branches. Uses grouping (`eslint`, `vite`, `vitest`), cooldown periods (4 days default, 8 days for semver-major), and disabled auto-rebase
- **oCIS** — Go modules on *daily* schedule (the most aggressive update cadence found), npm, Docker, GitHub Actions — each with `open-pull-requests-limit: 2` to prevent PR flooding
- **ZAP** — Gradle with targeted ignore rules (e.g., error_prone pinned below 2.43 to avoid Java 21 requirement)

**Renovate (1 project):**
- **Nextcloud** runs *both* Renovate and Dependabot — Renovate for broader ecosystem coverage, Dependabot for GitHub-native integration

**Custom workflows (2 projects):**
- **Minimal** — 30 hand-crafted update workflows, one per tracked upstream project (Traefik, Redis, MariaDB, Keycloak, etc.)
- **Checkov** — `pipenv-update.yml` runs weekly on Mondays, runs `pipenv update`, and creates a PR via `peter-evans/create-pull-request`

**No updater (8 projects):** Traefik, OpenTofu, Gitleaks, Grype, dep-scan, agent-scan, Insomnia, Threat Dragon. Dependencies are updated manually when needed.

> [!warning] Over half the projects — including major infrastructure tools — have no automated dependency updating. This means transitive vulnerabilities can sit undetected until someone remembers to update.

### 2. Minimal's Hand-Crafted Approach: The Gold Standard

Minimal is the smallest project in the survey but has the most sophisticated dependency management. For each of its 30+ tracked upstream projects, it maintains a dedicated workflow (e.g., `update-traefik.yml`, `update-redis.yml`) that:

1. **Checks for new versions daily** — queries GitHub API with semver-filtered tag matching (e.g., `^v3\\.[0-9]+\\.[0-9]+$`)
2. **Validates version format** — rejects non-semver strings
3. **Downloads and verifies SHA256** — computes checksum of the source tarball and updates the build config (`melange.yaml`)
4. **Creates a PR with auto-merge** — `gh pr merge --auto --squash --delete-branch`
5. **Detects next major version** — creates a GitHub Issue with an upgrade checklist including migration guide links, module path changes, and test steps

The major-version detection is particularly noteworthy. When Traefik v4 appears while Minimal tracks v3, the workflow automatically opens an issue with a migration checklist:

- Review migration guide
- Check Go module path changes
- Verify ldflags version variable
- Update tag filter regex
- Test image build

This is supply chain management as engineering discipline. Each upstream is treated as a first-class dependency with version tracking, integrity verification, and upgrade planning.

### 3. Pinning Philosophies: Exact, Range, and Lockfile

Three distinct pinning cultures emerge:

**Exact pinning (Go ecosystem):** Go modules use exact versions in `go.mod` (e.g., `github.com/aws/aws-sdk-go-v2 v1.41.6`) with the lockfile (`go.sum`) providing transitive integrity. Gitleaks has just 14 direct dependencies — the leanest Go project. Traefik and oCIS carry 100+ each. The `go.sum` lockfile is always committed.

**Range pinning (Python ecosystem):** dep-scan and agent-scan use minimum-version ranges in `pyproject.toml` (e.g., `"rich>=14.0.0"`) with `uv.lock` providing the lockfile. Checkov uses `Pipfile` with mixed strategies — some exact (`bc-jsonpath-ng = "==1.6.1"`), some upper-bounded ranges (`pyyaml = ">=6.0.0,<7.0.0"`). The upper bounds prevent silent breaking changes in major versions.

**Caret/tilde ranges (Node.js ecosystem):** Insomnia uses caret ranges (`^8.17.1`) in `package.json`, with `package-lock.json` (1101KB) pinning exact resolved versions. The monorepo structure means two separate lockfiles.

> [!tip] Lockfiles are the real pinning. Regardless of the declared version range philosophy, the lockfile is what actually gets installed. Projects without lockfiles (some Python projects using bare `requirements.txt`) have non-reproducible builds.

### 4. Vulnerability Response in CI

Three tiers of vulnerability response:

**PR gate (5 projects):** Grype, Threat Dragon, agent-scan, dep-scan, and Minimal run vulnerability scanners on every pull request. This is the strongest posture — vulnerabilities are caught before merge.

**Release gate (3 projects):** oCIS, dep-scan (also), and ZAP scan during release. Vulnerabilities are caught before publication but may accumulate in the main branch between releases.

**Scheduled audit (1 project):** Nextcloud runs `npm-audit-fix.yml` weekly on Sundays across 4 branches (main + 3 stable versions). When vulnerabilities are found, it auto-creates a PR with the audit output as the PR body. This is the only project that automatically fixes vulnerabilities on stable branches.

Minimal's `patch-go-deps.yml` is unique: it runs Grype against the *built container images* daily, then patches Go transitive dependencies in the build configs when vulnerabilities are found. This closes the gap between "source code is clean" and "built artifact is clean."

### 5. Supply Chain Attestation

5 of 14 projects generate supply chain attestations:

- **cosign/sigstore** — OpenTofu (release), Grype (validations), Minimal (build)
- **SLSA provenance** — Insomnia (release-publish), oCIS (release), ZAP (all Docker releases)
- **Notary/Notation** — dep-scan, Grype, Insomnia, oCIS, ZAP

ZAP is the most thorough — every Docker release variant (main, weekly, live) generates Notary signatures and provenance. Insomnia layers SLSA provenance on top of Notary signing for its Docker images.

### 6. Lockfile Commitment

All Go projects commit `go.sum`. All Node.js projects commit `package-lock.json`. The Python projects split:

- **dep-scan, agent-scan** — commit `uv.lock` (uv's lockfile)
- **Checkov** — commits `Pipfile.lock` (pipenv's lockfile)
- **No lockfile** — Wazuh's Python code uses bare `pip install` in CI workflows with no lockfile

### 7. Dependabot Automerge

Nextcloud is the only project with Dependabot automerge. The `dependabot-approve-merge.yml` workflow:

1. Checks that the PR author is `dependabot[bot]` or `renovate[bot]`
2. Blocks on forks (security guard)
3. Auto-approves via `hmarr/auto-approve-action`
4. Enables GitHub auto-merge via `alexwilson/enable-github-automerge-action`

This is safe because Nextcloud's CI is comprehensive — the PR still needs to pass all checks before auto-merge fires.

## Assessment

### Champions

- **Minimal** — Hand-crafted version tracking with SHA256 verification, major-version issue creation, and daily vulnerability patching. The gold standard for dependency management as engineering practice.
- **Nextcloud** — The most comprehensive automated setup: both Renovate and Dependabot, multi-branch npm audit fixes, automerge with CI gating, and cooldown periods to avoid churn.
- **ZAP** — Thorough supply chain attestation (Notary + provenance) on every Docker release variant, with targeted Dependabot ignore rules for known incompatibilities.

### Gaps

- **8 of 14 projects have no automated dependency updating.** Go projects (Traefik, OpenTofu, Gitleaks) are the worst offenders — despite Go making dependency updating trivial. These projects rely on contributors noticing outdated deps.
- **No vulnerability scanning on PRs in most projects.** Only 5 of 14 scan deps during CI. The rest discover vulnerabilities only during releases or not at all.
- **Lockfiles are inconsistent in Python.** Some use `uv.lock`, some use `Pipfile.lock`, some have no lockfile. The ecosystem lacks a standard.
- **No SBOM generation in CI for most projects.** dep-scan generates SBOMs extensively (12 workflows), but most projects skip this. Only dep-scan, Insomnia, Minimal, Threat Dragon, and Grype generate SBOMs.

### Recommendations

1. **Adopt Renovate over Dependabot.** Renovate supports more ecosystems, has better grouping, and can auto-merge with maturity filters. Nextcloud's dual setup is overkill for most projects.
2. **Add vulnerability scanning to PR CI.** `trivy fs --scanners vuln .` or `grype dir:.` takes seconds and catches problems before merge.
3. **Commit lockfiles always.** No exceptions. If your package manager supports a lockfile, commit it.
4. **Pin with upper bounds in Python.** Checkov's `>=X,<Y` pattern prevents silent breakage from major version bumps. Minimum-only ranges (`>=X`) trust upstream semver too much.
5. **Use cooldown periods.** Nextcloud's 4-day default / 8-day major cooldown prevents merging zero-day updates that get yanked. Let new versions bake.
6. **Generate SBOMs at release.** It takes one step (`syft dir:. -o cyclonedx-json=sbom.json`) and creates an auditable record of what went into each release.

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
