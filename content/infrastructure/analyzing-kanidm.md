---
title: "Analyzing KanidM"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/kanidm/kanidm
tags: [rust, identity-management, ldap, oauth, openid-connect, auth, kanidm, concread]
---

# Analyzing KanidM

> **Source:** [kanidm/kanidm](https://github.com/kanidm/kanidm) @ [`a44f9cf9`](https://github.com/kanidm/kanidm/commit/a44f9cf9118f043c50e9f8008bc6ed58056239b4)

## How It Works

KanidM is a self-contained identity management platform written entirely in Rust, designed to replace a stack of separate components (LDAP server, OIDC provider, RADIUS, PAM/NSS integration) with a single coherent system. It stores identities as attribute-value entries in an embedded, custom key-value store backed by SQLite, and exposes them through multiple protocols — HTTPS REST API, LDAP, and RADIUS — so existing applications and operating systems can authenticate against it without modification.

The core mental model is that everything in KanidM is an **Entry**: a set of attribute-value assertions with a UUID. Entries are validated against a **Schema** that defines which attributes exist, what syntax they accept, and which object classes they belong to. Access is controlled by **Access Controls** that evaluate a client's identity and the requested operation against a set of rules before granting or denying the action. Authentication itself is layered: the server can validate passwords, TOTP codes, WebAuthn/Passkey credentials, and backup codes in arbitrary combinations to satisfy an account's credential policy.

## Architecture

The workspace is organized as a Rust monorepo with several major subsystems:

```
kanidm/
├── server/core/          # HTTP server, actors, LDAP gateway, RADIUS
├── server/lib/           # Core server library (query engine, IDM, schema, backend)
├── libs/                 # Shared utilities: client, crypto, sketching (logging)
├── proto/                # Protobuf/serde types shared across boundary
├── unix_integration/     # PAM and NSS modules for Linux/Unix clients
└── tools/cli/            # kanidm administrative CLI
```

The **server/lib** crate is the heart of the system and is organized into several layers:

- **`be/`** — The Backend. A custom JSON-document KV store on top of SQLite. Uses **concread** (a Rust crate maintained alongside KanidM) for lock-free copy-on-write data structures, and **idlset** for efficient ID list intersection during queries.
- **`entry/`** — Entry types with a **type-state pattern** (`EntryInit`, `EntryInvalid`, `EntrySealed`, `EntryValid`, etc.) to enforce lifecycle correctness at compile time.
- **`schema/`** — Schema definition and validation, stored as entries in the database itself. The schema is loaded at startup and held in a `CowCell` for lock-free reads during transactions.
- **`filter/`** — The query language. Filters are compiled, resolved, and planned into index-aware execution paths.
- **`idm/`** — Identity management logic: authentication sessions, OAuth2/OIDC, LDAP mapping, account/group operations, SCIM, and credential management.
- **`server/`** — The `QueryServer` that coordinates transactions, manages access controls, and provides the read/write API used by actors.
- **`plugins/`** — A set of hooks that run on create/modify operations (e.g., `memberOf` computation, unique attribute enforcement, password badlist checking).
- **`repl/`** — Change-vector-based two-node replication.

The **server/core** crate owns the HTTP frontend (Axum), the actor system (`QueryServerReadV1` / `QueryServerWriteV1`), LDAP server, RADIUS server, and configuration.

## The Spine

A read request (e.g., search) travels this path:

```
HTTPS Request (Axum)
  → https/v1 route handler (e.g. search in v1.rs)
    → ServerState::qe_r_ref (QueryServerReadV1)
      → idms.proxy_read() → IdmServer read transaction
        → qs_search() → QueryServer
          → be.begin_read() → Backend read transaction
            → idl_arc_sqlite query (checks ARCache, then SQLite)
          → filter.resolve() against schema (with resolve filter cache)
          → access controls evaluated
        ← result EntrySet returned
      ← IdmServer transaction dropped (read committed)
    ← JSON response via Axum
```

A write request follows the same path but acquires a write permit from a semaphore, opens a write transaction on the Backend, runs the full plugin pipeline, and commits. Write operations also go through the delayed-action queue for async post-commit work (e.g., credential upgrades, WebAuthn counter increments).

Authentication is handled by `AuthSession` objects stored in a `concread::HashMap` within `IdmServer`. Sessions hold the in-progress authentication state and are resolved into a `UserAuthToken` (a signed JWT) upon success.

## Key Patterns

**Type-state entries.** Entries use a compile-time state machine (`EntryInitNew` → `EntryInvalidNew` → `EntrySealedNew` → `EntrySealedCommitted` → `EntryValidCommitted`) so invalid states are unrepresentable and each transformation step can enforce its own invariants.

**Lock-free reads via `concread`.** KanidM maintains its own fork of the `concread` crate. The `CowCell<T>` type allows a `RefCell`-like API with zero-lock readers and atomic writer swaps. The backend's `IdlArcSqlite` wraps this with an `ARCache` (associative replace cache) for entry and index lookups, giving very high read throughput without blocking.

**Two-phase plugin pipeline.** Write operations run through a fixed plugin sequence: `Base`, `RefInt`, `MemberOf`, `GidNumber`, `NameHistory`, `Unique`, `Spn`, `PasswordImport`, `OAuth2`, `Domain`, `AttrUnique`, `DefaultValues`, `DynGroup`, `Session`, `KeyObject`, `CredImport`, `VettedCredential`. Each plugin can veto or modify the operation.

**Actor-per-role pattern.** `QueryServerReadV1` and `QueryServerWriteV1` are leaked singletons (`Box::leak`) and registered as static references. This avoids `Arc` overhead in the hot path for actors that are never dropped.

**Credential softlocks.** When authentication fails repeatedly, the account's `CredSoftLock` defers further credential checks to a background task that enforces a cooldown window, preventing brute-force attacks without blocking the request thread.

## Non-Obvious Details

**Schema bootstraps from embedded Rust code.** Rather than loading schema from a file at startup, the initial schema is defined in `migration_data/` as generated Rust modules (`dl10`, `dl11`, ...). Each migration step defines the schema and data entries needed to move from one version to the next. This means schema evolution is versioned and reproducible.

**The `concread` crate is maintained alongside KanidM.** It appears in the workspace's `[patch.crates-io]` section as a local path override during development. It provides `ARCache`, `BptreeMap`, `CowCell`, and `HashMap` — all concurrency primitives built on the COW (copy-on-write) model rather than mutexes.

**Filter planning is index-aware.** The backend computes an "index slope" for each filter — an estimate of how many entries a filter will return. Cheap equality filters on indexed attributes get low slopes; substring or existence tests get high slopes. The query planner uses this to decide whether to use an index, do a full scan, or fail with "unindexed." The `FILTER_SUBSTR_TEST_THRESHOLD` constant gates when substring tests fall back to full scans.

**Replication uses change vectors (Cids), not last-write-wins.** Every write gets a `Cid` (court, server ID, andLamport clock). The `RUV` (Replication Update Vector) tracks the high-water mark per server. The replication protocol is pull-based: a consumer asks a supplier for changes since its last known `Cid`, and the supplier streams incremental entry updates.

**Client certificates are verified at the TLS layer.** The `ClientCertInfo` extractor in the HTTPS middleware validates client certificates against the KanidM trust store and extracts identity information before the route handler even runs, so every authenticated route gets a verified client identity for free.

**LDAP is a first-class protocol, not an afterthought.** `LdapServer` is a full actor in the server core, not a shim. It maps KanidM entries onto LDAP DITs, handles bind operations, and exposes search results as LDAP PDUs. The `ldap_vattr_map` module handles the attribute name translation between KanidM's internal names and LDAP RFC-compliant names.

## Assessment

**Strengths.** The codebase is unusually coherent for a project of this scope — the Rust type system is used aggressively to encode correctness (type-state entries, trait-based transactions, deny-by-default clippy). The `concread` + custom backend approach gives read performance that benchmarks favorably against FreeIPA. The multi-protocol support (HTTPS, LDAP, RADIUS, OAuth2, SCIM) in a single binary simplifies deployment dramatically. The plugin system makes extension points predictable and testable.

**Concerns.** The `CowCell`-based concurrency model, while fast, is not the most common Rust pattern — contributors unfamiliar with it will find the code harder to reason about. The "deny all clippy warnings as errors" policy (`#![deny(warnings)]`) in multiple crates means any upstream dependency update that adds a warning can break CI, requiring a maintenance burden. The custom SQLite backend trades portability and tooling support for performance; debugging corrupt or unexpected database state requires deep knowledge of KanidM's on-disk format. The replication system currently supports only two nodes, which is a significant operational limitation for anything beyond HA failover.

**DX / operational concerns.** The project has excellent documentation in the `book/` directory and a developer guide. Configuration is TOML-based with reasonable defaults. The `sketching` crate provides structured logging with `tracing`. However, the lack of built-in metrics (only OpenTelemetry tracing is wired in) means production observability requires additional instrumentation. Backup and restore are implemented but the process is non-trivial — a snapshot-and-restore of the SQLite file works but requires careful coordination with replication state.
