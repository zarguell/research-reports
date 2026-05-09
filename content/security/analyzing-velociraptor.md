---
title: "Analyzing Velociraptor"
date: 2026-05-09
type: codebase-analysis
status: complete
source: https://github.com/Velocidex/velociraptor
tags: [go, edr, dfir, endpoint-security, vql]
---

Source: [`2af6143`](https://github.com/Velocidex/velociraptor/commit/2af61431bee610b713ebc0067cf9f0980f500442) — Velociraptor is a Go-based endpoint monitoring, detection, and forensic collection tool built around VQL (Velocidex Query Language). At ~1,400 Go files and 418 YAML artifact definitions, it is a substantial, production-grade DFIR platform.

## How It Works

Velociraptor deploys as a single binary that can operate in three modes: **client** (endpoint agent), **frontend** (server), or **GUI** (local triage tool). The entire system revolves around VQL — a SQL-like query language that describes *what to collect* rather than *how to collect it*. Users define "artifacts" (YAML files containing VQL queries, parameters, and metadata), and the server compiles these into `VQLCollectorArgs` protobufs that get pushed to clients for execution.

The client-server communication uses a custom crypto layer (in `crypto/`) over HTTP/WebSocket. Clients enroll via certificate exchange, poll for tasks, execute VQL queries locally, and stream results back. The server maintains an artifact repository, schedules collections, manages hunts, and stores results in a file-based datastore (with MySQL/PostgreSQL support for indexing).

The architecture deliberately keeps clients thin — they don't need built-in artifact knowledge. The server sends both the VQL *and* any dependent artifact definitions with each collection request. This allows artifact editing on the server without redeploying clients.

## Architecture

```
┌─────────────┐    gRPC/HTTP     ┌──────────────────┐
│  GUI / API   │ ◄──────────────► │   Frontend        │
│  (Angular)   │                  │   (api/, server/) │
└─────────────┘                  └────────┬─────────┘
                                          │
                              ┌───────────┼───────────┐
                              │    Services Layer      │
                              │  (services/)           │
                              │  launcher, journal,    │
                              │  hunt_dispatcher,      │
                              │  indexing, orgs, ...   │
                              └───────────┬───────────┘
                                          │
                              ┌───────────┴───────────┐
                              │   Datastore            │
                              │  (datastore/)          │
                              │  file-based + remote   │
                              └────────────────────────┘
         │                         │
    ┌────┴─────┐            ┌─────┴──────┐
    │  Client   │ ◄────────►│  Crypto +   │
    │  Executor │  HTTP/WS  │  Comms      │
    │ (executor)│            │(http_comms) │
    └───────────┘            └────────────┘
```

**Key modules:**

| Module | Role |
|--------|------|
| `vql/` | VQL plugin/function registration and scope management |
| `vql_plugins/` | Blank-import aggregator — registers all VQL plugins at startup |
| `executor/` | Client-side VQL execution engine |
| `actions/` | Client action handlers (`VQLClientAction`, events, transactions) |
| `services/` | Server-side service orchestrator (~30 services: launcher, journal, hunts, orgs, indexing, etc.) |
| `http_comms/` | Client-server communication (polling, enrollment, WebSocket) |
| `crypto/` | End-to-end encryption, key management, certificate handling |
| `datastore/` | Persistence layer (file-based default, remote for distributed setups) |
| `artifacts/` | 418 built-in YAML artifact definitions across Windows/Linux/MacOS |
| `flows/` | Flow lifecycle management — artifact collection state machines |
| `api/` | gRPC/HTTP API surface + server builder |

## The Spine

**Entry point:** `bin/main.go` — a kingpin CLI app. Subcommands (`gui`, `client`, `frontend`, `query`, etc.) select the startup path. All commands import `vql_plugins` via blank import to register VQL capabilities before anything runs.

**Server startup path** (`startup/frontend.go`):
1. `StartFrontendServices()` creates a `ServiceManager` with a cancellable context and wait group
2. Starts throttler, org manager, API server builder
3. The org manager spins up all configured services (launcher, journal, hunt dispatcher, indexing, etc.)
4. Each service receives `ctx`, `wg`, and `config_obj` — the standard service triple

**Client startup path** (`startup/client.go`):
1. `StartClientServices()` creates a lighter service set (journal, repository, inventory, launcher, event table)
2. Builds a `ClientExecutor` with inbound/outbound protobuf channels
3. `http_comms` connects the executor to the server via encrypted HTTP

**Request lifecycle (artifact collection):**
1. User initiates collection via API → `Launcher.ScheduleArtifactCollection()`
2. Launcher compiles `ArtifactCollectorArgs` → `VQLCollectorArgs` (resolves parameters, dependencies, tools)
3. Serialized protobuf queued for client
4. Client `executor` receives `VeloMessage`, dispatches to `VQLClientAction.StartQuery()`
5. VQL queries execute against local scope with registered plugins
6. Results streamed back through `responder` → outbound channel → comms → server
7. Server `flows` package manages collection context, stores results via `file_store`

## Key Patterns

**Service orchestrator pattern.** Every subsystem is a "service" started through `ServiceManager.Start()`. Services receive a shared `context.Context` (cancelled on shutdown), a `sync.WaitGroup` (for graceful teardown), and a config object. This is consistent and predictable — the same pattern from the tiniest DNS cache to the hunt dispatcher.

**VQL registration via `init()`.** Plugins and functions self-register in package-level `init()` functions using `RegisterPlugin()` / `RegisterFunction()`. The `vql_plugins/plugins.go` file aggregates all imports. This is idiomatic Go but creates a global mutable registry — ordering matters, and duplicate names panic at startup.

**Artifact-as-data, not code.** Artifacts are YAML that embed VQL. The server compiles them into protobuf before sending to clients. Clients never see raw artifact YAML — they receive pre-compiled VQLCollectorArgs. This is a critical design decision that enables server-side artifact customization without client updates.

**Config via protobuf.** The entire configuration schema is defined in `config/proto/config.proto` (1,615 lines). This gives strong typing and backward compatibility but makes the config structure monolithic.

**Scope-based caching.** VQL scopes carry a `$cache` variable (`ScopeCache` in `vql/scope.go`) — a synchronized map that plugins use to share state within a query execution. This avoids redundant computation but is implicit — there is no type safety on cache values.

## Non-Obvious Details

> [!warning] Global mutable state in VQL registration
> `exportedPlugins` and `exportedFunctions` are package-level maps protected by a mutex. `OverridePlugin()` and `OverrideFunction()` exist to replace registered plugins at runtime (used in tests and for platform-specific overrides). This means plugin behavior can change after registration, which is powerful but easy to misuse.

> [!note] The `unimplemented.go` pattern
> `vql/unimplemented.go` provides stubs for platform-specific VQL plugins. On non-Windows builds, Windows-only plugins like `crypto()`, `registry()`, and `wmi()` resolve to stubs that return errors. This keeps cross-compilation clean without build tags on every file.

> [!tip] Artifact compilation is the performance bottleneck
> The launcher compiles artifacts into VQLCollectorArgs before sending to clients. For hunts (same artifact, thousands of clients), the compilation result is cached to avoid redundant work. This caching is essential for scale — without it, launching a hunt across 10k endpoints would recompile the same artifact 10k times.

> [!question] Client never trusts its own artifacts
> The design explicitly states "the client never uses its built-in artifacts" — every collection ships the full artifact definition from the server. This is a security property (server controls what runs) but also means the client-side artifact repository at startup is mostly empty, populated per-query from server-sent definitions.

**Critical files worth understanding first:**
- `services/launcher.go` — the compilation pipeline from artifact to VQL
- `actions/vql.go` — where VQL actually executes on the client
- `vql/vql.go` — plugin/function registration machinery
- `http_comms/comms.go` (~1,240 lines) — the entire client-server communication protocol
- `services/services.go` — the 80-line service manager that orchestrates everything

## Assessment

**Strengths:**
- **Single-binary, multi-mode design** is excellent for DFIR practitioners — same binary for server, client, and local triage
- **Artifact system** is genuinely innovative — decoupling *what to collect* from *how to deploy* is a major operational advantage
- **Service orchestrator** is clean and consistent; the `ctx + wg + config` pattern makes the codebase navigable despite its size
- **418 built-in artifacts** provide out-of-the-box coverage for common forensic collection scenarios
- **VQL** is expressive and extensible — the plugin system allows adding capabilities without modifying core

**Concerns:**
- **Monolithic config proto** (1,615 lines) makes configuration hard to reason about — changes ripple across many subsystems
- **Global plugin registry** with runtime overrides creates subtle coupling; testing requires careful setup/teardown
- **`http_comms/comms.go`** at 1,240 lines is doing too much — enrollment, polling, WebSocket, retry logic, and encryption are interleaved
- **File-based datastore** as default has scaling limitations (acknowledged; remote datastore exists but adds complexity)
- **CGO dependency** (SQLite, YARA, etc.) complicates cross-compilation and binary distribution

**Recommendations:**
- Consider splitting `http_comms` into distinct enrollment, transport, and retry components
- The config proto would benefit from decomposition — separate client config, server config, and service-specific configs
- Plugin registration could use a more structured approach (e.g., provider interfaces) to reduce global mutable state

## Related

- [[analyzing-nuclei]] — another security tool using a custom DSL (Nuclei templates vs VQL)
- [[analyzing-misp]] — threat intelligence platform; Velociraptor can integrate with MISP via VQL
- [[analyzing-opencti]] — CTI platform; complementary to Velociraptor's endpoint visibility
- [[analyzing-bloodhound]] — AD attack path tool; Velociraptor can collect similar data via VQL artifacts
- [[analyzing-prowler]] — cloud security assessments; different domain but similar "configurable checks" pattern
