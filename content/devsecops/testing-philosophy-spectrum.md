---
title: "The Testing Philosophy Spectrum: From Minimalist to Enterprise"
date: 2026-05-12
type: codebase-analysis
status: complete
tags: [testing, ci-cd, github-actions, pytest, go-testing, e2e, acceptance-testing]
---

# The Testing Philosophy Spectrum: From Minimalist to Enterprise

> **Source:** Synthesis of 14 open source CI/CD repos analyzed for testing patterns. See related reports for individual codebase deep dives.

## Overview

Testing is the single largest line item in most CI budgets — both in runner minutes and developer time. Yet projects vary enormously in how much they invest, where they invest it, and what they consider "enough." This report maps that spectrum using real data from 14 open source projects, extracting actionable patterns for teams trying to calibrate their own testing investment.

The projects span four languages (Go, Python, TypeScript/JavaScript, Java), five application types (CLI tools, web platforms, desktop apps, security scanners, infrastructure), and range from 1 test workflow to 104. The contrast between them is the point.

## Key Findings

### The Raw Numbers

- **Gitleaks:** 1 test workflow, 1 test directory (testdata/), 215 test fixture files
- **Agent-scan:** 1 test workflow, 323 test files
- **Traefik:** 4 test workflows (unit, integration, gateway API conformance, knative conformance)
- **Grype:** 7 test jobs across 1 workflow (unit, quality, integration, static analysis, CLI, acceptance-linux, acceptance-mac)
- **Checkov:** 3 test workflows, 6,397 test files, 5-version Python matrix
- **Dep-scan:** 9 test workflows across language suites (C, .NET, Go, Java, Python, binary, container, snapshot)
- **Insomnia:** 3 test workflows (unit, CLI, e2e with 6-shard Playwright)
- **ZAP:** 4 test workflows (integration, SonarCloud, Chrome Docker, packaged scans)
- **oCIS:** 3 test workflows, 251 Behat feature files, vmstat load monitoring
- **Wazuh:** 104 test workflows — 76% of all workflows in the repo
- **Nextcloud:** 39 test workflows including Cypress E2E, FTP/S3/SFTP/SMB/WebDAV external storage tests
- **OpenTofu:** Multi-OS E2E tests across 7 OS/arch combinations (Linux amd64/386, Darwin amd64/arm64, Windows amd64/386)
- **Threat Dragon:** Per-package test separation (server unit, Vue unit, desktop E2E)

### Pattern 1: The Minimalist — Gitleaks

Gitleaks represents the "just enough" philosophy: one workflow, two platforms, race detection, config validation.

```yaml
# The entire test.yml — 30 lines
strategy:
  matrix:
    platform: [ ubuntu-latest, windows-latest ]
steps:
  - run: go build ./...
  - run: gotestsum --raw-command -- go test -json ./... --race
  - run: go generate ./... && git diff --exit-code  # Config drift detection
```

What they test: race conditions (via `--race`), config schema validity (via `go generate` diff), and cross-platform compilation (Ubuntu + Windows). What they don't test: coverage thresholds, integration scenarios, snapshot comparisons. The 215 testdata files are regex patterns and detection rules — the tests are essentially "does this pattern catch this secret?"

**When this works:** Small, focused codebases with a single responsibility. Gitleaks is a detection engine — the test matrix is "does each regex work?" No external dependencies, no network calls, no multi-service orchestration.

### Pattern 2: The Layered Pyramid — Grype

Grype builds a full testing pyramid in a single workflow with 7 parallel jobs:

1. **Static analysis** — `make static-analysis` (linting, vetting)
2. **Unit tests** — `make unit` with cached test fixtures
3. **Quality tests** — `make quality` on a 4-core/16GB runner (heavier assertions, yardstick-based result validation)
4. **Integration tests** — `make integration` with cached test data
5. **CLI tests** — Tests the built binary against real scenarios
6. **Acceptance (Linux)** — install.sh validation on Linux
7. **Acceptance (Mac)** — install.sh + cosign verification on macOS

Each job has its own cache key and can fail independently. The snapshot artifacts from `Build-Snapshot-Artifacts` flow downstream to CLI, acceptance, and Mac jobs — a clean build-once-test-many pattern.

The quality test job is notable: it runs on `ubuntu-22.04-4core-16gb` (a larger runner) and archives provider state on failure for local debugging. The failure instructions are written directly into `$GITHUB_STEP_SUMMARY`:

```
Download the artifact from this workflow run: `qg-capture-state`
cd test/quality && unzip $ARCHIVE_NAME && tar -xzf ...
yardstick result list
yardstick label explore
```

This is a debugging-first philosophy: when tests fail in CI, give developers everything they need to reproduce locally without re-running the entire pipeline.

### Pattern 3: Per-Language Suites — Dep-scan

Dep-scan takes a different approach: instead of one unified test workflow, it has 9 separate workflows organized by test type:

- `pythonapp.yml` — Core Python unit tests across 5 Python versions (3.10–3.14) on 4 OSes (Ubuntu x86_64, Ubuntu ARM, macOS 26, Windows)
- `repotests.yml` — Integration tests against real vulnerable repos (java-sec-code, vulnerable-aws-koa-app, dotnet-podcasts)
- `repotests-lifecycle-c.yml` — Lifecycle analyzer against C/C++ projects
- `repotests-lifecycle-dotnet.yml` — .NET lifecycle analysis
- `repotests-lifecycle-go.yml` — Go lifecycle analysis
- `repotests-lifecycle-java.yml` — Java lifecycle analysis
- `gobintests.yml` — Binary analysis of installed tools (soar, rclone, rustscan)
- `dockertests.yml` — Container image scanning (slim, redmine)
- `snapshot_tests.yml` — Snapshot comparison against reference outputs

Each lifecycle workflow is `workflow_dispatch` only (manual trigger) — they're expensive and only needed when that language analyzer changes. The main `repotests.yml` runs on PRs with a 20-cell matrix (4 OS × 5 Python versions).

The snapshot testing approach is instructive: it clones `appthreat/dep-scan-snapshots` as reference, generates new snapshots, then compares via `diffs.json`. If the diff file exists after the run, the job fails. This catches regressions where the scanner's output format or detection behavior changes unexpectedly.

### Pattern 4: Change-Directed Testing — Checkov

Checkov's `pr-test.yml` demonstrates surgical test targeting:

1. **Lint** — Uses a shared `pre-commit.yaml` from `bridgecrewio/gha-reusable-workflows`
2. **DangerJS** — Automated PR review comments on self-hosted runners
3. **cfn-lint** — Only runs on changed CloudFormation test files, extracted via `tj-actions/changed-files`
4. **mypy** — Type checking via shared workflow
5. **Unit tests** — 5-version Python matrix (3.9–3.13) with pipenv + numpy compatibility shims

The cfn-lint step is the key pattern: it filters changed files to only `.yml`/`.yaml`/`.json` in `tests/cloudformation/checks/resource/aws/**`, then runs `cfn-lint` only on those. No point linting all 6,000+ test files when only two changed.

Checkov also uses `fail-fast: true` on its unit test matrix — the first Python version to fail cancels the others. For a repo with 6,397 test files, this saves significant runner minutes on broken PRs.

### Pattern 5: Acceptance Testing at Scale — oCIS

oCIS has 251 Behat feature files and a multi-phase acceptance workflow that treats CI like a production environment:

**Phase 1 (parallel I/O):** PHP style checks, Gherkin linting, deleted suite validation, Go vulnerability checking, and code generation — all run concurrently with vmstat monitoring:

```bash
vmstat 2 > /tmp/vmstat-phase1.log &
(php style checks) & PIDS=($!)
(gherkin lint) & PIDS+=($!)
(suite validation) & PIDS+=($!)
(govulncheck) & PIDS+=($!)
(node generate) & PIDS+=($!)
(go generate) & PIDS+=($!)

# Wait and report
awk '{ busy=100-$15; sum_b+=busy; ... }' /tmp/vmstat-phase1.log
```

The vmstat pattern is unique: it measures CPU busy percentage, run queue depth, and I/O wait for each phase, then prints a summary. This lets the team tune parallelism — "if wa > 20%, add more parallel tasks; if runq >> nCPU, reduce them."

**Phase 2 (CPU-bound):** Go compilation with shared build cache, golangci-lint, and test execution compete for 2 vCPUs. The critical path is ~300 seconds for the main build.

### Pattern 6: The Enterprise Behemoth — Wazuh

Wazuh has 104 test workflows — 76% of its 137 total workflows. The testing is organized by component:

- Component compilation tests (syscheck, syscollector, inventory-harvester)
- Platform-specific builds (macOS, Linux distributions)
- Integration tests (Elasticsearch templates, indexer connectors)
- Security tests (VD scanner, vulnerability detection)
- API tests (109 test files across controllers, models, spec)
- Framework tests (RBAC, cluster, indexer)

Most Wazuh test workflows run on self-hosted runners (`wz-linux-amd64`) with path-based triggers — the Elasticsearch template test only runs when `extensions/elasticsearch/**` changes.

The scale reflects Wazuh's architecture: a C agent + Python manager + React UI, with extensions for every major SIEM platform. Each component has its own test workflow because failures in one shouldn't block development of others.

### Pattern 7: Dynamic Matrix Generation — Traefik

Traefik generates its test matrix at runtime:

```yaml
# First job: enumerate Go packages
generate-packages:
  outputs:
    matrix: ${{ steps.set-matrix.outputs.matrix }}
  steps:
    - run: matrix_output=$(go run ./internal/testsci/genmatrix.go)

# Second job: test each package group
test-unit:
  needs: generate-packages
  strategy:
    matrix:
      package: ${{ fromJson(needs.generate-packages.outputs.matrix) }}
  steps:
    - run: go test -v -parallel 8 ${{ matrix.package.group }}
```

This ensures the matrix always matches the current code structure. If a package is added or removed, the matrix adapts without manual workflow edits. Traefik also separates UI tests (Vue/jest) from Go tests entirely.

### Pattern 8: Desktop App Testing — Insomnia & Threat Dragon

Desktop apps face unique CI challenges: GUI testing requires display servers, and Electron builds are platform-specific.

**Insomnia** shards its Playwright E2E tests across 6 runners:

```yaml
strategy:
  matrix:
    shardIndex: [1, 2, 3, 4, 5, 6]
    shardTotal: [6]
steps:
  - run: npm run test:build -w packages/insomnia-smoke-test -- --project=Smoke --shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }}
```

The build and test phases are separate jobs — the build uploads artifacts, then 6 test runners download them and run different shards. Insomnia also checks for circular dependency regressions on every PR using `madge`, comparing the PR's dependency graph against the base branch.

**Threat Dragon** tests at three levels: `test:site` (Vue unit), `test:server` (Express unit), and `test:desktop` (Electron E2E). The desktop E2E tests build Electron with `--publish=never` to avoid accidental publishes during testing.

### Pattern 9: Scheduled Heavy Tests — ZAP

ZAP runs its heaviest tests on schedules, not on every PR:

- **Integration tests:** Daily at 1 AM (Docker-based, multi-platform amd64/arm64)
- **SonarCloud analysis:** Weekly on Saturday (JaCoCo coverage + quality gates)
- **Chrome Docker test:** Weekly on Monday (Selenium automation in Docker)
- **Packaged scans:** On PRs that touch `docker/**` only

The SonarCloud workflow is the only place coverage is collected: `./gradlew test jacocoTestReport` followed by `./gradlew sonar`. This separation keeps PR feedback fast while still tracking coverage trends.

### Pattern 10: Coverage Tracking Approaches

Projects handle coverage in three distinct ways:

- **No coverage tracking:** Gitleaks, Traefik — tests pass or they don't, no thresholds
- **CI-only coverage:** Checkov (coverage.yaml with badge generation), dep-scan (`--cov-append --cov-report term`), agent-scan (`--cov-report=term-missing --cov-report=html`), ZAP (JaCoCo + SonarCloud weekly)
- **Quality gate coverage:** Grype (quality tests validate against yardstick benchmarks, not line coverage)

## Assessment

### The Three Schools

These 14 projects cluster into three testing philosophies:

**1. Trust the Compiler (Gitleaks, agent-scan)**
- Minimal CI, fast feedback, low cost
- Works when: small codebase, single language, few external dependencies
- Risk: regressions in edge cases that the compiler can't catch

**2. The Pyramid Builders (Grype, Traefik, OpenTofu)**
- Layered tests: static → unit → integration → acceptance → E2E
- Each layer catches what the layer below missed
- Works when: multi-component system, public API surface, need release confidence
- Risk: CI time grows with each layer; needs caching discipline to stay fast

**3. The Coverage Maximizers (Wazuh, Checkov, dep-scan, oCIS)**
- Test every component, every platform, every language version
- Path-based triggers to avoid running everything on every PR
- Works when: large team, high assurance requirements, multi-platform product
- Risk: CI maintenance becomes a full-time job; flaky tests erode trust

### Practical Takeaways

**For teams starting out:** The Gitleaks model is underrated. Race detection + config validation + two platforms covers most of the "did we break something obvious" cases for a Go CLI. Add coverage tracking later if you need it.

**For teams scaling up:** The Grype model — separate jobs per test tier, each with its own cache — is the best balance of speed and confidence. The debuggability features (archived state on failure, step summary instructions) matter more than the tests themselves when things break.

**For teams at scale:** The Checkov model of change-directed testing (only run tests relevant to changed files) and the Wazuh model of path-based workflow triggers are essential for keeping CI responsive. Without them, a 6,000-file test suite means every PR waits 30+ minutes.

**Anti-pattern to avoid:** Don't copy Wazuh's 104-workflow approach unless you have a dedicated CI/CD team. The maintenance burden is real — every workflow is a dependency that can break.

## Related

- [[best-cicd-implementations-reference-guide]]
- [[container-security-hardening-reference-guide]]
- [[analyzing-grype]]
- [[analyzing-gitleaks]]
- [[analyzing-checkov]]
- [[analyzing-wazuh]]
- [[analyzing-ocis]]
- [[analyzing-dep-scan]]
- [[analyzing-insomnia]]
- [[analyzing-traefik]]
- [[analyzing-zaproxy]]
- [[analyzing-threat-dragon]]
- [[analyzing-opentofu]]
- [[analyzing-agent-scan]]
