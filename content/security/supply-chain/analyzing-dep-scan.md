---
title: "Analyzing dep-scan"
date: 2026-05-10
type: codebase-analysis
status: complete
source: https://github.com/owasp-dep-scan/dep-scan
tags: [python, sbom, sca, vulnerability-scanning, supply-chain, devsecops, cyclonedx, owasp]
---

> **Source:** [owasp-dep-scan/dep-scan](https://github.com/owasp-dep-scan/dep-scan) @ [`8a74d71`](https://github.com/owasp-dep-scan/dep-scan/commit/8a74d713e12cf807ae644130dd889a36d89af792)

## How It Works

OWASP dep-scan is a dependency security and risk audit tool. You point it at a source directory, container image, binary, or existing CycloneDX SBOM, and it produces a vulnerability report enriched with reachability context, risk scores, and license analysis.

The mental model is a pipeline with four stages:

1. **BOM generation** — Delegates to cdxgen (CLI, HTTP server, or container image), or blint for binaries. Produces CycloneDX JSON SBOMs.
2. **Vulnerability matching** — Queries a local vulnerability database (VDB) downloaded via ORAS from a remote registry, supplemented by remote advisory sources (npm audit, GitHub).
3. **Analysis and enrichment** — Runs VDR (Vulnerability Disclosure Report) analysis, reachability analysis via atom slices, and OSS risk audits against PyPI/npm/crates.io metadata.
4. **Output** — Renders console tables, HTML/TXT reports, VDR JSON, CSAF VEX documents, and optional LLM-ready explanation prompts.

The tool runs entirely locally by default — no telemetry, no server. Server mode is an opt-in HTTP API built on Quart.

## Architecture

dep-scan is a **uv workspace** with four local packages:

| Package | Purpose |
|---|---|
| `depscan` (root) | CLI, orchestration, audit/risk logic, license analysis, explainer |
| `packages/xbom-lib` | BOM generation backends — cdxgen CLI, cdxgen server HTTP, cdxgen container images, blint |
| `packages/analysis-lib` | VDR analysis, reachability analysis, CSAF export, search/scope utilities |
| `packages/reporting-lib` | HTML report generation from Rich console output |
| `packages/server-lib` | Quart-based HTTP server mode (optional, behind `owasp-depscan[server]`) |

```
                    ┌──────────────────┐
                    │   depscan CLI    │
                    │   cli.py:main()  │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              v              v              v
        ┌──────────┐  ┌────────────┐  ┌──────────┐
        │ xbom-lib │  │analysis-lib│  │server-lib│
        │ (cdxgen, │  │ (VDR,      │  │ (Quart   │
        │  blint)  │  │  reach.,   │  │  HTTP)   │
        └────┬─────┘  │  CSAF)     │  └──────────┘
             │        └────────────┘
             v
    ┌────────────────┐
    │ cdxgen (ext)   │  ← subprocess / HTTP / Docker
    │ VDB (ORAS)     │  ← local vulnerability database
    │ npm/PyPI/crates│  ← registry metadata lookups
    └────────────────┘
```

**Key dependency chain:** `appthreat-vulnerability-db` provides the VDB search engine and ORAS download. `packageurl-python` handles PURL parsing. `defusedxml` guards XML BOM parsing. `Jinja2` drives custom report templates. `httpx` handles all HTTP client calls.

## The Spine

The request lifecycle from `depscan.cli:main()`:

1. **`main()`** → `build_args()` parses CLI options → calls `run_depscan(args)`.
2. **`run_depscan()`** is the ~500-line orchestrator:
   - Downloads VDB if stale (`db_lib.needs_update()`)
   - Detects project types via `set_project_types()` — can be explicit (`-t`), auto-detected, or "universal"
   - For each project type, enters a loop:
     - **BOM creation**: `create_bom()` in `depscan/lib/bom.py` selects engine (cdxgen CLI, cdxgen server, cdxgen image, or blint) via `xbom_lib`
     - **Package extraction**: Parses JSON/XML BOM into flat package lists
     - **License audit** (opt-in): Bulk SPDX license lookup
     - **Risk audit** (opt-in): Queries npm/PyPI/crates.io for maintenance metrics, confusion attack detection
     - **Remote audit** (opt-in): npm advisory via `NpmSource.bulk_search()`
     - **Reachability analysis**: `get_reachability_impl()` processes atom slices
     - **VDR analysis**: `VDRAnalyzer.process()` matches packages against VDB, produces prioritized vulnerability trees
     - **Explanation** (opt-in): `explainer.explain()` renders reachable flows, endpoint summaries, and LLM prompts
     - **CSAF export** (opt-in): Generates OASIS CSAF VEX
   - Renders HTML/TXT reports, applies custom Jinja templates, annotates VDR files

**Server mode** branches early in `run_depscan()`: constructs `ServerOptions`, delegates to `server_lib.simple.run_server()`. The Quart app exposes `GET/POST /scan` which accepts path, URL, or uploaded BOM — validates inputs, generates BOM, runs VDR analysis, returns JSON.

## Key Patterns

**Strategy pattern for BOM generation.** `xbom_lib` defines an abstract `XBOMGenerator` with a `generate() → BOMResult` interface. Four concrete implementations exist: `CdxgenGenerator` (subprocess), `CdxgenServerGenerator` (HTTP), `CdxgenImageBasedGenerator` (Docker/Podman), and `BlintGenerator` (binary analysis). Selection is automatic based on project type, available tooling, and `--bom-engine` override.

**Lifecycle-aware SBOM generation.** The `LifecycleAnalyzer` produces separate SBOMs for pre-build, build, post-build, container, and operations phases. Reachability analysis then compares across these lifecycle BOMs to distinguish genuinely reachable paths from false positives.

**VDB as a local database.** Vulnerability data ships as a pre-built database downloaded via ORAS (OCI registry). The `appthreat-vulnerability-db` library manages search against this local store, keeping all matching offline unless remote audit is explicitly enabled.

**Profile-driven configuration.** Profiles like `appsec`, `research`, `operational`, `threat-modeling`, and `machine-learning` pre-configure BOM engine, analysis technique, and reachability analyzer choices. This reduces the surface area of CLI flags users need to understand.

**Defense-in-depth for server mode.** The Quart server stacks: API key auth (constant-time compare), host allowlisting, path allowlisting (with `realpath` resolution), URL scheme validation, private IP blocking (with DNS resolution), request size limits, project type validation, and CycloneDX format validation on uploads.

## Non-Obvious Details

> [!warning] `cdxgen_args` passthrough
> The `--cdxgen-args` flag passes arbitrary arguments through `shlex.split()` directly to the cdxgen subprocess. In local CLI mode this is a trusted operator choice, but in server mode it would be a command injection vector. The server path does **not** pass `cdxgen_args` to `create_bom()`, which is the correct boundary.

> [!note] Windows uses `shell=True`
> In `xbom_lib/cdxgen.py`, the `exec_tool()` function sets `shell=sys.platform == "win32"` in `subprocess.run()`. This is a known Windows compatibility requirement but slightly widens the attack surface on that platform.

> [!tip] Reachability without vulnerability-first approach
> Unlike most SCA tools that start from known CVE sinks, dep-scan computes reachable data flows via atom *before* intersecting with vulnerability data. This means it can surface reachable-but-not-yet-vulnerable paths, which is useful for proactive security.

> [!note] Image-based cdxgen is the auto-default on Linux
> When Docker/Podman is available and the platform is not Windows, `CdxgenImageBasedGenerator` is auto-selected in `auto` mode for non-container project types. This means a simple `depscan --src .` on a Linux machine with Docker installed will pull and run a container image, which may surprise users expecting purely local execution.

> [!warning] Explanation output as prompt-like content
> The explainer generates structured content designed for both human review and LLM consumption (`depscan-prompts.md`). This includes endpoint names, file paths, vulnerability-to-code mappings, and reachable flow details. In CI artifacts or dashboards, this can expose more internal architecture than intended.

> [!question] Self-hosted runner in CI
> The `repotests.yml` workflow uses a self-hosted runner for deeper repository scans. Self-hosted runners have a different persistence and isolation profile than GitHub-hosted runners, which is worth tracking as a supply chain concern.

## Assessment

**Strengths:**

- **Thoughtful threat model.** The `THREAT_MODEL.md` is unusually detailed for an open-source project — it names specific attack surfaces, trust boundaries, and review questions per component. It treats workflows and Dockerfiles as security-relevant code, not plumbing.
- **Multi-layered analysis.** Combining local VDB matching, remote advisory lookups, reachability via atom slices, and registry metadata risk scoring in one tool is genuinely distinctive. Most SCA tools do one or two of these.
- **Server mode hardening.** The Quart server has more input validation than many production APIs: constant-time API key comparison, DNS-resolved private IP blocking, path traversal protection with `realpath`, upload size limits, and CycloneDX format validation.
- **Structured as a workspace.** Splitting into `xbom-lib`, `analysis-lib`, `reporting-lib`, and `server-lib` makes the trust boundaries clearer and allows `server-lib` to be an optional dependency.
- **Workflow discipline.** GitHub Actions are pinned by commit SHA, release uses trusted publishing, and the nydus binary has a pinned SHA-256.

**Concerns:**

- **Orchestrator complexity.** `run_depscan()` is ~500 lines with significant branching on mode flags. The lifecycle analysis mode, bom-dir mode, single-purl mode, CSAF mode, and explain mode each add conditional paths. This makes the full state space hard to reason about.
- **External toolchain dependency.** cdxgen (Node.js), atom-tools, blint, and the container images are all separate projects with their own supply chains. A vulnerability or behavior change in any of them affects dep-scan's results.
- **Risk audit precision trade-off.** The code comments acknowledge that enabling risk audit may reduce reachability precision. Users may not realize these features interact.
- **Template rendering.** Custom Jinja report templates (`--report-template`) are a code injection surface if templates come from untrusted sources. This is documented as a trusted-operator feature but the boundary could be clearer.

**Recommendations:**

- Consider splitting `run_depscan()` into smaller functions per mode (lifecycle, single-purl, bom-directory, server) to reduce the cyclomatic complexity of the main loop.
- Add a `--dry-run` flag that prints the selected engine, project types, and analysis plan without executing, to help users understand what dep-scan will do before it pulls images or runs subprocesses.
- Document the reachability-without-vulnerability-first approach more prominently — it is a genuine differentiator that is buried in code comments.
- Consider adding integrity checks (checksums or signatures) for the VDB download beyond HTTPS, since the VDB is the foundation of all vulnerability matching.

## Related

- [[analyzing-syft]]
- [[analyzing-dependency-track]]
- [[analyzing-dependency-check]]
- [[analyzing-trivy]]
