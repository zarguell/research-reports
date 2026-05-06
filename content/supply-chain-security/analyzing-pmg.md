---
title: "Analyzing PMG (Package Manager Guard)"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/safedep/pmg
tags: [go, supply-chain-security, npm, pypi, sandboxing, proxy, cli]
---

# Analyzing PMG (Package Manager Guard)

## How It Works

PMG is a supply-chain security tool that intercepts package installations across 10 package managers (npm, pnpm, yarn, bun, npx, pnpx, pip, pip3, uv, poetry) and checks every package for malware before it executes. It does this transparently — you alias `npm` to `pmg npm` and the tool wraps the real package manager, analyzing dependencies via gRPC calls to SafeDep's Malysis threat intelligence API.

The tool operates in two modes. **Guard mode** (default) works pre-flight: it parses your command, resolves the dependency tree, sends every package to the analysis API concurrently (up to 10 in parallel), blocks verified malware outright, prompts for confirmation on suspected malware, and only then executes the real package manager — optionally inside an OS-native sandbox (macOS Seatbelt or Linux Bubblewrap). **Proxy mode** (experimental) is more surgical: it starts a local MITM HTTP proxy, forces the package manager's traffic through it via `HTTP_PROXY` env vars, and analyzes each registry request in real-time as it happens. This catches transitive dependencies that guard mode might miss, but requires an ephemeral CA certificate and a clever PTY input switchboard to handle the UX of presenting confirmation prompts while the package manager is still running.

Both modes share the same analysis backend: a single gRPC call to `QueryPackageAnalysis` that returns a three-tier verdict — Allow, Confirm, or Block — based on SafeDep's malware inference and verification systems.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    CLI Entry Points                  │
│  cmd/npm/  cmd/pypi/  cmd/executors/  cmd/setup/   │
└──────────────────────┬──────────────────────────────┘
                       │
              ┌────────▼────────┐
              │ config.Get()    │
              │ (global viper)  │
              └────────┬────────┘
                       │
          ┌────────────▼────────────┐
          │ config.IsProxyModeEnabled?│
          └──┬──────────────┬────────┘
     No       │              │       Yes
              │              │
   ┌──────────▼──────┐  ┌────▼──────────────┐
   │ Guard Mode      │  │ Proxy Mode         │
   │ (pre-flight)    │  │ (real-time MITM)   │
   └──────────┬──────┘  └────┬──────────────┘
              │              │
   ┌──────────▼──────┐  ┌────▼──────────────┐
   │ guard.Run()     │  │ MITM Proxy Server  │
   │  1. Extract pkgs│  │ + Interceptors     │
   │  2. Resolve deps│  │ + Cert Manager     │
   │  3. Analyze     │  │ + Input Switchboard│
   └───────┬─────────┘  └────┬──────────────┘
           │                   │
   ┌───────▼───────────────────▼────────┐
   │        MalysisQueryAnalyzer        │
   │  gRPC → community-api.safedep.io  │
   │  circuit breaker + in-mem cache   │
   └──────────────────┬────────────────┘
                      │
   ┌──────────────────▼────────────────┐
   │      executor.ApplySandbox()      │
   │  macOS: sandbox-exec (Seatbelt)   │
   │  Linux: bwrap (Bubblewrap)        │
   └──────────────────┬────────────────┘
                      │
              ┌───────▼──────┐
              │ Real PM runs │
              └──────────────┘
```

### Key Packages

| Package | Role |
|---------|------|
| `cmd/` | One cobra command per PM — thin wrappers that parse args and dispatch to a flow |
| `internal/flows/` | Two flows: `common_flow.go` (guard) and `proxy_flow.go` (proxy) |
| `guard/` | Guard mode orchestrator — extract, resolve, analyze, block/allow |
| `analyzer/` | Single analyzer: `MalysisQueryAnalyzer` — gRPC client to SafeDep API |
| `packagemanager/` | `PackageManager` interface + per-PM implementations (npm, pypi) + resolvers |
| `extractor/` | Uses Google's `osv-scalibr` to parse lockfiles and extract package lists |
| `proxy/` | MITM proxy server, ecosystem-specific interceptors (npm/pypi), cert manager, cooldown |
| `sandbox/` | OS-native sandboxing with YAML policy system supporting inheritance |
| `config/` | Viper-based global config with cobra integration, embedded defaults, YAML merge |
| `internal/audit/` | Dual-sink audit: daily-rotating local JSON logs + optional cloud sync |
| `internal/pty/` | PTY session management for spawning and interacting with child PMs |

## The Spine

### Guard Mode Flow

```
pmg npm install lodash
  → cmd/npm/npm.go: executeNpmFlow()
  → npmPM.ParseCommand(args) → ParsedCommand{InstallTargets: [{lodash}]}
  → flows.Common(pm, resolver).Run(ctx, args, parsedCmd)
    → Create MalysisQueryAnalyzer (gRPC)
    → guard.Run(ctx, args, parsedCmd)
      → If manifest install: extractor.ExtractManifest() → parse lockfile → packages
      → If explicit targets: resolver.ResolveDependencies(pkg) → flat dep list
      → concurrentAnalyzePackages() (goroutine pool, max 10)
        → analyzer.Analyze(ctx, pkg) → gRPC QueryPackageAnalysis
          → Not malware → ActionAllow
          → Inferred malware → ActionConfirm (or Block if --paranoid)
          → Verified malware → ActionBlock
      → Any blocks? → log error + exit
      → Any confirms? → prompt user → block if declined
      → All clean → executor.ApplySandbox() → runner.Execute() → cmd.Run()
```

### Proxy Mode Flow

```
pmg npm install lodash  (proxy_mode: true)
  → flows.ProxyFlow(pm, resolver).Run(ctx, args, parsedCmd)
    → Generate ephemeral CA cert + system CA bundle merge
    → Create MITM proxy server on 127.0.0.1:0 (random port)
    → Create ecosystem-specific interceptors (NpmRegistry / PypiRegistry)
    → Set HTTP_PROXY, HTTPS_PROXY, NODE_EXTRA_CA_CERTS, etc.
    → Spawn PM in PTY with proxy env vars
      → npm → HTTPS_PROXY → PMG proxy
        → CONNECT registry.npmjs.org → ShouldMITM? → Yes → intercept
        → GET /lodash → analyzer.Analyze() → Allow/Block/Confirm
        → If Confirm → pause PTY output, switch terminal to cooked mode,
          route stdin to confirmation prompt, resume after answer
    → Post-execution: collect stats, audit log, clean up temp certs
```

## Key Patterns

**Near-hexagonal architecture.** The `guard` package takes function callbacks for UI interactions instead of depending on the `ui` package directly. This keeps the core logic testable without a terminal.

**Global singletons with manual DI for the core.** Config, audit, and analytics are global singletons initialized at startup. But the guard and proxy flows construct their dependencies (analyzer, resolver, sandbox) explicitly and pass them down — no service locator pattern for the critical path.

**Dual error system.** User-facing sentinel errors use `usefulerror.Useful()` — a builder pattern that attaches error codes, human-readable messages, and help text. Internal errors use `fmt.Errorf` wrapping with `%w`. Errors always propagate up; the AGENTS.md explicitly forbids swallowing them.

**Ecosystem abstraction.** Every package manager implements the same two interfaces: `PackageManager` (name, parse command, ecosystem) and `PackageResolver` (resolve versions, resolve transitive deps). Adding a new PM means implementing these two interfaces plus a cobra command file.

**Config layering.** Precedence: cobra CLI flags > environment variables > `~/.pmg/config.yml` > embedded defaults from `config.template.yml`. Config templates use YAML merge for backward-compatible upgrades — new config keys get sensible defaults without requiring user intervention.

**Testing.** Table-driven tests with `testify` (assert/require). Config isolation via `t.Setenv("PMG_CONFIG_DIR", tmpDir)`. No mock generation — tests exercise pure functions directly. E2E tests in `/test/`.

## Non-Obvious Details

### The PTY Input Switchboard

The most impressive UX engineering in the codebase. In proxy mode, PMG needs to show confirmation prompts *while the package manager is still running* — both fighting over stdin/stdout. The solution uses three coordinated mechanisms:

- **`InputRouter`** — atomically swaps stdin destination between the PTY (child process) and a confirmation prompt pipe using `atomic.Pointer` for lock-free switching
- **`OutputRouter`** — buffers PM output while a prompt is active to prevent garbling the UI, then flushes on resume
- **Terminal mode switching** — toggles between raw mode (child process gets raw keystrokes) and cooked mode (user gets line editing for y/n confirmation)

The invariant: only one goroutine reads from stdin (prevents data splitting). Known limitation: `os.Stdin.Read()` is a blocking syscall that can't be cancelled, so the reader goroutine leaks until process exit.

### The Cooldown System Does Response Surgery

Cooldown doesn't maintain a blocklist — it **modifies registry API responses in-flight** so the package manager's own resolver can't "see" recently-published versions. For npm, it strips entries from `versions`, `time`, and `dist-tags` JSON objects in the packument response. For PyPI, it filters file entries from PEP 691 JSON. It forces full 200 responses (strips caching headers) and sets `Cache-Control: no-store` to prevent the PM from caching the modified response. The granularity is calendar-day (`time.Since(publishDate).Hours() / 24` as integer division).

### Ephemeral CA with System Bundle Merging

The MITM CA is generated fresh every invocation (RSA 2048, valid 365 days, written to `/tmp/pmg-ca-cert-{pid}.pem`). The clever bit: `GenerateCAWithSystemCA()` appends the system's CA bundle to the PMG CA cert, so the package manager trusts both the MITM proxy *and* all original system CAs. System CA discovery covers OpenSSL Homebrew, Debian/Ubuntu/RHEL paths, Git for Windows bundles, and more — with a 10MB size cap and graceful fallback. Per-host certs are generated on-demand with singleflight dedup and cached for 1 hour.

### Sandbox Policy Inheritance Uses Pointer Booleans

Child policies can only *add* rules, never *remove* parent rules (union semantics). Boolean fields like `AllowPTY` use `*bool` pointers to distinguish "child explicitly set false" from "child didn't specify, inherit from parent." If no policy is configured for a package manager when sandbox is enabled, it errors out — it won't silently run unsandboxed. Runtime `--sandbox-allow` flags remove exact matches from deny lists but leave glob patterns intact (intentional security decision).

### Guard Mode Can't Trace Transitive Origins

There's a TODO in `guard.go`: guard mode doesn't build a full dependency tree, so when it blocks a malicious transitive dependency, it can't tell you which top-level package pulled it in. Proxy mode doesn't have this limitation — it sees the actual HTTP request flow.

### Only 3 TODOs in the Entire Codebase

The codebase is remarkably clean. The three are: GitHub npm registry URL parsing not implemented, GitHub blob storage URL parsing not implemented, and the dependency tree tracing gap mentioned above.

## Assessment

**Strengths:**

- Clean, well-organized Go codebase that follows idiomatic conventions consistently. The near-hexagonal separation makes core logic testable without terminal I/O.
- The proxy mode's input switchboard is genuinely clever UX engineering — transparent interception with inline confirmations is a hard problem and they've solved it well.
- Security-conscious design: sandbox fails closed (errors if unavailable rather than running unsandboxed), cooldown modifies responses rather than maintaining blocklists, ephemeral certs with cleanup.
- The config template merge system is thoughtful — backward-compatible config upgrades without user intervention.
- Good use of concurrency: goroutine pool for analysis, singleflight for cert generation, circuit breaker for API resilience.

**Concerns:**

- **Single analysis backend.** Everything depends on `community-api.safedep.io` being available and correct. The circuit breaker helps (30s open window after 3 failures), but in guard mode a circuit open means *all* packages are allowed through. In proxy mode the same — packages get `ActionAllow` when the API is unreachable. This is a reasonable trade-off but worth knowing.
- **No Windows support.** Sandbox returns an error on Windows. Proxy mode's PTY management is Unix-only. The tool is effectively macOS/Linux only.
- **Guard mode's flat dependency list.** No tree structure means no "X pulled in Y" reporting. If you're doing `npm install express` and a transitive dep 5 levels deep is malware, you'll know it's blocked but not what required it.
- **os.Exit() skips defers.** Proxy flow calls `os.Exit()` to propagate child exit codes, which skips deferred cleanup. They handle this by emitting audit events *before* the exit, but it's a fragile pattern.

**No DX concerns.** The AGENTS.md is comprehensive, tests use table-driven patterns, and the code is readable without excessive comments. The project has an active CLAUDE.md symlink (for Claude Code agents), which signals mature AI-assisted development practices.
