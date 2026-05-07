---
title: "Analyzing Smallstep Certificates"
date: 2026-05-07
type: codebase-analysis
status: complete
source: https://github.com/smallstep/certificates
tags: [go, certificate-authority, x509, ssh, acme, pki, tls, zero-trust, open-source]
---

# Analyzing Smallstep Certificates

> **Source:** [smallstep/certificates](https://github.com/smallstep/certificates) @ [`10075d9`](https://github.com/smallstep/certificates/commit/10075d94afe8818835a5ce8a444dbf6c02ac5d)

## How It Works

`step-ca` is a private certificate authority that issues both X.509 (TLS) and SSH certificates. It operates as an online CA — meaning it holds the intermediate signing key and responds to real-time issuance requests — rather than an offline root. The mental model is: a single binary starts an HTTPS server that accepts certificate signing requests authenticated via **provisioners** (OIDC tokens, JWK tokens, cloud identity documents, ACME challenges, X5C client certs, SCEP, or Nebula certs). Each provisioner type defines a trust anchor and authorization flow. The CA validates the token, applies policy/constraint checks, modifies the certificate via a chain of `SignOption` functions, signs it via a pluggable Certificate Authority Service (CAS), and returns the signed certificate chain.

The system is designed around **short-lived certificates** with passive revocation — certificates are issued with tight validity windows (default 24h for TLS) and expected to be renewed before expiry. Active revocation via CRLs is supported but presented as an add-on (and notably gated in the commercial product comparison). SSH certificates follow the same pattern: user and host certs are signed by separate CA keys.

Three deployment modes exist: standalone (config file on disk), embedded (used as a Go library via `authority.NewEmbedded`), and **linked RA** (Registration Authority) where `step-ca` connects to Smallstep's hosted Certificate Manager over gRPC via `linkedca.MajordomoClient`. The linked mode pulls its configuration from the remote service and delegates actual signing to a parent CA.

## Architecture

The codebase is organized by **concern layers** — not by feature — which keeps coupling manageable for a ~94k-line Go project.

```
cmd/step-ca/          ← Single entry point (binary)
commands/             ← CLI action wiring (start, export, onboard)
ca/                   ← HTTP server assembly, TLS config, router composition
api/                  ← REST handlers for the CA protocol (sign, renew, revoke, roots)
authority/            ← Core business logic: the Authority struct is the central brain
  provisioner/        ← 14+ provisioner types (OIDC, JWK, ACME, AWS, GCP, Azure, X5C, SCEP, ...)
  admin/              ← Admin API for managing provisioners, admins, policies
  config/             ← Config file parsing and validation
  policy/             ← Name policy engine (permitted/denied DNS, IP, email, URI, principals)
  internal/constraints/ ← X.509 name constraints enforcement from intermediate certs
acme/                 ← Full ACMEv2 implementation (RFC 8555) with challenge validation
  api/                ← ACME HTTP handlers
  db/                 ← ACME-specific storage (accounts, orders, challenges, authorizations)
cas/                  ← Certificate Authority Service abstraction (softcas, cloudcas, stepcas, vaultcas)
db/                   ← Authority database layer (certificate storage, revocation, CRL)
scep/                 ← SCEP protocol support for legacy device enrollment
policy/               ← Top-level policy engine (wraps authority/policy)
webhook/              ← Webhook types for enriching/authorizing certificate requests
pki/                  ← PKI initialization utilities (used by `step ca init`)
templates/            ← Certificate template rendering (Go templates with Sprig)
```

Data flows through the system as follows: **HTTP request** → **chi router** → **API handler** (in `api/` or `acme/api/`) → extracts **Authority** from `context.Context` → calls `Authorize()` which parses the JWT token, identifies the provisioner, and returns `SignOption` modifiers → calls `SignWithContext()` which applies those options (SANs, lifetime, templates, constraints, policy) → delegates to the **CAS** interface for actual signing → stores certificate in **DB**.

## The Spine

### Entry point and startup

```
cmd/step-ca/main.go → commands/app.go → ca/ca.go:New() → authority.New()
```

The CLI uses `urfave/cli`. The `start` action in `commands/app.go` loads the JSON config from `$STEPPATH/config/ca.json`, sets up passwords, and calls `ca.New()`. The `ca` package assembles the full HTTP server:

1. Creates the `authority.Authority` (the core brain)
2. Builds a `chi.Router` and mounts routes:
   - `/` and `/1.0` — CA REST API (sign, renew, revoke, roots, CRL)
   - `/acme` and `/2.0/acme` — ACME protocol (if DB is configured)
   - `/admin` — Admin API (if `EnableAdmin` is set)
   - `/scep` — SCEP endpoints (on both secure and insecure mux)
3. Wraps with middleware: request ID, logging (JSON or text), monitoring (Prometheus/NewRelic)
4. Starts up to three servers: HTTPS, HTTP (for SCEP/CRL), and metrics

### Certificate issuance lifecycle

The `Sign` handler in `api/sign.go` is the canonical flow:

```go
// 1. Parse CSR and one-time token from request body
// 2. Set method context: provisioner.SignMethod
// 3. a.Authorize(ctx, ott) → validates token, returns []SignOption
// 4. a.SignWithContext(ctx, cr, opts, signOpts...) → modifies + signs certificate
```

`Authority.Authorize()` in `authority/authorize.go` parses the JWS token, identifies the provisioner by the `iss` claim, calls `provisioner.AuthorizeSign()`, then wraps the returned options with constraint/policy enforcement. The actual X.509 certificate construction happens in `authority/tls.go` where a chain of `CertificateModifierFunc` and `CertificateEnforcerFunc` values apply defaults (ASN1 DN), templates, key usage, SANs, validity windows, and constraints.

### Provisioner system

The provisioner interface is the key extensibility point. Each type implements:

```go
type Interface interface {
    GetID() string
    GetName() string
    GetType() Type
    Init(config Config) error
    AuthorizeSign(ctx, token) ([]SignOption, error)
    AuthorizeRevoke(ctx, token) error
    AuthorizeRenew(ctx, cert) error
    AuthorizeSSHSign(ctx, token) ([]SignOption, error)
    // ... SSH variants
}
```

Provisioners are stored in a `provisioner.Collection` (a type-safe wrapper around a map keyed by ID). The `Method` enum (Sign, Renew, Revoke, SSHSign, etc.) is threaded through `context.Context` so provisioners can make method-specific authorization decisions. Webhook provisioners can call external HTTP services during authorization for both enriching (adding SANs) and authorizing (allow/deny) decisions.

## Key Patterns

**Functional options everywhere.** Both `ca.New()` and `authority.New()` accept `...Option` funcs — this is the dominant configuration pattern. The `errs` package also uses options for building API error responses.

**Context as dependency injection.** The Authority, database, admin database, ACME DB, and SCEP authority are all stored in `context.Context` using unexported key types. Handlers retrieve them with `MustFromContext()` (panics on missing) or `FromContext()` (returns bool). This is idiomatic Go but makes the implicit dependencies between layers harder to trace statically.

**Interface-driven pluggability at boundaries.** The CAS layer (`cas/apiv1.CertificateAuthorityService`) abstracts the actual signing operation. The DB layer (`db.AuthDB`) abstracts storage. The KMS layer (`go.step.sm/crypto/kms`) abstracts key management. Each has multiple implementations registered via `init()` side effects — the CAS registry pattern in `cas/apiv1/registry.go` is notable.

**SignOption chain pattern.** Certificate modifications are expressed as a slice of `SignOption` interfaces that are applied sequentially. This includes modifiers (add SANs, set lifetime), validators (check constraints, check policy), and enforcers (reject bad key usage). The separation between provisioner-returned options and authority-injected options (constraints, policy, defaults) is clean.

**Admin vs standalone mode.** When `EnableAdmin` is true, provisioners and admins are loaded from the database rather than the config file, enabling runtime management via the `/admin` API. The `linkedCaClient` implements `admin.DB` over gRPC, bridging local and managed deployments.

## Non-Obvious Details

> [!warning] The `Authority` struct is a god object. At 1051 lines, `authority.go` alone holds X.509 state, SSH state, SCEP state, CRL state, policy engines, constraint engines, webhook clients, custom function hooks, and admin state. The `init()` method is ~300 lines and orchestrates database, KMS, CAS, linked CA, provisioners, admins, SSH keys, CRL, and policy initialization in sequence. Refactoring this into sub-components would significantly improve testability.

**Token parsing is intentionally unsafe.** In `authorize.go`, `UnsafeClaimsWithoutVerification()` parses the JWT without signature verification first, extracting the `iss` claim to look up the provisioner, then verifies with the provisioner's key. This is correct (you need the key to verify), but the `Unsafe` naming is a deliberate signal to reviewers.

**ACME requires a database but the CA doesn't.** ACME state (accounts, orders, challenges) needs persistent storage, but the core CA can run with a barebones in-memory DB for simple token-based issuance. The config silently degrades: if no DB is configured and ACME provisioners exist, a warning is logged and ACME is disabled.

**BadgerDB v1 and v2 are both dependencies.** The `go.mod` lists both `dgraph-io/badger` and `dgraph-io/badger/v2`. The DB config's `type` field selects between `badger`, `badgerv2`, `bbolt`, `mysql`, and `postgresql` — all behind the `smallstep/nosql` abstraction.

**CRL generation has a TODO in production code.** The DB stores a single CRL under a hardcoded key with a comment: `"is this acceptable? probably not...."` This suggests CRL support, while functional, was not designed for multi-CA scenarios.

**The linked CA client auto-enables admin mode.** If a linked CA token is present, `a.config.AuthorityConfig.EnableAdmin` is force-set to `true`. This means the linked RA path always activates the admin API, which has significant security implications if the token is accidentally supplied.

**Graceful reload support exists.** The `server.Server` supports hot-reloading via `reloadCh` and `shutdownCh` channels. The `ca.StopReloaderHandler` goroutine watches for `SIGHUP` and can reinitialize the authority without dropping connections.

## Assessment

### Strengths

- **Clean interface boundaries.** The CAS, KMS, DB, and provisioner abstractions make it straightforward to add new backends (HSMs, cloud KMS, external CAs) without touching core logic.
- **Comprehensive protocol support.** Supporting ACMEv2, SCEP, OIDC, and cloud instance identity in a single binary covers the vast majority of enterprise PKI use cases.
- **Short-lived certificate design.** The default 24-hour TLS cert lifetime with passive revocation is a sound security posture that reduces the blast radius of compromised certificates.
- **Embedded mode.** `authority.NewEmbedded()` allows using step-ca as a library, which is valuable for testing and integration.

### Concerns

- **The Authority struct's surface area.** With 30+ fields spanning X.509, SSH, SCEP, CRL, policy, constraints, webhooks, and admin functions, it's difficult to reason about invariants. The `sync.RWMutex` for admin operations suggests concurrent access patterns that could have subtle races.
- **Error handling asymmetry.** The `errs` package builds structured HTTP errors, but the `authority` package mixes `errs.Error` with `pkg/errors` wrapped errors. Policy and constraint errors implement `As(*errs.Error)` to bridge this gap, which is clever but fragile — any new error type that needs HTTP status mapping must remember to implement `As()`.
- **No rate limiting or abuse protection.** The API handlers don't include built-in rate limiting. For an internet-facing CA (especially with ACME), this is a operational concern that must be addressed at the infrastructure level.
- **Configuration complexity.** The `ca.json` config file supports KMS options, CAS options, multiple DB backends, template data, CRL settings, monitoring, SSH config, and policy — all flat in one JSON structure. Misconfiguration is easy.

### Recommendations

For operators considering `step-ca`:
- Start with the default `badgerv2` backend for single-instance deployments. Use PostgreSQL only if you need ACME at scale or multi-replica HA.
- Pin certificate lifetimes aggressively (5 minutes to 1 hour for machine certs). The renewal automation via ACME or the step CLI handles this well.
- Enable the CRL endpoint and configure `insecureAddress` only if you need legacy client revocation checking.
- Use the embedded Go library mode for integration testing rather than spawning the binary.

## Related

- [[analyzing-gravitational-teleport]] — Teleport also issues SSH and X.509 certificates but operates as a full access proxy rather than a standalone CA. The two can complement each other: step-ca for infrastructure PKI, Teleport for SSH access management.
