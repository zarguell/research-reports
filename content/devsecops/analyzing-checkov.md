---
title: "Analyzing Checkov"
date: 2026-05-09
type: codebase-analysis
status: complete
source: https://github.com/bridgecrewio/checkov
tags: [python, devsecops, iac, static-analysis, sast, policy-as-code]
---

> **Source:** [bridgecrewio/checkov](https://github.com/bridgecrewio/checkov) @ [`25821c4`](https://github.com/bridgecrewio/checkov/commit/25821c44e1ace91d0387eef3b1b5ef44b078944a)

## How It Works

Checkov is a static analysis tool for infrastructure-as-code that parses IaC files (Terraform, CloudFormation, Kubernetes manifests, Dockerfiles, and ~20 other formats), builds an in-memory resource graph, then evaluates that graph against a library of policy checks. The core loop is: **parse → build graph → run checks → produce report**.

Each supported framework has a dedicated **runner** (e.g., `terraform.runner.Runner`, `cloudformation.runner.Runner`). Runners discover files, parse them into a normalized definition structure, hand those definitions to a `GraphManager` which constructs a directed graph via `rustworkx` (a Rust-based Python graph library), and then pass the graph to one or more **registries** that execute checks against it. Results are collected into `Report` objects that support CLI, JSON, SARIF, JUnit, CycloneDX, and SPDX output formats.

Checkov ships with **over 1,000 built-in policies** organized across two check systems: legacy Python-based resource checks (subclassing `BaseResourceCheck`) and newer declarative graph checks written in YAML/JSON. The declarative checks use a solver engine that evaluates logical conditions (attribute checks, connection checks, filter conditions) against the resource graph, enabling cross-resource policy evaluation—e.g., "ensure every ALB has an associated WAF."

## Architecture

```
checkov/
├── main.py                    # CLI entry point, Checkov class
├── runner_filter.py           # Filters which checks/frameworks run
├── common/
│   ├── checks_infra/          # Check loading, parsing, registry base classes
│   ├── graph/
│   │   ├── checks_infra/      # Graph check base classes, solver engine
│   │   ├── graph_builder/     # LocalGraph, graph manager, connectors
│   │   └── db_connectors/     # rustworkx (default) and networkx backends
│   ├── bridgecrew/            # Prisma Cloud / Bridgecrew platform integration
│   ├── output/                # Report, Record, SARIF, CycloneDX, SPDX
│   ├── runners/
│   │   ├── base_runner.py     # Abstract BaseRunner
│   │   └── runner_registry.py # Orchestrates parallel runner execution
│   └── parallelizer/          # Multi-process parallelization
├── terraform/                 # Terraform runner, parser, graph builder, checks
├── cloudformation/            # CloudFormation runner + checks
├── kubernetes/                # K8s runner + checks
├── secrets/                   # Secret detection runner
├── sast/                      # SAST runner
├── sca_package_2/             # SCA (package) runner
├── sca_image/                 # SCA (container image) runner
└── [25+ framework dirs]      # ARM, Bicep, Helm, Dockerfile, etc.
```

Each framework directory follows a consistent pattern: a `runner.py`, a `checks/` directory (with `resource/` for Python checks and `graph_checks/` for YAML/JSON checks), and optionally a `graph_builder/` and `graph_manager.py`.

## The Spine

The request lifecycle flows through these key points:

1. **`bin/checkov`** → calls `Checkov(sys.argv[1:])` (in `main.py`)
2. **`Checkov.__init__`** → parses CLI args via `configargparse`, normalizes framework/filter config
3. **`Checkov.run()`** → instantiates `RunnerFilter`, constructs `RunnerRegistry` with all 27+ runners
4. **`RunnerRegistry.run()`** → filters valid runners, dispatches them via `parallel_runner.run_function()` (multi-process by default)
5. **Each runner's `run()` method**:
   - Discovers files by extension/name
   - Parses definitions (framework-specific parser)
   - Builds a `LocalGraph` via its `GraphManager`
   - Loads checks from its registry (Python checks auto-register at import; YAML/JSON checks loaded from disk)
   - `BaseRegistry.run_checks()` executes checks against the graph using `ThreadPoolExecutor`
   - Returns a `Report`
6. **`RunnerRegistry`** merges reports, runs post-scan integrations, returns to `Checkov.run()`
7. **`Checkov`** outputs reports (CLI, file, upload to Prisma Cloud)

```
CLI args → Checkov → RunnerRegistry → [Runner.run() × N (parallel)]
                                               ↓
                                          Parse → Graph → Checks → Report
                                               ↓
                                     Merge reports → Output / Upload
```

## Key Patterns

### Check Registration via Import Side-Effects
Python-based checks register themselves at import time. `BaseResourceCheck.__init__()` calls `resource_registry.register(self)` — simply importing the module is enough. This is why you'll see `import checkov.terraform.checks.resource` chains in runner initialization.

### Declarative Graph Checks (YAML/JSON)
The newer check format defines policies declaratively:

```yaml
metadata:
  id: "CKV2_AWS_7"
  name: "Ensure EMR clusters' security groups are not open"
  category: "NETWORKING"
definition:
  and:
    - resource_types: [aws_emr_cluster]
      connected_resource_types: [aws_security_group]
      operator: exists
      cond_type: connection
    - cond_type: attribute
      resource_types: [aws_security_group]
      attribute: "ingress.*.cidr_blocks"
      operator: not_contains
      value: "0.0.0.0/0"
```

These are parsed by `GraphCheckParser` and evaluated by a solver engine (`checkov/common/checks_infra/solvers/`) supporting `and`, `or`, `not` combinators plus attribute, connection, and filter conditions.

### Runner Per Framework
Every framework follows the same contract: subclass `BaseRunner`, implement `run()`, declare `check_type`. The `RunnerRegistry` orchestrates them in parallel via Python's `multiprocessing`.

### Graph Backend: rustworkx
Graphs are stored in `rustworkx.PyDiGraph` (a Rust-based directed graph library) by default. A `NetworkxConnector` fallback exists. This is a performance-critical choice—graph traversal is on the hot path for every check.

### Bridgecrew/Prisma Cloud Integration
`bc_integration` (a singleton) handles API key validation, policy metadata download, custom policy loading, suppression rules, enforcement rules, and result upload to S3. The integration feature registry (`integration_feature_registry`) runs pre-scan and post-scan hooks for licensing, custom policies, suppressions, and policy metadata.

## Non-Obvious Details

> [!note] YAML graph checks are compiled to JSON at build time
> `setup.py` includes a `PreBuildCommand` that transforms all YAML graph checks to JSON during `python setup.py build`. The JSON versions are what actually ship in the package.

> [!warning] The `common` package must not import framework-specific modules
> Enforced via `import-linter` in `pyproject.toml`. The `checkov.common` package is forbidden from importing any framework module (terraform, cloudformation, etc.). There are a handful of explicit exceptions, most marked "considering what to do"—technical debt from tight coupling.

> [!tip] Graph check IDs follow a convention
> `CKV_<provider>_<number>` for single-resource checks (legacy Python), `CKV2_<provider>_<number>` for multi-resource graph checks. The numbering is sequential per provider.

> [!note] Pyston JIT acceleration
> On Linux/macOS x86_64 with CPython < 3.11, Checkov installs `pyston==2.3.5` as a dependency for JIT acceleration. This is a non-trivial performance optimization that most users won't notice.

> [!note] Two-level parallelism
> Runners execute in parallel (multi-process), and within each runner, graph checks execute in parallel (multi-thread via `ThreadPoolExecutor`). This two-level parallelism is the main reason Checkov can scan large codebases in reasonable time.

## Assessment

**Strengths:**
- The declarative YAML/JSON check format is a major strength—policies are data, not code, making them auditable and easy to write without Python knowledge.
- The graph-based approach enables cross-resource checks that simpler line-by-line scanners can't express.
- Framework coverage is exceptional (27+ frameworks) while maintaining a consistent runner pattern.
- Strong import dependency boundaries enforced by linting.

**Concerns:**
- The codebase has significant coupling to the Prisma Cloud platform. The `bc_integration` singleton permeates the runner registry and main loop, making offline/pure-CLI usage a secondary path.
- At ~9,800 files, the monorepo structure creates long import chains and high test overhead.
- The legacy Python check system and the newer graph check system coexist, creating two mental models for contributors. New checks should almost always use the YAML format, but the old system isn't deprecated.
- The `pyproject.toml` shows several "considering what to do" exceptions to the import rules, indicating architectural debt.

**Recommendations:**
- For users adopting Checkov: invest in custom YAML graph checks via `--external-checks-dir` rather than writing Python checks.
- For contributors: understand the graph check solver engine before attempting complex multi-resource policies.
- For the project: consider extracting the `bc_integration` layer into a pluggable backend to clean up the separation between core scanning and platform upload.

## Related

- [[analyzing-gitleaks]]
- [[analyzing-cloudsplaining]]
- [[analyzing-cloudsploit]]
- [[analyzing-prowler]]
- [[analyzing-trufflehog]]
- [[analyzing-ship-safe]]
