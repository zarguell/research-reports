---
title: "Analyzing LLDP"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/lldap/lldap @ dc883a060a1c852239c6c1a22368f62394192dc0
tags: [rust, actix, ldap, authentication, graphql, opaque-protocol, sea-orm, jwt]
---

# Analyzing LLDP

> **Source:** [lldap/lldap](https://github.com/lldap/lldap) @ [`dc883a0`](https://github.com/lldap/lldap/commit/dc883a060a1c852239c6c1a22368f62394192dc0)

## How It Works

LLDP (Lightweight LDAP) is a simplified LDAP authentication server built in Rust. Unlike full LDAP implementations like OpenLDAP, it focuses on being an opinionated user management system that speaks the LDAP protocol for compatibility with existing services.

At its core, LLDAP accepts LDAP authentication requests on port 3630 (LDAP) and 6360 (LDAPS), provides a web UI for administration, and exposes a GraphQL API for scripting. The server is built on Actix-web for HTTP handling and uses ldap3_proto for LDAP protocol encoding/decoding.

Authentication uses the OPAQUE protocol, a password-authenticated key exchange (PAKE) that allows zero-knowledge password verification—the server never stores or learns the actual password, only cryptographic proof of its existence.

## Architecture

LLDP uses a **hexagonal architecture** with clear boundaries between layers:

```
┌─────────────────────────────────────────────────────────────────┐
│                      Entry Points                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ LDAP Server │  │ TCP Server  │  │ Actix HTTP (GraphQL/UI) │ │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘ │
└─────────┼────────────────┼─────────────────────┼───────────────┘
          │                │                     │
          ▼                ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Handler Layer                                 │
│  ┌─────────────────┐  ┌────────────────────────────────────────┐│
│  │ LdapHandler     │  │ AccessControlledBackendHandler        ││
│  │ (Session/Proto) │  │ (Permission checks per group)          ││
│  └─────────────────┘  └───────────────┬───────────────────────┘│
└────────────────────────────────────────┼────────────────────────┘
                                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Backend Trait Layer                          │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │            BackendHandler (User/Group/Schema)               ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Storage Layer                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ SqlBackendHandler│  │ JwtSqlTables    │  │ PrivateKeyInfo │ │
│  │ (SeaORM/SQLite) │  │ (Token storage) │  │ (Password keys)│ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

The workspace contains:
- **server/** - Main binary with Actix HTTP server
- **app/** - Pre-built React frontend (served statically)
- **migration-tool/** - Database migration utilities  
- **set-password/** - CLI password management
- **crates/** - Shared libraries (domain, auth, ldap, graphql-server, etc.)

## The Spine

The data flow for an LDAP authentication request:

1. **Network I/O**: TCP stream arrives at `ldap_server.rs` → `handle_ldap_stream()`
2. **Codec**: `FramedRead/FramedWrite` with `LdapCodec` decodes LDAP BER messages
3. **Session**: Each connection gets a `LdapHandler` instance with a UUID session ID
4. **Access Control**: `AccessControlledBackendHandler` wraps the backend, enforcing group-based permissions
5. **Backend**: `SqlBackendHandler` (implements `BackendHandler` trait) queries SeaORM
6. **Auth**: Password verification uses OPAQUE protocol via `lldap_opaque_handler`

```
TCP Stream → LdapCodec decode → LdapHandler.handle_ldap_message()
         → AccessControlledBackendHandler.check_permission()
         → SqlBackendHandler methods
         → SeaORM → SQLite/MySQL/PostgreSQL
```

The main entry point `main.rs` sets up:
- Database connection pool (SQLite defaults to 1 connection, others to 5)
- OPAQUE private key management (stored in DB, compared on startup)
- Admin user/group bootstrap (creates `lldap_admin`, `lldap_password_manager`, `lldap_strict_readonly` groups)
- Three server types: LDAP (3630), LDAPS (6360), HTTP (17170)

## Key Patterns

### Handler Trait Hierarchy

The backend uses async traits to define capabilities:

```rust
// Base: read user details
trait UserReadableBackendHandler { ... }

// Add listing
trait ReadonlyBackendHandler: UserReadableBackendHandler { ... }

// Add user updates
trait UserWriteableBackendHandler: UserReadableBackendHandler { ... }

// Full admin access
trait AdminBackendHandler: ReadonlyBackendHandler + UserWriteableBackendHandler + SchemaBackendHandler { ... }
```

This allows flexible composition—LDAP doesn't need write operations, but the API does.

### OPAQUE Protocol Implementation

LLDP uses the OPAQUE protocol (via `opaque-ke` crate) for password authentication:

1. **Registration**: Client sends `RegistrationStart`, server responds with `RegistrationResponse`, client sends `RegistrationUpload`
2. **Login**: 3-step challenge-response where the server never sees the plaintext password
3. **Key Storage**: The OPAQUE "envelope" is encrypted with a server private key stored in the DB

> [!note]
> The private key is critical—changing it invalidates all passwords. The server detects this via hash comparison and refuses to start unless `--force-update-private-key` is used.

### JWT Session Management

Authentication generates JWT tokens with refresh token support. Tokens are stored in SQL tables (`jwt_sql_tables`) for validation and revocation.

### Configuration via Figment

Configuration is layered: defaults → TOML file → environment variables. The `Configuration` struct uses `derive_builder` for declarative construction.

## Non-Obvious Details

### LDAP BIND with OPAQUE

The LDAP `BIND` operation doesn't use standard LDAP simple bind. Instead, LLDAP implements a custom OPAQUE-based authentication flow:

1. Client sends SASL-style credentials
2. Server responds with OPAQUE challenge
3. Client responds with proof
4. Server validates and issues JWT

### Private Key Security Model

LLDP encrypts OPAQUE envelopes with a server private key stored in the database. The key hash is checked on startup—if it changes, the server refuses to start to prevent accidental password invalidation. This is a deliberate design choice to make key rotation explicit.

### Group-Based Permission Model

LLDP has three special groups with specific semantics:
- **lldap_admin**: Full web UI access
- **lldap_strict_readonly**: Read-only LDAP access for services (prevents privilege escalation)
- **lldap_password_manager**: Can reset passwords but not for `lldap_admin` members

### Paged Results Control

Search results use LDAP Simple Paged Results control (RFC 2696) to avoid large responses. The handler tracks result counts to populate the page size correctly.

### Frontend Delivery

The `app/` directory contains a pre-built React frontend served by Actix. During development it's served separately, but in production it's embedded in the binary.

## Assessment

**Strengths:**
- Clean hexagonal architecture with well-defined boundaries
- Strong cryptographic practices (OPAQUE, rustls)
- Database agnostic (SQLite/MySQL/PostgreSQL via SeaORM)
- Comprehensive test coverage visible in CI badges
- `#![forbid(unsafe_code)]` policy

**Concerns:**
- OPAQUE implementation is custom—while based on standard protocols, deviations could introduce vulnerabilities
- Private key management during key rotation is complex and requires careful ops handling
- SQLite default with single connection may not scale well for high-throughput scenarios

**Recommendations:**
- For production use, prefer PostgreSQL over SQLite for concurrent access
- Document private key rotation procedures more prominently
- Consider adding rate limiting on authentication endpoints

## Related

- [[analyzing-bifrost]] - Another authentication/gateway system
- [[analyzing-hermes-agent]] - Another Rust-based AI agent system