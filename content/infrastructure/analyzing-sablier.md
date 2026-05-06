---
title: "Analyzing Sablier"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/sablierapp/sablier
tags: [infrastructure, containers, kubernetes, serverless]
---

# Analyzing Sablier

> **Source:** [sablierapp/sablier](https://github.com/sablierapp/sablier) @ [`4d1ea62`](https://github.com/sablierapp/sablier/commit/4d1ea622a2ca436cee4408aa71d8e6231660ea98)

Sablier is a Go-based web server that starts workloads on demand and stops them after a period of inactivity. It integrates with reverse proxy plugins (Traefik, Caddy, Nginx, Envoy, Apache APISIX, Istio, Proxy-WASM) to intercept incoming requests, wake up sleeping containers, and display a waiting page until they're ready. It's infrastructure/DevOps tooling—not a blockchain project.

## How It Works

At its core, Sablier exposes a small HTTP API that reverse proxy plugins call when a request arrives for a sleeping instance. The proxy checks the session status via the `X-Sablier-Status` header; if `not-ready`, it serves a waiting page (dynamic strategy) or holds the request (blocking strategy). Once the provider reports all instances are `ready`, traffic passes through.

The lifecycle is simple:

1. **Request arrives** — reverse proxy plugin calls Sablier's API with instance names or a group name
2. **Session created** — Sablier dispatches a start command to the provider (Docker, Swarm, K8s, Podman) and stores the session with a TTL
3. **Readiness detected** — provider reports instance status (health check status for Docker, replica counts for K8s)
4. **Traffic flows** — proxy passes the request to the now-running instance
5. **Expiration** — when the session TTL expires, Sablier stops the instance

Sablier manages two strategies:

- **Dynamic** — returns a self-refreshing HTML waiting page while instances start. The browser polls Sablier until all instances are ready.
- **Blocking** — holds the HTTP request open, polling the provider every 5 seconds until ready, then returns a JSON session state. The proxy then forwards the original request.

## Architecture

```
reverse proxy (Traefik, Caddy, etc.)
        │
        ▼
┌───────────────────────────────────┐
│         Sablier HTTP API          │
│   (Gin router, port 10000)         │
│                                   │
│  GET /api/strategies/dynamic      │
│  GET /api/strategies/blocking      │
│  GET /api/themes                  │
│  GET /health                      │
└───────────────────────────────────┘
        │
        ├── pkg/sablier/  (core business logic)
        │     ├── Session, Instance (domain models)
        │     ├── Provider interface (docker, swarm, k8s, podman)
        │     ├── Store interface (in-memory, valkey)
        │     └── auto-stop via TTL expiration
        │
        ├── pkg/provider/  (one impl per orchestrator)
        │     ├── docker/     (container start/stop/inspect)
        │     ├── dockerswarm/ (service scale)
        │     ├── kubernetes/  (deployment/statefulset scale)
        │     └── podman/     (container start/stop/inspect)
        │
        ├── pkg/store/  (session persistence)
        │     ├── inmemory/ (TTL-based in-process map)
        │     └── valkey/  (Redis-compatible, TTL + keyspace events)
        │
        └── pkg/theme/  (HTML waiting page rendering)
              └── embedded/  (built-in themes, compiled into binary)
```

**Configuration precedence:** YAML config file > environment variables > CLI flags. Viper handles the layering — the sample config lives at `sablier.sample.yaml` and includes provider, server, storage, sessions, logging, and strategy sections.

## The Spine

The request path for a typical "start instance" flow:

```
HTTP GET /api/strategies/dynamic?names=mycontainer
  │
  ▼
internal/api/start_dynamic.go → DynamicRequest binding
  │
  ▼
pkg/sablier.RequestSession(ctx, names, duration)
  │
  ▼
pkg/sablier.InstanceRequest(ctx, name, duration) for each name
  │
  ├── store.Get(name) → ErrKeyNotFound? → requestStart()
  │     └── pkg/sablier.requestStart() → provider.InstanceStart(ctx, name) (async goroutine)
  │         └── store.Put(name, InstanceInfo, duration) with TTL
  │
  └── store.Get(name) → found? → provider.InstanceInspect() (if not ready)
  │
  ▼
SessionState created with per-instance InstanceInfo + error
  │
  ▼
theme.Render(themeName, options, writer) → HTML waiting page
  │
  ▼
Response written with X-Sablier-Status, Cache-Control, Content-Type headers
```

For blocking strategy, the same flow runs inside `RequestReadySession`, which polls every `BlockingRefreshFrequency` (default 5s) until all instances report `ready` or the timeout fires.

Instance expiration (TTL expiry):

```
store TTL fires → OnInstanceExpired() callback
  │
  ▼
provider.InstanceStop(ctx, instanceName) (goroutine, non-blocking)
```

## Key Patterns

**Provider interface** — `pkg/sablier.Provider` is the central abstraction. All four providers (docker, dockerswarm, kubernetes, podman) implement the same interface: `InstanceStart`, `InstanceStop`, `InstanceInspect`, `InstanceList`, `InstanceGroups`, `NotifyInstanceStopped`. This makes Sablier provider-agnostic. Kubernetes supports both Deployment and StatefulSet; Docker/Podman operate on containers.

**Async start with deduplication** — `instance_request.go` uses a `pendingStarts` map with a mutex. When a start is already in progress for a given instance, subsequent calls skip the start and return `NotReady`. On completion, the goroutine cleans up the map entry. This prevents thundering herd if multiple requests arrive simultaneously.

**Store abstraction** — `sablier.Store` has two implementations: in-memory (TTL-based `tinykv` map, single-process) and Valkey (distributed, uses keyspace notifications for expiration callbacks). Both implement `Get`, `Put`, `Delete`, `OnExpire`. The in-memory store also supports JSON marshal/unmarshal for optional file-based persistence via the `storage.file` config option.

**Config via Cobra + Viper** — the CLI is built with `spf13/cobra`, flags are bound to Viper with env var support. The precedence chain is explicit in `sabliercmd/root.go`: config file paths checked in order `/etc/sablier/`, `$XDG_CONFIG_HOME`, `$HOME/.config/`, current directory. Environment variables take the form `SABLIER_<FLAG_NAME>`.

**Theme rendering** — `pkg/theme` uses Go's `html/template` with `embed.FS` for built-in themes. Custom themes can be loaded from a directory via `strategy.dynamic.custom-themes-path`. Themes receive `Options` (display name, show details, session duration, refresh frequency, instance states) and render to a `bufio.Writer`.

**Healthcheck** — the `/health` endpoint returns 200 when running, 503 when the server context is cancelled (graceful shutdown signaling). Simple but functional.

## Non-Obvious Details

**Group auto-discovery polling** — `group_watch.go` polls the provider every 2 seconds for `InstanceGroups()`. This is explicitly marked as "should be changed to event based." Groups map a named group (e.g., `"frontend"`) to a list of instance names. Groups must be created by labels on the instances themselves; Sablier discovers them dynamically.

**Kubernetes delimiter parsing** — K8s provider names are `namespace_kind_name` (e.g., `default_deployment_myapp`). The delimiter defaults to `_` but can be changed via `provider.kubernetes.delimiter`. This maps to a `ParseName()` function that splits the string and resolves to a Deployment or StatefulSet.

**Auto-stop on startup** — `provider.auto-stop-on-startup` (default `true`) means Sablier will stop any running instances it didn't start, after initial discovery. This can be disabled if you want Sablier to manage only explicitly requested instances.

**Docker healthcheck awareness** — `container_inspect.go` reads `spec.State.Health.Status`. Containers marked `healthy` are reported as ready; `unhealthy` containers are unrecoverable. Containers running without a healthcheck get a warning log but are still reported as ready (with a recommendation to add healthchecks).

**AutoStopAllUnregisteredInstances** — in `autostop.go`, this function lists running instances, checks which aren't in the session store, and stops them. This is a separate mechanism from TTL expiry; it's a bulk cleanup pass that's called on startup or on demand.

**Valkey keyspace events** — the Valkey store enables `notify-keyspace-events KEx` so expiration callbacks fire as Redis keyspace notifications rather than polling. The in-memory store uses `tinykv` which has an internal ticker-based TTL sweep.

## Assessment

**Strengths:**

- Clean provider abstraction — swapping Docker for K8s requires only a config change
- Deduplicated async starts prevent thundering herd on cold starts
- Well-tested with `testcontainers-go` for all four providers (includes DinD and k3s modules)
- Small, focused codebase — easy to understand and audit
- Health-check-aware readiness detection (Docker health status, K8s replica counts)
- Group-based batch operations for correlated starts (e.g., start a whole stack)

**Concerns:**

- Group polling every 2 seconds is polling-based, not event-driven. For large deployments this adds unnecessary load.
- No authentication on the HTTP API — any caller who can reach port 10000 can start/stop instances. Reverse proxy plugins are expected to gate access, but there's no built-in protection.
- The Valkey store is the only distributed option; there's no distributed locking. Two Sablier instances could race on start/stop for the same instance.
- Instance names are opaque strings — there's no schema validation (e.g., K8s name format). Bad names produce cryptic errors from the underlying provider.

**Recommendations:**

- Add mutual TLS or a static API token for the HTTP endpoint to prevent unauthorized access
- Replace group polling with provider event streams (Docker events, K8s watch API) for efficiency
- Document that `X-Sablier-Status` header must be passed through by the reverse proxy for the integration to work correctly