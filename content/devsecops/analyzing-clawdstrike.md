---
title: "Analyzing Clawdstrike"
date: 2026-05-07
type: codebase-analysis
status: complete
source: https://github.com/backbay-labs/clawdstrike
tags: [rust, typescript, ai-security, agent-security, swarm-detection-response, policy-as-code, multi-agent, threat-hunting, runtime-enforcement]
---

# Analyzing Clawdstrike

> **Source:** [backbay-labs/clawdstrike](https://github.com/backbay-labs/clawdstrike) @ [`b69fb27`](https://github.com/backbay-labs/clawdstrike/commit/b69fb2727ff4aa32fbbe6485581336baed011ce9)

## Overview

Clawdstrike is a runtime security enforcement and threat hunting engine for autonomous AI fleets. It positions itself as "EDR for the age of the swarm" — enforcing policy at the tool boundary where agent intent becomes real-world action, with Ed25519-signed receipts for every decision. This analysis covers the codebase at commit `b69fb27`, examining architecture, design patterns, formal verification, and operational posture. The project is at v0.2.7 (pre-release) with ~258K lines of Rust, substantial TypeScript SDK/app layering, a Python SDK, Lean 4 proofs, TLA+ specifications, and a fuzzing corpus.

## How It Works

Clawdstrike sits between AI agent runtimes and their tool execution surfaces. An agent wants to read a file, call an API, or run a shell command — Clawdstrike intercepts that intent, evaluates it against a composable policy, and either allows it with a signed receipt or blocks it with cryptographic proof of denial. The system is intentionally fail-closed: if a policy fails to load or a guard encounters an error, the action is denied.

The core abstraction is the **Guard** — an async trait that receives a `GuardAction` (file access, network egress, shell command, MCP tool invocation, patch application, etc.) and a `GuardContext` (session, identity, organization, origin), returning a `GuardResult` (allow, block, warn, or sanitize). Thirteen built-in guards compose into a stack, from path access and egress control through jailbreak detection and Spider-Sense threat screening. A `HushEngine` orchestrates guard evaluation, aggregates verdicts, manages posture state (progressive capability restriction), and signs receipts.

Beyond single-agent enforcement, the system has three operational layers: the **Guard Stack** (per-agent tool-boundary enforcement), **Swarm C2** (fleet management over NATS JetStream with policy flow coordination via the Spine append-only transparency log), and **Swarm Trace** (cross-source threat hunting over signed receipts, kernel telemetry, and network flows). Multi-agent delegation uses signed capability tokens with cryptographic ceilings — re-delegation cannot grant more privileges than the parent token held.

## Architecture

The monorepo is organized into distinct tiers:

| Layer | Path | Responsibility |
|-------|------|---------------|
| **Crypto core** | `crates/libs/hush-core/` | Ed25519 signing, SHA-256/Keccak-256 hashing, Merkle trees, canonical JSON (RFC 8785), TPM support |
| **Decision core** | `crates/libs/clawdstrike/src/core/` | Pure functions: verdict aggregation, policy merge, cycle detection (no I/O, no serde) |
| **Guards + engine** | `crates/libs/clawdstrike/` | 13 guards, `HushEngine`, policy parsing (4156-line `policy.rs`), async guards, IRM monitors |
| **Policy verification** | `crates/libs/clawdstrike-logos/` | Compiles policies to Logos modal-temporal logic formulas; optional Z3 solver backend |
| **Spine protocol** | `crates/libs/spine/` | Signed envelopes, checkpoints with witness co-signatures, NATS JetStream transport, trust bundles |
| **Multi-agent** | `crates/libs/hush-multi-agent/` | Delegation tokens, identity registry, revocation stores, cross-agent correlation |
| **Daemon** | `crates/services/hushd/` | HTTP API server: policy evaluation, RBAC, SIEM export, Spine publishing, broker authority |
| **Broker daemon** | `crates/services/clawdstrike-brokerd/` | Local sidecar for secret injection and provider execution |
| **Bridges** | `crates/bridges/` | Tetragon, Hubble, auditd, k8s-audit, darwin-telemetry — ingest kernel events into Spine |
| **Hunt subsystem** | `crates/libs/hunt-{scan,query,correlate}/` | Threat hunting: MCP scanning, receipt queries, NL queries, timeline, rule correlation |
| **TS SDK** | `packages/sdk/hush-ts/` | `@clawdstrike/sdk` — pure TS guard implementations, session management, daemon client |
| **Framework adapters** | `packages/adapters/` | OpenAI, Claude, Vercel AI, LangChain, OpenClaw, OpenCode |
| **Apps** | `apps/` | Desktop (Tauri), agent (Tauri), workbench, control-console, academy, terminal |
| **Plugin** | `clawdstrike-plugin/` | Claude Code hooks (PreToolUse, PostToolUse, SessionStart/End, UserPromptSubmit), MCP server |

Data flows from agent action → guard evaluation → verdict → Ed25519-signed receipt → Spine envelope → NATS JetStream → bridge consumers → SIEM/audit trail. Every link in this chain is either signed or integrity-protected.

## The Spine

**Entry points:**

- **CLI** (`crates/services/hush-cli/`): `clawdstrike check`, `clawdstrike daemon start`, `clawdstrike hunt query`, `clawdstrike verify`
- **Daemon** (`crates/services/hushd/`): HTTP API on `127.0.0.1:9876` with endpoints for policy check, eval, audit, RBAC, SIEM export, Spine replay
- **Claude Code plugin** (`clawdstrike-plugin/`): Shell hooks that bridge to the CLI binary; MCP server exposing `clawdstrike_check`, `clawdstrike_scan`, `clawdstrike_hunt` tools
- **TS SDK** (`packages/sdk/hush-ts/`): `Clawdstrike.withDefaults("strict")` — in-process or daemon-backed evaluation
- **Python SDK** (`packages/sdk/hush-py/`): `pip install clawdstrike` with native Rust extension

**Request lifecycle** (daemon path):
1. Agent calls SDK → SDK sends HTTP POST to `hushd` `/v1/check`
2. `hushd` authenticates request, resolves effective policy (with scoping by identity/org)
3. `HushEngine::check()` runs: posture precheck → origin/enclave resolution → guard pipeline → async guards
4. Verdict aggregated (fail-fast or collect-all depending on policy setting)
5. Receipt created with canonical JSON hash of decision, policy hash, and evidence
6. Receipt signed with Ed25519 keypair (or TPM-sealed key)
7. Receipt stored, optionally published as Spine envelope to NATS JetStream
8. Response returned with decision + receipt

## Key Patterns

**Fail-closed semantics throughout.** Configuration errors at engine construction set a sticky `config_error` field — all subsequent checks deny. Async guard init errors similarly fail-closed. Policy parsing rejects unknown fields (`#[serde(deny_unknown_fields)]`). This is a deliberate design philosophy encoded at every layer.

**Feature-gated WASM compatibility.** The `clawdstrike` crate has a `full` feature flag. Detection modules (jailbreak, prompt injection, spider-sense, output sanitizer) compile to WASM without tokio. The full engine requires `full`. This enables browser and edge deployment of detection logic.

**Policy inheritance with cycle detection.** Policies use `extends` to inherit from built-in rulesets, local files, remote URLs, or git refs. The `core::cycle` module detects cycles with a depth limit of 32. The Lean 4 spec proves termination of this cycle detection against the actual Rust implementation via Aeneas extraction.

**Delegation with cryptographic capability ceilings.** Multi-agent delegation tokens carry a `cel` (capability ceiling) field. When agent A delegates to agent B, B's re-delegated token cannot exceed A's ceiling. This is enforced at token creation time by intersecting parent ceilings with requested capabilities.

**Bridge outbox pattern.** All bridges (`bridge-runtime`) use a SQLite-backed outbox with exponential backoff retry, idempotent enqueue (constraint violation = success), Prometheus metrics, and readiness probes. This decouples event ingestion from NATS availability.

**Clippy deny on unwrap/expect.** The workspace enforces `unwrap_used = "deny"` and `expect_used = "deny"` at the clippy level, with test-code exception via `#![cfg_attr(test, allow(...))]`. This is unusually strict and reflects the security-critical nature of the code.

## Non-Obvious Details

**Lean 4 formal verification with Aeneas extraction.** The `formal/lean4/ClawdStrike/` directory contains a hand-written spec of the core decision logic (verdicts, aggregation, merge, cycle detection, evaluation) plus Aeneas-generated Lean from the actual Rust source. Proofs include `CycleTermination_Impl` (proving the Rust `check_extends_cycle` terminates correctly), `DenyMonotonicity`, `SpecImplEquiv` (spec-implementation equivalence), and `ReceiptSigning`. This is a genuine verification effort, not decorative.

**TLA+ posture state machine.** `formal/tlaplus/PostureStateMachine.tla` models the progressive posture restriction system with state ordering invariants, budget exhaustion transitions, and absorbing state properties. Properties checked include monotonicity of restrictiveness and liveness of budget consumption.

**Logos/Z3 policy verification.** The `clawdstrike-logos` crate compiles policies into modal-temporal logic formulas and can check consistency, completeness (all action types covered), and deny monotonicity (child policies cannot weaken prohibitions). The `clawdstrike verify --policy strict` CLI command runs this.

**Vendored NATS client.** The workspace patches `async-nats` with a vendored copy at `infra/vendor/async-nats`. This suggests either custom protocol extensions or dependency pinning for offline builds (the project supports `CARGO_NET_OFFLINE=true` builds via `infra/vendor/`).

**Fuzzing corpus covering 9 targets.** The `fuzz/` directory has targets for policy parsing, secret leak detection, SHA-256, Merkle proofs, IRM filesystem/network parsing, DNS/SNI parsing, and remote extends parsing — covering both the crypto primitives and the policy surface.

**HushSpec test framework.** `fixtures/hushspec/` contains a YAML-based policy testing framework with evaluation fixtures (expected outcomes for specific guard configurations), merge fixtures (expected policy merge results), and invalid policy fixtures (expected parse errors). This is used by the `hushspec_compiler` to generate test cases.

**EAS anchoring.** The `crates/services/eas-anchor/` crate provides Ethereum Attestation Service integration — receipts can be anchored on-chain for tamper-evident long-term storage.

**DCO sign-off required.** All contributions require `git commit -s` with Developer Certificate of Origin. Combined with two-maintainer review for crypto/guard/Spine changes, this is a strong governance posture.

## Assessment

### Strengths

- **Rigorous security engineering.** Fail-closed defaults, formal verification (Lean 4 + TLA+ + Z3), comprehensive fuzzing, explicit threat model, and documented non-goals create a strong security foundation.
- **Excellent crate decomposition.** The separation between `hush-core` (pure crypto), `core/` (pure decision logic), guards, engine, and services enables independent testing and verification.
- **Multi-language SDK coverage.** Rust, TypeScript, Python, WebAssembly, C FFI, and Go native bindings, plus framework adapters for every major AI SDK, make adoption practical.
- **Operational tooling.** Helm charts, Cilium network policies, Dockerfiles, systemd/launchd configs, Homebrew formula, and Prometheus metrics show production awareness.

### Concerns

- **Engine complexity.** `engine.rs` is 4,599 lines with ~30+ public methods. The `HushEngine` struct holds mutable state behind `Arc<RwLock<>>`, manages guards, async guards, custom guards, extra guards, posture programs, and signing — this is a God struct approaching the complexity threshold where bugs become hard to reason about.
- **Three policy implementations.** Policies exist as Rust structs (`policy.rs`), TypeScript objects (`clawdstrike.ts` `BUILTIN_POLICIES`), and YAML rulesets. Keeping these in sync across a fast-moving codebase is a maintenance risk. The `egress_allowlist_plugin_parity` test file suggests this is a known pain point.
- **Pre-release posture.** At v0.2.7, public APIs are "expected to be stable" but "behavior and defaults may still evolve." The `deny.toml` has five active advisory exceptions with expiry dates in 2026, indicating known supply-chain debt.
- **Beta-quality documentation.** The README is 1,126 lines with promotional content intermixed with technical documentation. Core concepts are well-explained but operational runbooks and migration guides are thin.

### Recommendations

- Consider splitting `HushEngine` into smaller focused components (e.g., `PostureEngine`, `ReceiptEngine`, `GuardOrchestrator`) to reduce cognitive load and improve testability.
- Establish a single source of truth for built-in policy definitions, with code generation for language-specific SDKs rather than manual duplication.
- Prioritize clearing the five outstanding dependency advisories before 1.0 GA, especially `rustls-pemfile` (RUSTSEC-2025-0134) in the NATS transport path.

## Related

- [[analyzing-zeroshot]] — Zero-trust AI agent security architecture
- [[analyzing-stride-gpt]] — LLM security threat modeling with STRIDE
- [[analyzing-oat]] — AI agent compliance testing framework
- [[analyzing-microsandbox]] — MicroVM sandboxing for AI agent isolation
