---
title: "Documentation-as-Code Patterns Across Open Source"
date: 2025-05-12
type: codebase-analysis
status: complete
source: https://github.com/zarguell/research-reports
tags: [documentation, docs-as-code, ci-cd, mkdocs, jekyll, docusaurus, mdbook, linting, changelog]
---

> **Source:** Synthesis of 14 open source codebases analyzed in this vault. See Related section for individual reports.

# Documentation-as-Code Patterns Across Open Source

## Overview

This report surveys how 14 mature open source projects treat documentation as a first-class engineering artifact — versioned alongside code, validated in CI, and published through automated pipelines. The projects span security tools (Checkov, Grype, Gitleaks, dep-scan, agent-scan, Threat Dragon, ZAP, Wazuh), infrastructure (Traefik, OpenTofu, oCIS, Insomnia), and platforms (Nextcloud, Minimal).

The key finding: the most rigorous documentation-as-code implementations don't use the fanciest tools — they combine boring, well-understood components (markdown linting, link checking, spell checking) into a CI gate that treats docs with the same seriousness as code. Threat Dragon and Traefik are the clear champions here.

## Key Findings

### 1. Static Site Generator Spectrum

Every project with a docs directory uses a different SSG, and the choice correlates with language ecosystem:

- **Jekyll** — Checkov (Ruby-native, GitHub Pages default), Threat Dragon (custom OWASP theme `owasp-td-jekyll`)
- **MkDocs** — Traefik (custom `mkdocs-traefiklabs` theme with heavy plugin stack), oCIS
- **Docusaurus** — dep-scan (TypeScript config, ReadTheDocs hosting)
- **mdBook** — Wazuh (Rust ecosystem, mermaid diagram support)
- **Custom Docker build** — OpenTofu (Dockerfile + docker-compose for isolated builds)

Traefik's MkDocs setup is the most sophisticated: custom theme, `include-markdown` plugin for content reuse, `exclude` plugin for private includes, `redirects` plugin for URL migration, and a custom `mkdocs-traefiklabs>=100.1.0` theme pinned to a high version to prevent accidental downgrades. The entire doc build is pinned in `docs/requirements.txt` with exact versions for reproducibility.

OpenTofu takes isolation further — docs build inside a Docker container via `docker-compose.build.yml`, ensuring the build environment is hermetic regardless of CI runner state.

> [!tip] SSG choice is cultural, not technical. Go projects lean MkDocs, Node.js projects lean Docusaurus, security OWASP projects lean Jekyll. Pick what your contributors already know.

### 2. The Docs Quality Gate: Lint → Build → Verify

Traefik implements the most complete docs quality gate in CI (`.github/workflows/check_doc.yaml`):

1. **Markdown lint** — `markdownlint` with project-local `.markdownlint.json` configs. Per-directory overrides are supported: the lint script finds `.markdownlint.json` files nested in content directories and applies directory-specific rules before running the global check.
2. **Build** — `mkdocs build --strict` (the `--strict` flag treats warnings as errors, preventing broken references from merging)
3. **HTML verification** — `html-proofer` with aggressive caching, parallel execution (one process per vCPU), and a curated URL ignore list for known-flaky external links.

This three-stage pipeline runs on every PR that touches `docs/**`. No doc change lands without passing all three gates.

Threat Dragon achieves similar coverage with different tooling: `markdownlint-cli2` for linting, `lychee` for link checking (with GitHub token auth and per-commit caching), and `pyspelling` for spell checking with a custom `.wordlist.txt` for project-specific terminology.

OpenTofu uses the `remark` ecosystem (remark-lint, remark-validate-links, remark-lint-no-dead-urls) for its Docusaurus-based website — a natural fit since remark integrates directly with the MDX pipeline that Docusaurus uses.

### 3. Changelog Automation

Changelog generation splits into three distinct approaches:

**Release-triggered (Insomnia):** The `update-changelog.yml` workflow fires on `release: [published]`. It uses `stefanzweifel/changelog-updater-action` to inject the GitHub release body into `CHANGELOG.md`, then auto-commits via `git-auto-commit-action`. Clean and hands-off — the changelog writes itself from release notes.

**Git-trailer based (Nextcloud):** The `generate-release-changelog.yml` workflow runs on release publication. It checks out a separate `github_helper` repo alongside the server repo, then generates the changelog by analyzing git history between tags. It handles edge cases like first beta releases (falling back to the previous major's RC1 tag). The changelog is committed directly to the release.

**PR reminder (OpenTofu):** Rather than automating changelog generation, OpenTofu posts a bot comment on every newly opened PR: "Reminder for the PR assignee: If this is a user-visible change, please update the changelog as part of the PR." This is the lightest-touch approach — social engineering over automation.

### 4. Testing the Docs Themselves

OpenTofu has a unique pattern: **testing installation instructions**. The `website.yml` workflow has an `installation-instructions` job that only runs when files under `website/docs/intro/install` change. It executes `make test-linux-install-instructions` — literally running the documented install commands on a fresh Ubuntu runner to verify they work. This catches the most common docs failure mode: instructions that drift from reality.

Minimal takes a different approach: the README *is* the live status page. At 27KB, it contains badges, vulnerability reports, and links to `rtvkiz.github.io/minimal/` — a live vulnerability report that updates on every build. The README doubles as a dashboard.

### 5. Documentation Architecture Patterns

**Co-located (majority):** Most projects keep docs in a `docs/` directory at the repo root. This keeps documentation changes in the same PR as code changes, ensuring they stay synchronized.

**Separate website repo (Traefik):** Traefik's `documentation.yaml` workflow builds docs in the main repo, then publishes to a separate `traefik/doc` repository using the custom `mixtus` tool. This separates the published site from the source code while maintaining a single source of truth for content.

**Dual directory (OpenTofu):** OpenTofu has both `docs/` (internal design docs) and `website/` (public-facing documentation with its own Dockerfile and npm project). The website directory is effectively a sub-project with its own build pipeline.

**Monorepo docs (oCIS):** oCIS organizes docs by service: `docs/services/`, `docs/architecture/`, `docs/apis/`. With 42 microservices in one repo, the docs structure mirrors the service topology.

### 6. Spell Checking and Prose Quality

Only Threat Dragon runs spell checking in CI — via `pyspelling` with a curated `.wordlist.txt` for project-specific terms (technical jargon, product names, acronyms). The configuration uses `pyspelling.filters.markdown` to parse markdown and `pyspelling.filters.html` with `ignores: [code, pre]` to skip code blocks.

This is surprisingly rare. None of the other 13 projects validate prose quality in CI, despite documentation being the first thing users see.

### 7. GitHub Pages Dominance

GitHub Pages is the default hosting for most projects:
- **Checkov** uses the official `actions/jekyll-build-pages` + `actions/deploy-pages` workflow with the `github-pages` environment
- **Traefik** publishes to a dedicated `traefik/doc` repo via custom tooling
- **Minimal** publishes a live vulnerability report via GitHub Pages
- **dep-scan** uses ReadTheDocs (the only non-GitHub Pages deployment)

The Checkov workflow is the cleanest template: it uses `concurrency: group: "pages"` with `cancel-in-progress: false` to prevent deployment collisions while allowing in-progress deploys to complete.

## Assessment

### Champions

- **Threat Dragon** — The most complete docs-as-code pipeline: linting, link checking, spell checking, and build verification all gated on PR. The Jekyll site with custom OWASP theme shows investment in docs as a product.
- **Traefik** — The most sophisticated build pipeline: three-stage quality gate, custom MkDocs theme with 7+ plugins, html-proofer with parallel execution, and a separate publishing repo. The `mkdocs build --strict` flag is the single most impactful CI gate — it makes broken references a build failure.
- **OpenTofu** — Unique in testing installation instructions and using Docker for hermetic doc builds. The `remark` linting ecosystem is well-integrated with Docusaurus.

### Gaps

- **No prose style enforcement.** Only Threat Dragon spell-checks. None use Vale, Alex, or write-good for style/tone consistency. For projects with multiple contributors writing docs, this is a missed opportunity.
- **No visual regression testing.** No project validates that docs render correctly (screenshot comparison, layout checks). Build verification confirms links work, not that content looks right.
- **Inconsistent changelog discipline.** Only 3 of 14 projects automate changelog generation. Most rely on manual updates, which inevitably drift.
- **API docs are rare.** Only Nextcloud has `openapi.yml` for API documentation. Go projects with extensive HTTP APIs (Traefik, oCIS) don't generate API docs from code — they're hand-written.
- **Minimal projects get minimal docs.** Gitleaks (27KB README, no docs directory) and Grype (6KB README, no docs directory) rely entirely on README files. This works for focused CLI tools but limits discoverability.

### Recommendations

1. **Start with `mkdocs build --strict`** in CI. It catches broken links, missing images, and invalid references for zero marginal cost.
2. **Add lychee for link checking.** It's faster than html-proofer, supports markdown natively (no build step needed), and caches results between runs.
3. **Automate changelogs from release events.** The Insomnia pattern (release body → CHANGELOG.md) is the simplest to adopt.
4. **Test your install instructions.** OpenTofu's pattern of running documented install commands in CI is the highest-ROI docs test.
5. **Use `.editorconfig` consistently.** Only 3 of 14 projects have one. It's the lowest-effort way to enforce consistent formatting across doc contributors.
6. **Pin doc dependencies.** Traefik pins every MkDocs plugin version. Dep-scan pins nothing. Pinning prevents "docs build broke overnight" incidents.

## Related

- [[best-cicd-implementations-reference-guide]]
- [[open-source-release-engineering-reference-guide]]
- [[testing-philosophy-spectrum]]
- [[github-actions-reusable-patterns-reference-guide]]
- [[container-security-hardening-reference-guide]]
- [[analyzing-threat-dragon]]
- [[analyzing-traefik]]
- [[analyzing-insomnia]]
- [[analyzing-checkov]]
- [[analyzing-opentofu]]
- [[analyzing-ocis]]
- [[analyzing-gitleaks]]
- [[analyzing-grype]]
- [[analyzing-dep-scan]]
- [[analyzing-wazuh]]
- [[analyzing-nextcloud-server]]
