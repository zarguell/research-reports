---
title: "Analyzing OWASP Dependency-Check"
date: 2026-05-09
type: codebase-analysis
status: complete
source: https://github.com/dependency-check/DependencyCheck
tags: [java, security, sca, dependency-analysis, owasp, vulnerability-scanning]
---

> **Source:** [dependency-check/DependencyCheck](https://github.com/dependency-check/DependencyCheck) @ [`cfd3479`](https://github.com/dependency-check/DependencyCheck/commit/cfd3479d0b0f240499c1782e377cbbb341b23d4f)

## How It Works

OWASP Dependency-Check is a Software Composition Analysis (SCA) tool that detects publicly disclosed vulnerabilities in application dependencies. It works by scanning project directories and dependency files, extracting identifying evidence (vendor names, versions, file hashes), mapping that evidence to Common Platform Enumeration (CPE) identifiers via a Lucene index, then querying a local NVD CVE database to find matching vulnerabilities. The result is a report listing each dependency alongside its associated CVEs, severity scores, and remediation guidance.

The tool supports an enormous range of ecosystems — Java (JAR, Maven, Gradle), .NET (NuGet, assembly), Node.js (npm, yarn, pnpm), Python (pip, poetry, pipfile), Go, Ruby, PHP (Composer), Swift, Dart, Perl, Elixir, and C/C++. Each ecosystem has dedicated analyzers that know how to parse lockfiles, manifests, and binary metadata. Beyond NVD, it also queries Sonatype OSS Index, RetireJS, and the CISA Known Exploited Vulnerabilities catalog.

The core innovation is the **evidence-based CPE matching** system. Rather than relying solely on package names, Dependency-Check collects multiple types of evidence — vendor, product, version, and version-confident evidence — from each dependency's metadata (MANIFEST.MF, pom.xml, assembly attributes, filenames). A Lucene in-memory index of all known CPE entries is searched using this evidence, and matches are filtered through confidence thresholds, suppression rules, and false-positive detection before final vulnerability lookup.

## Architecture

```
dependency-check-parent (pom.xml, v12.2.3-SNAPSHOT)
├── core/           ← 276 Java files: Engine, analyzers, data layer, reporting
│   ├── analyzer/   ← 50+ analyzers via SPI (service loader)
│   ├── data/       ← NVD API, CPE index, CVE database (H2), ecosystem mapping
│   ├── dependency/  ← Dependency, Vulnerability, Evidence models
│   ├── reporting/  ← ReportGenerator (Velocity templates + SARIF/JSON/CSV)
│   └── xml/        ← Suppression rules, POM parsing, assembly metadata
├── cli/            ← App.java, CliParser — standalone command-line runner
├── maven/          ← BaseDependencyCheckMojo, AggregateMojo, CheckMojo
├── ant/            ← Ant task integration
├── utils/          ← Shared utilities (Settings, Downloader, checksums)
└── archetype/      ← Maven archetype for new integrations
```

**Data flow:**

```
Scan targets (files/dirs)
  → Engine.scan() → FileTypeAnalyzers accept/reject
    → AnalysisPhase pipeline (13 phases, sequential)
      1. INITIAL: ArchiveAnalyzer extracts nested archives
      2. INFORMATION_COLLECTION: ecosystem-specific analyzers
         extract Evidence (vendor, product, version) from metadata
      3. IDENTIFIER_ANALYSIS: CPEAnalyzer queries Lucene index
         with evidence → produces CpeIdentifiers
      4. POST_IDENTIFIER_ANALYSIS: FalsePositiveAnalyzer,
         CpeSuppressionAnalyzer filter bad matches
      5. FINDING_ANALYSIS: NvdCveAnalyzer queries CveDB,
         OssIndexAnalyzer queries Sonatype, RetireJsAnalyzer
         queries RetireJS
      6. POST_FINDING_ANALYSIS: KnownExploitedVulnerabilityAnalyzer,
         VulnerabilitySuppressionAnalyzer
      7. FINAL: DependencyBundlingAnalyzer merges related deps
    → ReportGenerator writes HTML/XML/JSON/CSV/SARIF/JUNIT/GitLab
```

## The Spine

**Entry points:**

- **CLI** (`cli/.../App.java`): Parses command-line args via `CliParser`, creates `Engine` in `STANDALONE` mode, calls `scan()` then `analyzeDependencies()` then `writeReports()`.
- **Maven plugin** (`maven/.../BaseDependencyCheckMojo.java`): Extends `AbstractMojo`, integrates into Maven lifecycle. `AggregateMojo` scans all modules in a multi-module build.
- **Ant task** (`ant/`): Similar lifecycle, adapted for Apache Ant builds.
- **Programmatic API**: `Engine` class itself — instantiate with `Settings`, call `scan()`, `analyzeDependencies()`, `writeReports()`, `close()`.

**Request lifecycle (standalone mode):**

1. `Engine` constructor loads analyzers via `AnalyzerService` (Java `ServiceLoader` from `META-INF/services`). Each analyzer declares its `AnalysisPhase`.
2. `Engine.doUpdates()` — opens H2 database, invokes `UpdateService` to fetch NVD API data, RetireJS repository, hosted suppressions, CISA KEV catalog, and version check. NVD data is fetched via `io.github.jeremylong.open-vulnerability-client` library, processed by `NvdApiProcessor`, and stored in H2.
3. `Engine.scan(paths)` — recursively walks directories. Each file is tested against `FileTypeAnalyzer.accept(File)`. Matching files become `Dependency` objects added to the engine's list.
4. `Engine.analyzeDependencies()` — iterates through all `AnalysisPhase` values in order. For each phase, gets its list of analyzers. For each analyzer, creates `AnalysisTask` per dependency and runs them on an `ExecutorService` (parallel if analyzer supports it). Analyzers enrich `Dependency` objects with `Evidence`, `Identifier`s, and `Vulnerability` entries.
5. `ReportGenerator.writeReport()` — constructs Velocity context with dependencies, analyzers, database properties. Renders templates for the selected format(s).

## Key Patterns

**Analyzer chain (SPI):** All 50+ analyzers implement the `Analyzer` interface and are registered in `META-INF/services/org.owasp.dependencycheck.analyzer.Analyzer`. `AnalyzerService` uses Java's `ServiceLoader` to discover them. Each analyzer declares its phase via `getAnalysisPhase()`. The engine groups them into an `EnumMap<AnalysisPhase, List<Analyzer>>` and executes phases sequentially. This makes adding new ecosystem support straightforward — implement the interface, register in the services file.

**Evidence-based identification:** Dependencies accumulate `Evidence` records (typed as `VENDOR`, `PRODUCT`, `VERSION`, `VERSION_CONFIDENCE`) during the information collection phases. The `CPEAnalyzer` then constructs Lucene queries from this evidence and searches an in-memory `CpeMemoryIndex` populated from the NVD's CPE dictionary. Matching confidence levels (`HIGHEST`, `HIGH`, `MEDIUM`, `LOW`) determine which CPE identifiers are retained.

**Three-tier suppression:** False positive management operates at three levels: (1) CPE suppression (`CpeSuppressionAnalyzer`) removes incorrect CPE matches, (2) vulnerability suppression (`VulnerabilitySuppressionAnalyzer`) silences specific CVEs, and (3) a hosted community suppression file (`HostedSuppressionsDataSource`) provides crowd-sourced rules. All suppression rules use XML files with regex-based matching on CPE vendor/product/version. The `UnusedSuppressionRuleAnalyzer` in the `FINAL` phase warns about rules that didn't match anything — useful for pruning stale suppressions.

**Mode split:** `Engine.Mode` has three values: `EVIDENCE_COLLECTION` (no database, collects metadata only), `EVIDENCE_PROCESSING` (database required, processes pre-collected evidence), and `STANDALONE` (both). This split supports distributed architectures where evidence collection can happen on build agents and processing on a central server.

**Database abstraction:** The CVE database layer (`CveDB`) supports H2 (embedded default), MySQL/MariaDB, PostgreSQL, Oracle, and MS SQL Server. SQL statements are externalized into `dbStatements.properties` with per-database overrides (e.g., `dbStatements_h2.properties`).

## Non-Obvious Details

**CPE matching is fuzzy and confidence-driven.** The `CPEAnalyzer` doesn't do exact matching. It builds weighted Lucene queries from evidence terms, and the `Fields` class defines boosting strategies. The `VersionFilterAnalyzer` (in `POST_INFORMATION_COLLECTION3`) filters out evidence with version ranges that don't match the dependency's actual version before CPE lookup even happens. The `NpmCPEAnalyzer` runs in a separate phase (`PRE_IDENTIFIER_ANALYSIS`) specifically because it reuses the `CPEAnalyzer`'s Lucene index as a singleton — a subtle ordering dependency noted in the enum's Javadoc.

**NVD API rate limiting is a critical operational concern.** Since v9.0, the tool uses the NVD REST API instead of data feeds. Without an API key, updates are rate-limited to near-unusable speeds. The `NvdApiDataSource` uses `io.github.jeremylong.open-vulnerability-client` for API calls with configurable retry and delay logic. In CI environments with shared API keys, the README explicitly warns about 403 errors and recommends a caching strategy. The H2 database acts as this cache — once populated, subsequent runs only fetch deltas.

**Hosted suppression is a hidden network dependency.** `AbstractSuppressionAnalyzer` loads two suppression sources: a bundled base file (`dependencycheck-base-suppression.xml`) and a hosted snapshot (`dependencycheck-hosted-suppression-snapshot.xml`) fetched from GitHub. If the hosted file fails to load, the analyzer logs a warning but continues — a deliberate resilience choice that means stale suppression data won't block scans.

**H2 database file locking and corruption.** The `Engine` uses a `WriteLock` mechanism for H2 database access to prevent concurrent writes. When H2 database files become corrupted (a recurring issue mentioned in README), the tool provides `purge` operations via CLI/Maven/Gradle. The `openDatabase(readOnly, lockRequired)` method copies the H2 file to a temp directory for read-only access — a defensive pattern to avoid locking the primary database during analysis.

**RetireJS integration.** `RetireJsAnalyzer` consumes data from the `RetireJSDataSource`, which fetches a curated JavaScript vulnerability repository. This supplements NVD data for JavaScript libraries where CPE matching is unreliable — npm package names don't always map cleanly to CPE product identifiers.

## Assessment

**Strengths:** The analyzer chain architecture is genuinely extensible — adding a new ecosystem means implementing one class and one service registration. The evidence-based CPE matching system, while imperfect, provides a reasonable heuristic approach to identifying vulnerable software across diverse package formats. Broad ecosystem support (15+ languages/package managers) makes it one of the most versatile open-source SCA tools. The three-tier suppression system gives teams practical false positive management. Multi-format reporting (HTML, XML, JSON, CSV, SARIF, JUNIT, GitLab) integrates well with CI tooling.

**Concerns:** The `Engine` class at 1,349 lines is a God object — it handles scanning, analysis orchestration, database lifecycle, updates, and reporting coordination all in one place. The 13-phase analysis pipeline is complex and the phase ordering contains subtle dependencies (e.g., `NpmCPEAnalyzer` singleton reuse) that aren't enforced at compile time. The H2 embedded database is operationally fragile — file corruption and version incompatibility are recurring issues. NVD API rate limiting creates a reliability dependency on an external service with tight quotas. CPE matching produces false positives that require active suppression management.

**Recommendations:** For teams adopting Dependency-Check, budget time for suppression rule management and consider using a shared, cached database in CI. For contributors, the `Engine` class is the highest-value refactoring target — extracting database lifecycle, update orchestration, and report generation into separate coordinators would improve maintainability significantly.

## Related

- [[analyzing-trufflehog]]
- [[analyzing-prowler]]
- [[analyzing-cloudsplaining]]
- [[analyzing-datadog-guarddog]]
- [[analyzing-packj]]
