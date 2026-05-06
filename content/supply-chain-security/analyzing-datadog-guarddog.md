---
title: "Analyzing GuardDog"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/DataDog/guarddog
tags: [python, security, supply-chain, semgrep, yara, cli]
---

# Analyzing GuardDog

## How It Works

GuardDog is DataDog's open-source CLI tool for detecting malicious packages across six ecosystems: PyPI, npm, Go modules, RubyGems, GitHub Actions, and VSCode extensions. It uses two complementary detection strategies: **source code analysis** via Semgrep rules and YARA signatures, and **metadata analysis** via Python detector classes that examine package registry information.

When you run `guarddog pypi scan requests`, the tool downloads the package archive from the registry, safely extracts it (with defenses against zip bombs, path traversal, and symlink attacks), then runs all applicable Semgrep rules against the extracted source code and all metadata detectors against the package's registry information. The results are aggregated and rendered through pluggable reporters (human-readable, JSON, or SARIF).

The key insight in GuardDog's design is that source code heuristics catch *what* malicious code does (base64 evals, data exfiltration, clipboard access), while metadata heuristics catch *who* is publishing it (typosquatting, compromised email domains, empty maintainer profiles). Neither alone is sufficient — together they form a reasonable defense-in-depth approach for supply chain malware detection.

## Architecture

```
cli.py                          Click CLI — ecosystem-agnostic group routing
├── CliEcosystem                Dynamic click.Group per ECOSYSTEM enum
│   ├── scan                    → _scan() → PackageScanner.scan_remote/scan_local
│   ├── verify                  → _verify() → ProjectScanner.scan_local
│   └── list-rules              → get_sourcecode_rules() + get_metadata_detectors()
│
scanners/
├── scanner.py                  PackageScanner (abstract) + ProjectScanner (abstract)
│   ├── PackageScanner          download → extract → Analyzer.analyze()
│   └── ProjectScanner          parse dep file → ThreadPoolExecutor → scan each dep
│
├── pypi_package_scanner.py     PyPI: queries PyPI JSON API, downloads sdist/wheel
├── npm_package_scanner.py      npm: queries npm registry, downloads tarball
├── go_package_scanner.py       Go: clones GitHub repo via pygit2
├── rubygems_package_scanner.py RubyGems: fetches .gem, extracts nested tar
├── extension_scanner.py        VSCode: downloads .vsix (ZIP-based)
└── github_action_scanner.py    Actions: clones GitHub repo via pygit2
│
analyzer/
├── analyzer.py                 Analyzer — orchestrates metadata + sourcecode analysis
│   ├── analyze_metadata()      iterates Detector.detect() for each metadata rule
│   ├── analyze_sourcecode()    delegates to analyze_semgrep() + analyze_yara()
│   ├── analyze_semgrep()       invokes semgrep CLI as subprocess
│   └── analyze_yara()          compiles and runs YARA rules in-process
│
├── metadata/                   Detector subclasses per ecosystem
│   ├── detector.py             abstract Detector base class
│   ├── typosquatting.py        TyposquatDetector — Levenshtein distance + permutations
│   ├── pypi.py                 PYPI_METADATA_RULES dict mapping
│   ├── npm.py                  NPM_METADATA_RULES dict mapping
│   └── ...
│
├── sourcecode/                 YAML Semgrep rules + YARA .yar files
│   ├── *.yml                   Semgrep rules (auto-discovered, language→ecosystem mapped)
│   └── *.yar                   YARA rules (binary/content pattern matching)
│
reporters/
├── reporter_factory.py         ReporterFactory — enum-based selection
├── human_readable.py           PrettyTable-based terminal output
├── json.py                     JSON structured output
└── sarif.py                    SARIF format for CI integration
│
utils/
├── archives.py                 safe_extract — zip bomb, symlink, device file defenses
├── config.py                   Env-var-driven configuration (parallelism, limits)
└── package_info.py             Registry API query helpers
```

## The Spine

**Entry point:** `guarddog.cli:cli` (registered in `pyproject.toml` as a Click group).

**Scan flow** (`guarddog pypi scan requests`):

1. Click dispatches to `CliEcosystem.scan_ecosystem()` → `_scan()`
2. `_scan()` resolves the target: local directory → local archive → remote package
3. For remote: `PackageScanner.scan_remote()` creates a temp directory, calls `_scan_remote()`
4. `_scan_remote()` calls `download_and_get_package_info()` (ecosystem-specific — e.g., `PypiPackageScanner` queries PyPI JSON API, downloads sdist, extracts with `safe_extract`)
5. `Analyzer.analyze()` runs both:
   - `analyze_metadata()` — iterates over all `Detector` instances, calling `detect(package_info, path, name, version)` → returns `(matched, message)`
   - `analyze_sourcecode()` → `analyze_semgrep()` (spawns `semgrep` subprocess with YAML rule configs) + `analyze_yara()` (compiles `.yar` files in-process via `yara-python`)
6. Results are merged: `{"issues": int, "results": {rule: findings}, "errors": {rule: err_msg}}`
7. `ReporterFactory` creates the appropriate reporter (default: `HumanReadableReporter`) and renders to stdout/stderr

**Verify flow** (`guarddog pypi verify requirements.txt`):

1. `ProjectScanner.scan_local()` parses the dependency file (ecosystem-specific parser)
2. Builds a `List[Dependency]` with names and versions
3. `scan_dependencies()` uses a `ThreadPoolExecutor` (default: CPU count workers) to scan each dependency in parallel via `PackageScanner.scan_remote()`
4. Results are rendered via the same reporter pipeline

## Key Patterns

**Ecosystem abstraction via enum.** The `ECOSYSTEM` enum drives everything: CLI routing, scanner selection, metadata detector selection, and sourcecode rule filtering. All ecosystem-specific logic is behind `match` statements in factory functions (`get_package_scanner`, `get_project_scanner`, `get_metadata_detectors`).

**Convention-based rule discovery.** Sourcecode rules are not registered — they're discovered by scanning the `sourcecode/` directory at import time. Any `.yml` file becomes a Semgrep rule; any `.yar` file becomes a YARA rule. The `__init__.py` maps YAML rule languages to ecosystems (`python` → PYPI, `javascript` → NPM + GitHub Actions + Extensions, etc.). Adding a new rule is as simple as dropping a file in the directory.

**Template Method for download/extract.** `PackageScanner.download_compressed()` defines the skeleton (fetch → extract → cleanup) while subclasses override `_fetch_archive()` and `_extract_archive()` for format-specific behavior (e.g., RubyGems needs nested extraction for `.gem` → tar.gz).

**Detector as strategy.** Metadata detectors subclass `Detector` and implement `detect()`, returning `(bool, Optional[str])`. They're instantiated at module load time and stored in dicts like `PYPI_METADATA_RULES`. The Analyzer has no knowledge of specific detectors — it just iterates.

**Configuration via environment variables.** All tuning knobs (parallelism, Semgrep timeout, max uncompressed size, compression ratio, file count limits, YARA file exclusions) are set through `GUARDDOG_*` env vars with sensible defaults in `utils/config.py`.

## Non-Obvious Details

**Semgrep runs as a subprocess, not a library.** Despite `semgrep` being a Python dependency, GuardDog invokes it via `subprocess.run()` with JSON output parsing. This avoids API stability issues but means every scan pays the cost of a new process + Semgrep's own startup time. The `--disable-nosem` flag is passed, meaning packages can't suppress Semgrep findings with inline comments.

**`--no-git-ignore` is intentional.** Semgrep normally respects `.gitignore`, but GuardDog explicitly disables this — malicious packages might use `.gitignore` to hide payloads.

**Typosquatting detection uses O(n×m) brute force.** For each package, it compares against the full set of ~5000 popular packages using Levenshtein distance-1 checks, adjacent swap detection, and hyphenated term permutations. There's no indexing or trie optimization. This works because the popular packages set is small, but it wouldn't scale to full registry scanning.

**Safe archive extraction is defense-in-depth.** `archives.py` checks for compression bombs (size limits, ratio limits, file count limits), unsafe symlinks (pointing outside target dir), and device files in both tar and zip. It uses `tarsafe` (a path-traversal-safe tar library) for tar archives. This is critical since GuardDog extracts *potentially malicious* archives.

**YARA rules run in-process while Semgrep runs out-of-process.** YARA rules are compiled via `yara-python` and matched against every file in the extracted directory. Semgrep is a separate process. This means a crashing YARA rule could take down the whole GuardDog process, while Semgrep failures are caught as subprocess errors.

**The `ReporterFactory.create_reporter` returns a *class*, not an instance.** Look carefully: `return HumanReadableReporter` (the class), not `HumanReadableReporter()`. The `render_scan` / `render_verify` methods are then called as class methods. This works because they're defined as `@staticmethod` or `@classmethod` on the reporters, but it's an unusual pattern.

**Extension ecosystem has no metadata detectors.** VSCode extension scanning only uses sourcecode rules. The `get_metadata_detectors(ECOSYSTEM.EXTENSION)` returns an empty dict.

> [!question]
> The `CliEcosystem` class defines `rule_options` as a closure that captures `self.ecosystem`, but the legacy `scan`/`verify` commands at module level compute `ALL_RULES` across *all* ecosystems at import time. This means the legacy commands may show rules from ecosystems you're not scanning against — a minor UX issue since they're deprecated.

## Assessment

**Code quality:** Good. The codebase is clean, well-documented, and uses consistent patterns. Type hints are present throughout. The separation between scanners, analyzers, and reporters is clear and well-maintained.

**Architecture fitness:** Strong. The ecosystem abstraction via enum + factory functions keeps multi-ecosystem support manageable without over-engineering. Convention-based rule discovery is the right call — it lowers the barrier for contributing new detection rules. The two-tier detection (source code + metadata) maps well to the actual threat model of supply chain attacks.

**Operational concerns:** Parallel dependency scanning via `ThreadPoolExecutor` is solid. However, there's no rate limiting when hitting package registries — bulk `verify` scans could trigger API throttling from PyPI/npm. The tool also lacks any caching of scan results or downloaded packages between runs.

**Security posture:** Excellent where it matters most. The `safe_extract` function is thorough against archive-based attacks. Running Semgrep with `--disable-nosem` prevents malicious suppression. YARA provides binary-level detection that Semgrep can't match. The tool is designed to handle adversarial inputs.

**DX/ergonomics:** The CLI is intuitive (`guarddog <ecosystem> scan <package>`). Three output formats cover human review, automation, and CI integration. The deprecated legacy commands still work but the ecosystem-prefixed commands are cleaner. Adding rules is low-friction — drop a YAML file and it's picked up automatically.
