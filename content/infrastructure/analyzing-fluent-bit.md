---
title: "Analyzing Fluent Bit"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/fluent/fluent-bit @ 0544ad7
tags: [c, cloud-native, log-processing, observability, telemetry, fluent-bit, plugin-architecture]
---

# Analyzing Fluent Bit

> **Source:** [fluent/fluent-bit](https://github.com/fluent/fluent-bit) @ [`0544ad7`](https://github.com/fluent/fluent-bit/commit/0544ad7d5673574851dbbcf1b2cac9f57ebf5b07)

## How It Works

Fluent Bit is a telemetry agent written in C that collects, processes, and forwards logs, metrics, and traces. It operates a **pipeline model**: data enters through input plugins, optionally passes through filter plugins, gets routed by tag matching, and exits through output plugins. A processor layer sits on top of inputs and filters, enabling multi-stage transformations without changing the core loop.

The engine is event-driven. Instead of threads-per-connection, Fluent Bit runs a single event loop (`mk_event_loop`, built on top of Monkey HTTP server) backed by a coroutine scheduler (`libco`). Each output plugin runs in a coroutine so network I/O on one output doesn't block the entire pipeline. Input plugins register file descriptors or timers with the event loop and receive callbacks when data is ready.

Configuration is parsed at startup from a YAML or classic config file into a global `struct flb_config`. Plugins declare their options through a static config map table (`FLB_CONFIG_MAP_*` macros), which the core engine uses to validate and bind properties without knowing plugin-specific details. This decouples the engine from plugin schemas.

## Architecture

```
[Input Plugin] ──► [Input Chunk] ──► [Processor] ──► [Router]
     │                  │                │
     └── event loop fd ─┘                │
                                        ▼
                              [Filter Plugin] (optional)
                                        │
[Output Plugin] ◄── [Task] ◄── [Router] (tag-matched)
     │
     └── coroutine (libco) ──► upstream connection pool
```

**Top-level directories:**
- `src/` — core engine: event loop (`flb_engine.c`), routing (`flb_router.c`), task dispatch (`flb_task.c`), storage (`flb_storage.c`), config parsing (`flb_config.c`, `config_format/`)
- `plugins/` — input (`in_*`), filter (`filter_*`), output (`out_*`), and processor (`processor_*`) plugins
- `include/fluent-bit/` — public headers with plugin interface structs (`flb_input_plugin.h`, `flb_output_plugin.h`, `flb_filter_plugin.h`)
- `lib/` — vendored libraries: `monkey` (HTTP server + event loop), `libco` (coroutines), `msgpack-c`, `luajit`, `onigmo` (regex), `chunkio` (storage), `cmetrics`/`cprofiles`/`ctraces` (telemetry format encoders)

**Bundled telemetry format libraries** (`lib/cmetrics`, `lib/cprofiles`, `lib/ctraces`) are notable: Fluent Bit doesn't just forward data — it encodes Prometheus-style metrics, OpenTelemetry profiles, and OpenTelemetry traces into wire formats internally using these dedicated libs.

## The Spine

The spine runs through `src/fluent-bit.c` → `src/flb_lib.c` → `src/flb_config.c` → `src/flb_engine.c`.

1. **`flb_create()`** (`src/flb_lib.c`) creates an `flb_lib_ctx` holding a `mk_event_loop` and `struct flb_config`.
2. **`flb_input()`**, **`flb_filter()`**, **`flb_output()`** register plugin instances into the config's linked lists (`config->inputs`, `config->filters`, `config->outputs`).
3. **`flb_start()`** calls `flb_engine_start(config)` (`src/flb_engine.c`), which initializes the event loop, starts input collectors, and enters the main event dispatch loop.
4. Input plugins push data into **input chunks** (`flb_input_chunk.c`) — ring buffers backed by file storage (`lib/chunkio`).
5. The **router** (`flb_router.c`) matches each chunk's tag against configured match rules (literal, wildcard `*`, or regex via `onigmo`) and dispatches to filter chains and output instances.
6. The filter chain runs synchronously on the caller's thread. Output dispatch runs via **tasks** (`flb_task.c`) — each task executes in a `libco` coroutine so the engine can interleave I/O.

A **task map** (`config->task_map`, a flat array of task pointers) maps small integer task IDs to task structs. The map has a default size of 2048 and a hard ceiling of 16,384 (expressed in the comments as a 14-bit limit from the underlying messaging mechanism).

## Key Patterns

**Plugin registration via static struct** — Every plugin exposes a `static struct flb_input_plugin in_tail` with callback function pointers (`cb_collect`, `cb_ingest`, `cb_init`, `cb_exit`, `cb_flush`). The global `flb_input_plugin` list is populated by the CMake build system scanning source files. This is a compile-time plugin registry: no `dlopen` needed for built-in plugins.

**Config map** — Plugins define their options using `FLB_CONFIG_MAP_INT`, `FLB_CONFIG_MAP_STR`, etc. The engine walks the config tree and populates plugin structs via `flb_output_config_map_set()` at init time. This pattern is used everywhere: inputs, outputs, filters, and stream processors.

**Coroutines via libco** — `lib/co.c` provides `flbCoroutineCreate`/`flbCoroutineSwitch`. Output plugins run in coroutines so that while one output waits for a TCP write, the engine can schedule another. The stack size is configurable at runtime (`-s` flag) and can be set per-plugin.

**Event loop** — Monkey's `mk_event_loop` (exposed via `include/monkey/mk_core.h`) is the I/O multiplexer. Plugins register FDs; the engine dispatches callbacks. It supports timers, fd events, and signal-based shutdown.

**Storage layer** — `lib/chunkio` manages on-disk chunk files. Chunks are content-addressed, named by hash, and organized by tag. The storage layer handles backpressure: if outputs are slow, chunks accumulate on disk and ingestion continues without loss.

## Non-Obvious Details

- **Task map 14-bit limit** — `config->task_map` can hold at most 16,384 concurrent tasks. This is a hard constraint from the messaging mechanism (the comments explicitly note it). Under high fan-out (many filters × many outputs), the task map could exhaust before the engine's nominal throughput is reached.
- **Input chunk as the core buffering primitive** — `struct flb_input_chunk` (not the storage layer's chunkio chunk) is the unit of work inside the engine. It's a wrapped msgpack buffer with reference counting, timers, and filters applied to it. Understanding this struct is key to understanding the ingestion path.
- **Processor plugin layer** — Processors sit *above* inputs and filters as a separate plugin type, not a sub-step of filters. An input can have a processor attached, and so can a filter. Processors can be chained. This adds flexibility but also complexity: data can be transformed multiple times in multiple stages.
- **Upstream/downstream abstraction** — `flb_upstream` and `flb_downstream` (not the network-upstream concept) manage connection pools to output endpoints. `flb_downstream` wraps TLS sessions; `flb_upstream` handles load balancing across multiple endpoint nodes. These are reused by outputs and inputs that make outbound connections.
- **Stream processor in C** — `src/stream_processor/flb_sp.c` is a full SQL-stream processor written in C (not a Lua script). It supports `SELECT`, `CREATE`, `GROUP BY`, time windows, and aggregations. This is a notable architectural bet: a native C query engine rather than embedding Lua or Python.
- **LuaJIT as a plugin runtime** — `lib/luajit-7152e154` is a locked submodule. Filter plugins can use Lua for dynamic transformations. The Lua VM is initialized per-input-instance, not globally.

## Assessment

**Strengths:** The plugin architecture is clean and consistent. The compile-time plugin registry avoids the complexity of dynamic loading while keeping the engine simple. The coroutine model is well-suited to the I/O-bound nature of log forwarding. The storage layer with on-disk buffering provides backpressure without losing data. The project has significant production deployment scale — stated at 10M+ daily deployments and 15B+ downloads.

**Concerns:** The task map's 16,384 ceiling is an undocumented hard limit that could silently throttle high-fan-out configurations. The C codebase lacks the memory safety guarantees of Rust or Go, which matters given Fluent Bit often runs in security-critical positions. Error propagation between plugin stages is implicit — a filter failure returns an int code, but the engine's behavior depends on how each plugin interprets and handles errors.

**Operational DX:** CMake build is standard. The in-tree Python integration test suite (`tests/integration/`) covers protocol-level behavior end-to-end. Valgrind is supported for memory safety verification. The project maintains a clear commit message convention enforced by a linter script.

**Security posture:** TLS is built-in and the connection layer supports certificate verification. The HTTP server exposes a monitoring API. External plugin loading (`-e` flag) uses `dlopen` and runs code with the fluent-bit process's privileges — the configuration documentation notes this as a feature, but it requires caution in untrusted environments.

The core architecture is well-suited to its role as a lightweight telemetry agent. The plugin model is extensible, the event loop is efficient, and the storage layer is robust. The primary maintenance surface is in the plugin ecosystem and the ongoing task of keeping bundled library dependencies current.