---
title: "GitHub Actions Reusable Patterns Reference Guide"
date: 2026-05-12
type: codebase-analysis
status: complete
tags: [github-actions, ci-cd, devsecops, automation, patterns]
---

# GitHub Actions Reusable Patterns Reference Guide

> **Source:** Synthesis of 14 open source projects across 326 workflow files: Checkov, dep-scan, Gitleaks, Grype, Insomnia, Minimal, Nextcloud Server, oCIS, OpenTofu, Threat Dragon, Traefik, Wazuh, ZAP, and agent-scan.

## Overview

GitHub Actions has become the lingua franca of CI/CD. Every project in our sample uses it, but no two use it the same way. This guide extracts the most practical, battle-tested patterns from 14 production codebases — from the minimal (Gitleaks, 3 workflows) to the enterprise (Wazuh, 137 workflows).

Each pattern includes concrete examples and guidance on when to adopt it. The goal is not to be exhaustive — GitHub's docs do that — but to show how mature projects actually compose these features.

## Key Findings

### 1. Reusable Workflows (`workflow_call`)

Reusable workflows let you define CI logic once and call it from multiple workflows. We found **13 definitions** and **24 call sites** across the sample.

**When to use:** You have identical CI logic triggered by different events (e.g., security scans on both PRs and pushes, but the PR path requires manual approval).

**Best example — Checkov's security scan split:**

Checkov defines `security-shared.yml` with `on: workflow_call` containing bandit, trufflehog, and checkov secret scans. Two callers invoke it differently:

```yaml
# .github/workflows/security.yml (PR path — requires approval)
jobs:
  start-security-scan:
    environment: scan-security  # manual approval gate
    runs-on: ubuntu-latest
    steps:
      - run: echo "Security scan approved"
  security:
    needs: start-security-scan
    uses: ./.github/workflows/security-shared.yml
    secrets: inherit

# .github/workflows/build.yml (push path — automatic)
jobs:
  security:
    uses: ./.github/workflows/security-shared.yml
    secrets: inherit
```

This is elegant: one security definition, two different approval workflows.

**Cross-organization reusable workflows:**

Grype calls workflows from a separate `anchore/workflows` repository, pinned by SHA:

```yaml
jobs:
  version-available:
    uses: anchore/workflows/.github/workflows/check-version-available.yaml@8b2b1caf
    with:
      version: ${{ github.event.inputs.version }}
  check-gate:
    uses: anchore/workflows/.github/workflows/check-gate.yaml@8b2b1caf
    with:
      checks: ["Acceptance tests (Linux)", "Acceptance tests (Mac)", ...]
```

This is the gold standard for organizations with multiple repos — extract shared logic into a dedicated workflows repo and pin by SHA.

**Wazuh's parameterized builders:**

Wazuh defines reusable workflows with heavy parameterization for package building:

```yaml
on:
  workflow_call:
    inputs:
      docker_image_tag:
        type: string
      architecture:
        type: string
      system:
        type: string
      revision:
        type: string
      is_stage:
        type: boolean
      debug:
        type: boolean
      checksum:
        type: boolean
      id:
        type: string
```

8 inputs per workflow call — the tradeoff is flexibility vs. complexity. This makes sense for Wazuh's multi-platform, multi-architecture build matrix but would be overkill for simpler projects.

**oCIS's organizational pattern:**

oCIS calls organizational reusable workflows for non-core concerns:

```yaml
jobs:
  sync:
    uses: owncloud/reusable-workflows/.github/workflows/translation-sync.yml@main
    with:
      mode: make
      reviewers: kobergj,mmattel
```

> [!tip] Pattern: Extract cross-cutting concerns (translation sync, release publishing, security scanning) into reusable workflows. Keep them in a shared repo pinned by SHA, not tag.

### 2. Composite Actions

Composite actions bundle multiple steps into a single reusable action defined in `.github/actions/<name>/action.yml`. We found **29 composite actions** across the sample — 28 from Wazuh and 1 from Grype.

**When to use:** You repeat the same 3-5 setup steps across multiple workflows in the same repo (install dependencies, configure tools, etc.).

**Best example — Grype's bootstrap action:**

```yaml
# .github/actions/bootstrap/action.yaml
name: "Bootstrap"
description: "Bootstrap all tools and dependencies"
inputs:
  go-version:
    default: "1.26.2"
  python-version:
    default: "3.11"
  go-dependencies:
    default: "true"
  cache-key-prefix:
    default: "1ac8281053"
  compute-fingerprints:
    default: "true"
  tools:
    default: "true"
  bootstrap-apt-packages:
    default: "libxml2-utils"
  cache-test-fixtures:
    default: "false"

runs:
  using: "composite"
  steps:
    - uses: actions/setup-go@v6
      if: inputs.go-version != ''
      with:
        go-version: ${{ inputs.go-version }}
        check-latest: true
    - uses: actions/setup-python@v6
      with:
        python-version: ${{ inputs.python-version }}
    - name: Restore tool cache
      uses: actions/cache@v5
      if: inputs.tools == 'true'
      with:
        path: ${{ github.workspace }}/.tool
        key: ${{ inputs.cache-key-prefix }}-${{ runner.os }}-tool-${{ hashFiles('.binny.yaml') }}
    - name: Install go dependencies
      if: inputs.go-dependencies == 'true'
      shell: bash
      run: make ci-bootstrap-go
    # ... more steps
```

This single action replaces 8 identical setup steps across every Grype workflow. Every workflow now starts with:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: ./.github/actions/bootstrap
    with:
      cache-test-fixtures: "true"
```

**Wazuh's domain-specific actions:**

Wazuh has 28 composite actions for C/C++ build operations: `compile`, `compile_and_test`, `coverage`, `coverage_cpp`, `clang_format`, `build_test_flags`, `doxygen`, etc. These wrap multi-step CMake + gcc + gcov operations into single action calls.

Key Wazuh examples:
- `check_files` (8 steps): Validates installed files, ownership, permissions, and sizes after package installation
- `build_external_deps` (6 steps): Installs all C/C++ external dependencies for compilation
- `coverage` (6 steps): Runs gcov, filters results, generates reports with threshold enforcement

> [!tip] Pattern: Create a composite action when you copy-paste 3+ steps across workflows. Grype's bootstrap pattern — configurable setup with sensible defaults — is the template to follow.

### 3. Concurrency Control

Concurrency prevents duplicate workflow runs from wasting resources. We found **112 instances** across the sample.

**The dominant pattern — PR-scoped with fallback:**

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: true
```

This was used 37 times (33% of all concurrency configs). The `|| github.run_id` fallback ensures that pushes to branches (without PR numbers) each get their own group instead of canceling each other.

**Three concurrency strategies, ranked by frequency:**

1. **PR-scoped with fallback** (37x) — `${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}` — Cancels superseded PR runs, never cancels branch pushes
2. **Branch-scoped** (13x) — `${{ github.workflow }}-${{ github.ref }}` — Cancels any superseded run on the same branch
3. **Head-branch scoped with fallback** (11x) — `${{ github.workflow }}-${{ github.head_ref || github.run_id }}` — Similar to PR-scoped but uses the source branch name

**Static groups for critical workflows:**

```yaml
# Grype — only one release at a time
concurrency:
  group: release
# Checkov — only one build pipeline
concurrency:
  group: build
  cancel-in-progress: true
```

**`cancel-in-progress` behavior:**
- `true` in 103 cases (92%) — standard for PRs and non-release workflows
- `false` in 5 cases — used for GitHub Pages deploys and long-running publish workflows where interruption causes issues

> [!tip] Pattern: Always set concurrency on PR-triggered workflows. Use the PR-number-with-fallback pattern unless you have a reason not to. For release workflows, use a static group name to prevent parallel releases.

### 4. Path-Based Triggers

Path triggers skip workflows when irrelevant files change. We found **67 instances** across the sample.

**When to use:** Your repo has components that change independently and each has its own test suite.

**Traefik's targeted testing:**

```yaml
on:
  pull_request:
    paths:
      - .github/workflows/test-gateway-api-conformance.yaml
      - pkg/provider/kubernetes/gateway/**
      - integration/fixtures/gateway-api-conformance/**
      - integration/gateway_api_conformance_test.go
      - integration/integration_test.go
```

Each of Traefik's test workflows watches a specific set of source paths. A change to `pkg/provider/kubernetes/knative/**` triggers the Knative conformance tests but not the Gateway API tests.

**Wazuh's component-level granularity:**

Wazuh has the most sophisticated path triggers in the sample. Each component gets its own workflow with precise paths:

```yaml
# vulnerability-scanner unit tests — only when scanner code changes
on:
  pull_request:
    paths:
      - .github/workflows/5_testunit_vulnerability-scanner.yml
      - src/wazuh_modules/vulnerability_scanner/**
      - src/shared_modules/utils/**

# API RBAC analysis — only when RBAC defaults change
on:
  pull_request:
    paths:
      - .github/workflows/5_codeanalysis_api-rbac-db-version.yml
      - framework/wazuh/rbac/default/**
      - framework/wazuh/rbac/orm.py
```

**Self-referencing pattern:**

Every project that uses path triggers includes the workflow file itself in the paths list. This ensures workflow changes always trigger a validation run:

```yaml
paths:
  - .github/workflows/this-workflow.yml  # always include self
  - src/matching-code/**
```

> [!tip] Pattern: Include the workflow file itself in path triggers so workflow modifications are always tested. For monorepos, use component-level path granularity to keep CI fast.

### 5. Environment Protection Rules

Environments add manual approval gates and branch restrictions. We found **8 instances** — concentrated in Checkov (4) and OpenTofu (1).

**When to use:** Release workflows, security-sensitive operations, or anything that needs human approval before execution.

**Checkov's dual-environment approach:**

```yaml
# PR security scans — require manual approval
jobs:
  start-security-scan:
    environment: scan-security  # humans must approve
    runs-on: ubuntu-latest
    steps:
      - run: echo "approved"

# Version bumps — restricted to release branch
jobs:
  bump-version:
    environment: release
    runs-on: [self-hosted, public, linux, x64]
```

**OpenTofu's GPG environment:**

```yaml
jobs:
  release:
    environment: gpg  # controls access to GPG signing keys
    runs-on: larger-runners
    steps:
      - name: Import GPG key
        # GPG key only available within the gpg environment
      - name: Run GoReleaser
      - name: Remove GPG key  # cleanup immediately after use
```

The `gpg` environment restricts access to the GPG private key used for signing release artifacts. The key is imported, used by GoReleaser, and removed — never persisted on disk.

> [!tip] Pattern: Use environments for release gates, secret scoping, and approval workflows. Don't overuse them — most CI jobs don't need protection rules.

### 6. Matrix Strategies

Matrix strategies run jobs across combinations of OS, language version, architecture, etc. We found **33 advanced matrix configurations** (with `include`/`exclude`).

**dep-scan's cross-platform Python matrix:**

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-26, windows-latest]
    python-version: ['3.10', '3.11', '3.12', '3.13', '3.14']
```

This generates 15 combinations (3 OS × 5 Python versions). dep-scan also uses separate jobs with smaller matrices for specific test types:

```yaml
# Docker tests — only Ubuntu + all Python versions
matrix:
  os: [ubuntu-latest]
  python-version: ['3.10', '3.11', '3.12', '3.13', '3.14']

# Mac/Win tests — only latest Python
matrix:
  os: [macos-26, windows-latest]
  python-version: ['3.12']
```

**dep-scan's rich matrix for Docker image builds:**

```yaml
strategy:
  matrix:
    image:
      - id: default-amd64
        arch: amd64
        dockerfile: Dockerfile
      - id: default-arm64
        arch: arm64
        runner-suffix: -arm
        dockerfile: Dockerfile
      - id: al9-amd64
        arch: amd64
        dockerfile: Dockerfile.al9
      - id: al9-arm64
        arch: arm64
        runner-suffix: -arm
        dockerfile: Dockerfile.al9
```

Matrix entries are full objects — each defines `id`, `arch`, `dockerfile`, and `runner-suffix`. This is a powerful pattern for building multiple image variants from a single workflow.

**Insomnia's include-only matrix for release artifacts:**

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - os: macos-14
      - os: windows-2022
      - os: ubuntu-24.04
```

No axes — just an explicit list of runners. This is simpler than defining an OS axis with only these three values, and it's clearer about intent.

**`fail-fast` behavior:**
- `false` in most release and publish workflows — don't cancel other platforms if one fails
- `true` (or omitted) in test workflows — stop wasting resources if a fundamental issue is found

> [!tip] Pattern: Use include-only matrices for heterogeneous job configs (different architectures, different Dockerfiles). Use axis-based matrices for homogeneous testing (OS × version). Always set `fail-fast: false` on release workflows.

### 7. Artifact Flow Patterns

Artifacts pass data between jobs. We found **272 artifact upload/download operations** across the sample.

**Cross-job test results (dep-scan):**

dep-scan uses a named artifact pattern where platform-specific test results flow from build jobs to downstream consumers:

```yaml
# Build job — upload with matrix-parameterized name
- uses: actions/upload-artifact@v4
  with:
    name: containertests_${{ matrix.os }}_python${{ matrix.python-version }}
    path: test-results/

# Consumer job — download specific artifact
- uses: actions/download-artifact@v4
  with:
    name: containertests_ubuntu-latest_python3.11
```

**Build→publish artifact handoff (Insomnia):**

```yaml
# Build job
- uses: actions/upload-artifact@v4
  with:
    name: ${{ runner.os }}-${{ runner.arch }}-artifacts
    path: dist/

# Publish job (in separate workflow, triggered by workflow_run)
- uses: actions/download-artifact@v4
  with:
    pattern: "*-artifacts"
    merge-multiple: true
```

**SLSA provenance with artifacts (Insomnia):**

Insomnia combines artifact uploads with SLSA provenance generation:

```yaml
jobs:
  artifact-provenance:
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v2.1.0
    with:
      base64-subjects-as-file: ${{ matrix.binary_artifacts_subject_as_file }}
      upload-assets: true
      provenance-name: ${{ matrix.product }}-provenance.intoto.jsonl

  inso-image-provenance:
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@v2.1.0
    with:
      image: kong/inso
      digest: ${{ needs.publish.outputs.INSO_DOCKER_IMAGE_DIGEST }}
```

Two SLSA generators — one for binary artifacts, one for container images — producing cryptographic provenance attestations.

> [!tip] Pattern: Use descriptive, parameterized artifact names (include OS, arch, version) to avoid collisions in matrix builds. For release pipelines, combine artifact uploads with SLSA provenance for supply chain security.

### 8. Permission Scoping

The principle of least privilege applied to GITHUB_TOKEN. We found **144 workflows with explicit permissions**.

**The dominant pattern — read-only by default:**

```yaml
permissions:
  contents: read
```

This appeared in 90 of 144 scoped workflows (63%). Most CI only needs to read code — write permissions are dangerous because any compromised step could push commits or create releases.

**Write permissions only where needed:**

- `contents: write` (6x) — version bumps, release creation, git push
- `pull-requests: write` (4x) — PR comments, auto-approve, feedback
- `id-token: write` (1x) — OIDC token for cloud provider auth
- `pages: write` (1x) — GitHub Pages deployment

**Checkov's pages deployment:**

```yaml
permissions:
  contents: read
  pages: write
  id-token: write  # for deployment authentication
```

**OpenTofu's release permissions:**

```yaml
permissions:
  contents: write   # create release
  id-token: write   # OIDC for signing
  packages: write   # push to GHCR
```

> [!tip] Pattern: Always set top-level `permissions: contents: read` on every workflow. Only elevate specific scopes on jobs that need them. Never use `permissions: write-all`.

### 9. Conditional Step Execution

Conditional steps (`if:` on steps) are the most common advanced pattern — **565 instances** across the sample. Here are the most useful categories:

**Cache hit/miss branching:**

```yaml
# Grype
- name: Load test image cache
  if: steps.install-test-image-cache.outputs.cache-hit == 'true'
- name: (cache-miss) Create test image cache
  if: steps.install-test-image-cache.outputs.cache-hit != 'true'
```

**Change detection gating:**

```yaml
# Checkov
- name: Setup dependencies if they changed
  if: steps.changed_files.outputs.files_changed == 'true'

# Wazuh — per-component gating
- name: Request pkg_deb_manager_builder_amd64 update
  if: steps.changes.outputs.pkg_deb_manager_builder_amd64 == 'true'
```

**Release channel routing (Insomnia):**

```yaml
- name: App version (stable, patch latest stable)
  if: github.event.inputs.channel == 'stable' && !github.event.inputs.version

- name: App version (alpha/beta, with a specific version)
  if: github.event.inputs.channel != 'stable' && github.event.inputs.version

- name: Upload .deb to pulp and/or cloudsmith (stable only)
  if: ${{ !contains(github.event.inputs.version, 'alpha') && !contains(github.event.inputs.version, 'beta') }}
```

**Always-run cleanup:**

```yaml
# Upload traces even if tests failed
- name: Upload smoke test traces
  if: ${{ !cancelled() }}

# Generate vulnerability report regardless of build outcome
- name: Generate vulnerability report
  if: always()
```

**Fork protection:**

```yaml
# Nextcloud — skip expensive operations on forks
- name: Disabled on forks
  if: ${{ fromJSON(steps.get-repository.outputs.result) != github.repository }}
```

> [!tip] Pattern: Use `if: always()` for cleanup and reporting steps. Use `if: !cancelled()` for steps that should run on success or failure but not cancellation. Gate expensive steps with change detection outputs.

### 10. Self-Hosted Runners

Self-hosted runners are used exclusively by **Checkov** (17 instances). Every Checkov job runs on:

```yaml
runs-on: [self-hosted, public, linux, x64]
```

With one exception for ARM builds:

```yaml
runs-on: [self-hosted, public, linux, arm64]
```

Checkov (owned by Palo Alto Networks / Bridgecrew) uses self-hosted runners for:
- Proprietary test suites that need internal network access
- Larger resource pools than GitHub-hosted runners provide
- Consistent environments for security scanning tools

**The `public` label** is notable — it means these runners accept workflows from public fork PRs, which is a security tradeoff. GitHub-hosted runners are the safer default for public repos.

> [!note] Only one project in our 14-repo sample uses self-hosted runners. For most open source projects, GitHub-hosted runners are sufficient and more secure.

## Assessment

**What works well:**
- Concurrency control is near-universal (112/326 workflows) and follows consistent patterns — the ecosystem has converged on best practices
- Permission scoping is widespread (144/326) and mostly follows least-privilege
- Composite actions (Grype's bootstrap) dramatically reduce workflow boilerplate
- Path-based triggers are used strategically in monorepos (Wazuh, Traefik) to keep CI fast

**Concerns:**
- Composite actions are underused — only Grype and Wazuh have them, despite every project having repeated setup steps
- Wazuh's 28 composite actions show the pattern at scale but also show diminishing returns — some actions have a single step and add indirection without reducing complexity
- Cross-org reusable workflows (Grype/Anchore) require SHA pinning discipline — a tag reference could be silently updated
- SLSA provenance integration (Insomnia) is sophisticated but rare — only one project does it

**Recommendations for teams adopting these patterns:**
1. Start with Grype's bootstrap composite action pattern — extract setup into a configurable action
2. Add concurrency control to all PR-triggered workflows using the PR-number-with-fallback pattern
3. Scope permissions to `contents: read` unless you have a specific need for more
4. Use path triggers for any repo with >5 workflow files to reduce CI spend
5. Consider reusable workflows (Checkov pattern) for security scans that need different approval paths
6. Adopt SLSA provenance for release artifacts if supply chain security matters for your project

## Related

- [[best-cicd-implementations-reference-guide]]
- [[container-security-hardening-reference-guide]]
- [[open-source-release-engineering-reference-guide]]
- [[testing-philosophy-spectrum]]
