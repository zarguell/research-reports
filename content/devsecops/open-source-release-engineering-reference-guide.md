---
title: "Open Source Release Engineering: A Cross-Project Reference Guide"
date: 2025-05-12
type: codebase-analysis
status: complete
tags: [release-engineering, goreleaser, artifact-signing, docker, homebrew, snap, pypi, npm, code-signing, devsecops]
description: "A cross-project analysis of real-world release engineering across 13 open-source codebases — GoReleaser configurations, artifact signing, package publishing, changelogs, release channels, and desktop code signing."
---

## Overview

This guide extracts real release engineering patterns from 13 open-source projects we have analyzed. Every code snippet and configuration comes from a production codebase. Rather than theoretical advice, this is a field guide to how established projects actually ship software.

The projects span languages (Go, Python, Java/Gradle, Node.js/Electron), deployment models (CLI tools, desktop applications, web applications, security scanners), and release cadences (on-demand, nightly, weekly, stable). This breadth reveals how release engineering adapts to different constraints — a Go CLI has very different needs than an Electron desktop app.

## Key Findings

### Release Triggers: Five Distinct Approaches

Projects choose different moments to initiate a release, each with different trade-offs:

**1. Tag push** (Traefik, OpenTofu, Threat Dragon, oCIS, dep-scan)
The simplest model: push a `v*` tag and the release workflow fires automatically. Traefik's trigger is `tags: ['v*.*.*']`, Threat Dragon uses `tags: ['v2.?.*']` to constrain to 2.x releases, and oCIS accepts any `v*` tag but also allows `workflow_dispatch` with a version override.

```yaml
# Traefik
on:
  push:
    tags:
      - 'v*.*.*'
```

```yaml
# oCIS — tag push OR manual override
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      version_override:
        description: 'Version override (leave empty to auto-detect)'
        type: string
        default: ''
```

**2. Manual workflow dispatch** (Grype, Insomnia, ZAP)
An explicit human-in-the-loop decision. Grype requires a version input: `version: tag the latest commit on main with the given version (prefixed with v)`. Insomnia goes further with a channel selector (alpha/beta/stable). ZAP uses separate dispatch workflows for stable, weekly, and Docker-only releases.

```yaml
# Insomnia — channel-aware dispatch
on:
  workflow_dispatch:
    inputs:
      channel:
        type: choice
        options: [alpha, beta, stable]
      version:
        required: false
        description: force version (e.g. 9.0.0)
```

**3. GitHub release event** (Gitleaks, ZAP handle-release)
Fires after a release is published on GitHub. Gitleaks uses this solely to build and push Docker images to Docker Hub and GHCR. ZAP's `handle-release.yml` runs post-publish Gradle tasks (Crowdin sync, etc.).

**4. Scheduled nightly** (Checkov, Insomnia Homebrew)
Checkov runs a nightly cron that compares the latest git tag against the latest GitHub release and auto-creates a release if they differ — effectively automating what other projects do with tag pushes. Insomnia's Homebrew workflow runs on weekdays to bump formulae.

```yaml
# Checkov — nightly auto-release
on:
  schedule:
    - cron: "0 23 * * *"
  workflow_dispatch:
```

**5. Repository dispatch** (ZAP weekly, ZAP snap)
ZAP's weekly release fires on `repository_dispatch: types: ['release-weekly']`, allowing external automation or manual trigger through the GitHub API.

### GoReleaser: The Go Standard, But Not a Monolith

Four of our Go projects use GoReleaser, but their configurations reveal dramatically different philosophies:

**Traefik — Dynamic per-architecture generation.** Traefik doesn't use a static `.goreleaser.yml`. Instead, it runs a Go program (`internal/release/release.go`) that takes a `GOOS-GOARCH` pair, applies a template (`.goreleaser.yml.tmpl`), and outputs a per-architecture config. The release workflow runs GoReleaser once per matrix entry (17 OS/arch combinations) in parallel, then aggregates artifacts in a final release job. This approach trades config simplicity for parallel build speed.

```yaml
# Traefik — one goreleaser config per architecture
- name: Generate goreleaser file
  run: |
    GORELEASER_CONFIG_FILE_PATH=$(go run ./internal/release "${{ matrix.os }}")
    echo "GORELEASER_CONFIG_FILE_PATH=$GORELEASER_CONFIG_FILE_PATH" >> $GITHUB_ENV

- name: Build with goreleaser
  uses: goreleaser/goreleaser-action@v6.4.0
  with:
    args: release --clean --timeout="90m" --config "${{ env.GORELEASER_CONFIG_FILE_PATH }}"
```

**OpenTofu — The most comprehensive GoReleaser config.** OpenTofu builds for 6 OS/arch combinations across 4 architectures (386, amd64, arm, arm64), produces both tar.gz and zip archives, builds Docker images in standard and minimal variants (using separate `Dockerfile.mini`), creates multi-arch manifests with semantic tagging (version, major.minor, major, latest), publishes `.deb`, `.rpm`, and `.apk` packages via `nfpms`, and deploys to Snap with channel-aware publishing.

```yaml
# OpenTofu — semantic Docker manifest tagging
docker_manifests:
  - name_template: ghcr.io/opentofu/opentofu:{{ .Version }}
  - name_template: ghcr.io/opentofu/opentofu:{{ .Major }}.{{ .Minor }}
    skip_push: auto  # skips pre-releases
  - name_template: ghcr.io/opentofu/opentofu:latest
    skip_push: auto
```

**Grype — Image variant matrix.** Grype produces three Docker image variants (standard, nonroot, debug) across four architectures (amd64, arm64, ppc64le, s390x) and pushes to both Docker Hub and GHCR. That's 24 per-arch images and 24 multi-arch manifests. The config uses YAML anchors (`&build-timestamp`, `&build-ldflags`) to DRY the build definitions.

**Gitleaks — Minimalist.** 31 lines. Four OS/arch combos, basic archives, pre-release marked as true by default. The Docker image is built in a separate workflow triggered by the GitHub release event, not by GoReleaser at all.

### Artifact Signing: Three Layers of Provenance

The projects demonstrate three complementary signing strategies:

**Cosign (keyless OIDC).** OpenTofu and Grype both use cosign with GitHub's OIDC issuer for keyless signing. OpenTofu signs both release artifacts (checksums) and Docker images:

```yaml
# OpenTofu — dual signing: cosign + GPG
signs:
  - artifacts: all
    id: cosign
    cmd: cosign
    args: ["sign-blob", "--oidc-issuer=https://token.actions.githubusercontent.com",
           "--output-certificate=${certificate}", "--output-signature=${signature}",
           "${artifact}", "--yes"]
  - artifacts: all
    id: gpg
    cmd: gpg
    args: ["--batch", "-u", "{{ .Env.GPG_FINGERPRINT }}",
           "--output", "${signature}", "--detach-sign", "${artifact}"]

docker_signs:
  - artifacts: all
    args: ["sign", "--oidc-issuer=https://token.actions.githubusercontent.com",
           "${artifact}@${digest}", "--yes"]
```

**GPG.** OpenTofu also signs `.deb` and `.rpm` packages with GPG, importing the private key from a base64-encoded secret during the release job and scrubbing it in a post-step (`rm -rf ~/.gnupg`). This dual signing (cosign + GPG) means consumers can verify artifacts through either Sigstore or traditional GPG workflows.

**Chalk.** ZAP uses Chalk (from Crashappsec) to sign Docker images during the weekly build-push step. The setup requires password, public key, and private key secrets:

```yaml
# ZAP — Chalk signing
- name: Set up Chalk
  uses: crashappsec/setup-chalk-action@main
  with:
    password: ${{ secrets.CHALK_PASSWORD }}
    public_key: ${{ secrets.CHALK_PUBLIC_KEY }}
    private_key: ${{ secrets.CHALK_PRIVATE_KEY }}
```

**Notary (Kong/Insomnia).** Insomnia pushes Docker image signatures to a dedicated notary repository (`kong/notary`) using Kong's shared signing action, separating signatures from the application images.

**SLSA provenance.** Insomnia generates SLSA provenance for both CLI and Electron binaries using `slsa-framework/slsa-github-generator`, creating base64-encoded subject digests that provide verifiable build attestations.

### macOS Code Signing and Notarization

Three projects handle macOS desktop signing, each with a different approach:

**Grype (Quill).** Grype uses the Quill tool to sign and notarize Go binaries (not Electron apps) during the GoReleaser build, using a `post` hook:

```yaml
# Grype — Quill signing in goreleaser build hook
hooks:
  post:
    - cmd: .tool/quill sign-and-notarize "{{ .Path }}"
            --dry-run={{ .IsSnapshot }} --ad-hoc={{ .IsSnapshot }} -vv
```

Secrets: `QUILL_SIGN_P12` (certificate chain), `QUILL_SIGN_PASSWORD`, `QUILL_NOTARY_ISSUER`, `QUILL_NOTARY_KEY_ID`, `QUILL_NOTARY_KEY`.

**Threat Dragon (electron-builder).** Uses Apple API keys (not Apple ID + app-specific password). The certificate is stored as `CSC_LINK` (base64 P12) and the API key as individual secrets:

```yaml
# Threat Dragon — macOS notarization env vars
CSC_KEY_PASSWORD: ${{ secrets.MAC_CERTS_PASSWORD }}
CSC_LINK: ${{ secrets.MAC_CERTS }}
API_KEY_ID: ${{ secrets.API_KEY_ID }}
API_KEY_ISSUER_ID: ${{ secrets.API_KEY_ISSUER_ID }}
```

The API key file is written to `~/private_keys/AuthKey_${API_KEY_ID}.p8` before packaging.

**Insomnia (electron-builder + Digicert).** Insomnia's signing is the most complex: macOS uses `CSC_LINK` certificates, Windows uses Digicert's Software Trust Manager (`smctl`) for EV code signing. The Windows flow involves unpacking the Electron app, signing individual `.exe` and `.dll` files with `smctl`, then re-packaging into the installer. A custom "secure wrapper" PE is also compiled to wrap `Insomnia.exe` as a CVE-2025-1353 mitigation.

### Docker Publishing: Multi-Registry, Multi-Variant

Every project that publishes Docker images pushes to at least one registry. Most push to both Docker Hub and GHCR:

**Dual-registry pattern** (Grype, Gitleaks, ZAP, dep-scan):
```yaml
# Grype — dual registry per-arch images
image_templates:
  - anchore/grype:{{.Tag}}-amd64
  - ghcr.io/anchore/grype:{{.Tag}}-amd64
```

**Multi-variant images** (Grype). Grype publishes three variants — standard, nonroot, and debug — each with its own Dockerfile. The debug image includes a shell for troubleshooting.

**oCIS production vs. rolling.** oCIS distinguishes between production releases (pushed to both `owncloud/ocis` and `owncloud/ocis-rolling`) and pre-releases (rolling only). This is controlled by a `PRODUCTION_RELEASE_TAGS` env var and a `determine-release-type` job that outputs which repos to push to.

**dep-scan AL9 variant.** dep-scan publishes standard images plus `al9` variants (AlmaLinux 9-based) for environments requiring specific glibc versions, using a matrix to handle 4 image variants x 2 architectures.

**Manifest creation.** Projects handle multi-arch manifests differently:
- GoReleaser projects (OpenTofu, Grype): `docker_manifests` in config, manifests created by GoReleaser
- dep-scan: `int128/docker-manifest-create-action` in a dedicated `deploy-manifest` job
- oCIS: raw `docker buildx imagetools create` commands, using digests captured from the build step

### Package Manager Publishing

| Project | PyPI | npm | Homebrew | Snap | Deb/RPM | Other |
|---------|------|-----|----------|------|---------|-------|
| dep-scan | Trusted publishing | — | — | — | — | — |
| Insomnia | — | npm workspaces | Auto-bump cask | — | — | Docker Hub |
| OpenTofu | — | — | — | Snapcraft | PackageCloud (deb+rpm) | APK |
| Grype | — | — | Cask (homebrew-grype) | — | deb, rpm | — |
| Threat Dragon | — | — | — | Snapcraft | deb, rpm, AppImage | — |
| ZAP | — | — | — | Snapcraft | — | Install4J |
| Checkov | pip (nightly) | — | — | — | — | — |

**PyPI trusted publishing** (dep-scan). Uses `uv publish --trusted-publishing always` with OIDC-based authentication — no API tokens stored as secrets. This is the modern recommended approach.

**Homebrew auto-bump** (Insomnia). A scheduled workflow runs on weekdays, uses `Homebrew/actions/bump-packages` to detect new versions and submit PRs to `homebrew/homebrew-cask`. Separate bumps for stable and beta casks (`inso`, `inso@beta`, `insomnia`).

**Snap publishing** (OpenTofu, ZAP, Threat Dragon). All use `snapcore/action-build` and `snapcore/action-publish`. OpenTofu dynamically selects the channel (`latest/stable` vs `latest/edge`) and grade (`stable` vs `devel`) based on pre-release status, all within GoReleaser's `snapcrafts` config.

**PackageCloud** (OpenTofu). Deb and RPM packages are uploaded to PackageCloud using `computology/packagecloud-github-action`, supporting both `any/any` and `rpm_any/rpm_any` distributions.

### Changelog Generation

| Project | Method | Tool |
|---------|--------|------|
| OpenTofu | `github-native` in GoReleaser | GitHub release notes |
| Checkov | `release-changelog-builder-action` | From/to tag diff |
| Insomnia | `update-changelog.yml` workflow | Automated version bump |
| oCIS | `calens` + Makefile | Changelog from YAML fragments |
| Grype | Auto via GoReleaser | Git log |
| Traefik | Manual | Human-written |

oCIS's approach is notable: changelog entries are individual YAML files in `changelog/unreleased/`, and the `calens` tool aggregates them into a release changelog. If no entries exist (dev builds), the workflow falls back to a pointer to the unreleased directory.

### Release Gates and Safety Checks

**Version validation** (OpenTofu). A pre-release script (`compare-release-version.sh`) validates that the version being released is sane. An additional check prevents stable releases from tags on `main` — they must come from version branches:

```yaml
# OpenTofu — branch-based release safety
if [ "$IS_PRERELEASE" == "false" ] && [ "$IS_TAG_ON_MAIN" == "true" ]; then
  echo "ERROR: Creating stable release from a tag on main is not allowed."
  exit 1
fi
```

**CI gate checks** (Grype). Before releasing, Grype verifies that 8 specific CI checks have passed on `main`: acceptance tests (Linux + Mac), snapshot builds, CLI tests, integration tests, quality tests, static analysis, and unit tests. These are verified via a reusable `check-gate` workflow from the `anchore/workflows` repo.

**Version availability check** (Grype). Uses a shared `check-version-available` workflow to ensure the requested version doesn't already exist as a release.

**Vulnerability scan gate** (oCIS). Trivy scans the freshly built Docker image with `exit-code: 1` for HIGH/CRITICAL findings. The release pipeline has a dedicated `docker-scan` job that blocks the release if vulnerabilities are found.

**Release audit** (oCIS). A final `audit-release` job runs `scripts/audit-release.py` to verify the release is complete (GitHub release exists, Docker images published, binaries present).

**SBOM generation** (Insomnia, Threat Dragon). Both generate SBOMs during the release build. Insomnia uses Syft via Kong's shared SCA action. Threat Dragon generates SBOMs via npm scripts and attaches them as release artifacts.

### Insomnia's Three-Phase Release Pipeline

Insomnia has the most sophisticated release process, split across three separate workflows:

1. **`release-start.yml`** — Bumps versions across npm workspaces (`npm --workspaces version patch`), creates a `release/X.Y.Z` branch, opens a PR back to `develop` with changelog updates.
2. **`release-build.yml`** — Triggered on push to `release/**` branches. Builds Electron desktop apps (macOS, Windows, Linux) and CLI binaries with platform-specific code signing.
3. **`release-publish.yml`** — Manual dispatch after QA. Downloads artifacts from the build workflow, creates the GitHub release with SLSA provenance, pushes Docker images to Docker Hub, signs images with Notary, uploads sourcemaps to Sentry, publishes version metadata to Insomnia's update API.

This separation allows QA to test signed binaries before they're publicly released — a pattern that makes sense for desktop applications where rollback is difficult.

### Post-Release Automation

**Traefik — Docker Hub official image sync.** After release, Traefik clones `traefik/traefik-library-image`, runs `updatev2.sh` with the new version, and pushes the update. This triggers Docker Hub's automated build for the official Traefik image.

**Grype — Install script + Slack notification.** After release, Grype updates an install script hosted on S3 and Cloudflare R2 via a shared workflow, and sends a Slack notification with release details.

**Insomnia — Sentry + Homebrew + API publish.** Post-publish: upload sourcemaps to Sentry, notify the Insomnia update API (for in-app update checks), and the scheduled Homebrew workflow picks up the new version.

**oCIS — Docker Hub README sync.** Uses `peter-evans/dockerhub-description` to update the Docker Hub repository description from the repo's README after each release.

## Assessment

### Strengths

- **Defense in depth for signing.** OpenTofu's dual cosign+GPG approach covers both modern (Sigstore) and traditional (GPG) verification workflows. This is forward-looking without breaking backward compatibility.
- **Release gates prevent bad releases.** Grype's CI check gate, oCIS's Trivy vulnerability gate, and OpenTofu's branch validation all prevent releasing from a dirty or untested state.
- **GoReleaser is the clear winner for Go projects.** Even Traefik's dynamic generation approach uses GoReleaser under the hood — it's just too good at the mechanical parts of release engineering to replace with custom scripts.
- **SLSA provenance adoption.** Insomnia's use of SLSA generators for both CLI and Electron binaries shows how build attestation can be integrated without significant overhead.

### Concerns

- **Secret sprawl.** Insomnia requires at least 15 secrets for a single release (Apple, Digicert, Docker, Sentry, Homebrew, API tokens). This operational complexity is fragile — rotating any certificate requires coordinated updates.
- **Checkov's nightly release approach is fragile.** Relying on a cron job to detect new tags and create releases adds latency and depends on GitHub Actions reliability. A tag-push trigger is more deterministic.
- **Gitleaks' release workflow is split.** The GoReleaser config handles binaries, but Docker images are built in a separate workflow triggered by the release event. This creates a window where the GitHub release exists but Docker images don't yet.

### Recommendations

1. **Start with GoReleaser for Go projects.** Even the 31-line Gitleaks config handles builds, archives, and checksums. Grow into OpenTofu's comprehensive config as needs expand.
2. **Use keyless cosign signing.** OpenTofu and Grype demonstrate that OIDC-based signing requires no secret management beyond the default `GITHUB_TOKEN` permissions. This is strictly better than managing signing keys.
3. **Gate releases on CI status.** Grype's `check-gate` pattern — requiring specific CI checks to have passed on `main` before allowing a release — should be standard practice.
4. **Separate build and publish for desktop apps.** Insomnia's three-phase pipeline allows QA verification of signed binaries between build and public release. For apps that auto-update, this safety window is critical.
5. **Generate SBOMs at release time.** Both Insomnia and Threat Dragon attach SBOMs to releases. This is becoming table stakes for supply chain transparency.
6. **Use PyPI trusted publishing.** dep-scan's `uv publish --trusted-publishing always` is the modern standard — no tokens, no secrets, just OIDC.

## Related

- [[best-cicd-implementations-reference-guide]]
- [[container-security-hardening-reference-guide]]
- [[analyzing-grype]]
- [[analyzing-opentofu]]
- [[analyzing-traefik]]
- [[analyzing-insomnia]]
- [[analyzing-zaproxy]]
- [[analyzing-threat-dragon]]
- [[analyzing-dep-scan]]
- [[analyzing-gitleaks]]
- [[analyzing-checkov]]
- [[analyzing-ocis]]
