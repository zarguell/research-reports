---
title: "Analyzing OSV-Scanner"
date: 2026-05-10
type: codebase-analysis
status: complete
source: https://github.com/google/osv-scanner
tags: [go, supply-chain, vulnerability-scanning, osv, security]
---

# Analyzing OSV-Scanner

> **Source:** [google/osv-scanner](https://github.com/google/osv-scanner) @ [`408fcd6`](https://github.com/google/osv-scanner/commit/408fcd6f8707999a29e7ba45e15809764cf24f67)

## How It Works

OSV-Scanner is Google's official CLI frontend to the [OSV database](https://osv.dev/) (Open Source Vulnerabilities). It answers one question: *which known vulnerabilities affect my project's dependencies?* It does this in three stages — **extract** dependency metadata from your project, **match** those packages against known vulnerabilities, and **report** the results in your preferred format.

The critical architectural decision is that OSV-Scanner delegates all dependency extraction to [osv-scalibr](https://github.com/google/osv-scalibr), a separate Google library that understands 19+ lockfile formats across 11+ language ecosystems (Go, Python, Java, Rust, JavaScript, PHP, Ruby, Dart, Elixir, C/C++, R), plus OS packages and container images. OSV-Scanner itself focuses on vulnerability matching, result formatting, and higher-level workflows like guided remediation.

The tool supports two matching modes: **online** (queries the OSV.dev API with batched paged requests, hydrating each result concurrently) and **offline** (downloads zipped vulnerability databases from GCS and performs local matching). It also layers on license scanning via the deps.dev API and call-graph reachability analysis for Go (via govulncheck) and Rust.

## Architecture

The codebase is a Go module (`github.com/google/osv-scanner/v2`) with ~219 `.go` files across ~40k lines. It follows a clear `cmd/` → `pkg/` → `internal/` layering:

```
cmd/osv-scanner/         # CLI entry points (scan, fix, update, mcp)
  ├── scan/source/       # "scan source" subcommand
  ├── scan/image/        # "scan image" subcommand
  ├── fix/               # Guided remediation
  ├── update/            # Update local vulnerability DBs
  └── mcp/               # Experimental MCP server
pkg/
  ├── osvscanner/        # Core scan orchestration (DoScan, DoContainerScan)
  └── models/            # Shared data types (VulnerabilityResults, PackageSource)
internal/
  ├── clients/           # Vulnerability & license matching backends
  ├── config/            # TOML-based config (ignores, overrides)
  ├── output/            # Formatters (table, JSON, SARIF, HTML, CycloneDX, SPDX)
  ├── sourceanalysis/    # Call-graph reachability (Go, Rust)
  ├── grouper/           # Groups related vulnerabilities by alias
  ├── scalibrplugin/     # Plugin resolution and presets
  └── scalibrextract/    # Custom scalibr extractors (vendored C/C++, git repos)
```

The `ScannerActions` struct in `pkg/osvscanner/osvscanner.go` is the central configuration object — it captures every user-facing flag and gets passed through the entire scan pipeline.

## The Spine

A source scan (`osv-scanner scan source`) follows this path:

1. **CLI entry** — `cmd/osv-scanner/main.go` dispatches to `scan/source/command.go`, which assembles a `ScannerActions` from CLI flags.
2. **Scan orchestration** — `pkg/osvscanner.DoScan()` initializes external accessors (vulnerability matcher, license matcher, OSV client), then calls the internal `scan()` function.
3. **Dependency extraction** — `scan()` resolves scalibr plugins via `internal/scalibrplugin/resolve.go`, builds a filesystem scan plan from directories/lockfiles/git commits, and runs `scalibr.New().Scan()`. This walks the filesystem and invokes per-ecosystem extractors to produce an `inventory.Inventory` of packages.
4. **Vulnerability matching** — `makeVulnRequestWithMatcher()` sends packages to either `OSVMatcher` (online, batched paged API queries with concurrent hydration) or `LocalMatcher` (offline, per-ecosystem zipped DB lookups).
5. **Result building** — `buildVulnerabilityResults()` groups vulnerabilities by alias, runs source analysis (call graphs), checks licenses, applies config overrides, and filters ignored entries.
6. **Output** — The result flows to one of ~8 formatters (table, SARIF, HTML, JSON, CycloneDX, SPDX, GitHub annotations, vertical).

Container scanning (`DoContainerScan`) follows the same shape but uses `scalibr.ScanContainer()` with OS-layer-aware extractors and adds image metadata extraction.

## Key Patterns

**Plugin-based extraction.** Scalibr extractors are resolved by name and organized into presets (`"lockfile"`, `"sbom"`, `"directory"`, `"artifact"`, `"transitive"`). The `scalibrplugin.Resolve()` function expands presets into individual plugin names, instantiates them, and filters out any enricher whose required plugins are missing. This is how support for new ecosystems gets added without touching the core scanner.

**Interface-based matching.** The `VulnerabilityMatcher` interface (`internal/clients/clientinterfaces/vulnerabilitymatcher.go`) decouples the scan pipeline from the matching backend. `OSVMatcher` and `LocalMatcher` are the two implementations. This keeps the offline/online split clean — the rest of the pipeline doesn't know or care which one is active.

**Config as ignore rules.** The `osv-scanner.toml` config file doesn't configure scanning behavior so much as it filters results post-hoc. `IgnoredVulns` suppresses specific vulnerability IDs (with optional expiry timestamps). `PackageOverrides` suppress entire packages or override their license declarations. The config manager walks up from each package's file path to find the nearest config file, creating per-path configuration.

**Dual error semantics.** The scanner returns two sentinel errors — `ErrNoPackagesFound` and `ErrVulnerabilitiesFound` — that double as exit codes. CLI commands translate these into non-zero exits for CI integration, while the `--allow-no-lockfiles` flag downgrades the "no packages" case to a warning.

## Non-Obvious Details

> [!note]
> OSV-Scanner includes an **experimental MCP server** (`cmd/osv-scanner/mcp/command.go`) that speaks the Model Context Protocol over stdin/stdout or SSE. This lets AI agents invoke vulnerability scanning as a tool — a forward-looking integration point.

**Reachability analysis is language-specific and file-specific.** The `sourceanalysis.Run()` function only triggers Go analysis when the source is a `go.mod` lockfile and Rust analysis when it's a `Cargo.lock`. This means call analysis won't run on, say, a `go.sum` or a Bazel query — it's tightly coupled to the lockfile type.

**Debian "unimportant" vulnerability handling is bespoke.** There's significant logic in `vulnerability_result.go` for classifying Debian/Ubuntu vulnerabilities as "unimportant" based on urgency fields and Ubuntu priority tags. These are marked as called-but-unimportant, meaning they appear in output but don't trigger the vulnerability-found exit code unless `--show-all-vulns` is set.

**Vulnerability grouping uses alias intersection.** The `grouper` package merges vulnerabilities that share aliases (e.g., CVE-2024-1234 and GHSA-xxxx-yyyy) using an O(n²) pairwise comparison. This is correct but could become a bottleneck at very large vulnerability counts — there's no union-find optimization.

**Workflow command injection protection.** Several places sanitize user-controlled strings (file paths, image names) before logging to prevent GitHub Actions `::command::value` injection via `\r\n` characters. This is a subtle security hardening that most tools miss.

## Assessment

**Strengths:**
- Clean separation between extraction (scalibr), matching (client interfaces), and reporting (formatters). Each layer can evolve independently.
- Comprehensive ecosystem support inherited from scalibr, plus thoughtful higher-level features (guided remediation, MCP, license scanning).
- Well-tested with snapshot-based test infrastructure and VCR-style HTTP recording for deterministic API tests.
- Good CI/ergonomics: SARIF output, GitHub annotations, exit-code semantics, `osv-scanner.toml` ignore files with expiry.

**Concerns:**
- The `buildVulnerabilityResults()` function is acknowledged in a TODO as too long — it handles grouping, filtering, license checking, Debian unimportant logic, and more in a single function.
- Tight coupling to scalibr's plugin registry means the project lives or dies on scalibr's velocity for new ecosystem support.
- The O(n²) vulnerability grouping won't scale well for projects with thousands of direct dependencies.

**Overall:** OSV-Scanner is a mature, well-structured tool that fills a specific niche — connecting dependency lists to the OSV database — and fills it thoroughly. The v2 rewrite (this codebase) is a significant architectural improvement over v1, with the scalibr delegation being the key design win.

## Related

- [[analyzing-syft]] — SBOM generator that produces the kind of dependency data OSV-Scanner consumes
- [[analyzing-dependency-track]] — Dependency analysis platform with similar vulnerability-matching goals
- [[analyzing-datadog-guarddog]] — PyPI-focused malware scanner; complementary threat model to OSV-Scanner's vulnerability matching
