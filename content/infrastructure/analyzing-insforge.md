---
title: "Analyzing InsForge"
date: 2026-05-10
type: codebase-analysis
status: complete
source: https://github.com/InsForge/InsForge
tags: [baas, postgresql, authentication, ai, serverless]
---

# Analyzing InsForge

> **Source:** [InsForge/InsForge](https://github.com/InsForge/InsForge) @ `e77710606c0d88cbefe772c16053d5304cf4f558`

## How It Works

InsForge is an open-source Backend-as-a-Service platform positioned for "agentic coding" — it gives AI coding agents (via MCP tools or CLI) the ability to provision and manage a complete backend. The platform bundles PostgreSQL with PostgREST for auto-generated CRUD APIs, JWT-based authentication with OAuth providers (Google, GitHub, Discord, Apple, and others), S3-compatible file storage, an OpenAI-compatible AI gateway (backed by OpenRouter), serverless edge functions running on Deno, and a real-time messaging layer built on PostgreSQL `LISTEN/NOTIFY` and Socket.IO.

The system is a monorepo with three runtime containers: the Express.js backend (port 7130), a Deno serverless runtime (port 7133) that spawns Web Workers per function invocation, and a PostgreSQL + PostgREST pair. A React dashboard is served as a static SPA from the same Express process. The SDK (`@insforge/sdk`) provides a Supabase-inspired client API. Infrastructure services — storage, compute, email, payments — are abstracted behind provider interfaces with local/S3 storage, Fly.io compute, SMTP/cloud email, and Stripe implementations.

Everything is wired together through singletons: `DatabaseManager`, `StorageService`, `TokenManager`, `SocketManager`, `RealtimeManager`, and so on. The Express app bootstraps them in sequence, runs database migrations via `node-pg-migrate`, seeds the admin user, then starts listening. Function invocations are proxied to the Deno runtime, which loads user function code inside isolated Web Workers with configurable timeouts.

## Architecture

The codebase is organized as a pnpm/turbo monorepo with four main packages:

- **`backend/`** — Express 4 server (TypeScript, ESM). Routes in `src/api/routes/`, services in `src/services/`, infrastructure in `src/infra/`, providers in `src/providers/`, Zod-validated request schemas.
- **`frontend/`** — React + Vite dashboard SPA (Tailwind CSS 3.4). Served as static files from the backend.
- **`packages/shared-schemas/`** — `@insforge/shared-schemas`, Zod schemas shared between frontend and backend for API types.
- **`packages/dashboard/`** — Dashboard UI components package.
- **`functions/`** — Deno runtime (`functions/server.ts`) for serverless function execution.

Key infrastructure components:

| Component | Implementation |
|---|---|
| Database | PostgreSQL 15 + PostgREST v12 for auto-CRUD |
| Auth | JWT (jsonwebtoken + jose for JWKS), bcrypt, OAuth2 flows |
| Storage | S3 (AWS SDK) or local filesystem, with CloudFront signed URLs |
| AI Gateway | OpenAI SDK → OpenRouter provider, streaming + non-streaming |
| Functions | Deno Web Workers with 60s timeout, secrets decrypted via AES-GCM |
| Realtime | `pg_notify` → Socket.IO rooms + webhook delivery |
| Payments | Stripe integration (checkout, subscriptions, webhooks) |

## The Spine

A typical authenticated database request flows like this:

1. Client sends `GET /api/database/records?table=users` with `Authorization: Bearer <jwt>`.
2. Express middleware stack: CORS → rate limiter (3000 req/15min) → request logger → JSON parser → route matching.
3. `database/index.routes.ts` delegates to `databaseRecordsRouter`, which calls `verifyAdmin` or `verifyUser` middleware.
4. Auth middleware extracts the Bearer token, `TokenManager.verifyToken()` decodes the JWT using the `JWT_SECRET` env var, validates the role claim, and attaches `req.user`.
5. Route handler instantiates the relevant service singleton (e.g., `DatabaseService.getInstance()`).
6. Service calls `DatabaseManager.getInstance().getPool()` to get a `pg.Pool` connection, executes parameterized SQL.
7. For record-level operations with RLS (Row Level Security), the `PostgrestProxyService` generates a short-lived PostgREST token with the user's `sub` claim and proxies the request to PostgREST, which enforces RLS policies at the database level.
8. Response flows back through `successResponse()` helper → Express → client.

For function invocation: `POST /functions/:slug` → Express proxies to Deno runtime → Deno `server.ts` looks up the function in its database, decrypts secrets, spawns a Web Worker with the function code, captures stdout, and returns the result.

## Key Patterns

**Singleton services with lazy initialization.** Every service (`AuthService`, `DatabaseService`, `StorageService`, etc.) follows the same pattern: `private constructor`, `static getInstance()`, and state initialized on first access. No DI container — singletons reference each other directly.

**Provider abstraction.** Storage, email, compute, and logs each have a `base.provider.ts` interface with local/cloud implementations. The runtime selects the provider based on environment variables (e.g., `AWS_S3_BUCKET` for S3, otherwise local filesystem).

**Zod-validated API layer.** `@insforge/shared-schemas` defines request/response schemas using Zod. Routes validate input with `.parse()` before hitting service logic. The same schemas generate OpenAPI documentation via `@asteasolutions/zod-to-openapi`.

**Structured error handling.** `AppError` carries `statusCode`, `code` (string error code), and `nextActions` (client-facing hint). PostgreSQL errors are mapped in `error.ts` — unique violation → 409, RLS denial → 403, etc. This gives machine-readable error responses.

**User context for RLS.** `UserContext` (admin, authenticated user, or anon) is derived from the auth middleware and passed through to database queries. PostgREST tokens carry the user's `sub` claim so PostgreSQL RLS policies can filter rows per-user.

**Realtime via pg_notify.** Database triggers call `realtime.publish()` which fires `pg_notify`. A dedicated `RealtimeManager` listens on a non-pooled connection and fans out to Socket.IO rooms and webhook URLs with retry logic.

## Non-Obvious Details

**S3 gateway is a full XML protocol implementation.** The `s3-gateway/` route isn't just presigned URLs — it parses raw S3 XML requests, handles `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` chunked signatures, and implements multipart upload, copy, delete-objects, and more. It's mounted *before* the JSON body parser so raw streams pass through untouched.

**Deno functions decrypt secrets client-side.** The Deno runtime receives AES-256-GCM encrypted secrets from the database and decrypts them using a SHA-256 hash of `JWT_SECRET` as the key. The ciphertext format is `iv:authTag:encryptedData` in hex.

**OAuth PKCE state lives in-memory.** `OAuthPKCEService` stores code verifiers in a Map with TTL-based cleanup. This means server restarts invalidate in-flight OAuth flows — acceptable for single-instance but notable for horizontal scaling.

**Column type caching.** `DatabaseManager` caches column type maps with a 5-minute TTL and LRU eviction (max 100 entries). This avoids repeated `information_schema` queries but means schema changes can take up to 5 minutes to propagate.

**Cloud vs. self-hosted split.** `isCloudEnvironment()` gates features like the root redirect and cloud backend JWT verification. Cloud mode uses JWKS-based token verification against `api.insforge.dev`, while self-hosted uses the local `JWT_SECRET`.

**Default body limits are very high.** JSON body limit defaults to 100MB, URL-encoded to 10MB. The code comments explain this is for "out-of-the-box" convenience but it's a security concern for production.

## Assessment

**Strengths:**
- Clean layered architecture: routes → services → providers, with consistent patterns throughout.
- The PostgREST + RLS integration is well-designed — the proxy service correctly maps JWT claims to database roles.
- Comprehensive feature set for a BaaS: auth (9 OAuth providers), storage (local + S3), AI gateway, realtime, payments, serverless functions.
- The shared-schemas package ensures type safety between frontend and backend.
- Error handling is thorough and machine-readable — `nextActions` hints are useful for both agents and developers.

**Concerns:**
- Singleton pattern everywhere makes testing harder and couples the system to a single process model. No DI container or inversion of control.
- The `AuthService` is 1,387 lines — a god class handling registration, login, OAuth for 9 providers, email verification, password reset, and admin management. It should be decomposed.
- High default body size limits (100MB JSON) and permissive CORS (`origin: true`) need hardening for production.
- OAuth PKCE state and session management are in-memory, which won't survive restarts or scale horizontally.
- No test coverage visible in the backend source — tests exist in `backend/tests/` but the focus seems to be on E2E over unit tests.
- Function proxying serializes the request body to JSON again (`JSON.stringify(req.body)`) which doubles serialization cost and drops non-JSON bodies.

**Recommendations:**
- Decompose `AuthService` into focused services: `UserService`, `OAuthService`, `SessionService`, `PasswordResetService`.
- Extract an external session store (Redis) for PKCE state and OAuth flow continuity.
- Add per-route body size limits instead of the global 100MB default.
- Consider connection pooling for the Deno function runtime's PostgreSQL access (currently creates a new client per invocation).

## Related

[[analyzing-litellm]] [[analyzing-microsandbox]] [[analyzing-kanidm]] [[analyzing-traefik]]
