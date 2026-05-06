---
title: "Analyzing Packj"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/ossillate-inc/packj
tags: [python, security, supply-chain-security, npm, pypi, sandboxing, cli, strace, static-analysis, dynamic-analysis, malware-detection]
---

# Analyzing Packj

## Orient

Packj (pronounced "package") is an open-source supply chain security tool developed by cybersecurity researchers at Ossillate Inc., originating from a PhD research project at Georgia Tech's CyFI lab. The project's static analysis techniques descend from the [MalOSS](https://github.com/osssanitizer/maloss) academic framework. Backed by NSF and state government grants, Packj has been presented at PyCon US, Black Hat Arsenal (Asia and USA), Open Source Summit Europe, and NullCon. It has identified over 60 malicious packages across PyPI and RubyGems, many of which were subsequently taken down.

The codebase lives at [ossillate-inc/packj](https://github.com/ossillate-inc/packj) (~686 stars, AGPL-3.0). Despite a README claiming support for Rust, PHP, Maven, and NuGet, the actual implementation is overwhelmingly Python (v0.15, requiring Python ≥3.4). A Java subproject exists for Java AST analysis (astgen-java, using Soot). Ruby scripts handle RubyGems package introspection. The project has no test suite whatsoever---zero test files exist in the repository.

## Find the Spine

The execution spine is a straightforward CLI pipeline with three entry points dispatched from `packj/main.py`:

```
main.py → packj/main.py → Options (argparse)
  ├─ auth   → packj/auth/main.py   (OAuth with packj.dev)
  ├─ audit  → packj/audit/main.py  (core analysis)
  └─ sandbox → packj/sandbox/main.py (safe installation)
```

The `audit` command is the heart of the tool. When you run `packj audit -p pypi:requests`, the spine executes in `packj/audit/main.py::audit()` (line 1028) in this exact sequence:

1. **Resolve package**: The PM proxy fetches metadata from the registry API (e.g., PyPI JSON API at `pypi.python.org/pypi/{name}/json`)
2. **Metadata analysis** (~15 sequential checks): description, release history, yanked releases, version age, release time gaps, author email validity, readme quality, homepage validity, download counts, zero-width unicode, install hooks, typo-squatting, dependency confusion, repo URL validation, repo info (stars/forks/activity), repo release matching, repo code matching, CVEs, and dependency count
3. **Download package**: Fetches the distribution archive (preferring sdist over bdist_wheel)
4. **Static analysis**: Runs language-specific AST generators, then maps detected API calls to permission categories
5. **Dynamic analysis** (optional, `--trace`): Installs the package under `strace`, parses syscall traces
6. **Aggregate and report**: Generates JSON per-package reports and an HTML summary via Django templates

Each metadata check is a standalone `analyze_*()` function that mutates a shared `risks` dictionary and `report` dictionary, following a consistent try/except/finally pattern that never halts on individual check failures.

## Identify Patterns

### Permission Model (Android-inspired)

The core abstraction maps sensitive API calls to six permission categories defined in the `Risk` enum (line 841): `file`, `codegen`, `process`, `decode`, `envvars`, and `network`. This is explicitly modeled after Android's runtime permission system---a design choice from the original MalOSS research. The `ALERTS` dictionary maps AST node types (e.g., `SINK_NETWORK`, `SOURCE_OBFUSCATION`) to human-readable risk descriptions.

### PM Proxy Pattern

Each package registry has a proxy class (`PypiProxy`, `NpmjsProxy`, `RubygemsProxy`, `RustProxy`, `PackagistProxy`, `MavenProxy`, `NugetProxy`) extending `PackageManagerProxy`. These are thin wrappers around registry REST APIs---fetching metadata, release history, author info, download stats, and dependencies. `pm_util.py` acts as a factory via `get_pm_proxy()` and `get_pm_enum()`. Notably, the Rust and NuGet proxies exist but lack corresponding static analyzers.

### API-to-Permission Mapping via CSV

Static analysis results (AST nodes) are mapped to permissions through CSV files (`config/{python,javascript,rubygems}_api/apis2perms.csv`). The `parse_apis.py` module reads these mappings and cross-references them against the JSON output from AST generators. This decoupling makes it trivially extensible---adding a new risky API requires only a CSV entry.

### SMT-Based Formula Evaluation

The `StaticAnalyzer._check_smt()` method (static_base.py:200) can evaluate satisfiability of Boolean formulas over API usage. The formula is defined in protobuf config files (e.g., `astgen_python_smt.config`) and transformed into Python expressions via regex substitution, then `eval()`'d. This allows expressing complex detection rules like "flag if `decode` AND `exec` are both present." Currently, `evaluate_smt` is set to `False` in the audit pipeline.

### The `alert_user()` Pattern

Every risk check goes through `alert_user(alert_type, THREAT_MODEL, reason, risks)`, which consults the user's threat model (from `.packj.yaml`) to decide whether the alert should fire. This is the policy engine---a flat dictionary mapping alert sub-categories to their parent categories (malicious, suspicious, vulnerable, undesirable). The policy file has 30+ configurable rules with `enabled` booleans, allowing users to tune noise.

## Spot Non-Obvious

### Sandbox Uses LD_PRELOAD, Not Containers

The sandbox (`packj/sandbox/`) is the most architecturally distinctive part. It works by LD_PRELOADing a custom shared library (`libsbox.so`, compiled from the pre-built `sandbox.o` object file---source intentionally kept closed) into a modified strace binary. This hooks system calls at the libc level, rewriting arguments in real-time. For example, a malicious package calling `open("/home/user/.ssh/id_rsa", ...)` would have the path transparently rewritten to a sandbox directory. This is system call interposition (also called "trampolining"), and it's fundamentally different from Docker or chroot because the host filesystem is preserved---the tool creates a Copy-on-Write layer. The README explicitly references the Stanford "traps and pitfalls" paper on interposition, claiming they've addressed those issues.

### The sandbox.o Binary is Closed Source

`sandbox.o` is a pre-compiled C object file checked into the repository. The Makefile links it into `libsbox.so`. The README says this is "NOT to implement security by obscurity, but to avoid easy copy-and-reuse." This is a significant trust concern for a security tool---users must trust an opaque binary that intercepts all system calls.

### No Actual Dependency Tree Resolution

Despite the dependency file parsing (`-f npm:package.json pypi:requirements.txt`), Packj does NOT build a transitive dependency tree. It extracts direct dependencies from the lockfile/manifest and audits each as a flat list. There's no recursive resolution. The `parse_deps_file()` methods do simple line-by-line parsing (for requirements.txt) or JSON parsing (for package.json) without version resolution.

### Many Features Are Stubbed Out

Four analyses are explicitly stubbed with "Coming soon!": zero-width unicode detection, install hooks analysis, typo-squatting detection, and dependency confusion detection. Additionally, risky API sequence analysis (e.g., detecting `decode()` followed by `exec()`) is stubbed. The SMT formula evaluation exists but is disabled. The repo-pkg source code matching (`analyze_repo_code`) also returns "Coming soon!" These stubs are scattered throughout the 1,236-line `audit/main.py`.

### strace Parsing Is Comprehensive but Linux-Only

The `strace_parser/` module has an extensive syscall table covering files, networking, process, time, signal, and IPC syscalls---each with custom parsers. The `rules.yaml` defines path ignore lists for common noise (system libraries, caches). But this entire dynamic analysis path is Linux-only and requires actual package installation, which is why the README strongly recommends Docker.

### CVE Checking Uses OSV, Not NVD

Vulnerability detection queries Google's OSV API (`api.osv.dev/v1/query`), not the NVD. This is actually a better choice---OSV aggregates multiple vulnerability databases (including NVD) and has a cleaner API. The implementation in `osv.py` is straightforward and supports all seven ecosystems.

### Python 2 Fallback in Static Analysis

The `PyAnalyzer.astgen()` catches `SyntaxError` exceptions and falls back to a Python 2 AST generator (`astgen_py.py`). This is a thoughtful accommodation for older PyPI packages, though Python 2 itself reached EOL in 2020.

### Django for HTML Report Generation

The summary report generator (`report.py`) imports the full Django stack just to render a single HTML template. This is a heavy dependency (21 requirements, including Django 4.1) for what amounts to string interpolation with a loop. It works, but it's an unusual choice for a CLI tool.

## Assess

Packj occupies a genuine and underserved niche: it goes beyond CVE scanning to analyze behavioral attributes of open-source packages. The three-pronged approach---metadata heuristics, static API usage analysis, and dynamic syscall tracing---provides defense-in-depth that no single existing tool matches. The design is informed by empirical study of 651 real malware samples, giving it credibility that ad-hoc heuristics lack.

However, the implementation has significant rough edges. The absence of any test suite is the most glaring weakness. The codebase mixes research prototype quality with production ambitions---bare `except` clauses, mutable default arguments in function signatures, and inconsistent error handling pervade the code. The 1,236-line `audit/main.py` is a monolith that duplicates patterns across 20+ `analyze_*()` functions rather than using a data-driven approach.

The closed-source sandbox binary (`sandbox.o`) is a fundamental tension for an AGPL-licensed security tool. Users auditing their supply chain must trust an unauditable blob that intercepts system calls. The README's justification ("avoid easy copy-and-reuse") doesn't fully address this concern.

The tool's utility is real and proven---it has found genuine malware that was taken down. But the gap between the README's claimed capabilities and the actual implementation is wide. Half of the "Coming soon!" features have been in that state since at least v0.15 (2023). The recommended Docker workflow adds friction, while the native Linux experience requires building strace from source.

For supply chain security research, Packj is a valuable reference architecture. Its permission model, API-to-permission CSV mapping, and SMT formula approach are clever abstractions. The syscall interposition sandbox is technically impressive even if partially closed. But as a production dependency auditing tool, it needs tests, refactored internals, and completion of its many stubbed features before it can be trusted at scale.

## Related

- [[analyzing-datadog-guarddog]] — Datadog's Guarddog is another open-source supply chain security tool that uses static analysis and ML heuristics to detect malicious PyPI and npm packages.
