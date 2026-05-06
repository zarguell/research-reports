---
title: "Analyzing LLDP"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/lldap/lldap
tags: [rust, ldap, identity, actix-web, sea-orm, opaque, jwt, hexagonal-architecture]
---

# Analyzing LLDP

> **Source:** [lldap/lldap](https://github.com/lldap/lldap) @ [`dc883a0`](https://github.com/lldap/lldap/commit/dc883a060a1c852239c6c1a22368f62394192dc0)

## How It Works

LLDP (Light LDAP) is a lightweight authentication server that speaks LDAP for identity management while exposing a modern GraphQL API and a Yew-based web frontend. The core idea: provide the minimal LDAP interface that self-hosted applications need for authentication, while making the management experience far simpler than traditional LDAP servers like OpenLDAP.

The system is built around three protocol layers:

1. **LDAP** — Traditional bind/search operations for client compatibility. Applications authenticate against LLDAP using standard LDAP credentials.
2. **HTTP/REST** — A GraphQL endpoint under `/api` for programmatic management (user CRUD, group management, schema updates).
3. **Web UI** — A compiled Yew (Rust-to-WASM) frontend served on the HTTP port, allowing administrators to manage users and groups through a browser.

Authentication is handled through **OPAQUE**, a password-authenticated key exchange protocol that prevents the server from ever learning the user's plaintext password. This is a deliberate design choice to resist offline dictionary attacks on compromised databases.

## Architecture

The project uses a **hexagonal/ports-and-adapters architecture** structured as a Rust workspace:

```
lldap/
├── server/              # Actix-web server, LDAP codec, HTTP handlers
├── app/                 # Yew frontend (compiled to WASM)
├── crates/
│   ├── domain/          # Core business types, requests, public schema
│   ├── domain-model/    # Error types, SeaORM model definitions
│   ├── domain-handlers/ # Trait definitions (BackendHandler, LoginHandler, etc.)
│   ├── auth/            # OPAQUE protocol implementation + JWT handling
│   └── sql-backend-handler/  # SQLite/MySQL/PostgreSQL implementation
├── migration-tool/      # DB schema migration utility
└── set-password/        # CLI utility for password management
```

The architecture enforces clear separation: `domain` contains pure business logic with no external dependencies, `domain-handlers` defines interfaces (traits), and the concrete implementations live in crates like `sql-backend-handler`. This makes it straightforward to swap storage backends.

## The Spine

The request lifecycle for an LDAP bind operation:

1. `server/src/main.rs` initializes configuration and starts the Actix server
2. `ldap_server.rs` binds TCP sockets on port 389 (LDAP) and optionally 636 (LDAPS)
3. Incoming LDAP messages are decoded via `ldap3_proto::LdapCodec` and passed to `LdapHandler`
4. `LdapHandler` (from `lldap_ldap` crate) processes LDAP operations, delegating to `AccessControlledBackendHandler`
5. `AccessControlledBackendHandler` wraps the `SqlBackendHandler`, enforcing group-based permissions (e.g., `lldap_admin`, `lldap_strict_readonly`)
6. `SqlBackendHandler` translates operations to SeaORM queries against SQLite (default), MySQL, or PostgreSQL
7. Responses are serialized back through the LDAP codec and sent to the client

For HTTP/API requests:

1. `tcp_server.rs` binds the HTTP port and configures the Actix-web router
2. Routes under `/auth` delegate to `auth_service.rs` (login, registration, JWT refresh)
3. Routes under `/api` delegate to `graphql_server.rs` (Juniper-based GraphQL)
4. GraphQL resolvers access `AppState`, which holds the `AccessControlledBackendHandler` reference

Startup initialization in `main.rs`:
- Sets up the SQL connection pool
- Runs migrations via `sql_tables::init_table()`
- Ensures built-in groups exist (`lldap_admin`, `lldap_password_manager`, `lldap_strict_readonly`)
- Creates the admin user if not present

## Key Patterns

**Trait-based backend abstraction:** The `BackendHandler` trait (and its sub-traits like `UserBackendHandler`, `GroupBackendHandler`) defines the contract for all data operations. The `SqlBackendHandler` is the primary implementation. This makes the core server agnostic to the storage backend.

**OPAQUE for password authentication:** The `opaque.rs` crate implements the OPAQUE-KE protocol using the `opaque_ke` library. The server never stores plaintext passwords—only the OPAQUE registration record. Login is a 3-step challenge-response: client sends credential request → server responds → client sends credential finalization → server validates and issues JWT.

**JWT with refresh tokens:** Authentication produces a short-lived JWT (access token) and a long-lived refresh token. The refresh token is stored in the database with a hash (not the raw token) for revocation. JWTs are blacklisted on logout by storing their hash in `jwt_storage` with `blacklisted=true`.

**OPAQUE server setup as private key:** The OPAQUE `ServerSetup` (used for password registration and login) is derived from a server private key stored in the database. If this key changes, all existing passwords become invalid—a safety mechanism, but one that requires explicit `--force-update-private-key` to override.

**Async traits everywhere:** The backend handler traits use `async_trait`, making all operations async. This keeps the architecture consistent with Rust's async ecosystem.

**Configurable SQL backends:** The `DatabaseUrl` type abstracts over SQLite, MySQL, and PostgreSQL connection strings, routing to the appropriate SeaORM driver.

## Non-Obvious Details

**LDAP attribute filtering at the protocol layer:** `LdapHandler` receives `LdapInfo` which contains `ignored_user_attributes` and `ignored_group_attributes` lists. These are applied during response serialization, not in the SQL query—this means the database still returns full rows, but unwanted attributes are stripped before sending.

**OPAQUE uses a fixed salt for the slow hash:** The `ArgonHasher` in `opaque.rs` uses a hardcoded salt (`b"lldap_opaque_salt"`) in the Argon2id configuration. The comment explicitly notes this is not a security-relevant salt—it's purely to increase computational cost during the OPAQUE protocol's inner hash, making offline brute-force attacks more expensive.

**JWT claims include groups as a `HashSet`:** The `JWTClaims` struct stores user groups as `HashSet<String>`, meaning group membership is baked into the token. This trades token freshness for reduced database lookups—revoking a user's group access won't take effect until their current JWT expires.

**The frontend is compiled Rust (Yew), not JavaScript:** The `app/` directory is a Yew application compiled to WebAssembly. The compiled assets (`.wasm` files) are embedded in the server binary or served from the configured `assets_path`.

**LDAP pagination is simulated:** In `ldap_server.rs`, responses include a `SimplePagedResults` control with `cookie: vec![]` and `size: results - 1`. This signals paging support to clients, but the actual implementation doesn't paginate results—the "page size" is set to the result count minus one, which is a no-op pagination hint.

**Docker entry point runs as root then drops privileges:** The `docker-entrypoint.sh` script runs as root to fix up file permissions, then spawns the LLDAP process as the configured UID/GID. The `*-rootless` variants skip this step for environments that can't run as root.

## Assessment

**Strengths:**
- Clean hexagonal architecture with strong separation between domain logic and infrastructure
- OPAQUE protocol implementation is a strong security choice—passwords never hit the wire or disk in recoverable form
- Support for three SQL backends (SQLite, MySQL, PostgreSQL) without changing application code
- Web UI (Yew/WASM) keeps the frontend in the same language as the backend
- Good CI badges (Rust, unsafe-forbidden, codecov) indicate active maintenance

**Concerns:**
- The `ServerSetup` private key changing invalidates all passwords—risky if the database is restored from an old backup
- JWT with embedded group membership means group changes don't propagate until token expiry
- LDAP browsing tools are explicitly not supported ("could be but aren't")
- Some services requiring password hash sync (Synology) are fundamentally incompatible with OPAQUE's zero-knowledge design

**Recommendations:**
- Document the private key backup and restore procedure prominently—it's a critical operational concern
- Consider adding an explicit "force logout all users" mechanism beyond just rotating the OPAQUE server key
- The simulated LDAP pagination should either be removed or implemented properly to avoid confusing clients

LLDP is a well-designed, security-conscious authentication server for the self-hosting community. Its architecture cleanly separates concerns, and its use of OPAQUE places it ahead of many LDAP implementations in terms of password security. The main operational risk is the OPAQUE server setup key—if lost or rotated, all user passwords are invalidated.