---
title: "Analyzing Grype"
date: 2026-05-10
type: codebase-analysis
status: complete
source: https://github.com/anchore/grype
tags: [go, vulnerability-scanner, supply-chain-security, container-security]
---

# Analyzing Grype

> **Source:** [anchore/grype](https://github.com/anchore/grype) @ [`7b26aa2`](https://github.com/anchore/grype/commit/7b26aa2aa40614bfbdd9798aaeb884646cc9534c)

## How It Works

Grype is a vulnerability scanner for container images, filesystems, and SBOMs. Its core operation is deceptively simple: take a list of software packages, look each one up in a local vulnerability database, and report matches. The complexity lives in three places — how packages are discovered, how version matching works across wildly different ecosystems, and how the vulnerability database is structured and kept current.

The scanning pipeline is a two-phase process that runs in parallel. First, Syft (Grype's sibling tool, imported as a library) catalogs all packages from the target — whether that's a Docker image, a directory, an OCI tarball, or a pre-existing SBOM. Second, Grype loads a local SQLite-based vulnerability database (v6 schema, built from NVD, GitHub Advisories, OS security advisories, and more). Each discovered package is then routed to an ecosystem-specific matcher (dpkg, RPM, Python, Java, Go, etc.) that queries the database using the right version comparison logic for that ecosystem.

What makes Grype interesting is the matcher architecture. There are 16 matchers, each tailored to a specific package type. A dpkg matcher, for example, searches by exact package name within the distro's namespace and also follows upstream source package indirection (e.g., `libc6` → `glibc`). The "stock" matcher is the fallback — it uses CPE (Common Platform Enumeration) matching, which is fuzzier and applicable to any package type. Matchers can return not just matches but also ignore filters, which are applied in a second pass to suppress false positives that the matcher itself knows about.

## Architecture

```
User Input (image/dir/SBOM/purl)
        │
        ▼
  ┌─────────────┐     ┌──────────────────┐
  │  Syft SBOM  │     │  Vulnerability   │
  │  Cataloger  │     │  DB (SQLite v6)  │
  └──────┬──────┘     └────────┬─────────┘
         │                     │
         ▼                     ▼
  ┌──────────────────────────────────────┐
  │        VulnerabilityMatcher          │
  │  ┌──────────────────────────────┐    │
  │  │  Package → Matcher Router    │    │
  │  │  (by syft pkg type)          │    │
  │  └──────────┬───────────────────┘    │
  │             ▼                         │
  │  ┌─────────────────────────┐         │
  │  │  Ecosystem Matchers     │         │
  │  │  dpkg/rpm/apk/python/   │         │
  │  │  java/go/ruby/dotnet/   │         │
  │  │  javascript/rust/stock  │         │
  │  └──────────┬──────────────┘         │
  │             ▼                         │
  │  Ignore Rules → VEX Filtering         │
  └──────────────┬───────────────────────┘
                 ▼
         Presenter (table/json/
           cyclonedx/sarif/template)
```

The top-level packages under `grype/` map directly to these concerns: `pkg/` handles package discovery (delegating to Syft), `db/` manages the vulnerability database lifecycle, `matcher/` contains the per-ecosystem matchers, `match/` defines the core types (`Match`, `IgnoreRule`, `Matcher` interface), `version/` implements version comparison for ~15 different formats, `vex/` handles VEX document processing, and `presenter/` renders output in various formats.

## The Spine

The entry point is `cmd/grype/main.go` → `cli/commands/root.go`, which wires up the cobra CLI via Anchore's `clio` framework. The `runGrype` function in `root.go` is the spine:

1. **Parallel initialization**: DB loading and package cataloging happen concurrently via `parallel()`. The DB is loaded via `grype.LoadVulnerabilityDB()`, which creates a distribution client, curator, and returns a `vulnerability.Provider` backed by a SQLite reader. Packages come from `pkg.Provide()`, which calls into Syft.

2. **Matcher configuration**: `getMatchers()` creates the 16 ecosystem matchers with user-specified config (e.g., Java external search, Go stdlib CPE behavior, epoch handling strategies for dpkg/rpm).

3. **Vulnerability matching**: `VulnerabilityMatcher.FindMatchesContext()` iterates every package, routes it to the right matcher(s) via a type-indexed lookup, collects all matches, then applies ignore rules and VEX filtering in sequence.

4. **Presentation**: Results are wrapped in a `models.Document` and written through a configurable presenter (table, JSON, CycloneDX, SARIF, or Go template).

The `Matcher` interface is the key extensibility point:

```go
type Matcher interface {
    PackageTypes() []syftPkg.Type
    Type() MatcherType
    Match(vp vulnerability.Provider, p pkg.Package) ([]Match, []IgnoreFilter, error)
}
```

Each matcher implements this with ecosystem-specific search strategies against the `vulnerability.Provider` interface, which abstracts the SQLite-backed v6 database.

## Key Patterns

**Strategy pattern for version comparison.** The `version/` package is a factory of format-specific comparators. A `Version` struct lazily initializes the right comparator (semantic, deb, rpm, maven, pep440, gem, KB, etc.) based on format. This is critical because "is version 1.2.3 vulnerable?" has entirely different semantics for a Debian package vs. a Maven artifact vs. a Windows KB patch.

**Parallel execution with defensive recovery.** The `searchDBForMatches` loop wraps each matcher call in `callMatcherSafely`, which recovers from panics and converts them to `FatalError`. This means a single buggy matcher can't crash the entire scan — a pragmatic choice for a tool that needs to be reliable in CI pipelines.

**Two-tier ignore system.** There are user-provided `IgnoreRule`s (config-driven, for suppressing known false positives) and programmatic `IgnoreFilter`s returned by matchers themselves (for things the matcher knows are wrong). Both are applied post-matching in `searchDBForMatches`, with an additional pass after optional CVE normalization.

**Event bus for UI progress.** Grype uses `go-partybus` for decoupled progress reporting. The CLI layer subscribes to events (DB update started, scanning started, etc.) and renders TUI progress via `bubbletea`. The core scanning logic doesn't know about the terminal.

**Configurable search strategies per matcher.** Each matcher has its own config struct (e.g., `dpkg.MatcherConfig` has `MissingEpochStrategy` and `UseCPEsForEOL`). This allows fine-grained control over tradeoffs — for instance, enabling CPE-based matching for packages on EOL distros where distro-specific vulnerability data may be incomplete.

## Non-Obvious Details

**Upstream package indirection.** The dpkg and rpm matchers don't just match on the installed package name — they follow the source/upstream package relationship. For example, `libc6` on Debian resolves to `glibc` upstream, so vulnerabilities filed against `glibc` are found. This happens in `pkg.UpstreamPackages()` and `matchUpstreamPackages()`.

**Database codename system.** The v6 DB uses a codename-based versioning system (`grype/db/internal/codename/`) with auto-generated constants. This is a build-time concern but ensures schema compatibility is checked by human-readable names, not just integer versions.

**CVE normalization pass.** When `--by-cve` is set, Grype rewrites non-CVE vulnerability IDs (e.g., GHSA-xxxx, ALSA-2024:xxxx) to their corresponding CVE IDs using the `RelatedVulnerabilities` field. It then re-applies ignore rules because the normalization can change which rules match. This double-pass is necessary for correctness.

**Ignore rule indexing for performance.** The `ignoredMatchFilter` in `vulnerability_matcher.go` builds hash indexes over ignore rules by vulnerability ID, package name, and file location. This converts O(n×m) rule matching into near-O(1) lookups — important when scanning images with thousands of packages against dozens of ignore rules.

**EOL distro awareness.** The vulnerability matcher tracks packages from end-of-life distros via `eolTracker`, surfaced as warnings in the output. The `vulnerability.EOLChecker` interface lets the DB provider report EOL dates per distro, and matchers can use this to decide whether to fall back to CPE-based matching.

**Panic recovery as architecture.** The `callMatcherSafely` function with `defer recover()` is not just defensive — it's load-bearing. The code explicitly documents that individual matchers may panic, and the system is designed to survive this by converting panics to `FatalError` that halt only that matcher's processing.

## Assessment

**Strengths:**
- Clean separation between package cataloging (Syft) and vulnerability matching (Grype). The `Matcher` interface is well-designed and easy to extend for new ecosystems.
- The version comparison layer is remarkably thorough — 15+ format-specific comparators handling edge cases like epoch mismatches, pseudo-versions (Go), and fuzzy matching.
- Solid operational design: parallel initialization, panic-safe matchers, configurable auto-update, offline mode, and multiple output formats including CycloneDX and SARIF for CI integration.
- VEX support (OpenVEX, CSAF) is a differentiator for enterprise use cases where vulnerability exceptions need to be documented and automated.

**Concerns:**
- The `version/` package carries significant complexity (fuzzy version parsing, format-specific constraint logic) that could be a maintenance burden. Each ecosystem's versioning quirks are handled inline rather than delegating to ecosystem-native libraries.
- The DB v6 migration path coexists with v5 legacy code (`db/package_legacy.go`), which adds surface area. The transition appears still in progress.
- The ignore rule system has grown complex — there are user-provided rules, matcher-returned filters, explicit exclusion rules from the DB, VEX-based filtering, and the indexed optimization. The interaction between these layers is subtle.

**Recommendations:**
- For anyone extending Grype, start by implementing the `Matcher` interface and studying the dpkg matcher as a reference — it demonstrates both direct and upstream indirection matching.
- The `grype/search/` package's criteria system (AND/OR composition of vulnerability search criteria) is an under-documented but powerful API for programmatic use.
- When using Grype as a library, `grype.SetLogger()` and `grype.SetBus()` in `lib.go` are the integration points — they're small but critical for controlling logging and event routing.

## Related

- [[analyzing-syft]] — Syft is Anchore's SBOM generator, Grype's sibling tool
- [[analyzing-trivy]] — competing container vulnerability scanner
- [[analyzing-dependency-track]] — supply chain vulnerability management platform
