---
title: "Analyzing Fluent Bit"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/fluent/fluent-bit @ 0544ad7d5673574851dbbcf1b2cac9f57ebf5b07
tags: [c, cloud-native, log-processing, observability, telemetry, fluent-bit]
---

> **Source:** [fluent/fluent-bit](https://github.com/fluent/fluent-bit) @ [`0544ad7`](https://github.com/fluent/fluent-bit/commit/0544ad7d5673574851dbbcf1b2cac9f57ebf5b07)

## How It Works

Fluent Bit is a telemetry agent that collects, processes, and forwards **logs, metrics, and traces** from any source to any destination. It is deployed on over 10 million hosts daily and is a CNCF graduated project. The codebase is a C/C++ monorepo (~1000+ commits, 5.0 development branch) built with CMake, heavily modularized into `src/` (core engine), `include/` (public headers), `plugins/` (input/filter/output), and `lib/` (bundled libraries like cmetrics, ctraces, chunkio).

The core mental model is a **pipeline**: *input plugins → buffer → filters → router → output plugins*. Data flows through this pipeline in discrete chunks, each tagged with a string identifier. Tags drive routing decisions—output plugins subscribe to tag patterns (literal or glob/regex), and the router delivers matching chunks downstream.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         flb_config                               │
│  (global config: flush interval, storage, router, plugins)      │
└─────────────────────────┬───────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐
    │  inputs  │   │  filters │   │  outputs │
    │  (mk_list)│   │(mk_list) │   │ (mk_list)│
    └────┬─────┘   └────┬─────┘   └────▲─────┘
         │               │              │
         ▼               ▼              │
  ┌──────────────┐  ┌──────────┐     │
  │flb_input_chunk│──│flb_filter│     │
  │  (msgpack)   │  │  _do()   │     │
  └──────┬───────┘  └──────────┘     │
         │                             │
         ▼                             │
  ┌────────────────┐                  │
  │flb_engine_dispatch               │
  │  (scheduler-driven)              │
  └──────┬────────────────┘          │
         │                            │
         ▼                            │
  ┌──────────────┐                   │
  │flb_router    │────────────────────┘
  │  (tag-based) │
  └──────────────┘
```

**Directory structure:**
- `src/` — core engine (`flb_engine.c`, `flb_router.c`, `flb_task.c`, `flb_filter.c`, `flb_engine_dispatch.c`)
- `include/fluent-bit/` — public/internal headers
- `plugins/in_*` — input plugins (cpu, tail, syslog, opentelemetry, etc.)
- `plugins/filter_*` — filter plugins (grep, kubernetes, lua, parser, etc.)
- `plugins/out_*` — output plugins (stdout, forward, es, kinesis, s3, etc.)
- `lib/` — bundled deps: chunkio, cmetrics, ctraces, cprofiles, monkey

## The Spine

The spine runs through three interconnected components: **scheduler**, **engine dispatcher**, and **task system**.

**1. Entry: Input plugins collect data**

Input plugins (e.g., `in_cpu.c`, `in_tail.c`) implement a `cb_collect` callback that runs on a timer or event. They call `flb_input_chunk_append_raw()` or `flb_input_chunk_append_obj()` to write msgpack-encoded records into `flb_input_chunk` buffers. Each chunk has a 256KB hint size (`FLB_INPUT_CHUNK_SIZE = 262144`) and can span up to 2MB (`FLB_INPUT_CHUNK_FS_MAX_SIZE`).

**2. Scheduler fires the flush timer**

The scheduler (built on `mk_event_loop`, a libev-style reactor) sets a timerfd that fires every `flush` seconds (default: 1). When the timer fires, the event loop invokes the scheduler handler, which calls `flb_engine_dispatch()` for each input instance.

**3. flb_engine_dispatch() — the core dispatch loop**

This function (`src/flb_engine_dispatch.c:247`) is the heart of the pipeline. For each input instance with pending chunks:

1. It iterates chunks that aren't busy (`ic->busy == FLB_FALSE`)
2. Flushes the chunk buffer and tag via `flb_input_chunk_flush()`
3. Creates a `flb_task` via `flb_task_create()` — a task represents one unit of work (a buffer + routing metadata)
4. Calls `tasks_start()` to kick off processing

**4. flb_filter_do() — filter chain**

Before routing, the task's data passes through the filter chain (`src/flb_filter.c:119`). Each filter instance is checked against the chunk's tag using `flb_router_match()` (glob or regex). Matching filters get invoked sequentially, potentially modifying the chunk in-place or dropping records entirely.

**5. Router maps tag → outputs**

The router (`src/flb_router.c`) implements tag-based matching. The `flb_router_match()` function supports:
- Exact match: `app.log`
- Glob wildcard: `app.*`, `*.log`
- Double-star: `app.**` (recursive)
- Regex: if `FLB_HAVE_REGEX` is enabled

After filtering, `flb_task` holds a list of `flb_task_route` entries, one per matched output. Each route is `FLB_TASK_ROUTE_ACTIVE` and the task is dispatched to output threads.

**6. Output plugins flush data**

Output plugins implement `cb_flush`, which receives the raw msgpack buffer. The engine can run outputs synchronously, in threads, or via coroutines (`FLB_OUTPUT_SYNCHRONOUS`, `FLB_OUTPUT_NO_MULTIPLEX`). If flush fails, the output can return `FLB_RETRY`, which creates a `flb_task_retry` entry that the scheduler re-dispatches with backoff.

## Key Patterns

### Plugin registration via macros

Plugins register through macro-heavy registration tables. For inputs:
```c
struct flb_input_plugin in_tail_plugin = {
    .name         = "tail",
    .description  = "Tail files",
    .cb_collect   = cb_collect,
    .cb_terminate = cb_terminate,
    ...
};
FLB_PLUGIN_REGISTER(&in_tail_plugin, "in_tail");
```

This pattern keeps the plugin interface contract explicit in a single struct.

### Chunk-based buffering with Chunk I/O

All ingested data lives in `flb_input_chunk` structures, backed by `lib/chunkio/`. This provides:
- Memory-mapped file storage for large buffers
- Checksum validation
- Backpressure via `storage.max_chunks_up` (limits in-memory chunks)
- On-disk backlog for crash recovery

### Tag routing with direct routes

Fluent Bit v2 introduced **direct routes** (chunk headers with embedded route metadata) for more efficient routing. The `flb_chunk_direct_route` struct encodes label/plugin metadata at write time, avoiding a full routing table lookup at flush time.

### Config maps (FLB_CONFIG_MAP)

New-style configuration uses `FLB_CONFIG_MAP_STR/INT/BOOL` macros to declare expected config keys at registration time. This enables automatic validation, default value injection, and cleaner plugin code compared to manual `flb_config_get_property()` calls.

### TLS/network abstraction

Outputs use `flb_upstream` and `flb_downstream` for connection pooling with keepalive. TLS is handled through a `flb_tls` struct with mbedTLS under the hood.

### Task map (bitmask-based ID allocation)

Task IDs are allocated from a configurable bitmap (`flb_task_map`, default 2048 entries, max 16384 due to 14-bit constraint from the messaging mechanism). When the bitmap fills, no new tasks can be created until slots free up — a hard backpressure signal.

## Non-Obvious Details

**1. Task users counter and lifecycle**

`flb_task` has a `users` counter incremented every time a thread accesses it. The task is only destroyed when `users == 0` AND `retries` list is empty. This avoids use-after-free when the same task routes to multiple outputs or when retries are pending.

**2. Coroutine stack size is configurable but has a default**

`coro_stack_size` defaults to a system-dependent value but can be set in config. Coroutines enable async I/O in output plugins without full threading overhead.

**3. Monkey HTTP server is used for internal endpoints**

The same `monkey/mk_core` library powering the HTTP server feature also provides the core event loop (`mk_event_loop`). This is a fork of the Monkey web server project, not a third-party dependency.

**4. Chunk magic bytes for format detection**

Chunks start with magic bytes `0xF1 0x77` (since v1.8.10) to distinguish Fluent Bit chunks from raw msgpack files.

**5. Hot reload is experimental**

`enable_hot_reload` triggers a config reload on file change via an inotify-style watcher, but the feature has `ensure_thread_safety_on_hot_reloading` toggles, suggesting thread-safety issues are known.

**6. Singleplex queue for ordered output**

Outputs with `FLB_OUTPUT_NO_MULTIPLEX` use a `singleplex_queue` to serialize flushes — ensuring ordered delivery to destinations that require it (like Kubernetes stdout).

**7. Chunk type enum (v5+ adds Profiles)**

Chunk types are `LOGS=0`, `METRICS=1`, `TRACES=2`, `BLOBS=3`, `PROFILES=4`. Profile support (for OpenTelemetry profiling data like pprof) is new in v5.

**8. Routes mask for direct routing optimization**

`flb_route_mask_element` tracks which output plugins a chunk routes to, stored as a bitmask per chunk. This enables O(1) output matching for direct routes.

## Assessment

**Strengths:**
- Clean separation between core engine and plugins — easy to add new plugins without touching core
- Tag-based routing with glob/regex support is intuitive and flexible
- Chunk-based buffering with filesystem backing handles backpressure gracefully
- Embedded metrics (cmetrics/cmt) per output instance gives operational visibility out of the box
- Support for 5 event types (logs/metrics/traces/blobs/profiles) in a unified pipeline
- Direct routes optimization shows attention to high-throughput use cases

**Concerns:**
- The 14-bit task map limit (16384 tasks) is a hard ceiling — busy systems with many output plugins and retries can hit this
- Hot reload is explicitly marked experimental with known thread-safety concerns
- Monkey HTTP server is an unusual choice for the event loop — more common to see libuv or libevent as explicit dependencies
- Config map migration (old-style vs new-style) creates two plugin code patterns
- No built-in backpressure signaling to input plugins — backpressure is implicit via chunk limits

**Recommendations:**
- For high-volume deployments, tune `storage.max_chunks_up` and monitor `output_backpressure_wait_seconds` histogram
- The task map size should be made auto-scaling rather than compile-time configured
- Consider replacing the embedded Monkey event loop with a more widely-used alternative like libuv for easier community contributions

> [!question]
> The interaction between `singleplex_queue`, coroutines, and retry scheduling across hot reloads deserves deeper investigation — the retry rescheduling path in `flb_engine.c` has complex mutex interactions that could introduce race conditions under reload stress.