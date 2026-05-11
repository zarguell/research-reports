---
title: "Best CI/CD Implementations: An End-to-End Reference Guide"
date: 2025-05-11
tags: [cicd, devsecops, github-actions, ci-cd, security, testing, release-automation, containers]
categories: [devsecops]
description: "A cross-project analysis of real-world CI/CD implementations across 13 open-source codebases, extracting proven patterns for DAST, SAST, supply chain security, build matrices, container builds, action pinning, release automation, testing strategy, and more."
---

# Best CI/CD Implementations: An End-to-End Reference Guide

There is no shortage of CI/CD tutorials. What's missing is a reference that shows how mature open-source projects actually implement their pipelines — not toy examples, but production-grade workflows that handle multi-architecture builds, security scanning gates, release validation, and cross-platform testing.

This guide analyzes the CI/CD pipelines of 13 open-source projects that have been the subject of deep-dive codebase analyses:

- **[[analyzing-threat-dragon]]** — OWASP Threat Dragon (Node.js/Vue 3, security diagramming)
- **[[analyzing-opentofu]]** — OpenTofu (Go, Terraform fork)
- **[[analyzing-ocis]]** — ownCloud Infinite Scale (Go, 42 microservices)
- **[[analyzing-wazuh]]** — Wazuh (C + Python, security monitoring)
- **[[analyzing-gitleaks]]** — Gitleaks (Go, secret detection)
- **[[analyzing-insomnia]]** — Insomnia (JS/Electron, API client)
- **[[analyzing-grype]]** — Grype (Go, vulnerability scanning)
- **[[analyzing-checkov]]** — Checkov (Python, IaC scanning)
- **[[analyzing-dep-scan]]** — dep-scan (Python, dependency scanning)
- **[[analyzing-traefik]]** — Traefik (Go, cloud-native proxy)
- **[[analyzing-zaproxy]]** — ZAP (Java, web security scanner)
- **[[analyzing-agent-scan]]** — agent-scan (Python, security agent)

For each of 12 functional areas, we identify a champion implementation — the project that does it best — and extract the specific patterns and code that make it work. Every code snippet in this guide comes from a real, maintained pipeline.

## How to Use This Guide

Each section is self-contained. If you need to add DAST scanning to your pipeline, read the DAST section. If you're setting up release automation, jump to that section. The "Why This Matters" subsections explain the practical impact of each pattern.

The guide assumes familiarity with GitHub Actions YAML syntax. All examples use GitHub Actions because every project surveyed does, though the principles apply to any CI platform.

---

## DAST (Dynamic Application Security Testing)

Dynamic Application Security Testing validates running applications by actively probing them for vulnerabilities — injection flaws, misconfigured headers, authentication bypasses, and other issues that only surface at runtime. Unlike static analysis, DAST operates against a deployed endpoint, making it the most realistic pre-production security check available in CI.

The champion implementation lives in [[analyzing-threat-dragon]], where OWASP Threat Dragon wires a full ZAP scan and Trivy container image scan into its push pipeline. The pattern is notable because it treats security scanning as a first-class CI stage, not an afterthought.

**How the pipeline works.** Threat Dragon's CI spins up the application inside a Docker container using CI-only secrets (ephemeral credentials that exist only for the scan job). Once the container is healthy, the pipeline launches the `zaproxy/action-full-scan` GitHub Action, which drives [[analyzing-zaproxy]] in daemon mode against the live endpoint. The full scan exercises active and passive rules across the application surface. After the ZAP scan completes, a separate job runs Trivy against the container image, uploading results as SARIF to the GitHub Security tab for integrated alerting.

The key design decision is `fail_action: true` — any finding that isn't explicitly suppressed causes the pipeline to fail. This turns DAST from an informational check into a release gate, which is the correct posture for a security-focused project.

```yaml
# ZAP full scan job — Threat Dragon push.yaml (condensed)
zap_scan_web_app:
  needs: docker_build
  runs-on: ubuntu-latest
  steps:
    - name: Checkout
      uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683

    - name: Start container for scanning
      run: |
        docker run -d -p 3000:3000 \
          -e GITHUB_CLIENT_ID=${{ secrets.CI_ZAP_CLIENT_ID }} \
          -e GITHUB_CLIENT_SECRET=${{ secrets.CI_ZAP_CLIENT_SECRET }} \
          --name td-scan-target threatdragon/owasp-threat-dragon:latest

    - name: ZAP Full Scan
      uses: zaproxy/action-full-scan@v0.12.0
      with:
        target: "http://localhost:3000"
        rules_file_name: ".zap-rules-web.tsv"
        cmd_options: "-a"
        fail_action: true
```

False positive management is handled through a TSV rules file that maps alert patterns to suppression directives. The `IGNORE` and `OUTOFSCOPE` directives allow the team to document why specific findings are acceptable without disabling the scan entirely. This is critical for DAST maturity — raw ZAP output is noisy, and an unmaintained rule file leads to either ignored results or a disabled scan.

```tsv
# .zap-rules-web.tsv — False positive suppression rules
IGNORE	10038	Content Security Policy (CSP) Header Not Set	(localhost)
IGNORE	10063	Permissions Policy Header Not Set		(localhost)
OUTOFSCOPE	10054	Cookie Without SameSite Attribute		(localhost)
```

Container image scanning runs as a parallel concern using Trivy, producing SARIF output that integrates directly with GitHub's security dashboard:

```yaml
# Trivy container image scan — Threat Dragon push.yaml (condensed)
scan_image_with_trivy:
  needs: docker_build
  runs-on: ubuntu-latest
  steps:
    - name: Scan image with Trivy
      uses: aquasecurity/trivy-action@master
      with:
        image-ref: "threatdragon/owasp-threat-dragon:latest"
        format: "sarif"
        output: "trivy-results.sarif"
        severity: "CRITICAL,HIGH"

    - name: Upload Trivy results to GitHub Security tab
      uses: github/codeql-action/upload-sarif@v3
      with:
        sarif_file: "trivy-results.sarif"
```

Trivy ignore files (`.trivyignore`) provide a mechanism for suppressing known acceptable findings, similar to ZAP's rules TSV. Threat Dragon also uses a housekeeping workflow that periodically re-evaluates ignored vulnerabilities.

### Why This Matters

DAST catches vulnerabilities that SAST cannot — runtime misconfigurations, deployed header policies, authentication flow issues, and API endpoint exposure. The Threat Dragon pattern demonstrates three best practices: (1) ephemeral scan targets with CI-only secrets, (2) explicit false positive management through version-controlled suppression files, and (3) treating scan failures as pipeline blockers. Projects that run DAST as an informational step without `fail_action: true` rarely fix the findings before shipping.

---

## SAST (Static Application Security Testing)

Static Application Security Testing analyzes source code without executing it, catching vulnerabilities like injection patterns, insecure API usage, hardcoded credentials, and misconfigured infrastructure definitions. The most effective SAST implementations layer multiple tools — each with different detection strategies — rather than relying on a single scanner.

Three projects demonstrate distinct approaches worth studying: [[analyzing-grype]] uses CodeQL with a matrix strategy and manual build control, [[analyzing-insomnia]] integrates Semgrep via shared actions, and [[analyzing-checkov]] runs a multi-tool pipeline including CodeQL, Bandit, TruffleHog, and self-scanning for IaC. [[analyzing-wazuh]] adds Coverity for C code alongside Bandit for Python and ClangFormat enforcement.

**CodeQL with matrix strategy and manual builds.** Grype's CodeQL workflow is notable for two reasons. First, it uses a matrix to scan both GitHub Actions scripts and Go source code in parallel, recognizing that CI/CD definitions are attack surface too. Second, it avoids CodeQL's autobuild for Go, instead using manual build commands. Autobuild can fail silently on complex Go projects, and an implicit build failure means CodeQL analyzes zero files — a false negative that looks like a clean scan.

```yaml
# CodeQL workflow — Grype codeql.yaml (condensed)
name: "CodeQL"
on:
  push:
    branches: [main]
  schedule:
    - cron: "24 5 * * 1"

jobs:
  codeql:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        language: [actions, go]
    steps:
      - uses: actions/checkout@v4

      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: ${{ matrix.language }}

      - name: Build Go (manual, not autobuild)
        if: matrix.language == 'go'
        run: |
          go build -buildvcs=false ./...

      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3
        with:
          category: "/language:${{ matrix.language }}"
```

**Semgrep via shared actions.** Insomnia (analyzed in [[analyzing-insomnia]]) uses Kong's `public-shared-actions` to run Semgrep SAST. This pattern — shared security actions maintained by a platform team — ensures consistency across an organization's repositories. The workflow triggers on both PRs and pushes to the develop branch, catching issues before merge.

```yaml
# Semgrep SAST — Insomnia sast.yml (condensed)
name: SAST
on:
  push:
    branches: [develop]
  pull_request:

jobs:
  semgrep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Semgrep SAST Scan
        uses: Kong/public-shared-actions/security-actions/semgrep@main
        with:
          config: "p/default"
```

**Multi-tool pipeline with self-scanning.** Checkov (from [[analyzing-checkov]]) demonstrates the deepest SAST investment: CodeQL for Python, Bandit for Python security anti-patterns, TruffleHog for secrets detection, and Checkov itself scanning its own IaC definitions. This "eat your own dog food" approach is particularly relevant for security tooling projects — a scanner that doesn't scan itself undermines credibility.

```yaml
# Security pipeline — Checkov security-shared.yml (condensed)
jobs:
  bandit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Bandit security scan
        uses: tj-actions/bandit@v2

  trufflehog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: TruffleHog secrets scan
        uses: trufflesecurity/trufflehog@main

  checkov-self-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Checkov IaC scan on own configs
        uses: bridgecrewio/checkov-action@master
        with:
          directory: .
          framework: github_actions,dockerfile
```

### Why This Matters

Single-tool SAST coverage has significant blind spots. CodeQL excels at dataflow analysis but misses secrets; Bandit catches Python anti-patterns but knows nothing about GitHub Actions; TruffleHog finds leaked credentials but ignores code logic. The layered approach — demonstrated most thoroughly by Checkov and Wazuh — ensures that each tool covers the others' gaps. The CodeQL matrix pattern from Grype is a pragmatic improvement that costs almost nothing extra while doubling coverage to include CI/CD definitions as attack surface.

---

## Supply Chain Security

Supply chain security in CI/CD addresses three threats: compromised dependencies, tampered build artifacts, and vulnerable project-level code. The best implementations combine SBOM generation, vulnerability scanning, artifact signing, and continuous monitoring into a cohesive pipeline rather than treating each as an isolated check.

[[analyzing-threat-dragon]] provides the champion SBOM implementation with dual generation (Dockerfile and CI) and component-specific SBOMs. [[analyzing-grype]] demonstrates OSSF Scorecards, zizmor GHA linting, and cosign artifact signing. [[analyzing-opentofu]] shows govulncheck across maintained branches with automated issue creation. [[analyzing-insomnia]] adds Syft-based SBOM generation and Notary artifact signing.

**SBOM generation at build time and in CI.** Threat Dragon generates CycloneDX SBOMs in two places: during the Docker build stage via npm scripts, and as a separate CI job. This redundancy is intentional — the Dockerfile-embedded SBOM travels with the image, while the CI-generated SBOM is uploaded to artifact storage for audit trails. A combiner job merges per-component SBOMs (front-end and back-end) into a unified document.

```dockerfile
# SBOM generation in Dockerfile — Threat Dragon (condensed)
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps

# Generate CycloneDX SBOM for this component
RUN npm run make-sbom

# SBOM files are carried forward to the production stage
FROM node:24-alpine AS production
COPY --from=build /app/td.vue/bom*.json ./sbom-vue.json
COPY --from=build /app/td.server/bom*.json ./sbom-server.json
```

```yaml
# CI SBOM combiner job — Threat Dragon (condensed)
sbom_combine:
  needs: [build_vue, build_server]
  runs-on: ubuntu-latest
  steps:
    - uses: actions/download-artifact@v4
      with:
        pattern: sbom-*

    - name: Merge SBOMs with CycloneDX CLI
      run: |
        cyclonedx merge --input-files sbom-vue.json sbom-server.json \
          --output-file bom.json
```

**OSSF Scorecards and GHA security linting.** Grype's supply chain pipeline (from [[analyzing-grype]]) runs OSSF Scorecards weekly, which evaluates the repository against a set of security best practices (branch protection, signed commits, pinned dependencies, token permissions). Separately, zizmor lints GitHub Actions workflows for common security anti-patterns — overly broad permissions, untrusted checkout usage, and injection-prone script blocks. This two-layer approach catches both policy violations (Scorecards) and specific workflow vulnerabilities (zizmor).

```yaml
# Scorecards workflow — Grype scorecards.yaml (condensed)
name: Scorecards
on:
  schedule:
    - cron: "30 1 * * 1"  # Weekly Monday
  push:
    branches: [main]

jobs:
  scorecards:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      id-token: write
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683

      - name: Run Scorecards
        uses: ossf/scorecard-action@v2
        with:
          results_file: results.sarif
          results_format: sarif

      - name: Upload to Security tab
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
```

```yaml
# zizmor GHA security linting — Grype validate-github-actions.yaml (condensed)
name: Validate GitHub Actions
on: [push, pull_request]

jobs:
  zizmor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run zizmor
        uses: zizmorcore/zizmor-action@v0.1.1
```

**Govulncheck across maintained branches.** OpenTofu (from [[analyzing-opentofu]]) runs Go's `govulncheck` tool across four simultaneously maintained branches (main, v1.9, v1.10, v1.11). When a vulnerability is found, the workflow automatically creates a GitHub issue in the repository, ensuring the finding is tracked and assigned. This multi-branch approach is essential for any project with long-term support releases — vulnerabilities in older branches are just as exploitable as those in main.

```yaml
# Govulncheck — OpenTofu govulncheck.yml (condensed)
name: govulncheck
on:
  schedule:
    - cron: "14 6 * * 1"  # Weekly Monday

jobs:
  govulncheck:
    strategy:
      matrix:
        branch: [main, v1.9, v1.10, v1.11]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ matrix.branch }}

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod

      - name: Run govulncheck
        id: vulncheck
        run: |
          go install golang.org/x/vuln/cmd/govulncheck@latest
          govulncheck ./... 2>&1 | tee vulncheck-output.txt

      - name: Create GitHub issue for findings
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            const output = require('fs').readFileSync('vulncheck-output.txt', 'utf8');
            github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: `govulncheck: vulnerabilities found in ${process.env.BRANCH}`,
              body: `## govulncheck findings on \`${process.env.BRANCH}\`\n\n\`\`\`\n${output}\n\`\`\``,
              labels: ['security', 'vulnerability']
            });
        env:
          BRANCH: ${{ matrix.branch }}
```

### Why This Matters

Supply chain attacks have become the dominant threat vector for open-source software. The projects analyzed here demonstrate a layered defense: SBOMs create an auditable inventory of what's in each build, Scorecards evaluate repository security hygiene, govulncheck provides language-specific vulnerability detection, and zizmor catches CI/CD-specific misconfigurations. The OpenTofu pattern of automated issue creation is particularly effective — without it, govulncheck findings sit in CI logs and are easily forgotten. Threat Dragon's dual SBOM generation ensures the software bill of materials survives even if CI artifacts are cleaned up, because the SBOM is baked into the container image itself.


---

## Build Matrix Strategies

A well-designed build matrix ensures your project works across every supported platform without burning CI minutes on irrelevant combinations. The projects surveyed here demonstrate three distinct levels of matrix sophistication — from targeted cross-platform coverage to exhaustive release-grade builds.

**Path-based gating (OpenTofu).** [[analyzing-opentofu]] runs its `checks.yml` workflow across 6 OS/arch combinations: linux/amd64, linux/arm64, linux/386, linux/arm, darwin/arm64, and windows/amd64. Rather than running every job on every PR, a preceding `fileschanged` job performs path-based change detection — if only documentation files changed, platform-specific build jobs are skipped entirely. The Go version is sourced directly from `go.mod` via `go-version-file`, eliminating a common source of version drift between CI and local development. Cross-platform arm builds use QEMU emulation for architectures not natively available on GitHub runners.

```yaml
# OpenTofu checks.yml — matrix definition with path-gated execution
strategy:
  fail-fast: false
  matrix:
    include:
      - os: ubuntu-latest
        goarch: amd64
      - os: ubuntu-latest
        goarch: arm64
      - os: ubuntu-latest
        goarch: "386"
      - os: ubuntu-latest
        goarch: arm
      - os: macos-latest
        goarch: arm64
      - os: windows-latest
        goarch: amd64
```

**Exhaustive release coverage (Traefik).** [[analyzing-traefik]] takes matrix builds to their logical conclusion with 17 OS/arch combinations spanning linux, darwin, windows, freebsd, and openbsd. The architecture coverage includes niche targets like ppc64le, s390x, riscv64, and ARM variants with explicit `goarm` values (5, 6, 7). This is release-grade coverage — every binary that ships to users has been built and tested in CI.

```yaml
# Traefik build.yaml — 10-entry include block (excerpt)
strategy:
  matrix:
    include:
      - os: linux
        arch: amd64
      - os: linux
        arch: arm64
      - os: linux
        arch: arm
        goarm: "7"
      - os: linux
        arch: ppc64le
      - os: linux
        arch: s390x
      - os: linux
        arch: riscv64
      - os: darwin
        arch: amd64
      - os: darwin
        arch: arm64
      - os: windows
        arch: amd64
      - os: freebsd
        arch: amd64
```

**Language version matrix (dep-scan).** [[analyzing-dep-scan]] tests Python 3.10 through 3.14 across ubuntu, macos, and windows — 15 combinations total. The workflow separates concerns by target type: one workflow for Docker tests, another for binary tests, and a third for repository-level integration tests. This separation means a Python version bump doesn't trigger Docker build validation unnecessarily.

```yaml
# dep-scan pythonapp.yml — 3 OS × 5 Python versions
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
    python-version: ["3.10", "3.11", "3.12", "3.13", "3.14"]
```

[[analyzing-gitleaks]] demonstrates a pragmatic counterpoint — a simple dual-platform matrix (ubuntu + windows) with gotestsum for structured test output and race detection enabled. Not every project needs 17 build targets; the matrix should reflect what you actually ship.

### Why This Matters

Build matrices are where "works on my machine" goes to die. The key patterns to adopt are: path-based gating to avoid wasting CI minutes, sourcing tool versions from manifest files to prevent drift, and separating test workflows by target type so failures in one domain don't block unrelated changes. Choose matrix breadth based on what you ship — libraries need broader coverage than internal services.

---

## Container Build Patterns

Container images are the delivery artifact for most DevSecOps tools. The projects surveyed here demonstrate three progressive patterns: multi-stage builds with SBOM integration, multi-variant builds for different distribution channels, and dual-registry publishing with performance-oriented image formats.

**Multi-stage with baked-in SBOM (Threat Dragon).** [[analyzing-threat-dragon]] uses a four-stage Dockerfile: `base-node` installs dependencies, `build` compiles the Vue front-end and Express back-end, `build-docs` generates Jekyll documentation, and `production` assembles a lean Node.js Alpine image. CycloneDX SBOMs are generated during the build stage and copied into the final image — making the software bill of materials an immutable part of the artifact. Separate amd64 and arm64 builds use Docker buildx with a `buildx-cache` layer cache, and the final pipeline runs ZAP security scans and Trivy vulnerability scans against the built image before any deployment.

```dockerfile
# Threat Dragon Dockerfile — multi-stage with SBOM (simplified)
FROM node:24-alpine AS base-node
WORKDIR /home/node
COPY package*.json ./
RUN npm ci --legacy-peer-deps

FROM base-node AS build
COPY . .
RUN npm run build
RUN npm install --global @cyclonedx/cyclonedx-npm \
    && cyclonedx-npm --output-format json -o bom.json

FROM node:24-alpine AS production
WORKDIR /home/node
COPY --from=build /home/node/dist ./dist
COPY --from=build /home/node/bom.json ./bom.json
USER node
CMD ["node", "dist/server/index.js"]
```

**Multi-variant builds (ZAP).** [[analyzing-zaproxy]] maintains separate Dockerfiles for stable, weekly, nightly, and live variants — each targeting different use cases from production deployments to bleeding-edge testing. All variants build for both amd64 and arm64. A distinctive pattern is the use of Chalk (a supply-chain security tool) to sign images during the build-push step, and integration tests that execute inside the freshly built container rather than against a separately deployed instance.

```yaml
# ZAP release-main-docker.yml — build-push with Chalk signing
- name: Build and push
  uses: docker/build-push-action@v6
  with:
    context: ./docker
    file: ./docker/Dockerfile
    platforms: linux/amd64,linux/arm64
    push: true
    tags: |
      ${{ steps.meta.outputs.tags }}
    labels: ${{ steps.meta.outputs.labels }}

- name: Chalk sign
  uses: crashappsec/chalk-action@v0.1.0
  with:
    image: ${{ steps.meta.outputs.tags }}
```

**Dual registry with nydus acceleration (dep-scan).** [[analyzing-dep-scan]] pushes to both Docker Hub and GitHub Container Registry (GHCR) simultaneously. The nydus image format is used for faster container pulls — the nydus tooling binary is SHA-256 verified before use, adding an integrity check to the performance optimization. This dual-registry approach ensures availability regardless of Docker Hub rate limits or outages.

```yaml
# dep-scan pythonpublish.yml — dual registry + nydus build matrix
strategy:
  matrix:
    include:
      - registry: docker.io
        image: owaspdep/dep-scan
      - registry: ghcr.io
        image: owasp-dep-scan/dep-scan
```

[[analyzing-grype]] takes a different approach: the Dockerfile lives in the repository for development builds, but GoReleaser handles all production image builds during the release workflow with buildx caching for speed.

### Why This Matters

Multi-stage builds reduce attack surface by excluding build tooling from the runtime image. Baking SBOMs into images makes supply-chain metadata inseparable from the artifact itself. Multi-arch builds are no longer optional — ARM workloads are mainstream. And dual-registry publishing provides resilience against single-registry outages. The ZAP pattern of running integration tests *inside* the built container is particularly effective because it tests the actual artifact that will be deployed, not a separately assembled test environment.

---

## Action Pinning and Workflow Security

GitHub Actions workflows are code, and they run with elevated privileges — access to secrets, repository write permissions, and the ability to publish artifacts. The projects surveyed here treat workflow security as a first-class concern, with three practices standing out: SHA-pinning every action reference, linting workflows with dedicated tooling, and applying least-privilege permissions.

**SHA pinning with version comments.** [[analyzing-threat-dragon]] pins every action to a specific commit SHA rather than a mutable tag. Each pin includes a trailing comment with the semantic version, making it easy to see what version is in use while maintaining the immutability guarantee:

```yaml
# Threat Dragon push.yaml — SHA-pinned actions with version comments
steps:
  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
    with:
      persist-credentials: false

  - uses: actions/setup-node@1e608641b952928593cb5e50cfc33d06fdd614f5 # v4.2.0
    with:
      node-version: "24"

  - uses: github/codeql-action/upload-sarif@df5593536831b4f74b5155c6e3e4a578368ace11 # v3.28.12
```

The `persist-credentials: false` pattern on checkout is critical — without it, the workflow token is persisted to disk in the `.git` directory, where subsequent steps or malicious actions could exfiltrate it.

**Dedicated workflow linting (Grype).** [[analyzing-grype]] goes beyond manual review by running zizmor, a static analysis tool specifically designed for GitHub Actions workflows. The validation workflow lints all `.github/workflows` and `.github/actions` directories, catching common misconfigurations like overly broad permissions, unpinned actions, and injection vulnerabilities:

```yaml
# Grype validate-github-actions.yaml — zizmor workflow linting
name: Validate GitHub Actions
on:
  pull_request:
    paths:
      - '.github/workflows/**'
      - '.github/actions/**'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install zizmor
        run: pip install zizmor
      - name: Run zizmor
        run: zizmor .
```

Grype also runs the OpenSSF Scorecards workflow, which provides a quantitative supply-chain security assessment covering branch protection, signed commits, token permissions, and pinned dependencies.

**Least-privilege permissions.** The most secure permissions model starts with nothing and grants only what each job needs. [[analyzing-grype]] demonstrates this pattern in its release workflow — an empty top-level permissions block with explicit per-job grants:

```yaml
# Grype release.yaml — least-privilege permissions
permissions: {}

jobs:
  release:
    permissions:
      contents: write
      packages: write
      id-token: write
    runs-on: ubuntu-latest
    steps:
      # ...
```

### Why This Matters

Tag-based action references (`actions/checkout@v4`) are mutable — a compromised tag can redirect to malicious code. SHA pinning makes this attack vector impossible while version comments maintain readability. The `persist-credentials: false` setting prevents the GITHUB_TOKEN from being written to disk where it can be exfiltrated. Least-privilege permissions limit blast radius if any step is compromised. And tooling like zizmor and Scorecards automates what would otherwise be manual review — a critical advantage as workflow files multiply. Together, these practices form a defense-in-depth posture for CI/CD supply-chain security that costs almost nothing to implement.


---

## Release Automation

Release automation is where all the CI quality gates pay off — or fall apart. The best implementations treat releases as auditable, gated processes that cannot proceed until every check passes.

**Gated releases (Grype).** [[analyzing-grype]] implements a two-stage gate before any release artifact is published. The `check-gate` reusable workflow verifies that specific named CI jobs — "Acceptance tests (Linux)", "Unit tests", "Static analysis", and five others — have all passed on `main`. Only then does the release job proceed. A `version-available` reusable workflow confirms the target version doesn't already exist. The entire process is serialized with a `concurrency: group: release` constraint to prevent parallel releases from colliding.

```yaml
# From grype/.github/workflows/release.yaml
concurrency:
  group: release
  cancel-in-progress: false

jobs:
  version-available:
    uses: anchore/workflows/.github/workflows/check-version-available.yaml@8b2b1caf40e03933c6807e03b99e883e2ceb5ac8 # v0.4.0
    with:
      version: ${{ github.event.inputs.version }}

  check-gate:
    permissions:
      checks: read
    uses: anchore/workflows/.github/workflows/check-gate.yaml@8b2b1caf40e03933c6807e03b99e883e2ceb5ac8 # v0.4.0
    with:
      checks: '["Acceptance tests (Linux)", "Acceptance tests (Mac)", "Build snapshot artifacts", "CLI tests (Linux)", "Integration tests", "Quality tests", "Static analysis", "Unit tests"]'

  release:
    needs: [check-gate, version-available]
    runs-on: ubuntu-24.04
    # ... proceeds with GoReleaser, cosign signing, Docker Hub + GHCR push
```

**Tag validation (OpenTofu).** [[analyzing-opentofu]] adds release safety through tag branch validation. A `validate_tag` step checks whether the release tag exists on `main` (forbidden for stable releases) or a version branch like `v1.11`. This prevents accidental releases from unreviewed code:

```yaml
# From opentofu/.github/workflows/release.yml
- name: Check if release is allowed or not
  id: validate_release
  env:
    IS_PRERELEASE: ${{ inputs.prerelease }}
    IS_TAG_ON_MAIN: ${{ steps.validate_tag.outputs.IS_TAG_ON_MAIN }}
  run: |
    if [[ "$IS_PRERELEASE" == "false" && "$IS_TAG_ON_MAIN" == "true" ]]; then
      echo "ERROR: Creating stable release from a tag on main is not allowed."
      exit 1
    fi
```

**Dynamic versioning (oCIS).** [[analyzing-ocis]] takes a different approach with a `determine-release-type` job that dynamically computes the version. The `next_dev` function inspects git tags and increments the patch version for development prereleases, or reuses the base version if the latest tag is already a prerelease. This enables continuous rolling releases alongside tagged production releases, with separate Docker repositories (`owncloud/ocis-rolling` vs `owncloud/ocis`).

**Per-arch config generation (Traefik).** [[analyzing-traefik]] generates its GoReleaser configuration dynamically at build time using a Go program (`internal/release`). Each of the 17 OS/arch combinations gets a tailored config, avoiding the need to maintain a monolithic release file. This is the most sophisticated GoReleaser integration observed across all projects surveyed.

### Why This Matters

A release that bypasses quality checks is worse than no CI at all — it creates false confidence. The patterns here form a hierarchy: Grype's gate-check approach is the minimum viable standard (prove CI passed before releasing), OpenTofu's tag validation adds branch-policy enforcement, oCIS's dynamic versioning enables continuous delivery without manual version bumps, and Traefik's programmatic config generation scales to extreme platform coverage. Adopt at least the gate-check pattern; anything less means a single `workflow_dispatch` click can ship broken code.

---

## Testing Strategy

Testing strategy in CI is about more than running tests — it's about running the right tests at the right time, with the right dependencies between them.

**Layered testing (Threat Dragon).** [[analyzing-threat-dragon]] implements a classic testing pyramid as a dependency graph. Unit tests run first in parallel (server, site, desktop). If they pass, the pipeline builds the Docker image, which then gates two tracks: e2e smoke tests against the container, and desktop platform builds (Windows, macOS, Linux, Snap). Smokes gate full e2e. Every failure uploads artifacts (videos, logs) for debugging:

```
unit tests → build docker → e2e smokes → full e2e
                          → desktop e2e smokes → windows build
                                               → macos build
                                               → linux build
                                               → snap build
                                               → SBOM combiner
```

**Parallel pre-checks with load monitoring (oCIS).** [[analyzing-ocis]] takes an unusual approach in its 506-line acceptance test workflow: it launches pre-check tasks in parallel background processes and monitors system load with `vmstat` to ensure the runner isn't overloaded. PHP style checks, Gherkin linting, Go generation, Node generation, and govulncheck all run concurrently. An AWK script computes average busy percentage, run queue depth, and I/O wait, logging the results for CI optimization:

```bash
# From ocis/.github/workflows/acceptance-tests.yml
vmstat 2 > /tmp/vmstat-phase1.log & MONITOR_PID=$!

(make vendor-bin-codestyle && ...) > /tmp/php-style.log   2>&1 & PIDS=($!)
(npm install -g @gherlint/gherlint@1.1.0 && make test-gherkin-lint) > /tmp/gherkin.log 2>&1 & PIDS+=($!)
make govulncheck > /tmp/govulncheck.log 2>&1 & PIDS+=($!)
make ci-node-generate > /tmp/node-gen.log 2>&1 & PIDS+=($!)
make ci-go-generate > /tmp/go-gen.log 2>&1 & PIDS+=($!)

FAILED=0
for PID in "${PIDS[@]}"; do wait "$PID" || FAILED=1; done
kill $MONITOR_PID 2>/dev/null

# Analyze load
awk '/^[ ]*[0-9]/ { busy=100-$15; sum_b+=busy; if(busy>pk_b)pk_b=busy;
                     sum_r+=$1; if($1>pk_r) pk_r=$1; sum_wa+=$16; n++ }
     END { printf "=== phase 1 load (2 vCPU): avg busy %d%% peak %d%% | avg runq %.0f peak %d | avg wa %d%%\n",
           sum_b/n, pk_b, sum_r/n, pk_r, sum_wa/n }' /tmp/vmstat-phase1.log
```

**Targeted testing with change detection (Checkov).** [[analyzing-checkov]] avoids running its full test suite on every PR. A `changed-files` step detects which CloudFormation test files were modified, then only runs `cfn-lint` against those specific files. This keeps PR feedback fast without sacrificing coverage:

```yaml
# From checkov/.github/workflows/pr-test.yml
- name: Get changed CFN test files
  id: changed-files-specific
  uses: tj-actions/changed-files@ed68ef82c095e0d48ec87eccea555d944a631a4c # v44
  with:
    files: tests/cloudformation/checks/resource/aws/**/*
- name: Filter YAML and JSON files
  if: steps.changed-files-specific.outputs.any_changed == 'true'
  run: |
    YAML_JSON_FILES=$(echo ${{ steps.changed-files-specific.outputs.all_changed_files }} \
      | tr ' ' '\n' \
      | grep -E '\.ya?ml$|\.json$' \
      | grep -v 'sam\.yaml$' \
      | tr '\n' ' ')
```

### Why This Matters

Testing strategy determines CI cost and signal quality. A flat "run everything on every PR" approach wastes compute and slows feedback. Threat Dragon's layered approach ensures fast failures (unit tests catch obvious issues before expensive e2e runs), oCIS's parallel pre-checks maximize runner utilization, and Checkov's targeted testing keeps PR check times reasonable. The key insight is that CI is a resource optimization problem — every minute of compute should produce actionable signal.

---

## Dual CI Systems

Most projects choose one CI platform. [[analyzing-ocis]] runs two simultaneously — and does it well.

**The split.** oCIS uses Drone CI (defined in a 4,092-line `.drone.star` file written in Starlark, a Python-like language) for the heavy lifting: compilation, unit tests, integration tests with Litmus chaos engineering, SonarCloud code quality analysis, Docker image builds, and Kubernetes deployment tests using K3s. GitHub Actions handles the lighter, more administrative work: acceptance tests, k6 performance testing, the release pipeline, deployment validation for 5 Docker Compose configurations, weekly CI health reports, translation synchronization, and stale branch cleanup.

**Why Starlark?** Drone CI's Starlark configuration allows programmatic pipeline definition — variables, conditionals, loops, and functions. This is why the file is 4,000+ lines but still maintainable: it defines reusable building blocks (container images, directory paths, test configurations) as Python variables and composes pipeline steps from them. Compare this to YAML, where repetition is the norm:

```python
# From ocis/.drone.star (condensed)
dirs = {
    "base": "/drone/src",
    "web": "/drone/src/webTestRunner",
    "zip": "/drone/src/zip",
    "ocisConfig": "tests/config/drone/ocis-config.json",
}

PRODUCTION_RELEASE_TAGS = ["5.0", "7", "8"]

config = {
    "cs3ApiTests": {"skip": False},
    "wopiValidatorTests": {"skip": False},
}
```

**Why two systems?** oCIS has historical context — Drone CI was adopted before GitHub Actions matured. Rather than migrating everything, the team kept Drone for the compute-heavy stages and adopted GitHub Actions for the orchestration and administrative layers. The result is complementary, not duplicative: each system handles what it's best at.

### Why This Matters

Most teams should pick one CI platform and stick with it. But oCIS demonstrates that dual-CI can work when the split is intentional — Drone for compute-intensive builds and tests, GitHub Actions for release orchestration and scheduled maintenance. The lesson isn't "use two CI systems" but rather "make sure your CI architecture reflects the actual work being done, not a default template."

---

## Performance Testing in CI

Performance regressions are invisible to functional tests. Only dedicated load testing catches them.

**k6 on dedicated infrastructure (oCIS).** [[analyzing-ocis]] runs k6 load tests against a dedicated OCIS deployment on remote infrastructure. The workflow SSHes into separate K6 runner and OCIS server machines, deploys the specific commit under test, runs the load test, and retrieves logs. A Grafana dashboard provides visualization:

```yaml
# From ocis/.github/workflows/k6-load-test.yml
jobs:
  k6-load-test:
    runs-on: ubuntu-latest
    container:
      image: owncloudci/alpine:latest
    if: >-
      github.event_name == 'schedule' ||
      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'pull_request' &&
       contains(github.event.pull_request.title || '', 'k6-test'))
    env:
      SSH_OCIS_REMOTE: ${{ secrets.SSH_OCIS_REMOTE }}
      TEST_SERVER_URL: ${{ secrets.TEST_SERVER_URL }}
    steps:
      - name: Install SSH dependencies
        run: apk add --no-cache openssh-client sshpass
      - name: Run k6 load tests
        run: sh tests/config/drone/run_k6_tests.sh
      - name: Show Grafana dashboard link
        run: echo "Grafana Dashboard: https://grafana.k6.infra.owncloud.works"
```

The `if` condition is worth noting: k6 tests only run automatically on schedule or dispatch. On PRs, they only trigger when the PR title contains "k6-test" — preventing expensive load tests from running on every typo fix.

### Why This Matters

Performance testing in CI is expensive — it requires realistic infrastructure and test data. oCIS's approach of gating expensive perf tests behind title-matching or scheduling is pragmatic. The key takeaway: not every CI job needs to run on every push. Use conditional execution to balance coverage against cost.

---

## Code Quality Gates

Quality gates are the enforcement layer that prevents regressions from merging. The best implementations are automated, non-negotiable, and fast.

**Named release gates (Grype).** [[analyzing-grype]] uses job names as release prerequisites. The `check-gate` reusable workflow takes a JSON array of job names and verifies each one passed on `main` before allowing a release. This means adding a new quality check is as simple as adding a job name to the array — no workflow logic changes needed.

**Merge trains and concurrency (Insomnia).** [[analyzing-insomnia]] uses GitHub's `merge_group` trigger to support merge trains — multiple PRs can be queued and validated in sequence before merging. Combined with `concurrency` groups keyed by `${{ github.workflow }}-${{ github.ref }}`, this prevents duplicate runs while ensuring every merge is individually validated:

```yaml
# From insomnia/.github/workflows/test.yml
on:
  merge_group:
  workflow_dispatch:
  push:
    branches:
      - develop
  pull_request:
    types: [opened, synchronize]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

**PR enforcement (Checkov).** [[analyzing-checkov]] layers multiple quality gates on every PR: DangerJS for PR hygiene, a PR title checker with configurable regex patterns, pre-commit hooks for formatting, cfn-lint for CloudFormation, Bandit for Python security, and TruffleHog for secrets. The `security-shared.yml` reusable workflow keeps the security scanning DRY between PR and push-to-main contexts:

```yaml
# From checkov/.github/workflows/security-shared.yml
jobs:
  bandit:
    runs-on: [self-hosted, public, linux, x64]
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v3
      - name: security test
        uses: jpetrucciani/bandit-check@74c5ecc4297e374c7e9283bc81f649287bb14f34  # v1
        with:
          path: 'checkov'
  trufflehog-secrets:
    # ... secret detection with regex and entropy checks
  checkov-secrets:
    # ... self-scan with checkov-action
```

### Why This Matters

Quality gates only work if they're enforced. Grype's named-gate approach is the gold standard for release pipelines — it makes the requirements explicit and auditable. Insomnia's merge train support is essential for high-traffic repositories where multiple PRs compete for merge priority. Checkov's layered PR checks demonstrate that quality gates can be comprehensive without being slow, as long as they're targeted (cfn-lint only runs on changed CloudFormation files).

---

## IaC (Infrastructure as Code) Testing

Infrastructure code deserves the same testing rigor as application code. [[analyzing-checkov]] — itself an IaC scanner — demonstrates the most comprehensive self-testing approach.

**Self-referential scanning.** Checkov runs its own `checkov-action` against its repository as part of CI. The `security-shared.yml` workflow calls `bridgecrewio/checkov-action@master` with a Prisma Cloud API key and configuration file. This catches misconfigurations in any Terraform, Kubernetes, or CloudFormation files in the repo — the scanner scanning itself.

**Helm and Kustomize in CI.** The build workflow installs `azure/setup-helm` and `imranismail/setup-kustomize` so that Checkov's integration tests can validate Kubernetes policy checks against real Helm charts and Kustomize overlays. This ensures the scanner works correctly against the IaC tools it's designed to analyze.

**Automated dependency updates.** Checkov's `pipenv-update.yml` runs weekly, updating all Python dependencies and creating a pull request via `peter-evans/create-pull-request`:

```yaml
# From checkov/.github/workflows/pipenv-update.yml
on:
  schedule:
    - cron: '8 22 * * 1'  # Weekly on Monday at 22:08 UTC

jobs:
  pipenv-update:
    steps:
      - run: |
          pipenv update
          git add -u
          git commit -m "update pipenv packages"
      - name: Create Pull Request
        uses: peter-evans/create-pull-request@271a8d0340265f705b14b6d32b9829c1cb33d45e # v5
        with:
          title: '[AUTO-PR] Update pipenv packages'
          labels: automated pr
          branch: pipenvfix
          branch-suffix: timestamp
```

**Nightly coverage tracking.** A separate `nightly.yml` workflow runs the full test suite with `--cov=checkov` and generates a coverage badge SVG, committed back to the repository. This makes test coverage visible in the README without requiring a third-party service.

### Why This Matters

IaC testing is the most commonly skipped CI category. Teams invest heavily in application testing but leave Terraform, Kubernetes manifests, and CloudFormation templates unvalidated. Checkov's self-referential approach is the ideal: the same tool that scans infrastructure code is used to scan the infrastructure code that defines the project's own deployment. The automated dependency update pattern is also widely applicable — any project with lockfiles should automate updates with PR creation, reducing manual toil and security debt.


---

# Putting It All Together: The Reference Pipeline

No single project implements every pattern perfectly. But combining the best practices from each, here's what an ideal CI/CD pipeline looks like:

**Pull Request Pipeline:**
1. Pre-checks: lint, format, spell check (Threat Dragon pattern)
2. SAST: CodeQL + Semgrep + secret scanning (Grype + Insomnia pattern)
3. Unit tests: fast, parallel, targeted via change detection (Checkov pattern)
4. Build: Docker multi-stage with SBOM generation (Threat Dragon pattern)

**Push to Main Pipeline:**
1. Full test suite including integration tests
2. Container build: multi-arch via Buildx, SBOM baked in
3. DAST: ZAP scan against running container (Threat Dragon pattern)
4. Image scanning: Trivy with SARIF upload (Threat Dragon pattern)
5. Performance regression check (oCIS pattern, if applicable)

**Release Pipeline:**
1. Gate check: verify all CI jobs passed on main (Grype pattern)
2. Tag validation: ensure release is from correct branch (OpenTofu pattern)
3. Build: multi-platform matrix (Traefik pattern)
4. Sign: cosign for images, SBOMs, and binaries (Grype + OpenTofu pattern)
5. Publish: Docker Hub + GHCR dual push, PyPI/npm with trusted publishing
6. SBOM combiner: aggregate all component SBOMs (Threat Dragon pattern)

**Scheduled Maintenance:**
1. govulncheck / dependency vulnerability scanning (OpenTofu pattern)
2. Scorecards assessment (Grype pattern)
3. Coverage tracking (Checkov pattern)
4. Stale issue/PR cleanup (Threat Dragon pattern)
5. Automated dependency updates with PR creation (Checkov pattern)

**Key Principles:**
- **Pin all actions to SHAs** with version comments (every champion does this)
- **Set `permissions: {}` as default** and grant explicitly per job (Grype pattern)
- **Use `persist-credentials: false`** on checkout steps (Grype pattern)
- **Gate releases on named CI checks** not just "workflow passed" (Grype pattern)
- **Fail on security findings** — don't make DAST/SAST informational (Threat Dragon pattern)

---

# Anti-Patterns Observed

Across the 13 codebases, several anti-patterns appeared repeatedly:

- **Ungated releases.** Several projects allow `workflow_dispatch` releases without verifying CI passed on the target commit. One click ships whatever is on main, regardless of test status.
- **Missing `concurrency` groups.** Without concurrency control, pushing to a PR branch multiple times in quick succession spawns duplicate workflow runs, wasting CI minutes and creating confusing status checks.
- **Unpinned actions.** Projects that use `actions/checkout@v4` instead of a SHA are vulnerable to tag hijacking — a malicious actor could overwrite the `v4` tag to point to compromised code.
- **Over-broad permissions.** Workflows that request `contents: write` at the top level when only one job needs it. Use per-job permissions instead.
- **No artifact retention on failure.** When tests fail but logs/videos aren't uploaded as artifacts, debugging requires re-running the entire workflow.

---

# Conclusion

The best CI/CD implementations share a common trait: they treat the pipeline as a first-class part of the project, not infrastructure boilerplate. Threat Dragon's DAST scanning is as carefully designed as its application code. Grype's release gates are as important as its vulnerability database. OpenTofu's build matrix is as engineered as its Terraform interpreter.

The patterns in this guide are proven at scale — Wazuh's 137 workflows, oCIS's 4,000-line Drone configuration, Traefik's 17-platform release matrix. They work because they were iterated on by real teams solving real problems.

Start with the principles: pin your actions, gate your releases, fail on security findings, and test incrementally. Then adopt the specific patterns that match your project's needs. The code is all here — take what works.
