---
title: "Analyzing Minimal — CVE-Hardened Container Images"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/rtvkiz/minimal
tags: [supply-chain-security, containers, docker, cosign, sbom, melange, apko, wolfi, devsecops]
---

# Analyzing Minimal — CVE-Hardened Container Images

> **Source:** [rtvkiz/minimal](https://github.com/rtvkiz/minimal) @ [`91c8e88`](https://github.com/rtvkiz/minimal/commit/91c8e88955d1294a84de04b423bf3efd115733d9)

## How It Works

Minimal is a collection of 41 hardened container images for common infrastructure software — languages (Python, Node, Go, Java, .NET, PHP, Rails), databases (MySQL, PostgreSQL, Redis, MariaDB), message brokers (Kafka, RabbitMQ, NATS), observability (Prometheus, Grafana, Jaeger, OTel), and more. Every image is rebuilt daily via GitHub Actions to pick up the latest CVE patches, scanned for vulnerabilities with Grype, signed with cosign keyless signing, and ships with a full SPDX SBOM.

The project uses two build paths. **Simple images** (Python, Node, Go, Nginx, PostgreSQL, Bun, Deno, etc.) are assembled from Wolfi's pre-built packages using Chainguard's `apko` — essentially a declarative `apk`-based image builder that produces distroless, shell-less OCI images. **Source-built images** (Redis, MySQL, Jenkins, Kafka, PHP, Rails, Memcached, Caddy, and ~20 others) first compile the upstream software from source using `melange` (also from Chainguard), then assemble the image with `apko` using the locally-built packages. Both paths produce images with 0–5 CVEs compared to the 127+ typical of `debian:latest`, with patches landing within 24–48 hours of disclosure.

The versioning scheme mirrors Chainguard Images: each image gets an immutable `VERSION-rN` tag (e.g., `8.6.3-r0`) plus a floating `latest`. The `-r0` suffix resets on upstream version bumps and increments for rebuilds of the same version. Old version tags are preserved in the registry.

## Architecture

The build system is a 917-line GitHub Actions workflow (`build.yml`) with a change-detection layer that skips unchanged images on push/PR while doing full rebuilds on the daily cron schedule.

```
Image Directory                  CI Pipeline
─────────────                    ──────────
python/apko/python.yaml    ──►   detect-changes (path filter)
                                ├─► melange-build (9 matrix jobs, ARM64 runners)
redis-slim/                        │   cross-compile x86_64 + aarch64
  melange.yaml                │   sign packages with RSA key
  apko/redis.yaml             │
                              ▼   build-melange (10 matrix jobs)
                                │   merge multi-arch packages
                              ▼   build-apko (11 matrix jobs)
                                  │   assemble from Wolfi packages
                                  ▼
                              Verification
                                ├─► Grype CVE scan (JSON + SARIF)
                                ├─► Container test (version check + no-shell)
                                ├─► cosign sign (keyless, Sigstore)
                                └─► SBOM (SPDX) + version tagging

Update Automation (30 workflows)
  update-redis.yml ──► PR with version bump + SHA256 + auto-merge
  update-kafka.yml ──► PR with version bump + SHA512 + auto-merge
  update-wolfi-packages.yml ──► Detect new Wolfi package versions
  ... (one per source-built image)
```

Each image directory follows a convention: an `apko/*.yaml` declares the image (packages, user, entrypoint, paths), optionally a `melange.yaml` defines source compilation, and a `test.sh` validates the built image. The `Makefile` provides local build targets for all 41 images.

## The Spine

The entry point for the system is the daily cron trigger in `build.yml`. The flow:

1. **Change detection** — `detect-changes` job compares `git diff` against the previous commit. On cron/dispatch, all images are flagged for rebuild. On push/PR, only images with changed config files trigger.
2. **Package building** (melange images only) — Runs in two stages: `melange-build` compiles for x86_64 and aarch64 on native ARM runners (using `--runner=docker`), then `build-melange` merges the multi-arch packages and assembles the image with `apko publish`.
3. **Image assembly** (apko-only images) — `build-apko` pulls Wolfi packages and builds the OCI image directly via `apko publish --image-reference`.
4. **Verification** — Every image goes through: Grype CVE scan → container test → cosign signing → SBOM generation → version tagging.

For source-built packages, the melange pipeline handles: source download → SHA256/SHA512 verification → compilation → binary stripping → installation to a package directory → RSA signing. The Kafka build includes an additional step that patches known-vulnerable JARs (plexus-utils, jetty-server, jetty-http, log4j) with fixed versions from Maven Central before packaging.

## Key Patterns

**Two-tier package sourcing.** Wolfi pre-built packages are preferred (faster builds, Wolfi handles CVE patches). Source builds via melange are used when Wolfi doesn't package the software or when specific compile-time flags are needed (e.g., Redis with `BUILD_TLS=yes USE_SYSTEMD=no MALLOC=jemalloc`, Jenkins with a custom jlink JRE).

**Checksum pinning at every layer.** Source tarballs are pinned with SHA256 or SHA512 checksums stored directly in `melange.yaml`. The update automation computes and commits new checksums. This means supply-chain attacks on download mirrors are detectable.

**jlink for Java workloads.** Jenkins and Kafka both use `jlink` to create custom JREs containing only the specific Java modules needed — significantly reducing image size and attack surface compared to shipping a full JDK.

**App-based PR automation.** The 30 update workflows use a GitHub App (`APP_ID` + `APP_PRIVATE_KEY` secrets) rather than `GITHUB_TOKEN`, which avoids permission issues and allows auto-merge on PRs. Patch version bumps auto-PR and auto-merge; minor/major bumps create a GitHub Issue for manual review.

**Ephemeral vs persistent signing keys.** PR builds generate an ephemeral melange signing key (packages are built and tested but not published). Only the `main` branch uses repository secrets for persistent signing keys. Cosign signing is always keyless via Sigstore.

**Shell-less by default, exceptions documented.** Most images deliberately exclude a shell. Images that need one (MySQL for auto-init scripts, Kafka for KRaft entrypoint, Gitea for git hooks) are marked in the README with notes about *why* the shell is present.

## Non-Obvious Details

**The Kafka JAR patching pipeline.** The `kafka/melange.yaml` includes a hardcoded step that removes known-vulnerable JARs from the upstream Kafka distribution and replaces them with patched versions fetched from Maven Central. This is a manual supply-chain mitigation that requires maintenance — the comment says "auto-generated — do not edit manually," suggesting there's a separate process (the `patch-go-deps.yml` workflow) that generates these patches. If a new vulnerability appears in a Kafka dependency between updates, the daily rebuild won't catch it unless the patch list is updated.

**Wolfi package version detection via APKINDEX.** The `update-wolfi-packages.yml` workflow scrapes the Wolfi APKINDEX to detect when Python, Node, Go, .NET, Java, PostgreSQL, or Deno packages get bumped in Wolfi. This is how apko-only images get version updates — there's no melange config to bump, so the workflow watches the upstream package repository directly.

**The Makefile is purely local.** The entire CI pipeline is defined in `build.yml`. The `Makefile` exists for developer convenience but is never invoked by CI. This means the Makefile can drift out of sync with the CI — though in practice it's kept up to date.

**Arm64 cross-compilation via native runners.** The `melange-build` jobs use `ubuntu-arm` self-hosted runners for aarch64 compilation rather than QEMU emulation, which dramatically speeds up builds for C/C++ source builds (MySQL, PHP, Rails/Ruby, Fluent Bit).

**OpenSearch uses Wolfi packages despite being source-built elsewhere.** Most "big" software is built from source, but OpenSearch pulls from Wolfi's `opensearch-3` package. This is likely because building OpenSearch from source (a Gradle-based Java project) is prohibitively expensive in CI.

**Concurrency handling.** The build workflow uses a clever concurrency group: `build-${{ (schedule || dispatch) && run_id || ref }}`. This means scheduled runs never cancel each other, but push/PR runs cancel in-flight builds on the same branch.

## Assessment

**Strengths:**

- The daily rebuild + Grype scanning + public vulnerability report dashboard is an excellent transparency model. Users can see the actual CVE count for every image at `rtvkiz.github.io/minimal`.
- Supply-chain hardening is thorough: checksum pinning, cosign keyless signing, SBOM generation, non-root execution, shell-less images.
- The automated version update workflow (30 separate workflows, one per source-built image) with auto-merge for patches and manual-gate for minor/major bumps is well-designed.
- The melange + apko approach gives full control over what goes into each image while leveraging Wolfi's fast CVE patching for the base system.

**Concerns:**

- **Single maintainer.** The project appears to be primarily maintained by one person (`rtvkiz`). The update automation helps, but review of auto-merged PRs, melange build configurations, and the Kafka JAR patching list are all single points of human trust.
- **Manual JAR patching is fragile.** The Kafka build's hardcoded list of JARs to replace is a whack-a-mole approach. A better pattern would be a vulnerability-aware dependency resolution step (like Renovate for Java deps) or consuming a patched upstream release.
- **No image size budget.** There's no CI check that images stay under a certain size threshold. As dependencies creep in, images could grow silently.
- **Test coverage is basic.** Tests verify version output and absence of a shell, but don't test actual functionality (e.g., that Redis can serve SET/GET, that Kafka can produce/consume). For images used in production, functional smoke tests would catch regressions earlier.
- **No SLSA provenance.** While images are cosign-signed, there's no SLSA provenance attestation linking the image back to the specific build invocation. Adding `slsa-github-generator` would provide stronger supply-chain guarantees.

**Recommendations:**

- Add functional smoke tests beyond version checks, especially for databases and message brokers.
- Implement SLSA Level 2+ provenance generation alongside cosign signing.
- Replace the manual Kafka JAR patching with an automated dependency update mechanism.
- Consider adding an image size regression test to the CI pipeline.
