---
title: "Analyzing ownCloud Infinite Scale (ocis)"
date: 2025-05-10
type: codebase-analysis
status: complete
source: https://github.com/owncloud/ocis
tags: [owncloud, file-sync, collaboration, go, microservices, self-hosted, cloud-storage]
---

## Overview

ownCloud Infinite Scale (oCIS) is the next-generation file synchronization and collaboration platform from ownCloud, completely rewritten in Go as a successor to the PHP-based ownCloud Server. It is designed as a self-hosted alternative to commercial cloud storage services, competing directly with [[analyzing-nextcloud-server]] in the open-source file sync and share space.

At its core, oCIS is a single-binary Go application that contains **42 distinct microservices**, orchestrated via a supervisor pattern using [thejerf/suture](https://github.com/thejerf/suture). The architecture is based on the [CS3 APIs](https://github.com/cs3org/cs3apis/) — a vendor-neutral, gRPC-based protocol for cloud storage — with the storage layer powered by [Reva](https://github.com/cs3org/reva), the reference implementation of the CS3 standard.

The project is licensed under Apache 2.0 and maintained by ownCloud GmbH. It ships as a single Docker container or binary that can scale from a Raspberry Pi to a full Kubernetes cluster by configuring which services run and how they communicate. The default deployment requires no external database or identity provider — everything is embedded.

**Key facts:**

- **Language:** Go 1.25 (module path: `github.com/owncloud/ocis/v2`)
- **Lines of Go code:** ~178,000 (excluding vendored dependencies)
- **Go files:** ~1,381 (excluding vendor/)
- **Services:** 42 microservices across authentication, storage, sharing, search, policies, and more
- **Transport:** gRPC for inter-service communication, HTTP/REST for client-facing APIs
- **Commit analyzed:** `3efec50c5bad0eadbd40793142c05e5bd6944118`

## Key Findings

### Architecture

oCIS follows a **monorepo microservices architecture**. All 42 services live under `services/` in the repository, each with its own package structure, configuration, and command entry point. The main binary (`ocis/cmd/ocis/main.go`) delegates to a runtime system that starts all services as supervised goroutines via the `suture` library.

The service lifecycle is managed in `ocis/pkg/runtime/service/service.go`, which implements a priority-based startup system:

- **Priority 0:** NATS message broker (must start first)
- **Priority 1:** Gateway service (must start before Reva-dependent services)
- **Priority 2:** Reserved (currently empty)
- **Priority 3:** All remaining services (graph, proxy, search, sharing, storage, etc.)
- **Priority 4:** Frontend, audit, collaboration, OCM, and auth-bearer services

Each service is registered as a `suture.Service` and runs in its own goroutine within the single process. When deployed in distributed mode, services can be run independently by setting `OCIS_RUN_SERVICES` to select specific services per instance.

The service registration pattern is consistent across all services:

```go
// From ocis/pkg/runtime/service/service.go
reg(3, opts.Config.Graph.Service.Name, func(ctx context.Context, cfg *ociscfg.Config) error {
    cfg.Graph.Context = ctx
    cfg.Graph.Commons = cfg.Commons
    return runServerCommand(ctx, graph.Server(cfg.Graph))
})
```

### Complete Service Inventory

The 42 services listed in `Makefile` (variable `OCIS_MODULES`) are:

| Category | Services |
|----------|----------|
| **Authentication** | auth-app, auth-basic, auth-bearer, auth-machine, auth-service |
| **Storage** | storage-system, storage-users, storage-publiclink, storage-shares |
| **Core API** | gateway, graph, frontend, ocdav, ocs, webdav, proxy |
| **Identity** | idm (identity management), idp (identity provider), users, groups |
| **Collaboration** | sharing, collaboration, app-provider, app-registry |
| **Observability** | audit, activitylog, eventhistory, clientlog, userlog |
| **Infrastructure** | nats, postprocessing, thumbnails, search, policies |
| **Communication** | notifications, sse, invitations, webfinger |
| **Federation** | ocm (Open Cloud Mesh) |
| **Security** | antivirus |
| **Settings** | settings |
| **UI** | web (embedded web frontend) |

Each service follows an identical directory layout:

```
services/<name>/
  cmd/<name>/main.go          # Standalone entry point
  pkg/command/server.go       # Server command (used by runtime)
  pkg/config/
    config.go                 # Service-specific config struct
    defaults/defaultconfig.go # Default values with port assignments
  pkg/service/v0/             # Business logic
  pkg/server/grpc/            # gRPC server
  pkg/server/http/            # HTTP server
  pkg/metrics/                # Prometheus metrics
```

### Tech Stack

**Core framework:**
- **Go 1.25** — the module specifies `go 1.25.9` in `go.mod`
- **go-micro v4** — microservices framework providing service registry, gRPC client/server, and HTTP server plugins
- **suture v4** — supervisor tree for process management within the single binary
- **urfave/cli v2** — command-line interface framework

**Communication:**
- **gRPC** (`google.golang.org/grpc v1.80.0`) — primary inter-service RPC
- **NATS** (`github.com/nats-io/nats.go v1.49.0`) — event bus and service registry
- **HTTP/REST** — client-facing APIs via chi router (`github.com/go-chi/chi/v5`)

**Storage:**
- **Reva v2** (`github.com/owncloud/reva/v2`) — the CS3 reference implementation providing storage drivers
- **BoltDB** (`go.etcd.io/bbolt v1.4.3`) — embedded key-value store for metadata
- **Bleve** (`github.com/blevesearch/bleve/v2`) — full-text search engine
- **POSIX filesystem** — default storage driver ("ocis" driver stores blobs + metadata on disk)
- **S3-compatible** — "s3ng" driver stores blobs in S3 while keeping metadata on POSIX
- **Ceph** — via `github.com/ceph/go-ceph` (indirect dependency)

**Identity and authentication:**
- **LibreGraph Connect** (`github.com/libregraph/lico v0.66.0`) — embedded OpenID Connect provider
- **LibreGraph IDM** (`github.com/libregraph/idm v0.5.0`) — embedded identity management
- **LDAP** (`github.com/go-ldap/ldap/v3`) — user/group backend
- **Keycloak** (`github.com/Nerzal/gocloak/v13`) — external IdP integration
- **OpenID Connect** (`github.com/coreos/go-oidc/v3`) — standard OIDC client
- **JWT** (`github.com/golang-jwt/jwt/v5`) — token handling

**Observability:**
- **OpenTelemetry** (`go.opentelemetry.io/otel v1.43.0`) — distributed tracing
- **Prometheus** (`github.com/prometheus/client_golang`) — metrics export
- **Zerolog** (`github.com/rs/zerolog`) — structured logging

**Security:**
- **Open Policy Agent** (`github.com/open-policy-agent/opa v1.12.3`) — policy engine for access control
- **ClamAV** and **ICAP** — antivirus scanning integration
- **SAML** (`github.com/crewjam/saml`) — SAML-based SSO support

**Web frontend:**
- The web UI is a separate build artifact (ownCloud Web, `github.com/owncloud/web`), embedded at build time

### Storage Architecture

The storage layer is the most architecturally significant part of oCIS. It separates storage into four distinct services:

1. **storage-system** — System-level storage (configuration, metadata)
2. **storage-users** — User file storage, supporting multiple drivers:
   - `ocis` driver: All data on POSIX-compliant filesystem (default)
   - `s3ng` driver: Metadata on POSIX, blobs in S3-compatible storage
   - `owncloudsql` driver: Legacy ownCloud Server migration path
3. **storage-publiclink** — Public link shares
4. **storage-shares** — Received shares from other users/servers

The storage configuration in `services/storage-users/pkg/config/config.go` exposes detailed settings:

```go
Driver string `yaml:"driver" env:"STORAGE_USERS_DRIVER" desc:"...Supported values are: 'ocis', 's3ng' and 'owncloudsql'."`
```

File uploads use the [TUS protocol](https://tus.io/) (`github.com/tus/tusd/v2`) for resumable uploads, with post-processing pipelines supporting virus scanning, content extraction, and thumbnail generation.

The backup system (`ocis/pkg/command/backup.go`) supports consistency checks across both POSIX and S3 blobstores, enabling point-in-time backup verification.

### Authentication and Authorization

oCIS implements a multi-layered authentication system:

- **IDP service** — Embedded OpenID Connect provider using LibreGraph Connect, listening on port 9130 by default. Supports PS256 signing, configurable token lifetimes (5-minute access tokens, 30-day refresh tokens).
- **IDM service** — Identity management using LibreGraph IDM with LDAP backend
- **Five auth services** handle different authentication flows:
  - `auth-basic` — username/password via LDAP bind
  - `auth-bearer` — JWT/OIDC token validation
  - `auth-machine` — service-to-service authentication via API keys
  - `auth-app` — application-specific token handling
  - `auth-service` — internal service authentication

The proxy service (`services/proxy/`) acts as the main entry point, handling OIDC token verification, role mapping from OIDC claims, and auto-provisioning of accounts. Role assignment maps OIDC claims to oCIS roles:

```go
// From services/proxy/pkg/config/defaults/defaultconfig.go
RolesMap: []config.RoleMapping{
    {RoleName: "admin", ClaimValue: "ocisAdmin"},
    {RoleName: "spaceadmin", ClaimValue: "ocisSpaceAdmin"},
    {RoleName: "user", ClaimValue: "ocisUser"},
    {RoleName: "user-light", ClaimValue: "ocisGuest"},
},
```

External identity providers like [[analyzing-kanidm]] or [[analyzing-lldap]] can replace the embedded IDP through OIDC integration.

### Configuration System

oCIS uses a layered configuration system defined in `ocis-pkg/config/`:

1. **Defaults** — hardcoded in each service's `defaults/defaultconfig.go`
2. **Config file** — YAML at `~/.ocis/config/ocis.yaml` (or `/etc/ocis/`)
3. **Environment variables** — every config option has an `env` tag (e.g., `STORAGE_USERS_DRIVER`)
4. **CLI flags** — command-level overrides

The base paths default to the user's home directory (`~/.ocis/` for data, `~/.ocis/config/` for config), configurable via `OCIS_BASE_DATA_PATH` and `OCIS_CONFIG_DIR`. Production deployments typically override these to `/var/lib/ocis` and `/etc/ocis`.

Each service has its own port range (e.g., proxy on 9200, gateway on 9142, graph on 9120, search on 9220), with debug servers on separate ports for metrics and profiling.

### Deployment Model

oCIS supports three deployment modes:

1. **Single binary** — `ocis server` starts all 42 services in one process. Suitable for small deployments, testing, and homelab use.

2. **Docker container** — The official `owncloud/ocis` image (Alpine-based, multi-arch: amd64 and arm64) runs the single binary. The quickstart requires only two `docker run` commands.

3. **Distributed/ Kubernetes** — Individual services can be selected via `OCIS_RUN_SERVICES`, enabling horizontal scaling of specific components. The NATS event bus and shared storage provide the coordination layer.

The Dockerfile at `ocis/docker/Dockerfile.linux.amd64` shows a production-grade container:
- Runs as non-root user (UID 1000)
- Multi-architecture support (separate Dockerfiles for amd64/arm64)
- Debug variants available
- OCI-compliant image labels
- Minimal Alpine base with only required system packages

The release pipeline (`.github/workflows/release.yml`) builds production releases for tags matching `5.0`, `7`, and `8` (semver major tracks), with a rolling release channel (`owncloud/ocis-rolling`).

### Graph API and Microsoft Graph Compatibility

The `graph` service (`services/graph/`) is the largest service at 123 Go files. It implements a subset of the **Microsoft Graph API** via the `owncloud/libre-graph-api-go` client library, enabling:

- User and group management (CRUD operations)
- Drive and file operations (list, create, delete, copy, move)
- Permission and sharing management
- Education APIs (schools, classes, users)
- Personal data export (GDPR compliance)
- Tag management

The Graph API serves as the primary REST API for the web frontend and programmatic access, providing a modern alternative to the WebDAV and OCS APIs.

### Search and Content Processing

The search service (`services/search/`) uses [Bleve](https://bleve.org/) as its default full-text search engine, with configurable content extractors:

- `basic` — filename-based indexing only
- `tika` — Apache Tika integration for full-text extraction from documents (PDFs, Office files, etc.)

Search events are consumed from the NATS event bus, enabling asynchronous index updates as files are created or modified.

### Security Features

oCIS incorporates several security layers:

- **Antivirus** (`services/antivirus/`) — Integrates ClamAV and ICAP-compliant scanners with configurable infected file handling (delete or reject). Runs as a post-processing step on file upload.
- **Policy engine** (`services/policies/`) — Uses Open Policy Agent (OPA) for fine-grained access control policies with a 10-second evaluation timeout.
- **TLS everywhere** — Inter-service communication defaults to TLS with per-service certificates.
- **Pre-signed URLs** — Time-limited, signed URLs for file downloads with configurable TTL (12 hours default).
- **Vulnerability scanning** — `govulncheck` runs in CI to detect known Go vulnerabilities.

### Testing

The test infrastructure is substantial:

- **129 test files** across the services directory (unit tests using `testify` and `ginkgo/gomega`)
- **Acceptance tests** (`.github/workflows/acceptance-tests.yml`) — a comprehensive 505-line workflow that:
  - Runs PHP code style checks (legacy API test tooling)
  - Performs Gherkin linting on test scenarios
  - Runs `govulncheck` for vulnerability detection
  - Executes API acceptance tests against a live oCIS instance
- **CI pipeline** — Dual CI system: Drone CI (`.drone.star`, a 4,091-line Starlark configuration) and GitHub Actions
- **k6 load testing** (`.github/workflows/k6-load-test.yml`) — performance regression testing
- **SonarCloud integration** — code quality and coverage tracking
- **Codacy** — additional code analysis

The Drone CI configuration is particularly extensive, handling builds, Docker image publishing, acceptance tests against multiple storage backends, WOPI integration tests, Kubernetes deployment tests (k3d), and release automation.

### Code Quality Observations

**Strengths:**
- Consistent project structure across all 42 services — the `pkg/command/`, `pkg/config/`, `pkg/service/` pattern is uniform
- Every service has its own `Makefile` with standardized targets
- Structured logging throughout using Zerolog
- Prometheus metrics exported by every service
- OpenTelemetry tracing integrated across gRPC and HTTP handlers
- Each service exposes a debug endpoint for pprof and zpages
- Configuration is thoroughly documented with `desc` and `introductionVersion` tags

**Patterns worth noting:**
- The `register.AddCommand()` pattern in `ocis/pkg/register/` provides clean CLI command composition
- The `serviceFuncMap` in the runtime enables dependency-ordered service startup
- The shared `ocis-pkg/` module provides common utilities (config, logging, tracing, LDAP, OIDC) that all services import, reducing code duplication

### Protobuf and Code Generation

oCIS defines its own protobuf services in `protogen/proto/ocis/` for:
- Event history, policies, search, settings, store, and thumbnails services

Generated Go code lives in `protogen/gen/ocis/`. The codebase uses `make generate` to run all code generation steps including protobuf, mocks, and configuration documentation.

### Internationalization

The `L10N_MODULES` variable in the Makefile identifies five services with translation support:
- `services/activitylog`, `services/graph`, `services/notifications`, `services/userlog`, `services/settings`

Translations are managed via Transifex, with automated sync in `.github/workflows/translation-sync.yml`.

## Assessment

### Strengths

1. **Architectural maturity.** The microservices design is well-executed for a single-binary distribution. The priority-based startup system, supervisor pattern, and consistent service structure demonstrate thoughtful engineering. The ability to run all services in one process for simplicity or distribute them for scale is a genuine advantage over monolithic alternatives.

2. **Batteries-included deployment.** The embedded NATS broker, LibreGraph identity provider, LDAP server, and BoltDB storage mean oCIS can be productive with zero external dependencies. This dramatically lowers the barrier to entry compared to [[analyzing-nextcloud-server]], which typically requires MySQL/MariaDB, Redis, and often an external identity provider.

3. **Standards-based APIs.** The CS3 API foundation, WebDAV support, and Microsoft Graph API compatibility give oCIS strong interoperability. Clients exist for web, desktop (ownCloud Client), Android, and iOS, all using open protocols.

4. **Security depth.** Multiple authentication mechanisms, OPA-based policy engine, antivirus integration, TLS by default, and pre-signed URLs demonstrate a security-conscious design. The `govulncheck` CI step catches known vulnerabilities early.

5. **Multi-architecture support.** Docker images for both amd64 and arm64, with explicit support for Raspberry Pi deployments, broadens the hardware compatibility.

6. **Comprehensive CI/CD.** The 4,000+ line Drone CI configuration and multi-workflow GitHub Actions pipeline cover builds, tests across multiple backends (S3, POSIX), integration tests with Collabora and OnlyOffice, WOPI validation, Kubernetes deployment tests, and performance regression testing.

### Concerns

1. **Complexity ceiling.** With 42 services, each with its own configuration, gRPC ports, HTTP ports, and debug ports, the operational complexity for troubleshooting is significant. Even in single-binary mode, understanding which service is failing requires familiarity with the architecture. The port assignments alone span from 9120 to 9277.

2. **Vendor dependency on ownCloud GmbH.** The project is primarily developed by ownCloud employees (as evidenced by CODEOWNERS). While open source under Apache 2.0, the development velocity and direction are heavily corporate-driven. Community contributions are welcome but the project is not community-governed.

3. **Shallow git history.** The analyzed clone contains only a single commit, which may indicate a shallow clone or a packaging issue. This makes it difficult to assess long-term commit patterns and contributor diversity from the local data alone.

4. **Reva dependency weight.** The `github.com/owncloud/reva/v2` dependency is a massive library that provides the core storage, events, and CS3 API functionality. This creates a tight coupling between oCIS and Reva's release cycle, and understanding oCIS requires understanding Reva's architecture as well.

5. **PHP tooling in CI.** The acceptance test framework uses PHP (code sniffer, codestyle), which adds an unusual dependency for a Go project. This is likely a legacy artifact from the ownCloud Server testing infrastructure.

6. **Limited external documentation for contributors.** While admin documentation exists at `doc.owncloud.com`, the development documentation is hosted separately at `owncloud.dev`. The repository itself lacks inline architecture documentation beyond README.md.

### Recommendations

1. **For self-hosters:** oCIS is an excellent choice for users who want a modern, Go-based file collaboration platform with minimal external dependencies. The single-binary deployment is straightforward, and the Docker quickstart can have a functional instance running in minutes. Pair with [[analyzing-traefik]] or [[analyzing-envoy]] as a reverse proxy for TLS termination.

2. **For identity integration:** Replace the embedded IDP with [[analyzing-kanidm]] or [[analyzing-lldap]] for production deployments requiring centralized identity management across multiple services.

3. **For production deployments:** Use S3-compatible storage (MinIO, Ceph) for the blobstore to enable horizontal scaling of the storage layer. Deploy NATS as a separate cluster for high availability. Use the `OCIS_RUN_SERVICES` / `OCIS_EXCLUDE_RUN_SERVICES` mechanism to distribute services across multiple instances.

4. **For evaluators comparing with Nextcloud:** oCIS offers superior architectural scalability (true microservices vs. monolithic PHP) and lower resource requirements for small deployments. However, [[analyzing-nextcloud-server]] has a vastly larger plugin ecosystem and community. oCIS is the better engineering choice; Nextcloud is the better ecosystem choice.

## Related

- [[analyzing-nextcloud-server]] — Primary competitor in self-hosted file sync and share; PHP-based monolith with extensive plugin ecosystem
- [[analyzing-envoy]] — Infrastructure proxy that can be used as an alternative to the built-in oCIS proxy for advanced load balancing
- [[analyzing-kanidm]] — Identity management system that can replace the embedded LibreGraph IDM for centralized authentication
- [[analyzing-lldap]] — Lightweight LDAP server that can serve as an alternative user backend to the embedded LDAP
- [[analyzing-traefik]] — Reverse proxy commonly used in self-hosted deployments for TLS termination and routing to oCIS
