---
title: "Analyzing FOSSA CLI"
date: 2026-05-10
type: codebase-analysis
status: complete
source: https://github.com/fossas/fossa-cli
tags: [haskell, rust, dependency-analysis, supply-chain, licensing, vulnerability-scanning]
---

# Analyzing FOSSA CLI

> **Source:** [fossas/fossa-cli](https://github.com/fossas/fossa-cli) @ [`77a146d`](https://github.com/fossas/fossa-cli/commit/77a146d943edd44905afaa0d285f7ff46b231508)

## How It Works

FOSSA CLI is a polyglot dependency analysis engine. You point it at a codebase and it automatically discovers which package managers and build systems are present, resolves dependency graphs for each, and uploads the results to the FOSSA SaaS backend for license compliance and vulnerability scanning. It supports ~35 build tools across 25+ languages — from npm and Maven to Cargo, Pub, and RPM — through a plugin-like analyzer architecture.

At a high level, the tool operates in three phases: **discover**, **analyze**, and **upload**. Discovery walks the filesystem looking for manifest files (e.g., `package.json`, `go.mod`, `pom.xml`) and registers projects. Analysis runs the appropriate strategy for each discovered project — parsing lockfiles, shelling out to build tools, or executing custom logic — to produce a `Graphing Dependency`, which is a directed graph with the notion of "direct" vs. "transitive" dependencies. Finally, the graph is converted to FOSSA's `SourceUnit` format and uploaded to the backend API.

Beyond core dependency analysis, FOSSA CLI also runs **Ficus** (vendored dependency / snippet scanning), **Lernie** (keyword and custom license search), **Millhone** (snippet extraction for IP matching), VSI (Vulnerable Systems Integration for OS packages), first-party license scans, and reachability analysis — all orchestrated from the main `fossa analyze` entrypoint.

## Architecture

The codebase is a **Haskell + Rust polyglot**. The core CLI and all analyzer strategies (~60K lines of Haskell) live in `src/`. Rust components (~4K lines) live in `extlib/` as separate crates within a Cargo workspace. The two languages do not interop via FFI; instead, Rust binaries are **embedded as compressed blobs** in the Haskell binary via Template Haskell (`Data.FileEmbed`). At runtime, Haskell extracts them to a temp directory and shells out as subprocesses.

**Key Rust crates:**
- **`berkeleydb`** — parses BerkeleyDB format files for RPM package databases on Linux containers. Ported from Go's `go-rpmdb`.
- **`millhone`** — extracts code snippets (C/C++ functions) for IP/attribution matching against FOSSA's knowledge base.

**Key Haskell modules:**
- `src/App/Fossa/` — CLI commands (analyze, test, report, container, SBOM, etc.)
- `src/Strategy/` — per-ecosystem analyzers (Cargo, Node, Maven, Go, Python, etc.)
- `src/Types.hs` / `src/DepTypes.hs` — core domain types (`Dependency`, `DepType`, `GraphBreadth`)
- `src/Graphing.hs` — custom graph data structure wrapping `alga` adjacency maps with direct/transitive tracking
- `src/Srclib/` — conversion layer from internal types to FOSSA's `SourceUnit` protocol
- `src/Effect/` — effect system (Exec, ReadFS, Logger) using the `fused-effects` library
- `src/Control/Carrier/` — effect carriers including `FossaApiClient` for backend communication

The build system uses **Cabal** (`spectrometer.cabal`) for Haskell and **Cargo** for Rust, unified via a `Makefile`. The cabal package name is `spectrometer` (a historical artifact).

## The Spine

A `fossa analyze` command flows like this:

1. **Entry** — `app/fossa/Main.hs` → `App.Fossa.Main.appMain` parses CLI opts via `optparse-applicative` subcommands.
2. **Dispatch** — `App.Fossa.Analyze.dispatch` receives an `AnalyzeConfig`, calls `analyzeMain`.
3. **Preflight** — `preflightChecks` validates API credentials and fetches org capabilities from the FOSSA backend.
4. **Manual deps** — `analyzeFossaDepsFile` parses optional `.fossa.yml` / `fossa-deps.yml` for user-declared dependencies.
5. **Discovery** — `runAnalyzers` iterates over `discoverFuncs`, a heterogeneous list of 35+ `DiscoverFunc` values. Each calls `withDiscoveredProjects`, which forks concurrent tasks via a `TaskPool`.
6. **Per-project analysis** — For each discovered project, `runDependencyAnalysis` applies filters, then calls `analyzeProject` on the strategy-specific project type. Each strategy produces a `DependencyResults` containing a `Graphing Dependency` and `GraphBreadth`.
7. **Enrichment** — Path dependencies are enriched with license data. Ficus runs snippet scans. Lernie runs keyword/license searches. VSI handles OS package analysis.
8. **Conversion** — `Srclib.Converter.projectToSourceUnit` converts each `ProjectResult` into a `SourceUnit` with `Locator`-based dependency graphs.
9. **Upload** — `uploadSuccessfulAnalysis` POSTs the analysis to the FOSSA API, waits for build completion, and renders a scan summary.

## Key Patterns

**Strategy pattern via typeclasses.** Each ecosystem analyzer implements `AnalyzeProject` (from `App.Fossa.Analyze.Types`), which provides `analyzeProject` and `analyzeProjectStaticOnly` methods. The `DiscoverFunc` GADT wraps heterogeneous discover functions into a uniform list, working around Haskell's lack of impredicative types.

**Effect system via fused-effects.** The codebase uses an algebraic effect system extensively. Core effects include `Exec` (shell command execution), `ReadFS` (filesystem reads), `Logger`, `Diagnostics` (error accumulation), `FossaApiClient` (backend API), and `Telemetry`. Functions declare effect constraints as typeclass bounds (`Has Exec sig m, Has ReadFS sig m`).

**Embedded binaries.** Rust tools and other native binaries are compiled separately, compressed (LZMA for the Themis index), and embedded via Template Haskell. At runtime, `extractEmbeddedBinary` writes them to `$TMP/fossa-vendor-<uuid>/` and cleans up via `bracket`. This avoids FFI complexity and simplifies cross-compilation.

**Graphing with direct/transitive distinction.** `Graphing` wraps `algebraic-graphs` (alga) adjacency maps, adding a "direct" label to vertices. This is crucial because FOSSA's backend needs to know which dependencies are direct vs. transitive for license policy evaluation. The `shrink`/`prune` operations preserve this distinction.

**Configuration layering.** CLI options (`AnalyzeCliOpts`) merge with `.fossa.yml` config file settings via `mergeOpts`, with CLI flags taking precedence. This is handled in `App.Fossa.Config.Analyze`.

## Non-Obvious Details

**The `DiscoverFunc` GADT is solving a real Haskell limitation.** The `discoverFuncs` list contains functions returning different project types (`NodeProject`, `CargoProject`, etc.). Without impredicative types, you can't have a list of `forall a. ... -> [DiscoveredProject a]`. The GADT existential encoding hides the concrete type behind the `AnalyzeProject a` constraint.

**Rust interop is subprocess-based, not FFI.** The `Strategy.BerkeleyDB.Internal` module shows the pattern: Haskell extracts the `berkeleydb-plugin` binary, base64-encodes the input, pipes it to stdin, and parses JSON from stdout. This is slower than FFI but dramatically simpler for cross-platform builds and avoids Rust/Haskell ABI coupling.

**The `SourceUnit` / `Locator` protocol is the real interface contract.** `Srclib.Types` and `Srclib.Converter` define the wire format that the FOSSA backend expects. The `Locator` type (`fetcher$project@revision`) is the universal dependency identifier. The `depTypeToFetcher` function maps ~25 internal `DepType` variants to backend fetcher strings — and contains several `FIXME` comments about historical mismatches (e.g., `SubprojectType` maps to `"mvn"`, `GooglesourceType` maps to `"git"`).

**Ficus is a separate Go-based binary.** Despite the Rust extlib pattern, Ficus and Lernie are embedded binaries that are *not* built from this repo's Rust code. They appear to be external artifacts downloaded during the build via `vendor_download.sh`.

**`spectrometer.cabal` is the actual package name.** The Haskell package is called `spectrometer` — likely the original internal name before it became FOSSA CLI. The cabal file is auto-generated; configuration lives in `cabal.project` and `cabal.project.common`.

## Assessment

**Strengths:**
- The analyzer architecture is genuinely extensible. Adding a new ecosystem means creating a `Strategy/Foo.hs` with `discover` and `AnalyzeProject` instance, then adding one line to `discoverFuncs`.
- Effect system usage is disciplined — functions declare exactly which capabilities they need, making the code testable and the dependency graph explicit.
- Concurrent analysis via `TaskPool` with per-project error isolation (each project's failures don't block others) is robust.
- The embedded binary pattern sidesteps FFI complexity while keeping the distribution story simple (single binary).

**Concerns:**
- The `SourceUnit` conversion layer (`depTypeToFetcher`) has accumulated several hacks (three `FIXME` comments about incorrect mappings). This suggests the backend protocol evolved separately from the CLI and the impedance mismatch is managed with patches rather than refactoring.
- The codebase is large for what it does (~60K lines of Haskell). The effect system, while clean, adds significant type machinery overhead. A newcomer must understand fused-effects, alga graphs, and the custom `Graphing` wrapper before being productive.
- Error handling uses a custom `Diagnostics` effect that accumulates errors and warnings, but the error types are not always well-structured — some strategies use `fatalText` with ad-hoc messages.

**Recommendations:**
- If extending: start from `Strategy/Cargo.hs` or `Strategy/Node.hs` as reference implementations. They show the full discover → analyze → graph pattern.
- If integrating: the `SourceUnit` JSON format is the stable contract. Don't depend on internal types.
- The embedded binary approach means Rust tools must communicate via JSON on stdin/stdout. For performance-sensitive operations, this is a bottleneck worth measuring.

## Related

- [[analyzing-syft]]
- [[analyzing-dependency-track]]
- [[analyzing-datadog-guarddog]]
- [[analyzing-hijagger]]
- [[analyzing-packj]]
