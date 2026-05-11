---
title: "Analyzing PocketBase"
date: 2026-05-11
type: codebase-analysis
status: complete
source: https://github.com/pocketbase/pocketbase
tags: [go, sqlite, baas, self-hosted, backend, realtime, authentication]
---

# Analyzing PocketBase

> **Source:** [pocketbase/pocketbase](https://github.com/pocketbase/pocketbase) @ [`d438c6a`](https://github.com/pocketbase/pocketbase/commit/d438c6a96a0252ff9df62c1cfe193480ed9ff15d)

## How It Works

PocketBase is an open source backend-as-a-service packed into a single Go binary. At its core, it embeds SQLite (via the `modernc.org/sqlite` pure-Go driver — no CGo required) and exposes a REST-ish API over it. You define **collections** (schemas), and PocketBase auto-generates CRUD endpoints, a record table in SQLite, and access control rules. Collections come in three flavors: `base` (plain data), `auth` (user accounts with password/OAuth2/OTP), and `view` (read-only SQL queries over other collections).

The programming model is hook-centric. Every meaningful action — record creation, validation, file upload, mail dispatch — fires through a typed hook chain (`tools/hook.Hook[T]`). Users register handlers with `app.OnRecordCreate().BindFunc(...)`, and each handler calls `e.Next()` to pass control down the chain. This middleware-like pattern is the primary extension mechanism for both Go framework users and JavaScript hook authors. The JS extension system uses [goja](https://github.com/dop251/goja) (a Go-native ECMAScript runtime) to execute user-defined hooks and migrations from `pb_hooks/` and `pb_migrations/` directories, with no Node.js dependency.

Realtime subscriptions use Server-Sent Events (SSE). Clients connect to `GET /api/realtime`, receive a client ID, then POST subscription filters. When a record changes, PocketBase broadcasts to all matching subscribed clients, re-evaluating access rules against each client's auth state. File storage abstracts over local disk and S3 through a `filesystem.System` type (backed by a portable blob bucket interface). The admin dashboard is a Svelte SPA embedded at compile time via `//go:embed` and served at `/_/`.

## Architecture

The codebase is organized into five layers:

- **`pocketbase.go`** — The launcher. `PocketBase` embeds `core.App`, wires up a Cobra root command, and orchestrates bootstrap/serve/terminate lifecycle with graceful shutdown via signal handling.
- **`core/`** — The domain core. Defines `App` interface and `BaseApp` implementation, all database models (`Collection`, `Record`, `Settings`), field types (20+ field kinds from `FieldBool` to `FieldGeoPoint`), the hook registry (40+ hook types for models, records, collections, auth, realtime, mailer), query builders, and the record-table sync engine that mutates SQLite schema when collections change.
- **`apis/`** — HTTP layer. `apis.NewRouter()` constructs the router with middleware (CORS, rate limiting, auth token loading, panic recovery, body limits) and registers route groups under `/api`: collections, record CRUD, auth flows (OAuth2 redirect, password, OTP, email verification, MFA), realtime SSE, files, logs, backups, batch, cron, health. Each route group is bound via a `bind*Api()` function.
- **`forms/`** — Request validation and upsert logic. The `RecordUpsert` form handles multi-part file uploads, field validation, and delegates to the core hooks. Thin layer between HTTP handlers and the domain.
- **`plugins/`** — Optional extensions: `jsvm` (JavaScript VM for hooks/migrations), `migratecmd` (CLI migration tool), `ghupdate` (self-update from GitHub releases).

**Data flow for a record creation:**

1. `POST /api/collections/{collection}/records` hits `apis.recordCreate()`
2. Middleware loads auth token via `loadAuthToken()`, checks rate limits
3. Handler resolves collection from cache, validates access rules
4. `forms.RecordUpsert` validates fields, processes file uploads
5. `app.Save(record)` triggers the hook chain: `OnRecordValidate` → `OnRecordCreate` → `OnRecordCreateExecute` → DB INSERT → `OnRecordAfterCreateSuccess`
6. Realtime subscribers are notified if the record matches their subscription filters

## The Spine

**Entry point:** `examples/base/main.go` (prebuilt binary) or a custom `main.go` that calls `pocketbase.New()`.

```
main() → pocketbase.New() → app.Start()
  → registers Cobra commands: serve, superuser
  → app.Execute()
    → app.Bootstrap() (opens DBs, runs migrations, loads settings, starts cron)
    → pb.RootCmd.Execute() → "serve" command
      → apis.Serve(app, config)
        → runs pending migrations
        → apis.NewRouter(app) — registers all API routes + UI
        → app.OnServe().Trigger() — user hooks can modify router
        → http.Server.Serve(listener)
```

Bootstrap opens two categories of database connections: **concurrent** (WAL-mode, for reads) and **nonconcurrent** (for writes and schema changes), plus a separate **auxiliary** DB for logs. This split avoids SQLite write contention under load. The `BaseApp` holds four `dbx.Builder` instances (`concurrentDB`, `nonconcurrentDB`, `auxConcurrentDB`, `auxNonconcurrentDB`) and dispatches queries to the appropriate one.

The `ServeEvent` is the key extension point. Users bind to `app.OnServe()` to inject custom routes, middleware, or even replace the entire HTTP server — while still gaining PocketBase's default API routes.

## Key Patterns

**Generic hook system.** `hook.Hook[T]` is a type-safe, thread-safe middleware chain. Handlers have `Id` and `Priority` fields for ordering and removal. The `Trigger()` method accepts a finalizer function (the "base action") that runs last. This pattern is used uniformly across model lifecycle, API requests, mail sending, and realtime events.

**Hook tags for filtering.** Record and collection hooks use tags (collection name, collection ID) so users can bind handlers to specific collections: `app.OnRecordCreate().Tag("users").BindFunc(...)`. This avoids global hooks that must manually filter.

**Collection-driven schema.** Creating or modifying a collection triggers `SyncRecordTableSchema()`, which runs DDL (ALTER TABLE ADD/DROP COLUMN, CREATE TABLE) inside a transaction. The collection definition is the source of truth; the SQLite schema is derived.

**Dual-mode usage.** PocketBase works as both a standalone binary (download and run) and a Go framework (`import "github.com/pocketbase/pocketbase"`). The standalone mode loads the JSVM plugin; the framework mode gives you full Go control with the same `core.App` interface.

**Embedded UI.** The admin dashboard is built with Svelte, compiled to static assets in `ui/dist/`, and embedded via `//go:embed all:dist`. A build tag (`!no_ui`) controls inclusion, allowing minimal builds without the dashboard.

## Non-Obvious Details

> [!note] Four database connections
> `BaseApp` opens four separate SQLite connections — concurrent/nonconcurrent for both data and logs. The concurrent connections use WAL mode for read scalability. The nonconcurrent connections serialize writes. This is a deliberate SQLite optimization that many Go projects overlook.

**Filesystem abstraction via blob buckets.** The `tools/filesystem` package wraps both local disk and S3 behind a single `System` struct backed by a `blob.Bucket` interface (inspired by `gocloud.dev/blob`). Switching storage backends is a settings change — no code modification needed.

**Notify watcher for multi-instance sync.** PocketBase uses `fsnotify` to watch a `.notify` directory inside `pb_data`. When multiple instances share the same data directory, they write sentinel files to trigger settings reloads and cache invalidation across processes — a cross-platform alternative to Unix signals.

**Record proxies.** The `RecordProxy` interface lets custom Go types wrap a `Record` while participating in the same hook chain. This enables type-safe model definitions in Go framework mode without losing the dynamic collection system.

**Installer flow.** On first run with no superuser, PocketBase generates a temporary system superuser, creates a short-lived auth token, and opens a browser to the admin UI with that token pre-loaded — enabling zero-config first-run setup.

**Batch API.** The `/api/batch` endpoint accepts an array of requests and executes them in a transaction, with each sub-request going through the full middleware and hook chain. This supports atomic multi-operation writes from clients.

## Assessment

**Strengths:**

- **Single-binary simplicity.** No external dependencies, no CGo, no container required. The entire BaaS — DB, API, auth, files, admin UI — ships as one static binary.
- **Exceptional Go API design.** The generic hook system, typed events, and `core.App` interface make framework-mode extension clean and discoverable. The codebase is a masterclass in Go package architecture.
- **SQLite done right.** The four-connection split, WAL mode, query timeouts, and semaphore-limited concurrent access show deep understanding of SQLite's concurrency model.
- **Zero-config JS extensions.** The goja-based JSVM with hot reload (`hooksWatch`) gives non-Go-users extension capability without adding a Node.js toolchain.

**Concerns:**

- **SQLite ceiling.** While the connection pooling is excellent, PocketBase is fundamentally single-node for writes. Horizontal scaling requires application-level partitioning or external tooling.
- **Pre-1.0 stability.** The maintainers explicitly warn that backward compatibility is not guaranteed before v1.0. Breaking changes between minor versions are common.
- **Security surface.** The JSVM exposes significant power (filesystem access, process env) to hook authors. In multi-tenant scenarios, sandboxing is the operator's responsibility.

**Recommendations:**

- For self-hosted projects needing a backend fast, PocketBase is among the best options in the Go ecosystem. Start with the standalone binary, migrate to Go framework mode only when you need custom logic that JS hooks can't express.
- Pair with a reverse proxy like Traefik for TLS termination and routing in production deployments.
- Monitor the migration changelog carefully on upgrades — the pre-1.0 cadence means schema and API changes are frequent.

## Related

- [[analyzing-firefly-iii]] — self-hosted finance manager
- [[analyzing-nextcloud-server]] — self-hosted collaboration
- [[analyzing-traefik]] — infrastructure/reverse proxy (often paired with PocketBase)
- [[analyzing-litellm]] — infrastructure/AI gateway
- [[analyzing-sablier]] — infrastructure/container scaling
