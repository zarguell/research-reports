---
title: "Analyzing Falco"
date: 2026-05-10
type: codebase-analysis
status: complete
source: https://github.com/falcosecurity/falco
tags: [security, runtime-security, ebpf, linux, cplusplus, cloud-native]
---

*Source: [falcosecurity/falco](https://github.com/falcosecurity/falco) at commit [cd1a862](https://github.com/falcosecurity/falco/commit/cd1a862d42e7f2b086380a2a44bc5408b450c801)*

## How It Works

Falco is a Linux runtime security engine that observes system calls in real time and evaluates them against YAML-defined rules to detect anomalous or malicious behavior. Think of it as an intrusion detection system where the "signatures" are expressive filter expressions over syscall metadata, enriched with container and Kubernetes context.

The mental model is a pipeline:

1. **Kernel instrumentation** (eBPF probe, kernel module, or modern eBPF CO-RE) captures syscalls and pushes them into per-CPU ring buffers.
2. **libsinsp** (from the `falcosecurity/libs` submodule) reads events from the buffers, enriches them with process/container/K8s metadata, and yields `sinsp_evt` objects.
3. **The Falco rules engine** matches each event against compiled filter conditions derived from YAML rules. Matching rules produce alert results.
4. **The output subsystem** formats alerts and dispatches them to configured channels (stdout, file, syslog, HTTP, program) via an async queue.

This is a streaming architecture — events flow continuously, there is no request/response cycle.

## Architecture

The Falco repository (`falcosecurity/falco`) contains the userspace binary and engine. The heavy lifting — kernel drivers, syscall parsing, container enrichment — lives in the separate [`falcosecurity/libs`](https://github.com/falcosecurity/libs) repository, consumed as a git submodule.

```
userspace/
  engine/          ← Rules engine core (rule loading, compilation, evaluation)
  falco/           ← Application binary (CLI, config, outputs, event loop)
    app/           ← Ordered action pipeline (init → process events → teardown)
    app/actions/   ← Individual lifecycle steps as composable functions
```

| Component | Responsibility |
|-----------|---------------|
| `falco_engine` | Rule loading, source registration, event-to-rule matching |
| `rule_loader` (reader/collector/compiler) | YAML parsing → AST compilation → filter instantiation |
| `evttype_index_ruleset` | Event-type-indexed rule evaluation (the hot-path filter) |
| `falco_outputs` | Async output dispatch via TBB concurrent bounded queue |
| `falco_configuration` | YAML config parsing for engine, outputs, plugins |
| `libsinsp` (submodule) | Kernel driver interface, event parsing, container metadata |

## The Spine

The application lifecycle is implemented as an ordered list of function objects in `app.cpp`. Each action returns a `run_result` indicating success/failure and whether to proceed:

```cpp
std::list<app_action> const run_steps = {
    print_help, load_config, load_plugins,
    init_inspectors, init_falco_engine,
    load_rules_files, init_outputs,
    create_signal_handlers, configure_interesting_sets,
    start_webserver, process_events,
};
```

The event processing loop in `process_events.cpp` is the hot path:

1. `inspector->next(&ev)` — pulls the next `sinsp_evt` from the kernel buffer (via libsinsp).
2. `s.engine->process_event(source_idx, ev, strategy)` — runs the event through the rules engine.
3. For each matching rule: `s.outputs->handle_event(...)` — formats and enqueues the alert.
4. A background worker thread in `falco_outputs` dequeues messages and dispatches to all configured output channels.

The rules engine's `process_event` delegates to `filter_ruleset::run()`, which uses `evttype_index_ruleset` — a ruleset implementation that indexes enabled rules by event type code, then performs filter evaluation only on the relevant bucket. This avoids scanning all rules for every event.

Two matching strategies exist:
- **FIRST** (default): stops after the first matching rule.
- **ALL**: collects all matching rules (higher performance cost).

Live mode runs one inspector thread per event source (syscalls + plugin sources). Capture/replay mode uses a single thread with source-indexed dispatch per event.

## Key Patterns

**Action pipeline pattern.** The entire application lifecycle is a flat list of composable action functions. Each action is a standalone `.cpp` file in `app/actions/`. This makes the startup sequence explicit, testable, and easy to extend — just add a function to the list.

**Event-type indexed rulesets.** Rather than evaluating every rule's filter against every event, `evttype_index_ruleset` buckets rules by the syscall/event types they reference (extracted from the rule condition's AST at compile time). At evaluation time, only rules in the event's type bucket are checked. This is the primary performance optimization.

**Thread-partitioned engine.** `falco_engine::process_event` is thread-safe by contract: each caller must use a distinct `source_idx` and never switch. This means each event source's ruleset is accessed by exactly one thread — no locks needed on the hot path.

**Async output with backpressure.** `falco_outputs` uses a TBB `concurrent_bounded_queue` with a configurable capacity. A single worker thread drains the queue and calls each output's `output()` method. If the queue is full, events are dropped and a counter is incremented (`m_outputs_queue_num_drops`).

**Hot restart via SIGHUP.** The main loop in `falco.cpp` re-calls `falco_run` when the restart flag is set. Signal handlers set this flag atomically. This allows config/rule reload without process restart.

**Pluggable sources.** Beyond the built-in `syscall` source, Falco supports plugin event sources loaded as shared libraries. Each source gets its own inspector, filter factory, and formatter factory registered in the engine.

## Non-Obvious Details

> [!note] The rules are in a separate repository
> The default ruleset ships in [`falcosecurity/rules`](https://github.com/falcosecurity/rules), not in this repo. The `rules/` directory does not exist here — only the engine that evaluates them.

**The syscall source fast path.** `falco_engine` caches the syscall source pointer separately (`m_syscall_source`) and checks it with an explicit branch in `find_source()`, bypassing the indexed vector lookup. The comment says this is because syscalls can exceed 1M events/sec and every nanosecond matters.

**Sampling is two-tiered.** The `sampling_ratio` controls dropping at the kernel/inspector level. The `sampling_multiplier` adds a second layer of dropping inside the engine itself (`should_drop_evt()`). With multiplier=0 (default), only kernel-level sampling applies. With multiplier=1, the engine also probabilistically skips events proportional to the ratio.

**Rule conditions are compiled to sinsp filters.** YAML rule conditions are parsed into an AST by `rule_loader::reader`, collected and resolved (macros/lists expanded) by `rule_loader::collector`, then compiled into `sinsp_filter` objects by `rule_loader::compiler`. The compiled filters are what actually run against events — not the raw YAML.

**`falco_common::rule_matching` is configurable.** The default is `FIRST` (first match wins), but `ALL` mode evaluates every enabled rule against every event. The config key is `rule_matching` in `falco.yaml`. The engine supports both modes in the same codepath via a switch on the strategy enum.

**Output formatting is lazy.** `falco_outputs::handle_event` doesn't format the message immediately. It pushes a `ctrl_msg` into the concurrent queue. The worker thread calls `m_formats->format_event()` and then dispatches to each output. This keeps formatting off the hot event-processing thread.

## Assessment

**Strengths:**
- **Performance-conscious design.** The event-type indexing, syscall source caching, lock-free engine partitioning, and async output queue are all clearly designed for the >1M events/sec target. The performance story is consistent across the codebase.
- **Clean separation of concerns.** The engine, outputs, and application lifecycle are distinct classes with narrow interfaces. The action pipeline makes the startup sequence self-documenting.
- **Extensible plugin architecture.** Event sources, output channels, and rule conditions can all be extended without modifying the core engine.
- **Mature project governance.** CNCF graduated, multiple security audits, OpenSSF scorecard integration. The code is well-licensed (Apache 2.0) and has clear ownership (`OWNERS` files).

**Concerns:**
- **libsinsp is a submodule dependency.** The majority of the actual event capture and parsing logic lives in `falcosecurity/libs`, which this repo imports as a git submodule. Understanding the full picture requires reading two repos. This also means build complexity is high (cmake with many options).
- **C++ codebase with manual memory management.** While modern C++ patterns (smart pointers, RAII) are used consistently, the performance-critical paths use raw pointers (`sinsp_evt* ev`) and manual resource management. This is a tradeoff for speed.
- **Output drops are silent by default.** If the output queue fills up, events are silently dropped with only an internal counter. In high-throughput scenarios, alerts could be lost without operators noticing.

**Recommendations:**
- If adopting Falco, invest time understanding the `base_syscalls` config and `buf_size_preset` tuning — these have the largest impact on event drop rates.
- Use the `metrics` subsystem (Prometheus endpoint or file output) to monitor `outputs_queue_num_drops` and kernel drop counters.
- Prefer `modern_ebpf` engine kind — it uses CO-RE and requires no kernel module installation or BCC dependency.
- Write custom rules for your environment rather than relying solely on the default ruleset. The default rules are broad; specificity reduces noise.

## Related

- [[analyzing-trivy]] — container image vulnerability scanning
- [[analyzing-checkov]] — IaC static analysis
- [[analyzing-wazuh]] — host-based intrusion detection
- [[analyzing-prowler]] — cloud security posture assessment
