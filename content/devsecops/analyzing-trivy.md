---
title: "Analyzing Trivy"
date: 2026-05-09
type: codebase-analysis
status: complete
source: https://github.com/aquasecurity/trivy
tags: [go, security, scanner, containers, devsecops, supply-chain]
---

# Analyzing Trivy

> **Source:** [aquasecurity/trivy](https://github.com/aquasecurity/trivy) @ [a75a468](https://github.com/aquasecurity/trivy/commit/a75a468facbff12c81da00742709c88c0a4ad29d)

## How It Works

Trivy is a unified security scanner built in Go that treats every scan as a combination of two axes: **targets** (what to scan) and **scanners** (what to look for). Targets include container images, filesystems, git repositories, VM images, Kubernetes clusters, and SBOM files. Scanners cover vulnerabilities (CVEs), misconfigurations (IaC), secrets, licenses, and SBOM generation. The CLI exposes subcommands for each target — `trivy image`, `trivy fs`, `trivy repo`, `trivy k8s`, etc. — each of which selects which scanners to run.

Under the hood, a scan follows a three-stage pipeline: **inspect**, **scan**, **report**. The inspection phase uses a pluggable analyzer system (the `fanal` package) to walk the target artifact and extract structured data — OS packages from `/var/lib/dpkg`, language dependencies from lockfiles, IaC files from the filesystem. Analyzers register themselves globally via `init()` functions and are filtered at runtime based on what scanners are enabled. The scan phase then matches extracted packages against a local vulnerability database (bbolt-backed, served from GitHub Container Registry) or runs Rego-based policy checks for misconfigurations. The report phase filters, formats, and writes results.

Trivy also supports a **client/server mode** where the heavy lifting (vulnerability matching) runs on a server and the client handles artifact inspection locally. This separation is deliberate: artifact analysis requires access to the target, but vulnerability matching only needs the package list and the DB.

## Architecture

The codebase lives entirely under `pkg/` — there is no `internal/` directory of consequence. The main packages and their roles:

```
cmd/trivy/main.go          → Entry point, error handling, plugin delegation
pkg/commands/              → Cobra CLI wiring (app.go), per-target commands
pkg/commands/artifact/     → Runner orchestration: scan → filter → report
pkg/fanal/                 → Artifact analysis engine (the "eyes")
  analyzer/                → Pluggable analyzers (OS, language, config, secret, SBOM)
  artifact/                → Target adapters (image, local, repo, vm, sbom)
  applier/                 → Layer merging for container images
  image/                   → Image source abstraction (docker, OCI, tar)
pkg/scan/                  → Scan service (the "brain") — coordinates inspection + scanning
pkg/vulnerability/         → CVE matching against trivy-db
pkg/misconf/               → IaC misconfiguration scanning via Rego + trivy-checks
pkg/iac/                   → IaC parsing, detection, and scanner framework
pkg/types/                 → Core domain types (Report, Result, ScanOptions)
pkg/db/                    → Vulnerability database management
pkg/cache/                 → Scan result caching (memory, s3, redis)
pkg/report/                → Output formatting (table, JSON, CycloneDX, SPDX, SARIF)
rpc/                       → Protobuf definitions for client/server mode
```

## The Spine

A `trivy image alpine:3.18` scan flows through these steps:

1. **CLI parsing** (`pkg/commands/app.go`): Cobra routes to `NewImageCommand`. Flags are bound via Viper. Options are assembled from flags, env vars, and config file.

2. **Runner initialization** (`pkg/commands/artifact/run.go`): `NewRunner` downloads/updates the vulnerability DB (if needed), initializes the Java DB for JAR scanning, and loads WASM extension modules. Returns a `runner` struct.

3. **Service selection** (`runner.ScanImage`): Based on whether `--input` (tarball) and `--server` flags are set, picks one of four service constructors: `imageStandaloneScanService`, `archiveStandaloneScanService`, `imageRemoteScanService`, or `archiveRemoteScanService`.

4. **Service creation** (`pkg/commands/artifact/scanner.go`): The selected constructor creates an `artifact.Artifact` (e.g., `artimage.NewArtifact`) and a `scan.Service` with either a local or remote backend.

5. **Inspection** (`scan.Service.ScanArtifact`): Calls `artifact.Inspect(ctx)` which runs all enabled analyzers against the target. For container images, this means walking each layer, running OS package analyzers (apk, dpkg, rpm), language analyzers (go.sum, package-lock.json, etc.), and config analyzers. Results are cached by layer digest.

6. **Scanning** (`backend.Scan`): The local backend runs `ospkg.Scanner` and `langpkg.Scanner` to match packages against the vulnerability DB, plus any enabled misconfig/secret/license scanners.

7. **Report assembly** (`scan.Service.ScanArtifact`): Collects results into `types.Report`, fills fingerprints, and returns.

8. **Filter + Write** (`runner.Filter`, `runner.Report`): Applies severity filters, ignore rules, and VEX exemptions. Formats and writes output.

## Key Patterns

**Global analyzer registry.** Analyzers register themselves in `init()` functions by calling `RegisterAnalyzer` / `RegisterPostAnalyzer` with a `Type` string constant. The `AnalyzerGroup` struct at runtime assembles the right set based on what's enabled. This is a service-locator pattern — simple, but makes it hard to see the full set of analyzers without grepping.

**Strategy pattern for scan backends.** `scan.Service` takes a `Backend` interface with a single `Scan` method. Two implementations exist: `local.Service` (standalone) and `remote.Service` (client/server). This cleanly separates the "what to scan" concern (artifact inspection) from the "how to evaluate" concern (vulnerability matching).

**Cobra + Viper flag layering.** Flags are defined in typed structs (`flag.GlobalFlagGroup`, `flag.ScanFlagGroup`, etc.) that know how to register themselves with Cobra and bind to Viper. Each command composes the flag groups it needs. The `ToOptions()` method collapses flags + env vars + config file into a single `flag.Options` struct. This is thorough but produces a large options struct (~837 lines).

**Configuration priority.** Defaults → config file → environment variables → CLI flags. Viper handles this natively. The config file path defaults to `~/.trivy.yaml` but is overridable via `--config`.

**Error handling.** Trivy uses `golang.org/x/xerrors` for wrapped errors with a consistent pattern: `xerrors.Errorf("descriptive message: %w", err)`. The main entry point distinguishes `ExitError` (for exit codes), `UserError` (for user-facing messages), and general fatal errors. The `commands.Run` function adds context-specific guidance (e.g., timeout troubleshooting URLs).

**Plugin system.** Trivy supports external plugins via the `TRIVY_RUN_AS_PLUGIN` environment variable. If set, `main()` short-circuits entirely and delegates to the plugin. Plugins can also register as CLI subcommands by placing executables in `~/.trivy/plugins/`.

## Non-Obvious Details

**Fanal is the real engine.** The `pkg/fanal/` package (short for "file analyzer") is the most architecturally significant part of the codebase. It handles all target inspection — image layer extraction, filesystem walking, package parsing. The rest of Trivy is essentially a reporting and DB-matching layer on top of fanal.

**Analyzer filtering is complex.** The `disabledAnalyzers()` function in `run.go` is a 60-line decision tree that determines which analyzers to disable based on target type, scanner flags, and environment variables. This is the single most important function for understanding *what actually runs* in any given invocation. Miss a flag, and entire categories of analysis silently skip.

**Misconfiguration scanning runs client-side even in client/server mode.** The `checkOptions` function warns about this, but it's an implicit architectural constraint: IaC files and secrets must be locally accessible. Only vulnerability matching is offloaded to the server.

**Built-in Rego policies come from `trivy-checks`.** Misconfiguration rules aren't embedded in the binary — they're pulled from the `aquasecurity/trivy-checks` repository (via Go module). Custom policies can be added via `--policy-path` with custom Rego namespaces.

**Artifact IDs use deterministic hashing.** `scan.Service.generateArtifactID` creates stable identifiers by hashing image ID + registry/repository for images, or URL + commit for repos. This enables result deduplication across scans of the same artifact.

**Layer caching by digest.** Container image layers are analyzed independently and cached by their content digest. A subsequent scan of an image that shares base layers with a previously scanned image will skip re-analysis of those layers entirely.

> [!tip]
> The `TRIVY_RUN_AS_PLUGIN` env var is the extension escape hatch. It bypasses the entire CLI and runs an arbitrary binary as Trivy. This is how tools like `trivy-kubernetes` integrate.

## Assessment

**Code quality** is strong. The codebase is well-organized, consistently structured, and thoroughly commented. Go conventions are followed throughout. The fanal package alone is a significant engineering achievement — handling dozens of package formats across multiple OS families and language ecosystems.

**Architecture fitness** is excellent for the problem. The target/scanner matrix is naturally two-dimensional, and the code reflects this cleanly. The analyzer registry pattern allows adding new package formats or config types without touching the scan orchestration. The client/server split is well-placed at the vulnerability matching boundary.

**Operational concerns** are well-handled. Caching (memory, Redis, S3), database management (auto-update, skip-update), timeout handling with troubleshooting links, and graceful shutdown via signal context are all present. The WASM module system provides an extension point for custom analysis logic.

**The main risk** is complexity. With ~45 top-level packages, a massive flag/options surface, and analyzer selection logic that depends on subtle flag combinations, the system has a steep learning curve. New contributors must understand the fanal analyzer model, the scan service backend abstraction, and the flag composition system before they can be productive. The `flag.Options` struct is a god object at ~837 lines.

**Security posture** is appropriate for a security tool. The vulnerability DB is fetched over HTTPS from signed OCI artifacts. No network calls are made during offline scanning. The plugin system does execute arbitrary binaries, but this is by design and documented.

## Related

- [[analyzing-trufflehog]]
- [[analyzing-gitleaks]]
- [[analyzing-prowler]]
- [[analyzing-datadog-guarddog]]
