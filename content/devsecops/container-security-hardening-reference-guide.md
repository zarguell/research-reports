---
title: "Container Security Hardening: An End-to-End Reference Guide"
date: 2025-05-11
tags: [containers, docker, security, devsecops, trivy, sbom, cosign, multi-arch, vulnerability-scanning]
categories: [devsecops]
type: codebase-analysis
status: complete
source: https://github.com/zarguell/research-reports
---

## Overview

This guide extracts real container security patterns from 13 open-source projects — from Dockerfile design to CI pipeline scanning to image signing. Every code snippet comes from a production codebase we have analyzed. Rather than theoretical best practices, this is a field guide to what actually works at scale.

The projects span languages (Go, Python, Node.js, Java) and deployment models (CLI tools, web applications, security scanners, infrastructure platforms), giving us a broad view of how container security is implemented in practice.

**Projects analyzed:** [[analyzing-threat-dragon|Threat Dragon]], [[analyzing-opentofu|OpenTofu]], [[analyzing-ocis|oCIS]], [[analyzing-wazuh|Wazuh]], [[analyzing-gitleaks|Gitleaks]], [[analyzing-insomnia|Insomnia]], [[analyzing-grype|Grype]], [[analyzing-dep-scan|dep-scan]], [[analyzing-checkov|Checkov]], [[analyzing-zaproxy|ZAP]], [[analyzing-traefik|Traefik]]

## The Base Image Spectrum

The single most impactful container security decision is your `FROM` line. Across our codebases, we see the full spectrum:

### `FROM scratch` — Absolute Zero

[[analyzing-grype|Grype]] and [[analyzing-opentofu|OpenTofu]] use `scratch` as their base image. This means the container contains literally nothing except what you explicitly copy in — no shell, no package manager, no libc.

```dockerfile
# Grype - Dockerfile
FROM gcr.io/distroless/static-debian12:latest AS build

FROM scratch
# needed for version check HTTPS request
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# create the /tmp dir, which is needed for image content cache
WORKDIR /tmp
COPY grype /
ENTRYPOINT ["/grype"]
```

```dockerfile
# OpenTofu - Dockerfile.minimal
FROM scratch
LABEL maintainer="OpenTofu Core Team <core@opentofu.org>"
COPY tofu /usr/local/bin/tofu
ENTRYPOINT ["/usr/local/bin/tofu"]
```

**When to use:** Compiled static binaries (Go, Rust) that don't need libc. Grype copies only CA certs and the binary. OpenTofu copies only the binary. Attack surface is near zero.

### `FROM distroless` — Minimal Runtime

Grype offers three variants using Google's distroless images:

```dockerfile
# Grype - Dockerfile.nonroot
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /tmp
COPY grype /
ENTRYPOINT ["/grype"]
```

```dockerfile
# Grype - Dockerfile.debug
FROM gcr.io/distroless/static-debian12:debug-nonroot
WORKDIR /tmp
COPY grype /
ENTRYPOINT ["/grype"]
```

The `nonroot` variant runs as UID 65532 by default. The `debug-nonroot` variant includes a shell for troubleshooting. Both are built on Debian 12 but contain only the minimal runtime dependencies.

**When to use:** When you need CA certs, timezone data, or a minimal runtime but want to avoid a shell in production.

### `FROM alpine` — Small but Capable

[[analyzing-traefik|Traefik]] and [[analyzing-gitleaks|Gitleaks]] use Alpine for their runtime images:

```dockerfile
# Traefik - Dockerfile
# syntax=docker/dockerfile:1.2
FROM alpine:3.23
RUN apk add --no-cache --no-progress ca-certificates tzdata
ARG TARGETPLATFORM
COPY ./dist/$TARGETPLATFORM/traefik /
EXPOSE 80
VOLUME ["/tmp"]
ENTRYPOINT ["/traefik"]
```

```dockerfile
# Gitleaks - Dockerfile
FROM golang:1.24 AS build
WORKDIR /go/src/github.com/zricethezav/gitleaks
COPY . .
RUN VERSION=$(git describe --tags --abbrev=0) && \
CGO_ENABLED=0 go build -o bin/gitleaks -ldflags "-X=...version.Version=${VERSION}"

FROM alpine:3.22
RUN apk add --no-cache bash git openssh-client
COPY --from=build /go/src/github.com/zricethezav/gitleaks/bin/* /usr/bin/
RUN git config --global --add safe.directory '*'
ENTRYPOINT ["gitleaks"]
```

**When to use:** When your application needs shell access, git, or other common tools. Alpine uses musl libc instead of glibc — test thoroughly if your app has C dependencies.

### `FROM slim` — Full Runtime, Smaller Footprint

[[analyzing-checkov|Checkov]] uses Debian slim:

```dockerfile
# Checkov - Dockerfile
FROM python:3.11-slim
ENV RUN_IN_DOCKER=True
RUN set -eux; \
    apt-get update; \
    apt-get -y upgrade; \
    apt-get install -y --no-install-recommends \
            ca-certificates git curl openssh-client; \
    pip install setuptools==78.1.1 urllib3==2.2.2; \
    curl -sSLo get_helm.sh https://raw.githubusercontent.com/helm/helm/master/scripts/get-helm-3; \
    chmod 700 get_helm.sh; VERIFY_CHECKSUM=true ./get_helm.sh; \
    ...
    apt-get remove -y curl; \
    apt-get purge -y --auto-remove; \
    rm -rf /var/lib/apt/lists/*
```

Note how Checkov installs curl, uses it, then removes it. The final image doesn't contain the download tool.

### `FROM enterprise-minimal` — Full Language Runtimes

[[analyzing-dep-scan|dep-scan]] needs Python, Java, Go, Node.js, and PHP in a single image:

```dockerfile
# dep-scan - Dockerfile
FROM ghcr.io/almalinux/10-minimal:10
ARG JAVA_VERSION=26.0.1-tem
ARG MAVEN_VERSION=3.9.15
ARG PYTHON_VERSION=3.12
ARG GO_VERSION=1.26.3
...
```

This is the heavyweight end of the spectrum — necessary when your tool is a multi-language scanner, but it significantly increases the attack surface.

> [!tip] Decision Framework
> - Static binary (Go/Rust) → `scratch` or `distroless`
> - Need shell access → `alpine`
> - Need glibc or specific system libs → `*-slim`
> - Multi-language runtime → enterprise minimal (AlmaLinux, Ubuntu minimal)

## Multi-Stage Build Patterns

Multi-stage builds are the single most important Dockerfile technique for security. They ensure build-time dependencies never reach the runtime image.

### The 4-Stage Pattern: [[analyzing-threat-dragon|Threat Dragon]]

Threat Dragon has the most sophisticated multi-stage build in our analysis:

```dockerfile
ARG NODE_VERSION=24.15.0

# Stage 1: Hardened base with system updates and non-root user
FROM node:$NODE_VERSION-alpine AS base-node
RUN apk -U upgrade
WORKDIR /app
RUN npm i -g npm@latest
RUN chown -R node:node /app
USER node

# Stage 2: Build front-end and back-end with devDependencies
FROM base-node AS build
RUN mkdir -p boms td.server td.vue td.vue/src/service/schema/api_json
COPY package-lock.json package.json /app/
COPY ./td.server/package-lock.json ./td.server/package.json ./td.server/
COPY ./td.vue/package-lock.json ./td.vue/package.json ./td.vue/
RUN npm clean-install --ignore-scripts
RUN cd td.server && npm clean-install
RUN cd td.vue && npm clean-install --legacy-peer-deps
RUN npm run build
# Generate SBOMs during build
RUN cd td.server && npm run make-sbom
RUN cp td.server/sbom.json boms/threat-dragon-server-bom.json && \
    cp td.server/sbom.xml boms/threat-dragon-server-bom.xml && \
    cp td.vue/dist/.sbom/bom.json boms/threat-dragon-site-bom.json && \
    cp td.vue/dist/.sbom/bom.xml boms/threat-dragon-site-bom.xml

# Stage 3: Separate docs build (Ruby/Jekyll - completely isolated)
FROM ruby:4.0-slim-bookworm AS build-docs
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /td.docs
COPY docs/Gemfile Gemfile
COPY docs/Gemfile.lock Gemfile.lock
RUN bundle install
COPY docs/ .
RUN bundle exec jekyll build -b docs/

# Stage 4: Production image - only runtime deps
FROM base-node
COPY --chown=node:node --from=build-docs /td.docs/_site /app/docs
COPY --chown=node:node --from=build /app/boms /app/boms
COPY --chown=node:node ./td.server/package-lock.json ./td.server/package.json ./td.server/
RUN cd td.server && npm clean-install --omit dev --ignore-scripts
COPY --chown=node:node --from=build /app/td.server/dist ./td.server/dist
COPY --chown=node:node --from=build /app/td.vue/dist ./dist
COPY --chown=node:node ./td.server/index.js ./td.server/index.js
HEALTHCHECK --interval=10s --timeout=2s --start-period=2s \
    CMD ["/nodejs/bin/node", "./td.server/dist/healthcheck.js"]
CMD ["td.server/index.js"]
```

Key observations:
- **Stage 1** creates a hardened base with system updates and non-root user — reused by stages 2 and 4
- **Stage 2** builds the application AND generates SBOMs — the SBOMs are then copied to the final image
- **Stage 3** builds documentation in a completely isolated Ruby environment — Jekyll never touches the Node.js stages
- **Stage 4** reinstalls dependencies with `--omit dev` — devDependencies from stage 2 are excluded

### The Build Secrets Pattern: [[analyzing-zaproxy|ZAP]]

ZAP uses Docker build secrets for sensitive download URLs:

```dockerfile
# ZAP - Dockerfile-stable
FROM --platform=linux/amd64 debian:bookworm-slim AS builder
RUN apt-get update && apt-get install -q -y --fix-missing \
    wget curl openjdk-17-jdk xmlstarlet unzip && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /zap
RUN wget -qO- https://raw.githubusercontent.com/.../ZapVersions.xml | \
    xmlstarlet sel -t -v //url | grep -i Linux | \
    wget --content-disposition -i - -O - | tar zxv && \
    mv ZAP*/* . && rm -R ZAP*

# Webswing setup with build secret
ENV WEBSWING_VERSION=24.2.2
RUN --mount=type=secret,id=webswing_url \
    if [ -s /run/secrets/webswing_url ]; \
    then curl -s -L "$(cat /run/secrets/webswing_url)-${WEBSWING_VERSION}-distribution.zip" > webswing.zip; \
    else curl -s -L "https://dev.webswing.org/files/public/...-eval-${WEBSWING_VERSION}-distribution.zip" > webswing.zip; \
    fi && unzip webswing.zip && rm webswing.zip
```

The `--mount=type=secret` mounts a secret during build that is never baked into the image layers. The fallback URL is used when the secret isn't provided.

### The Read-Only Runtime Pattern: [[analyzing-dep-scan|dep-scan]]

dep-scan uses a single-stage build but enforces runtime immutability:

```dockerfile
# dep-scan - Dockerfile (excerpt)
COPY . /opt/dep-scan
RUN set -e; \
    ... install all runtimes ... \
    && cd /opt/dep-scan \
    && uv sync --all-extras --all-packages --no-dev \
    && uv cache clean \
    && depscan --help \
    && chown -R owasp:owasp /opt \
    && chmod a-w -R /opt \
    && rm -rf /var/cache/yum \
    && microdnf clean all
USER owasp
WORKDIR /app
CMD ["depscan"]
```

`chmod a-w -R /opt` removes all write permissions from the application directory at the OS level. Even if an attacker gains execution in the container, they cannot modify the application files.

## Non-Root User Enforcement

Running containers as root is the most common container security anti-pattern. Our analysis shows two distinct approaches:

### Explicit User Creation: [[analyzing-ocis|oCIS]]

oCIS creates a dedicated user with specific UID/GID and restrictive permissions:

```dockerfile
# oCIS - Dockerfile.linux.amd64
FROM amd64/alpine:3.23.4

RUN addgroup -g 1000 -S ocis-group && \
    adduser -S --ingroup ocis-group --uid 1000 ocis-user --home /var/lib/ocis

RUN mkdir -p /var/lib/ocis && \
    chown -R ocis-user:ocis-group /var/lib/ocis && \
    chmod -R 751 /var/lib/ocis && \
    mkdir -p /etc/ocis && \
    chown -R ocis-user:ocis-group /etc/ocis && \
    chmod -R 751 /etc/ocis

VOLUME ["/var/lib/ocis", "/etc/ocis"]
WORKDIR /var/lib/ocis
USER 1000
EXPOSE 9200/tcp
```

The `751` permissions mean: owner can read/write/execute, group can read/execute, others can only execute (traverse directories). This is more restrictive than the typical `755`.

### Built-In Image User: [[analyzing-threat-dragon|Threat Dragon]]

Threat Dragon leverages the `node` user that comes with the official Node.js image:

```dockerfile
FROM node:$NODE_VERSION-alpine AS base-node
RUN apk -U upgrade
WORKDIR /app
RUN npm i -g npm@latest
RUN chown -R node:node /app
USER node
```

Every `COPY` in later stages uses `--chown=node:node`:

```dockerfile
COPY --chown=node:node --from=build /app/td.server/dist ./td.server/dist
COPY --chown=node:node --from=build /app/td.vue/dist ./dist
```

### Distroless Non-Root: [[analyzing-grype|Grype]]

Grype's `nonroot` variant uses UID 65532, which is baked into the distroless base image:

```dockerfile
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /tmp
COPY grype /
ENTRYPOINT ["/grype"]
```

No user creation needed — the base image already runs as non-root.

### User with Password: [[analyzing-zaproxy|ZAP]]

ZAP creates a user and sets a password (needed for VNC access in the full image):

```dockerfile
RUN useradd -u 1000 -d /home/zap -m -s /bin/bash zap
RUN echo zap:zap | chpasswd
RUN mkdir /zap && chown zap:zap /zap
USER zap
```

> [!warning] Anti-Pattern: Projects Without Non-Root
> Several projects in our analysis run as root by default:
> - [[analyzing-opentofu|OpenTofu]] — standard Dockerfile uses `alpine` with no USER directive
> - [[analyzing-traefik|Traefik]] — single-stage, no USER
> - [[analyzing-checkov|Checkov]] — no USER directive
> - [[analyzing-gitleaks|Gitleaks]] — no USER directive
>
> For CLI tools like these, the risk is lower since they're typically run as ephemeral commands. But for long-running services, always enforce non-root.

## SBOM Generation and Attestation

Software Bill of Materials (SBOM) generation is increasingly required for supply chain security. Our projects use three distinct approaches:

### In-Build SBOM: [[analyzing-threat-dragon|Threat Dragon]]

Threat Dragon generates SBOMs during the Docker build and bakes them into the final image:

```dockerfile
FROM base-node AS build
...
RUN cd td.server && npm run make-sbom
RUN cp td.server/sbom.json boms/threat-dragon-server-bom.json && \
    cp td.server/sbom.xml boms/threat-dragon-server-bom.xml && \
    cp td.vue/dist/.sbom/bom.json boms/threat-dragon-site-bom.json && \
    cp td.vue/dist/.sbom/bom.xml boms/threat-dragon-site-bom.xml
```

Both CycloneDX JSON and XML formats are generated for both the server and the Vue.js frontend. The SBOMs end up at `/app/boms/` in the final image, available for runtime verification.

### CI Pipeline SBOM: [[analyzing-grype|Grype]]

Grype generates SBOMs as CI artifacts using Anchore's sbom-action:

```yaml
# Grype - release.yaml
- uses: anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610 # v0.24.0
  continue-on-error: true
  with:
    artifact-name: sbom.spdx.json
```

The SBOM is uploaded as a GitHub Actions artifact and attached to the release. This uses SPDX format.

### OCI-Attached SBOM: [[analyzing-dep-scan|dep-scan]]

dep-scan takes the most sophisticated approach — generating SBOMs for both the Python project and the Docker image, then attaching them directly to the container registry:

```yaml
# dep-scan - pythonpublish.yml
- name: Generate SBOM with cdxgen
  run: |
    npm install -g @cyclonedx/cdxgen
    cdxgen -t python -o bom.json . --profile research
    cdxgen -t docker -o depscan-oci-image.cdx.json ghcr.io/owasp-dep-scan/depscan:latest

- name: Attach sbom to the image
  if: startsWith(github.ref, 'refs/tags/')
  continue-on-error: true
  run: |
    oras attach --artifact-type sbom/cyclonedx \
      ghcr.io/owasp-dep-scan/depscan:latest \
      ./depscan-oci-image.cdx.json:application/json
    oras discover --format tree ghcr.io/owasp-dep-scan/depscan:latest
```

`oras attach` uses OCI referrers to attach the SBOM to the image manifest in the registry. This means anyone pulling the image can also retrieve its SBOM. The `oras discover --format tree` command verifies the attachment.

### Monorepo SBOM: [[analyzing-insomnia|Insomnia]]

Insomnia uses Kong's shared security action for monorepo-wide SBOM:

```yaml
# Insomnia - release-build.yml
- id: sca-project
  uses: Kong/public-shared-actions/security-actions/sca@a18abf762d6e2444bcbfd20de70451ea1e3bc1b1 # v4.1.1
  with:
    dir: .
    upload-sbom-release-assets: false
```

> [!tip] SBOM Strategy Recommendations
> - **For published images:** Use OCI referrers (dep-scan's oras approach) so SBOMs travel with the image
> - **For release artifacts:** Upload as GitHub release assets (Grype's approach)
> - **For compliance:** Bake into the image (Threat Dragon's approach) for offline verification
> - **Format:** CycloneDX for security tooling, SPDX for license compliance

## Vulnerability Scanning in CI

### PR-Gated Scanning: [[analyzing-threat-dragon|Threat Dragon]]

Threat Dragon makes Trivy scanning a hard gate on every pull request:

```yaml
# Threat Dragon - pull_request.yaml
build_docker_image:
    name: Build docker image
    runs-on: ubuntu-24.04
    needs: e2e_smokes
    steps:
      - name: Set up Docker Buildx
        id: buildx
        uses: docker/setup-buildx-action@4d04d5d9486b7bd6fa91e7baf45bbb4f8b9deedd # v4.0.0
        with:
          install: true
      - name: Cache Docker layers
        uses: actions/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae # v5.0.5
        with:
          path: /tmp/.buildx-cache
          key: ${{ runner.os }}-buildx-${{ hashFiles('Dockerfile') }}
      - name: Build for amd64
        uses: docker/build-push-action@bcafcacb16a39f128d818304e6c9c0c18556b85f # v7.1.0
        with:
          outputs: type=docker,dest=/tmp/${{ env.IMAGE_NAME }}.tar
          cache-from: type=local,src=/tmp/.buildx-cache
          cache-to: type=local,dest=/tmp/.buildx-cache-new,mode=max
      - name: Upload docker local image
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: ${{ env.IMAGE_NAME }}
          path: /tmp/${{ env.IMAGE_NAME }}.tar

scan_image_with_trivy:
    name: Scan with Trivy
    runs-on: ubuntu-24.04
    needs: build_docker_image
    permissions:
      contents: read
    steps:
      - name: Retrieve local docker image
        uses: actions/download-artifact@3e5f45b2cfb1
7a40e8e0b5a5461e7c # v8.0.1
        with:
          name: ${{ env.IMAGE_NAME }}
          path: /tmp
      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        with:
          image-ref: '${{ env.IMAGE_NAME }}'
          format: 'table'
          trivyignores: '.github/workflows/.trivyignore'
          exit-code: 1
          skip-files: '/app/docs/configure/bitbucket.html,/app/docs/assets/search.json'
```

The pattern is: build → save image as artifact → scan in separate job. `exit-code: 1` makes Trivy block the PR on any finding. `skip-files` excludes known false positives (generated documentation files).

### Release-Gated Scanning with Severity Filter: [[analyzing-ocis|oCIS]]

oCIS adds severity filtering and a manual block step to their release pipeline:

```yaml
# oCIS - release.yml
docker-scan:
    name: docker-scan (${{ matrix.arch }}, ${{ matrix.repo }})
    runs-on: ubuntu-latest
    needs: [determine-release-type, docker-build]
    strategy:
      matrix:
        arch: [amd64]
        repo: ${{ fromJSON(needs.determine-release-type.outputs.docker_repos) }}
    steps:
      - uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        id: trivy
        continue-on-error: true
        with:
          image-ref: ${{ matrix.repo }}:${{ needs.determine-release-type.outputs.version }}-linux-${{ matrix.arch }}
          format: table
          exit-code: 1
          severity: HIGH,CRITICAL
          ignore-unfixed: true
          skip-files: /usr/bin/gomplate,/usr/bin/wait-for
          hide-progress: true
        env:
          TRIVY_IGNOREFILE: .trivyignore

      - name: Block on vulnerabilities
        if: steps.trivy.outcome == 'failure'
        run: |
          echo "::error title=Security scan blocked release::Image ${{ matrix.repo }}:${{ needs.determine-release-type.outputs.version }}-linux-${{ matrix.arch }} has HIGH or CRITICAL vulnerabilities (see Trivy report above). Fix all findings before releasing."
          exit 1
```

Key design choices:
- **`severity: HIGH,CRITICAL`** — only blocks on serious findings, LOW/MEDIUM are informational
- **`ignore-unfixed: true`** — skips CVEs that have no available patch (avoids blocking on vendor responsibility)
- **`continue-on-error: true` + manual block** — captures the scan result without immediately failing, then provides a clear error message in the block step
- **`TRIVY_IGNOREFILE: .trivyignore`** — project-specific exception list

oCIS also runs filesystem scans on source code:

```yaml
security-scan-trivy:
    runs-on: ubuntu-latest
    steps:
      - uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25
        with:
          scan-type: fs
          format: table
          exit-code: 0
          severity: CRITICAL,HIGH
```

This catches vulnerabilities in lockfiles and dependencies before they even reach the Docker build.

## Image Signing and Provenance

Image signing verifies that an image was built by a trusted source and hasn't been tampered with. Our projects use three different approaches:

### Cosign (Sigstore): [[analyzing-opentofu|OpenTofu]] and [[analyzing-grype|Grype]]

OpenTofu uses cosign as part of its GoReleaser release pipeline:

```yaml
# OpenTofu - release.yml
- name: Install cosign
  uses: sigstore/cosign-installer@faadad0cce49287aee09b3a48701e75088a2c6ad # v4.0.0
  with:
    cosign-release: v2.2.0
```

Grype installs cosign in validation workflows to verify signed artifacts:

```yaml
# Grype - validations.yaml
- name: Install Cosign
  uses: sigstore/cosign-installer@cad07c2e89fa2edd6e2d7bab4c1aa38e53f76003 #v4.1.1
```

Cosign supports keyless signing via Sigstore's transparency log, meaning you don't need to manage private keys — the signing is tied to the CI identity (GitHub OIDC token).

### Chalk (CrashAppSec): [[analyzing-zaproxy|ZAP]]

ZAP uses Chalk for image signing and provenance:

```yaml
# ZAP - release-live-docker.yml
- name: Set up Chalk
  uses: crashappsec/setup-chalk-action@main
  with:
    password: ${{ secrets.CHALK_PASSWORD }}
    public_key: ${{ secrets.CHALK_PUBLIC_KEY }}
    private_key: ${{ secrets.CHALK_PRIVATE_KEY }}
```

Chalk embeds metadata (build time, commit, signer) directly into the image and uses asymmetric key pairs for verification.

### DigiCert Software Trust: [[analyzing-insomnia|Insomnia]]

Insomnia uses enterprise-grade code signing via DigiCert for Windows binaries:

```yaml
# Insomnia - release-build.yml
- name: Setup Software Trust Manager
  if: runner.os == 'Windows'
  uses: digicert/code-signing-software-trust-action@9b30180369343eb1ce0dcbebb933cfa3e17b6cc8 # v1.0.0
  with:
    simple-signing-mode: true
  env:
    SM_HOST: ${{ vars.DIGICERT_SM_HOST }}
    SM_API_KEY: ${{ secrets.DIGICERT_SM_API_KEY }}
    SM_CLIENT_CERT_PASSWORD: ${{ secrets.DIGICERT_SM_CLIENT_CERT_PASSWORD }}
```

> [!tip] Signing Approach Selection
> - **Open source / CI-native:** Cosign with keyless signing (free, transparent, Sigstore-backed)
> - **Need embedded metadata:** Chalk (build provenance baked into image)
> - **Enterprise compliance:** DigiCert / Venafi (PKI-backed, audit trail)

## Multi-Architecture Builds

Multi-arch images ensure your container works across different CPU architectures. The approaches range from simple to industrial.

### Makefile-Driven Buildx: [[analyzing-traefik|Traefik]]

Traefik uses a Makefile target that pre-builds binaries then uses buildx for multi-arch:

```makefile
# Traefik - Makefile
DOCKER_BUILD_PLATFORMS ?= linux/amd64,linux/arm64

multi-arch-image-%: binary-linux-amd64 binary-linux-arm64
	docker buildx build $(DOCKER_BUILDX_ARGS) \
	    -t traefik/traefik:$* \
	    --platform=$(DOCKER_BUILD_PLATFORMS) \
	    -f Dockerfile .
```

CI workflow:

```yaml
# Traefik - experimental.yaml
- name: Set up QEMU
  uses: docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130 # v3.7.0
- name: Set up Docker Buildx
  uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3.12.0
- name: Build docker experimental image
  env:
    DOCKER_BUILDX_ARGS: "--push"
  run: make multi-arch-image-experimental-${GITHUB_REF##*/}
```

### GoReleaser Multi-Arch with Manifests: [[analyzing-grype|Grype]]

Grype has the most comprehensive multi-arch setup — 4 architectures × 3 image variants:

```yaml
# Grype - .goreleaser.yaml
dockers:
  # Production images - 4 architectures
  - image_templates:
      - anchore/grype:{{.Tag}}-amd64
      - ghcr.io/anchore/grype:{{.Tag}}-amd64
    goarch: amd64
    dockerfile: Dockerfile
    use: buildx
    build_flag_templates:
      - "--platform=linux/amd64"
      - "--provenance=false"
  - image_templates:
      - anchore/grype:{{.Tag}}-arm64v8
      - ghcr.io/anchore/grype:{{.Tag}}-arm64v8
    goarch: arm64
    ...
  - image_templates:
      - anchore/grype:{{.Tag}}-ppc64le
    goarch: ppc64le
    ...
  - image_templates:
      - anchore/grype:{{.Tag}}-s390x
    goarch: s390x
    ...

  # Nonroot variants - same 4 architectures
  - image_templates:
      - anchore/grype:{{.Tag}}-nonroot-amd64
    dockerfile: Dockerfile.nonroot
    ...

docker_manifests:
  - name_template: anchore/grype:latest
    image_templates:
      - anchore/grype:{{.Tag}}-amd64
      - anchore/grype:{{.Tag}}-arm64v8
      - anchore/grype:{{.Tag}}-ppc64le
      - anchore/grype:{{.Tag}}-s390x
  - name_template: ghcr.io/anchore/grype:nonroot
    image_templates:
      - ghcr.io/anchore/grype:{{.Tag}}-nonroot-amd64
      - ghcr.io/anchore/grype:{{.Tag}}-nonroot-arm64v8
      - ghcr.io/anchore/grype:{{.Tag}}-nonroot-ppc64le
      - ghcr.io/anchore/grype:{{.Tag}}-nonroot-s390x
```

The `docker_manifests` section creates multi-arch manifests so `docker pull anchore/grype:latest` automatically selects the right architecture.

### OpenTofu's Dual Dockerfile Approach

OpenTofu offers two Dockerfiles per architecture:

```yaml
# OpenTofu - .goreleaser.yaml
dockers:
  - use: buildx
    goarch: amd64
    image_templates:
      - "ghcr.io/opentofu/opentofu:{{ .Version }}-amd64"

  - use: buildx
    goarch: amd64
    dockerfile: Dockerfile.minimal
    image_templates:
      - "ghcr.io/opentofu/opentofu:{{ .Version }}-minimal-amd64"
  # Same pattern for arm64, arm, 386...

docker_manifests:
  - name_template: ghcr.io/opentofu/opentofu:{{ .Version }}
    image_templates:
      - ghcr.io/opentofu/opentofu:{{ .Version }}-amd64
      - ghcr.io/opentofu/opentofu:{{ .Version }}-arm64
      - ghcr.io/opentofu/opentofu:{{ .Version }}-arm
      - ghcr.io/opentofu/opentofu:{{ .Version }}-386

  - name_template: ghcr.io/opentofu/opentofu:{{ .Version }}-minimal
    image_templates:
      - ghcr.io/opentofu/opentofu:{{ .Version }}-minimal-amd64
      - ghcr.io/opentofu/opentofu:{{ .Version }}-minimal-arm64
      - ghcr.io/opentofu/opentofu:{{ .Version }}-minimal-arm
      - ghcr.io/opentofu/opentofu:{{ .Version }}-minimal-386
```

4 architectures × 2 Dockerfile variants = 8 per-arch images, combined into 2 multi-arch manifests.

### Simple Build-Push: [[analyzing-gitleaks|Gitleaks]]

The simplest multi-arch approach:

```yaml
# Gitleaks - release.yml
- name: Set up QEMU
  uses: docker/setup-qemu-action@8b122486cedac8393e77aa9734c3528886e4a1a8
- name: Set up Docker Buildx
  uses: docker/setup-buildx-action@dc7b9719a96d48369863986a06765841d7ea23f6
- name: Build and push Docker image
  uses: docker/build-push-action@e551b19e49efd4e98792db7592c17c09b89db8d8
  with:
    platforms: linux/amd64,linux/arm64
    push: true
    tags: ${{ steps.meta.outputs.tags }}
```

No manifest management needed — `build-push-action` handles it automatically when you specify multiple platforms.

### Nydus for Faster Pulls: [[analyzing-dep-scan|dep-scan]]

dep-scan goes beyond multi-arch by converting images to Nydus format for faster container pulls:

```yaml
# dep-scan - pythonpublish.yml
- name: Setup nydus
  run: |
    NYDUS_ARCHIVE="nydus-static-${NYDUS_VERSION}-linux-amd64.tgz"
    curl -LO "https://github.com/dragonflyoss/nydus/releases/download/${NYDUS_VERSION}/${NYDUS_ARCHIVE}"
    echo "${NYDUS_STATIC_AMD64_SHA256}  ${NYDUS_ARCHIVE}" | sha256sum -c -
    tar -xvf "${NYDUS_ARCHIVE}"
    chmod +x nydus-static/*
    mv nydus-static/* /usr/local/bin/

- name: nydusify
  run: |
    nydusify convert --oci --oci-ref \
      --source ghcr.io/owasp-dep-scan/depscan:master \
      --target ghcr.io/owasp-dep-scan/depscan:master-nydus \
      --prefetch-dir /opt/dep-scan
    nydusify check --target ghcr.io/owasp-dep-scan/depscan:master-nydus
```

Nydus uses a chunk-based image format that enables on-demand loading — container startup without downloading the entire image. The `--prefetch-dir` flag pre-loads critical files for fast startup. SHA256 checksum verification ensures the Nydus binary itself is trusted.

## .dockerignore Best Practices

A good `.dockerignore` prevents sensitive files and unnecessary build context from reaching the Docker daemon.

### Comprehensive Exclusion: [[analyzing-threat-dragon|Threat Dragon]]

```
*/coverage
dev-notes.md
dist/
*/dist/
.env
example.env
.git*
docs/.jekyll-cache
log/
*/node_modules
node_modules/
nyc_output/
*/nyc_output/
ThreatDragonModels/
utils/
.vscode/
*/.vscode/
*/dist-desktop/
sbom.*
*/sbom.*
# Generated files, not relevant in CI but in local development,
# these files will break the docker build if included
td.vue/src/service/schema/api_json/
```

Notable: excludes `.env` files, `.git*`, IDE configs, coverage output, and generated schema files that would break the build.

### Selective Negation: [[analyzing-traefik|Traefik]]

```
dist/
!dist/**/traefik
site/
vendor/
.idea/
```

The `!dist/**/traefik` line is key — it excludes the entire `dist/` directory but specifically keeps the compiled traefik binary. This prevents accidentally including intermediate build artifacts while keeping what's needed.

### Minimal but Effective: [[analyzing-checkov|Checkov]]

```
bin/
checkov/
docs/
integration_tests/
tests/
```

Just 5 lines — excludes compiled binaries, the package itself (installed via pip), documentation, and tests. Simple and effective.

## Health Checks

HEALTHCHECK instructions let the container runtime (Docker, Kubernetes) know if the application is actually working, not just running.

### Node.js Application Check: [[analyzing-threat-dragon|Threat Dragon]]

```dockerfile
HEALTHCHECK --interval=10s --timeout=2s --start-period=2s \
    CMD ["/nodejs/bin/node", "./td.server/dist/healthcheck.js"]
```

Uses a dedicated healthcheck script rather than a curl request — cleaner for Node.js applications and doesn't require curl in the image.

### HTTP Health Check: [[analyzing-zaproxy|ZAP]]

```dockerfile
ENV ZAP_PORT=8080
HEALTHCHECK CMD curl --silent --output /dev/null --fail http://localhost:$ZAP_PORT/ || exit 1
```

Standard HTTP health check. `--fail` makes curl return non-zero on HTTP errors.

### High-Tolerance Startup: [[analyzing-wazuh|Wazuh]]

```dockerfile
HEALTHCHECK --interval=5s --timeout=30s --start-period=5s --retries=35 \
    CMD /scripts/healthcheck.sh
```

35 retries × 5s intervals = 175 seconds of tolerance. Wazuh manager can take several minutes to fully initialize, so the high retry count prevents false-negative health checks during startup.

> [!warning] Missing Health Checks
> Many projects in our analysis lack HEALTHCHECK directives:
> - [[analyzing-opentofu|OpenTofu]] — CLI tool, reasonable to skip
> - [[analyzing-grype|Grype]] — CLI scanner, reasonable to skip
> - [[analyzing-traefik|Traefik]] — long-running proxy, should have one
> - [[analyzing-dep-scan|dep-scan]] — CLI scanner, reasonable to skip
>
> For long-running services, always include a HEALTHCHECK.

## Layer Caching and Build Optimization

### Buildx Cache with Workaround: [[analyzing-threat-dragon|Threat Dragon]]

```yaml
# Threat Dragon - pull_request.yaml
- name: Cache Docker layers
  uses: actions/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae # v5.0.5
  with:
    path: /tmp/.buildx-cache
    key: ${{ runner.os }}-buildx-${{ hashFiles('Dockerfile') }}
    restore-keys: |
      ${{ runner.os }}-buildx-
      ${{ runner.os }}-

- name: Build for amd64
  uses: docker/build-push-action@bcafcacb16a39f128d818304e6c9c0c18556b85f # v7.1.0
  with:
    cache-from: type=local,src=/tmp/.buildx-cache
    cache-to: type=local,dest=/tmp/.buildx-cache-new,mode=max

# Workaround for cache growing indefinitely
# https://github.com/docker/build-push-action/issues/252
- name: Move cache
  run: |
    rm -rf /tmp/.buildx-cache
    mv /tmp/.buildx-cache-new /tmp/.buildx-cache
```

The cache key includes the Dockerfile hash, so cache is invalidated when the Dockerfile changes. The `mode=max` flag stores all intermediate layers, not just the final ones. The move workaround prevents the cache from growing unboundedly — a known issue with buildx local cache.

## Vulnerability Exception Management

### The Gold Standard: [[analyzing-ocis|oCIS]]

oCIS's `.trivyignore` is the best example of vulnerability exception management in our analysis:

```
# Trivy vulnerability ignore file
# Add CVE IDs or file paths here to suppress known/accepted findings.
# See: https://aquasecurity.github.io/trivy/latest/docs/configuration/filtering/#trivyignore

# Alpine 3.23.3 ships vulnerable package versions; no fixed base image exists yet.
# Fix: bump FROM alpine:3.23.3 → alpine:3.23.4 once released, or add
#   RUN apk upgrade --no-cache
# to Dockerfile.linux.amd64 and Dockerfile.linux.arm64.
CVE-2026-28390  # libcrypto3/libssl3 3.5.5-r0 → fixed in 3.5.6-r0 (openssl DoS)
CVE-2026-22184  # zlib 1.3.1-r2 → fixed in 1.3.2-r0 (buffer overflow in untgz)
CVE-2026-40200  # musl/musl-utils 1.2.5-r21 → fixed in 1.2.5-r23 (stack-based arbitrary code execution / DoS)
```

Every exception includes:
1. **Context** — why the vulnerability exists (Alpine version)
2. **Remediation path** — exactly what to change (bump FROM line)
3. **Fix version** — the specific version that resolves the issue
4. **Impact** — what the vulnerability actually is

### Good With Room to Improve: [[analyzing-threat-dragon|Threat Dragon]]

```
# https://avd.aquasec.com/nvd/cve-2023-28155
# request version prior to 2.88.2
# this vulnerability is for the build system, not run time, so ignore
CVE-2023-28155

# ignore until Vue2 to Vue3 upgrade
CVE-2025-15284

# uuid is only used at runtime via v4; this issue affects v3/v5/v6 with caller buffers.
GHSA-w5hq-g745-h8pq
```

Good: links to the vulnerability, explains why it's safe to ignore. Missing: no fix version or expiry plan.

> [!tip] .trivyignore Best Practices
> Every exception should answer four questions:
> 1. **What** is the vulnerability? (link to CVE/GHSA)
> 2. **Why** is it safe to ignore? (build-only, no fix available, not applicable)
> 3. **When** will it be fixed? (next base image bump, upstream patch)
> 4. **Who** is responsible? (implicit: the team that added the exception)

## Putting It All Together — Reference Dockerfile

Synthesizing the best patterns from all 13 codebases into a single annotated reference Dockerfile for a Node.js application:

```dockerfile
# === VERSION PINNING (Threat Dragon pattern) ===
ARG NODE_VERSION=22
ARG ALPINE_VERSION=3.21

# === STAGE 1: Hardened base ===
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS base
# Apply security patches (Threat Dragon, Checkov pattern)
RUN apk -U upgrade && \
    apk add --no-cache dumb-init
# Create non-root user (oCIS pattern - explicit UID)
RUN addgroup -g 1001 -S appgroup && \
    adduser -S --ingroup appgroup --uid 1001 appuser
WORKDIR /app
RUN chown -R appuser:appgroup /app
USER 1001

# === STAGE 2: Build with dev dependencies ===
FROM base AS build
# Copy lockfile first for layer caching
COPY --chown=1001:1001 package-lock.json package.json ./
RUN npm clean-install
# Copy source and build
COPY --chown=1001:1001 . .
RUN npm run build
# Generate SBOM (Threat Dragon pattern)
RUN npm run make-sbom 2>/dev/null || \
    npx @cyclonedx/cyclonedx-npm --output-format json > sbom.json

# === STAGE 3: Production image ===
FROM base
# OCI labels (oCIS/Grype pattern)
LABEL org.opencontainers.image.title="my-app" \
      org.opencontainers.image.vendor="MyOrg" \
      org.opencontainers.image.description="My application" \
      org.opencontainers.image.source="https://github.com/myorg/my-app" \
      org.opencontainers.image.licenses="MIT"

# Copy SBOMs from build stage (Threat Dragon pattern)
COPY --chown=1001:1001 --from=build /app/sbom.json /app/sbom.json

# Install ONLY production dependencies
COPY --chown=1001:1001 package-lock.json package.json ./
RUN npm clean-install --omit dev --ignore-scripts

# Copy built artifacts only
COPY --chown=1001:1001 --from=build /app/dist ./dist

# Make runtime read-only (dep-scan pattern)
RUN chmod a-w -R /app/node_modules

# Health check (Threat Dragon + ZAP patterns)
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1))" \
    || exit 1

EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
```

This reference incorporates patterns from 6 different projects:
- **Version pinning** (Threat Dragon)
- **System updates** (Threat Dragon, Checkov)
- **Explicit non-root user with UID** (oCIS)
- **Multi-stage build** (Threat Dragon)
- **SBOM in build stage** (Threat Dragon)
- **OCI labels** (oCIS, Grype)
- **Read-only runtime** (dep-scan)
- **Production-only deps** (Threat Dragon)
- **Health check** (Threat Dragon, ZAP)
- **dumb-init for PID 1** (best practice for Node.js)

## Anti-Patterns to Avoid

Drawn from patterns observed (or notably absent) across the 13 codebases:

**1. Running as root**
OpenTofu, Traefik, Checkov, and Gitleaks all run as root in their standard Dockerfiles. For CLI tools executed ephemerally this is acceptable; for long-running services it's a critical gap.

**2. No HEALTHCHECK**
Only Threat Dragon, ZAP, and Wazuh include HEALTHCHECK directives. For any long-running service (Traefik, oCIS), this is a significant omission.

**3. `apt-get upgrade` without pinning**
Checkov and Threat Dragon run `apk -U upgrade` / `apt-get -y upgrade` which makes builds non-reproducible — different runs may get different package versions. Prefer pinning specific versions.

**4. Missing .dockerignore**
Wazuh has no .dockerignore file, meaning the entire repo context (including test data, scripts, configs) is sent to the Docker daemon on every build.

**5. `COPY . .` instead of specific files**
Several Dockerfiles copy the entire context first, then build. The Threat Dragon pattern of copying lockfiles first, then source, enables Docker layer caching to skip dependency installation when only source files change.

**6. Missing OCI labels**
oCIS and Grype are exemplary with OCI labels. Most other projects omit them, losing build provenance metadata.

**7. No vulnerability scanning in CI**
Only Threat Dragon and oCIS run container image scans as CI gates. Most projects scan source code but not the actual images they ship.

**8. Secrets in environment variables**
Avoid `ENV DB_PASSWORD=...` in Dockerfiles. Use Docker secrets (`--mount=type=secret`) as ZAP does, or runtime secret injection.

**9. `FROM node:latest` or unpinned tags**
Every project in our analysis pins base image versions. Using `:latest` or untagged images makes builds unreproducible and can introduce unexpected vulnerabilities.

**10. Single-stage builds for complex apps**
Checkov and dep-scan use single-stage builds despite having complex build requirements. Multi-stage builds are almost always worth the added Dockerfile complexity.

## Related

- [[best-cicd-implementations-reference-guide]] — CI/CD pipeline patterns from the same codebases
- [[analyzing-minimal-container-images]] — Deep dive on distroless and scratch-based images
- [[analyzing-trivy]] — Trivy vulnerability scanner analysis
