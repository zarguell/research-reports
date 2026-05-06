---
title: "Analyzing LLDAP"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/lldap/lldap @ dc883a0
tags: [rust, ldap, identity, actix-web, sea-orm, opaque, jwt, hexagonal-architecture]
---

# Analyzing LLDAP

> **Source:** [lldap/lldap](https://github.com/lldap/lldap) @ [`dc883a0`](https://github.com/lldap/lldap/commit/dc883a060a1c852239c6c1a22368f62394192dc0)

## How It Works

LLDAP is a lightweight LDAP authentication server written in Rust, designed as a simple alternative to full LDAP stacks like OpenLDAP. It provides user management, group management, and password authentication via the standard LDAP protocol, plus a GraphQL admin API and a web UI built in TypeScript. The server speaks LDAP to compatible clients (Nextcloud, Authelia, KeyCloak, etc.) while exposing a human-friendly admin surface for managing users and groups.

At its core, LLDAP acts as a **translation layer**: it accepts LDAP bind operations for authentication, maps LDAP search/modify operations to its own domain model, and stores everything in SQLite (with optional MySQL/PostgreSQL support). Users are stored under `ou=people,<base_dn>` and groups under `ou=groups,<base_dn>`. Custom attributes can be defined at runtime without schema recompilation.

## Architecture

LLDAP uses a **hexagonal (ports-and-adapters) architecture** organized as a Cargo workspace with a clear separation between layers:

```
server/                     ← Actix HTTP + LDAP server entry point
server/src/main.rs          ← CLI dispatch, configuration, startup
server/src/ldap_server.rs   ← LDAP-over-TCP server binding
server/src/graphql_server.rs ← GraphQL HTTP handler (Actix)
server/src/tcp_server.rs    ← Admin panel HTTP server
crates/
  auth/                     ← OPAQUE protocol + JWT types
  domain/                   ← Domain model (types, requests, schema)
  domain-model/             ← Database models (SeaORM entities)
  domain-handlers/          ← Trait definitions (BackendHandler, etc.)
  ldap/                     ← LDAP protocol codec + session handler
  opaque-handler/           ← Trait for OPAQUE operations
  sql-backend-handler/      ← SeaORM-backed handler implementation
  access-control/          ← ACL wrappers around handlers
  graphql-server/           ← Juniper GraphQL schema + resolvers
  validation/              ← Input validation rules
app/                        ← TypeScript frontend (Vite + React)
```

The dependency direction is strictly inward: `auth` knows nothing about storage, `domain` has no database dependencies, `sql-backend-handler` depends on domain traits, and the server layer wires everything together.

## The Spine

### Startup flow

`server/src/main.rs` is the entry point. On `lldap run`:

1. Parse CLI via `clap`, load `Configuration` from env/flags.
2. Initialize logging.
3. Connect to the SQL database via SeaORM (`setup_sql_tables`).
4. Initialize or validate the RSA private key (used for password encryption).
5. Create the `SqlBackendHandler` — this is the single implementation of all backend traits.
6. Ensure the three builtin groups exist (`lldap_admin`, `lldap_password_manager`, `lldap_strict_readonly`).
7. Create the admin user if missing.
8. Build the LDAP server (`ldap_server::build_ldap_server`).
9. Attach the admin panel HTTP server (`tcp_server::build_tcp_server`).
10. Run with `actix_server::Server::build()`.

### LDAP request path

A bind or search request arrives at `ldap_server.rs`:

1. **Codec:** `FramedRead`/`FramedWrite` with `LdapCodec` from `ldap3_proto`.
2. **Session init:** `LdapHandler::new` wraps the `AccessControlledBackendHandler` (ACL enforcement layer) with a UUID session ID.
3. **Message handling:** `handle_ldap_message` calls `session.handle_ldap_message(msg.op)`, which dispatches to the LDAP operation module (`compare`, `search`, `bind`, etc.).
4. **Backend dispatch:** Each module calls the `BackendHandler` trait method on the SQL backend.
5. **Response:** Results stream back with pagination controls (LDAP Simple Paged Results).

### GraphQL path

The admin panel HTTP server runs on a separate Actix instance (different port). GraphQL requests hit `graphql_server.rs`:

1. Extract bearer token from `Authorization` header.
2. Validate JWT via `check_if_token_is_valid` from `auth_service`.
3. Build a `Context<Handler>` with the validated user + groups.
4. Execute via Juniper with the domain handler.

### Authentication flow

LLDAP supports two login paths:

- **Simple bind:** classic LDAP username + password bind.
- **OPAQUE:** a three-step zero-knowledge password proof protocol. The `OpaqueHandler` trait abstracts this, with `SqlOpaqueHandler` implementing it via `opaque-ke`. OPAQUE is the default for the web UI.

On successful auth, a JWT is issued containing the user ID, group memberships, and expiry.

## Key Patterns

**Hexagonal trait boundaries.** The entire backend is defined as `async_trait` interfaces in `domain-handlers/src/handler.rs`: `BackendHandler`, `LoginHandler`, `OpaqueHandler`, etc. The SQL backend implements these traits; the LDAP/GraphQL servers consume them. This makes the storage layer swappable and the core domain testable in isolation.

**Access control wrapper.** `AccessControlledBackendHandler` in the `access-control` crate wraps the raw backend handler and enforces permissions based on JWT claims. Admin-panel mutations go through this wrapper; the LDAP server also uses it. This is the single enforcement point for RBAC.

**OPAQUE protocol as a feature-gated crate.** `lldap_auth` implements the OPAQUE password-authenticated key exchange. It uses `opaque-ke` under the hood and exposes typed request/response structs for the three-step registration and login flows. The `sea_orm` feature gates the SQL-related helpers.

**JWT + private key binding.** JWTs are used for API access. The server also holds an RSA private key that encrypts sensitive data stored in the database (password records). The key is derived from config, stored in the DB, and validated on startup — changing it invalidates all passwords unless `--force-update-private-key` is set.

**SeaORM with SQL backend flexibility.** The `sql-backend-handler` crate uses SeaORM with `runtime-actix-rustls` and `sqlx-all` (supporting SQLite, MySQL, MariaDB, PostgreSQL). Connection pooling is configured at runtime based on the DB type (SQLite uses a single connection).

**No unsafe code.** The `#![forbid(unsafe_code)]` directive at the crate root enforces this. LLDAP explicitly targets the Rust safety-dance.

## Non-Obvious Details

**Private key versioning.** The server stores a hash of the RSA private key in the DB. If the key in config differs from what's stored, the server refuses to start unless `--force-update-private-key` is set. This prevents silent password corruption when the key is inadvertently rotated.

**LDAP Simple Paged Results control.** In `ldap_server.rs`, the response handler attaches a paging control to every `SearchResultDone` message. The `size` field is set to `results - 1` to avoid counting the final done message as a result. This allows LDAP browsers to paginate without loading the entire result set.

**`Box::leak` for static `LdapInfo`.** The server leaks a `Box<LdapInfo>` to create a `'static` reference that lives for the server's lifetime. This avoids threading the config through the Actix service factory closure — a pragmatic choice in an async server context where lifetime management is tricky.

**Builtin group bootstrapping.** On first startup, `ensure_group_exists` is called for the three builtin groups before checking for the admin user. This ordering is important: the admin must be able to be added to `lldap_admin` when created.

**Opaque token isolation.** OPAQUE server-side login state (`ServerLogin`) is stored in the struct returned to the client, encrypted as `server_data`. The server never stores this state server-side — the client returns it on the final step. This is a stateless server design for the auth protocol.

**Password manager cannot reset admin passwords.** The `lldap_password_manager` group can reset passwords but is explicitly denied from changing passwords of users in `lldap_admin`. This privilege separation is enforced in `access-control`.

**Frontend served separately.** The TypeScript app in `app/` is a separate Vite + React project, not embedded in the Rust binary. It's served by the TCP server from `server/src/tcp_server.rs` via static file serving. The frontend options crate (`frontend-options`) holds the configuration schema shared between Rust and TypeScript.

## Assessment

**Strengths:**
- Clean hexagonal architecture with well-defined trait boundaries. The domain layer has no infrastructure dependencies, making it fully testable.
- OPAQUE as the default auth protocol is a significant security improvement over traditional salted-hash password storage.
- Multi-database support via SeaORM with runtime SQL type detection is flexible and low-overhead for self-hosters.
- `#![forbid(unsafe_code)]` + codecov + Rust edition 2024 + `rust-version = "1.89.0"` signals a well-maintained, modern project.
- Good separation between LDAP (standard protocol) and admin API (GraphQL) — compatible with existing tooling while enabling a modern UX.

**Concerns:**
- The `Box::leak` pattern for static context is a pragmatic escape hatch but relies on memory that will never be freed. Acceptable for a server process, but worth noting.
- The RSA private key mechanism adds complexity. Key rotation is a multi-step process with force flags. This could be smoother.
- The LDAP Simple Paged Results implementation calculates the page size on every response — this could be confusing if the client expects exact page sizes.
- JWT validation in the GraphQL handler does not appear to have a refresh mechanism documented — if the JWT expires, the client must re-authenticate from scratch.

**Recommendations:**
- Consider deriving the JWT secret from the private key material rather than a separate secret, reducing the number of secrets to manage.
- Add a key rotation grace period where both old and new private keys are accepted, allowing zero-downtime key rotation.
- The frontend-as-separate-repo pattern (TypeScript app) adds build complexity. Embedding the frontend or using a pre-built asset directory would simplify container images.
