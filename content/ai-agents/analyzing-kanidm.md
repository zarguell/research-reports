---
title: "Analyzing KanidM"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/kanidm/kanidm @ a44f9cf9118f043c50e9f8008bc6ed58056239b4
tags: [rust, identity-management, ldap, oauth, openid-connect, auth, kanidm]
---

# Analyzing KanidM

> **Source:** [kanidm/kanidm](https://github.com/kanidm/kanidm) @ [`a44f9cf`](https://github.com/kanidm/kanidm/commit/a44f9cf9118f043c50e9f8008bc6ed58056239b4)

KanidM is a modern identity management platform written in Rust, designed as a complete self-contained alternative to products like Keycloak, FreeIPA, and OpenLDAP. It provides authentication, authorization, and directory services through native OAuth2/OIDC, LDAP, RADIUS, and WebAuthn/Passkey support—without requiring external dependencies beyond its embedded SQLite database.

## How It Works

At its core, KanidM operates as a transaction-based system where every operation flows through a carefully staged pipeline. When a client authenticates, the request enters through the HTTP layer (`server/core/src/https/`), which uses Axum to handle routing. Authentication requests are routed to `QueryServerWriteV1` actors, which acquire a write lock via a semaphore and delegate to `IdmServer`.

The `IdmServer` (`server/lib/src/idm/server.rs`) maintains in-memory session state using a `BptreeMap` of `AuthSession` objects. Each authentication session tracks the current step in a multi-factor flow, supporting password, TOTP, security key (WebAuthn), passkeys, and backup codes. Upon successful authentication, the server constructs a `UserAuthToken` (a JWT-like structure) and signs it using `compact_jwt`.

For OAuth2/OIDC flows, the `IdmServer` handles authorization code generation with PKCE support, state management, and scope validation. The OAuth2 module (`server/lib/src/idm/oauth2.rs`) implements the full RFC 6749 and related specifications, including token introspection and revocation.

Data persistence happens in the `Backend` (`server/lib/src/be/`), which wraps rusqlite with a custom indexing layer. The system uses a two-phase commit pattern: writes go through `QueryServerWriteTransaction` which validates against schema, applies access controls, and then persists to the backend. Reads use snapshot isolation via the `CowCell` (Copy-On-Write Cell) pattern for concurrent access without locking.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      External Protocols                         │
│   HTTP (Axum) │ LDAP │ RADIUS │ SSH Certificate Distribution   │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                      server/core                                │
│   actors/ (QueryServerReadV1, QueryServerWriteV1, AdminActor)   │
│   https/ (v1.rs, oauth2.rs, mod.rs for route handling)          │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                      server/lib                                  │
│   idm/ ─ AuthSession, OAuth2, LDAP, Account, Group, Credential   │
│   server/ ─ QueryServer, Access Control, Identity Resolution    │
│   be/ ─ Backend, SQLite, Indexing                               │
│   schema/ ─ Attribute/Class definitions, validation             │
│   entry.rs ─ Core Entry abstraction with lifecycle states       │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                    Embedded SQLite (rusqlite)                    │
│   - Content-addressed storage                                    │
│   - Custom index layer (IDL)                                    │
│   - Two-node replication support                                │
└─────────────────────────────────────────────────────────────────┘
```

The workspace consists of 27 crates spanning server components, client libraries, and Unix integration (NSS/PAM modules). Key dependencies include `webauthn-rs` for passkey support, `compact_jwt` for token handling, and `concread` for concurrent data structures.

## The Spine

The entry point for HTTP traffic begins in `server/core/src/https/mod.rs`, which constructs an Axum router with middleware for authentication and tracing. Routes are defined in several modules:
- `v1.rs` handles core operations (auth, search, create, modify, delete)
- `v1_oauth2.rs` processes OAuth2 authorization and token endpoints
- `v1_scim.rs` handles SCIM provisioning
- `ldap.rs` routes LDAP operations

Authentication follows this flow:
1. Client POSTs to `/v1/auth` with credentials
2. `auth_action` in `v1.rs` extracts client info and delegates to `state.qe_w_ref`
3. `QueryServerWriteV1::handle_auth` acquires a write transaction on `IdmServerAuthTransaction`
4. The transaction invokes `AuthSession::begin` or `AuthSession::process` based on current state
5. On success, `AuthSession::finalize` creates a `UserAuthToken`, signs it with `JwsHs256Signer`, and returns `AuthState::Success`

OAuth2 authorization follows a similar pattern through `oauth2_authorize` → `oauth2_authorize_validate` → `oauth2_resume_code_send`, with state stored in memory using encrypted cookies.

## Key Patterns

**Transaction-based Architecture**: Every database operation passes through typed transactions (`QueryServerReadTransaction`, `QueryServerWriteTransaction`). Write transactions hold exclusive access via a semaphore, while reads operate on snapshot views. This pattern extends to `IdmServerProxyReadTransaction` and `IdmServerProxyWriteTransaction` for IDM operations.

**Entry Lifecycle States**: Entries use phantom types to track their state: `EntryNew` (never in DB), `EntryCommitted` (has an ID), `EntryValid` (schema-correct), `EntrySealed` (immutable). This prevents invalid state transitions at compile time. Helper types like `EntryInitNew`, `EntryValidCommitted` express intermediate states.

**COWCell for Concurrency**: The `concread` crate provides Copy-On-Write cells that allow multiple readers with one writer. KanidM uses `CowCellReadTxn` for schema and domain info that rarely changes but must be accessed frequently.

**Actor Pattern for Query Servers**: The `actors` module provides `QueryServerReadV1` and `QueryServerWriteV1` as static singleton actors that handle all request processing. They're started once and handle requests via async methods.

**Plugin System**: Schema plugins (`server/lib/src/plugins/`) enforce invariants during entry commits—credential strength, unique attributes, referential integrity, etc. Each plugin implements `Plugin` trait with `pre_create`, `post_create`, `pre_modify` hooks.

**Crypto Abstraction**: The `crypto-glue` crate abstracts cryptographic operations, allowing different implementations. KanidM ships with a software implementation but can integrate with HSMs via `kanidm-hsm-crypto`.

## Non-Obvious Details

**Index Slope Estimation**: The indexing system (`be/idl_sqlite.rs`) uses slope estimation to determine optimal index usage based on selectivity. Rather than simple histogram-based estimates, it samples actual query execution to build a model of index effectiveness.

**Session Soft-Locking**: Failed authentication attempts trigger a "soft lock" on credentials (`credential/softlock.rs`), temporarily blocking further attempts without modifying the credential itself. This prevents brute-force without creating a permanent denial-of-service vector.

**Delayed Action Queue**: Authentication and credential updates can spawn "delayed actions" (via unbounded channels) that execute asynchronously—password upgrades, backup code rotation, WebAuthn counter increments. This keeps authentication paths fast while handling background cleanup.

**Migration Data Embedded**: Schema migrations include embedded JSON data (`server/lib/src/migration_data/`) for initial population. The `migrations.rs` module handles rolling forward through versioned migration steps with embedded deltas.

**Access Control via ACP (Access Control Profile)**: Access isn't just filter-based. The system uses `AccessControlProfile` entries that define who can perform what operations on which targets, with separate read/write/manage permissions and subject/source-time constraints.

**OAuth2 PKCE State Machine**: The authorization flow uses a state machine in `Oauth2StateMachine` that tracks transitions through `AuthReq`, `ConsentPending`, `CodeGrant`, etc. State transitions are validated at each step, preventing replay attacks or state confusion.

## Assessment

**Strengths:**
- Clean separation between HTTP layer, business logic, and data access
- Strong typing prevents many runtime errors (entry lifecycle, transaction types)
- Comprehensive protocol support (OAuth2, OIDC, LDAP, RADIUS) in a single binary
- No external database dependency simplifies deployment
- Excellent documentation (the "Kanidm book" covers operational and development aspects)

**Concerns:**
- Single-writer semantics in the query server limit write throughput—future read-replicas would help but aren't implemented
- The 44K-line `v1.rs` file suggests possible API surface overgrowth
- Session state in-memory means restarts invalidate all active sessions (though this is documented)
- Replication is "two node" only—multi-region deployments require careful planning

**Operational Notes:**
- The server requires `kanidm` or `root` for binding privileged ports (RADIUS 1812, LDAP 636)
- Initial setup requires offline first-user creation for security
- Benchmarks claim 3x faster searches than 389-ds with 3000 users/1500 groups

**DX Assessment:**
- Extensive use of `tracing` for structured logging throughout
- `utoipa` generates OpenAPI specs automatically from route handlers
- Integration tests (`testkit`) provide good coverage patterns
- The project maintains strict clippy/deny warnings as CI checks