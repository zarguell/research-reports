---
title: "Analyzing Microsandbox"
date: 2026-05-07
type: codebase-analysis
status: complete
source: https://github.com/superradcompany/microsandbox
tags: [rust, microvm, sandboxing, libkrun, oci, ai-agents, cli, embedded-runtime]
---

## How It Works

Microsandbox boots lightweight microVMs in milliseconds using libkrun as the VMM backend. The mental model: you specify an OCI image (or local rootfs/disk), configure resources, and call `Sandbox::builder("name").image("python:3.12").create().await`. Under the hood, the SDK pulls and caches the image (materializing OCI layers into read-only EROFS images), spawns a child process that becomes the sandbox VM via libkrun's `Vm::enter()` — which never returns — and communicates with the guest over a CBOR-framed virtio-serial channel. Each sandbox is a separate OS process with its own VM; there's no shared hypervisor daemon.

Inside the guest, `agentd` runs as PID 1. It performs synchronous init (mounting filesystems, configuring networking, installing TLS certificates, applying resource limits), optionally hands off PID 1 to a real init system (systemd, OpenRC) via a fork+exec dance, then enters an async agent loop serving exec requests from the host. The host-side runtime runs a relay process: a Unix domain socket (`agent.sock`) accepts SDK client connections and transparently forwards protocol frames between clients and the guest over virtio-console ring buffers.

> **Source:** [superradcompany/microsandbox](https://github.com/superradcompany/microsandbox) @ [`5f94146`](https://github.com/superradcompany/microsandbox/commit/5f9414632c6e831b3ac30c6a7c5abd44a8fec5b7)

Networking is entirely userspace via smoltcp — no TAP devices, no root, no network namespaces. The host-side smoltcp stack acts as a virtual router, assigning each sandbox a deterministic IP derived from a "slot" number (up to 65535 concurrent sandboxes). DNS interception, TLS MITM proxying for secrets injection, and network policy enforcement all happen in-process. The guest sees a standard Ethernet interface configured via env vars.

The project targets AI agent sandboxes specifically: untrusted code execution with secret injection, network policy control, and snapshot/fork for rapid environment reuse. SDKs in Rust, Python (PyO3), and Node.js (NAPI-rs) make it embeddable in any orchestrator.

## Architecture

The workspace is a ~97K-line Rust monorepo (edition 2024) with 11 crates organized in dependency order:

| Crate | Role |
|---|---|
| `microsandbox-utils` | Shared utilities (size types, wake pipes, TTL index) |
| `microsandbox-protocol` | Wire protocol: CBOR-over-virtio-serial codec, message types, env var constants |
| `microsandbox-db` | SQLite persistence via sea-orm (sandboxes, runs, images, volumes, snapshots, metrics) |
| `microsandbox-migration` | Database migrations (6 migrations, all schema creation) |
| `microsandbox-image` | OCI image pull, layer caching, EROFS generation, ext4 upper formatting, VMDK assembly |
| `microsandbox-filesystem` | VirtioFS backends: PassthroughFs, MemFs, DualFs (overlay-like policy composition) |
| `microsandbox-network` | smoltcp userspace networking, DNS interception, TLS proxy, secret injection, network policy |
| `microsandbox-runtime` | Sandbox process entry point: VM config, agent relay, heartbeat, metrics, exit observers |
| `microsandbox` | Public SDK crate: `Sandbox::builder()`, exec, filesystem, snapshots, volumes |
| `microsandbox-cli` | `msb` CLI binary with 18 subcommands |
| `agentd` | Guest-side daemon (excluded from workspace, built separately for musl/static linking) |

**Data flow:** SDK call → image pull (oci-client → EROFS materialization) → `spawn_sandbox()` (fork+exec the `msb sandbox` subprocess) → libkrun boots VM → agentd init → agent loop serves requests. The host relay bridges SDK clients (Unix socket) to the guest agent (virtio-console) without rewriting frame headers, using non-overlapping correlation ID ranges per client.

## The Spine

### CLI entry (`crates/cli/bin/main.rs`)

`main()` parses clap commands. The `Sandbox` subcommand is hidden — it's the internal sandbox process entry that calls `sandbox_cmd::run()`, which calls `microsandbox_runtime::vm::enter()` (never returns). All other commands (`run`, `create`, `exec`, `pull`, `snapshot`, etc.) run async via `run_async_command_anyhow()` with a tokio runtime. A background reaper task cleans up sandboxes whose processes crashed.

### SDK entry (`crates/microsandbox/lib/sandbox/`)

The fluent builder pattern: `Sandbox::builder("name").image("python:3.12").memory(512).cpus(2).create().await`. The `create()` method resolves the image (pulling if needed), writes config to the DB, prepares filesystem backends, and calls `spawn_sandbox()` which `fork()`s and `exec()`s the `msb sandbox` subprocess with serialized config. The parent then waits for the agent relay to signal readiness before returning the `Sandbox` handle.

### Guest entry (`crates/agentd/bin/main.rs`)

Agentd boots as PID 1, captures `CLOCK_BOOTTIME`, parses `MSB_*` env vars into `BootParams`, runs synchronous init (mounts, networking, TLS, rlimits), optionally performs PID 1 handoff via fork+exec, then enters the async agent loop on virtio-serial.

### Core lifecycle

```
SDK: Sandbox::builder().create()
  → Image pull + EROFS materialization
  → spawn sandbox process (fork + exec "msb sandbox")
  → sandbox process: write startup JSON → setup log capture
  → build AgentRelay (Unix socket) + heartbeat + metrics
  → build VM via msb_krun::VmBuilder (libkrunfw)
  → Vm::enter() — never returns
  → [inside guest] agentd init → mount rootfs → agent loop
  → SDK connects to agent.sock → sends ExecRequest → receives stdout/stderr/exit
```

## Key Patterns

**Fluent builders everywhere.** `SandboxBuilder`, `ExecOptionsBuilder`, `InitOptionsBuilder`, `NetworkBuilder`, `SecretBuilder` — all use method chaining with deferred error collection. Build errors accumulate but don't panic; they surface at `create()` time.

**Protocol design.** The wire format is `[len: u32 BE][id: u32 BE][flags: u8][CBOR payload]`. The fixed-position header lets the relay route frames without CBOR parsing. The `flags` byte encodes session start, terminal mode, and shutdown. Correlation IDs are assigned in non-overlapping ranges per SDK client so the relay never needs to rewrite headers.

**EROFS fsmerge for images.** OCI layers are individually converted to EROFS (read-only, compressed Linux filesystem) images, then concatenated via a VMDK descriptor into a single virtual block device. A writable ext4 upper layer provides the overlay. This avoids in-memory rootfs construction — the kernel reads directly from EROFS, and only writes go to the upper.

**Feature-gated networking.** The `net` feature flag controls compilation of the entire networking stack. Without it, sandboxes have no network device — useful for minimal builds.

**Three filesystem backends.** `PassthroughFs` (host directory via virtiofs), `MemFs` (in-memory, for temporary sandboxes), and `DualFs` (policy-based overlay of two backends — e.g., read from backend A, fall back to B, write to A). Policies are composable: `BackendAOnly`, `BackendAFallbackToBackendB`, `MergeReads`, `ReadBackendBWriteBackendA`.

**State in SQLite, artifacts on disk.** The DB tracks sandbox metadata, run history, image references, volume metadata, and snapshot indices. But the actual images, upper layers, and snapshot artifacts are content-addressed files in `~/.microsandbox/`. The DB is a cache of what's on disk, not the source of truth.

**Snapshot/fork model.** Snapshots capture a stopped sandbox's writable upper layer plus a manifest pinning the immutable lower (image digest). They're self-describing directories with `manifest.json` + upper file, content-addressed by digest. Forking creates a new sandbox from a snapshot's upper as its writable layer, enabling fast environment cloning.

## Non-Obvious Details

**"Unexploitable secrets" via TLS MITM.** When secrets are configured, the host-side TLS proxy terminates the guest's TLS connection with a per-domain generated certificate, then re-originates TLS to the real server. The guest receives a placeholder (e.g., `$MSB_OPENAI_API_KEY`); the real value is only injected into the plaintext HTTP stream for connections to allowed hosts. If the guest tries to exfiltrate a placeholder to a disallowed host, the `SecretsHandler` detects it and can block, log, or terminate the sandbox (`ViolationAction::BlockAndTerminate`). The secret value itself never enters the guest's memory.

**PID 1 handoff mechanism** (`crates/agentd/lib/handoff.rs`). Agentd starts as PID 1, performs all init (mounts, networking), then forks. The parent execs the target init (systemd), becoming the new PID 1. The child continues as a grandchild process running the agent loop. This happens before any tokio runtime exists, keeping the fork single-threaded and safe. The handoff is constrained by agentd's RSS (<5MB) since fork cost scales with mapped memory.

**Heartbeat-based idle timeout.** Agentd writes `/.msb/heartbeat.json` (via virtiofs, atomically via rename) with active session count and last activity timestamp. The host-side runtime polls this file every second; if idle timeout is configured and no sessions are active, it triggers VM exit.

**Clock sync** (`crates/agentd/lib/clock.rs`). Uses `CLOCK_BOOTTIME` (includes suspend time) to measure VM boot duration. The agentd binary captures this at startup for latency metrics, separate from the host-side wall-clock timing.

**VMDK fsmerge for multi-layer OCI images.** Rather than constructing an overlayfs at runtime, each OCI layer is materialized as a separate EROFS image, then a VMDK flat descriptor concatenates them into a single virtual block device. The kernel sees one disk with a merged filesystem — no overlayfs, no union mount, no FUSE overhead for reads.

**Serial communication as ring buffers.** The host and guest communicate via virtio-console, with the runtime maintaining shared ring buffer state (`ConsoleSharedState`). The `AgentRelay` reads from these ring buffers and relays to SDK clients over Unix domain sockets.

**rlimit inheritance.** Resource limits set via `SandboxBuilder::rlimit()` are applied during agentd's PID 1 startup. Every subsequent guest process inherits these raised baselines without explicit per-exec configuration.

## Assessment

**Strengths.** The architecture is clean and well-layered — the separation between protocol, runtime, networking, and SDK crates is sharp. The userspace networking (no root, no TAP devices) is a genuine differentiator for embedded/multi-tenant deployments. The secret injection model is clever: TLS MITM at the host edge means real secrets never touch guest memory, and violation detection is enforceable. The EROFS fsmerge approach avoids runtime overlayfs overhead. Code quality is high: comprehensive doc comments, pre-commit hooks (fmt, clippy, doc, build), clean error handling with `anyhow` chains, and thorough testing in the filesystem crate.

**Concerns.** The 16-bit slot limit (65535 concurrent sandboxes) constrains dense deployments. The TLS MITM approach, while secure by design, requires the guest to trust a custom CA — this could break applications with certificate pinning. The `panic = "abort"` in release profile means `Drop` impls don't run on panic, mitigated by explicit panic hooks. agentd being PID 1 means a crash kills the entire VM (by design, but worth noting). The macOS support depends on Apple Silicon HVF — no Intel Mac support.

**Maturity.** At v0.4.5, the project is in active beta. The feature set is remarkably complete for the version: OCI images, EROFS materialization, userspace networking, TLS interception, secret injection, snapshots, volumes, three SDKs, and an MCP server for AI agents. The migration history (6 migrations since March 2026) shows rapid schema evolution.

**Comparison.** Versus Firecracker: microsandbox trades Firecracker's minimal-VMI isolation for embedded convenience and userspace networking — no root needed, no separate VMM process management. Versus gVisor: microsandbox uses hardware virtualization (KVM/HVF) rather than syscall interception, giving stronger isolation at the cost of requiring hardware support. Versus containerd: microsandbox provides VM-level isolation in a library crate — embeddable in-process rather than requiring a daemon.
