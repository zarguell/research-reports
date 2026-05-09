---
title: "Analyzing Syft"
date: 2026-05-09
type: codebase-analysis
status: complete
source: https://github.com/anchore/syft
tags: [go, sbom, supply-chain, containers, cli]
---

> Source: [anchore/syft](https://github.com/anchore/syft) at [`87d6a28`](https://github.com/anchore/syft/commit/87d6a288d7dbaa32e57480c1a74beea9cf39da92)

## How It Works

Syft generates a Software Bill of Materials from container images, filesystems, and archives. You point it at a target — a Docker image, an OCI directory, a local directory — and it resolves the target into a file tree, runs a fleet of *catalogers* across that tree, and collects every package, license, and relationship it can find into a structured SBOM. The SBOM can be emitted as CycloneDX, SPDX, Syft JSON, or a custom template.

The mental model is simple: **one source → many catalogers → one SBOM**. Each cataloger is a narrow specialist (one for Alpine apk databases, one for Python `requirements.txt`, one for ELF binaries) that knows how to find its ecosystem's packages given a file resolver. Catalogers run in parallel within task groups, and the results are merged into a single `SBOM` struct behind a mutex.

## Architecture

The top-level packages are organized by responsibility:

- **`cmd/syft/`** — CLI entry point. Cobra-based, with commands for `scan`, `attest`, `convert`, and `cataloger` introspection. The root command is an alias for `scan`.
- **`syft/`** — the public library surface. `CreateSBOM()` and `GetSource()` are the two main entry points for library consumers.
- **`syft/pkg/`** — the core `Package` model, `Collection` (package catalog), and the `Cataloger` interface. Every ecosystem-specific cataloger lives under `syft/pkg/cataloger/<ecosystem>/`.
- **`syft/source/`** — `Source` abstraction. A source provides a `FileResolver` scoped to one of three views: *squashed* (runtime-visible files), *all-layers* (every layer), or *deep-squashed* (all layers but deduped to runtime view).
- **`syft/artifact/`** — `ID` (content-addressable via hash), `Relationship`, and `Identifiable` interface. The relationship graph connects packages to files, packages to packages, and files to the source.
- **`syft/format/`** — output encoders: CycloneDX JSON/XML, SPDX JSON/tag-value, Syft JSON, table, text, template.
- **`syft/sbom/`** — the `SBOM` struct itself: artifacts (packages, file metadata, digests, licenses, executables, unknowns), relationships, source description, and descriptor (tool name/version/config).
- **`internal/task/`** — the task orchestration layer. Catalogers are wrapped in `Task` objects, grouped, selected by tags, and run through a parallel executor.

## The Spine

A scan flows through these stages:

1. **CLI dispatch** — `main.go` → `cli.Application()` → Cobra routes to `runScan()`.
2. **Source resolution** — `syft.GetSource()` parses the user's input string (image ref, directory path, tarball), detects the scheme, and returns a `source.Source` backed by [stereoscope](https://github.com/anchore/stereoscope) for container images or a filesystem walker for directories.
3. **Configuration** — `CreateSBOMConfig` is assembled from CLI flags and config files. It holds search scope, relationship toggles, license scanning config, package cataloging config, parallelism, and cataloger selection rules.
4. **Task group assembly** — `makeTaskGroups()` resolves which catalogers to run based on source type (image vs directory) and user selection. Task groups are ordered: environment detection → package+file cataloging (parallel within group) → scope cleanup → relationship finalization → unknowns labeling → OS feature detection.
5. **Cataloging** — Each task wraps a `pkg.Cataloger`'s `Catalog()` method, passing it a `file.Resolver`. Catalogers return `[]Package` and `[]Relationship`. Results are written to the SBOM through `sbomsync.Builder`, a mutex-guarded wrapper.
6. **Output** — The completed `SBOM` is handed to the format-specific writer selected by `-o` flags.

The `pkg.Cataloger` interface is the central contract:

```go
type Cataloger interface {
    Name() string
    Catalog(context.Context, file.Resolver) ([]Package, []artifact.Relationship, error)
}
```

Every cataloger — from `alpine.NewDBCataloger` to `golang.NewGoModuleBinaryCataloger` — implements exactly this.

## Key Patterns

### Tag-based cataloger selection

Catalogers are registered with a set of tags (e.g., `installed`, `image`, `language`, `python`, `binary`). The default set is determined by source type: image scans use `image` + `file` tags, directory scans use `directory` + `file` tags. Users can add, remove, or sub-select via `--select-catalogers` and `--override-default-catalogers` flags. The `task.SelectInGroups()` function resolves expressions like `+python -binary` into a final task set.

### Installed vs. declared

Syft distinguishes between *installed* packages (evidence in OS package databases, Python `dist-info` directories, gemspecs) and *declared* packages (lockfiles, manifest files). Installed catalogers run on image scans by default; declared catalogers run on directory scans. This is controlled entirely through tags.

### The file resolver abstraction

`file.Resolver` is the universal interface between catalogers and the data source. It provides `FilesByPath()`, `FilesByGlob()`, `FileContentsByLocation()`, and `FileMetadataByLocation()`. Container image sources resolve through stereoscope's layer-aware resolver; directory sources use a filesystem walker. Catalogers never know which they're dealing with.

### Content-addressable IDs

Every `Package` gets an `artifact.ID` computed by hashing its fields (excluding `FoundBy`, CPEs, and PURL which are derived). This enables deduplication: the same package discovered by multiple catalogers can be merged via `Package.merge()`.

### Parallel task execution

`sync.Collect()` from `anchore/go-sync` runs task groups concurrently with bounded parallelism (default: `NumCPU * 4`). The `sbomsync.Builder` serializes writes to the SBOM with a `sync.RWMutex`.

## Non-Obvious Details

**Binary classification is pattern matching, not execution.** The `binary.ClassifierCataloger` runs a curated set of classifiers that match binary files by content patterns (magic bytes, embedded version strings, file path conventions). It can identify Python, Go, Java, Node runtimes and common tools like busybox without executing anything. Classifiers are ordered; earlier definitions take precedence as "primary" evidence over later "supporting" evidence.

**Relationships are post-hoc, not incremental.** Package-to-file and package-to-package relationships are built in a separate task group *after* all cataloging completes. The `binary.PackagesToRemove()` function prunes ELF/binary packages that duplicate source packages already found by a package manager cataloger — a subtle deduplication that prevents double-counting.

**The environment task runs first for a reason.** Linux distribution detection (reading `/etc/os-release`, etc.) happens before any package cataloging because OS-package catalogers (apk, dpkg, rpm) need to know the distro to select the right database format and metadata mappings.

**License scanning is context-injected.** A single `LicenseScanner` is created per scan and injected into the context. This avoids redundant initialization of license matching rules across dozens of catalogers.

**OCI model scanning.** Syft can scan OCI model artifacts (AI models stored in registries) via a dedicated `ai.NewGGUFCataloger`, which parses GGUF model files — a relatively niche capability that reflects the evolving definition of "software" in an SBOM.

## Assessment

**Architecture fitness:** Excellent. The cataloger-per-ecosystem pattern is clean and extensible. Adding a new ecosystem means implementing the `Cataloger` interface, registering it with tags in `DefaultPackageTaskFactories()`, and writing a test. The resolver abstraction decouples catalogers from source types entirely.

**Code quality:** High. The codebase is well-structured with clear package boundaries. The `internal/` vs `syft/` split keeps internal machinery separate from the public library API. Go conventions are followed consistently. The task system is well-designed for its purpose.

**Complexity risk:** The tag-based selection system (`task.SelectInGroups`, expression parsing) is the most intricate part of the codebase and the most likely source of user confusion. The `makeTaskGroups()` method orchestrates ordering constraints (environment before packages, packages before relationships) that are correct but not immediately obvious from reading any single file.

**Security posture:** Syft reads untrusted inputs (container images, package manifests, binary files) so catalogers are naturally exposed to malformed data. Error handling is thorough — cataloger errors are logged and continued, not fatal. No network calls are made during cataloging (only during source pulling).

**Developer experience:** Strong. Library consumers get a clean API: `syft.GetSource()` → `syft.CreateSBOM()` → format. The `clio`/`fangs` configuration framework handles CLI flags, config files, env vars, and YAML merging automatically. The test infrastructure includes snapshot-based cataloger tests that compare full output against golden files.

## Related

- analyzing-hijagger
- analyzing-datadog-guarddog
- analyzing-packj
- analyzing-minimal-container-images
- analyzing-pmg
