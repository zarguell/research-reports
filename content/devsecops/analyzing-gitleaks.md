---
title: "Analyzing Gitleaks"
date: 2026-05-09
type: codebase-analysis
status: complete
source: https://github.com/gitleaks/gitleaks
tags: [devsecops, secret-scanning, git, golang, regex, entropy, ci-cd]
---

## Overview

Gitleaks is an open-source secret detection tool written in Go that scans git repositories, directories, files, and stdin for accidentally committed secrets such as API keys, passwords, and tokens. At commit `8863af4` (v8), it is a mature project with ~131 provider-specific rule files, a sophisticated multi-pass detection engine with encoding-aware decoding, and deep integration into CI/CD workflows via pre-commit hooks and GitHub Actions.

Secret scanning is a critical DevSecOps control. Leaked credentials in git history are a leading attack vector — attackers routinely crawl public repositories for exposed API keys. Gitleaks addresses this by providing fast, configurable scanning across both current files and full git history.

## Key Findings

### Architecture

Gitleaks follows a clean pipeline architecture: **Source → Fragments → Detector → Findings → Report**.

The codebase is organized into well-separated packages:

| Package | Responsibility |
|---------|---------------|
| `cmd/` | CLI entrypoints using Cobra (git, dir, stdin, detect [deprecated]) |
| `sources/` | Source adapters that yield `Fragment` structs via a callback interface |
| `detect/` | Core detection engine — regex matching, entropy, allowlists, filtering |
| `detect/codec/` | Multi-pass decoder for base64, hex, percent, unicode encodings |
| `config/` | TOML config parsing, rule/allowlist structs, config extension |
| `report/` | Output formatters (JSON, CSV, SARIF, JUnit, template) |

The `sources.Source` interface defines a single method:

```go
type Source interface {
    Fragments(ctx context.Context, yield FragmentsFunc) error
}
```

Each source type (`Git`, `Files`, `File`) implements this interface, yielding fragments to the detector via a callback. This design is clean and extensible — adding a new scan target only requires implementing `Fragments()`.

### Detection Engine

The detection pipeline in `detect.go` is multi-layered:

1. **Aho-Corasick prefilter**: At detector creation, all rule keywords are compiled into an Aho-Corasick trie. Before running expensive regex matching, the engine checks if any keywords appear in the fragment. Rules without keywords always run.

2. **Regex matching**: Each rule's `Regex` pattern is applied via `FindAllStringIndex`. The `SecretGroup` field extracts a specific capture group as the secret value.

3. **Shannon entropy check**: If a rule sets `Entropy > 0`, the Shannon entropy of the extracted secret is computed. Findings with entropy below the threshold are discarded. For example, AWS access token rules set `Entropy: 3.0` to filter out low-entropy placeholders like `AKIAIOSFODNN7EXAMPLE`.

4. **Multi-pass decoding**: The engine supports recursive decoding through `detect/codec/`. It detects and decodes **base64**, **hex**, **percent-encoded**, and **unicode-escaped** strings, then re-runs all rules against the decoded content. The `MaxDecodeDepth` flag (default 5) caps recursion depth.

5. **gitleaks:allow suppression**: Lines containing the string `gitleaks:allow` cause any finding on that line to be skipped, unless `--ignore-gitleaks-allow` is set.

6. **Generic rule deduplication**: The `filter()` function removes generic rule findings when a more specific rule already covers the same secret at the same location, preventing noisy duplicate alerts.

7. **Required rules (multi-part matching)**: A sophisticated feature where rules can declare `RequiredRules` — auxiliary patterns that must also match within proximity (configurable via `withinLines` and `withinColumns`) for the primary finding to be reported.

### Rule System

Rules are defined in TOML and translated into Go structs:

```toml
[[rules]]
id = "aws-access-token"
description = "AWS credentials detected"
regex = '''\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b'''
entropy = 3.0
keywords = ["AKIA", "ASIA", "ABIA", "ACCA"]

[[rules.allowlists]]
regexes = ['''.+EXAMPLE$''']
```

Key rule fields:

- **`regex`**: Go RE2-compatible pattern applied to content
- **`path`**: Optional regex applied to file paths; can be used alone (path-only rules) or combined with `regex`
- **`entropy`**: Minimum Shannon entropy threshold for the matched secret
- **`secretGroup`**: Which regex capture group contains the actual secret
- **`keywords`**: Used for Aho-Corasick prefiltering — rules only run if a keyword appears in the content
- **`tags`**: Metadata labels attached to findings
- **`allowlists`**: Per-rule exclusion criteria (commits, paths, regexes, stopwords)
- **`required`**: Dependencies on other rules for composite detection

The default configuration ships **131 provider-specific rule files** covering AWS, Azure, GCP, GitHub, GitLab, Stripe, Slack, and many more. Rules are generated from Go code in `cmd/generate/config/rules/` and compiled into `config/gitleaks.toml` via `go generate`.

**Config extension** allows custom configs to inherit from the default or another config file using `[extend] useDefault = true` or `[extend] path = "..."`, with `disabledRules` to selectively exclude inherited rules. Extension depth is capped at 2 levels.

### Allowlist System

The allowlist system is the primary mechanism for suppressing false positives, operating at both global and per-rule levels. Each allowlist supports:

- **`commits`**: Ignore specific commit SHAs
- **`paths`**: Regex patterns for file paths to skip
- **`regexes`**: Regex patterns matched against the secret (or match/line via `regexTarget`)
- **`stopWords`**: Substrings that, if present in the secret, suppress the finding
- **`condition`**: `OR` (default) or `AND` logic for combining checks

Stopwords use an Aho-Corasick trie for efficient matching. Paths and regexes are combined into single OR-patterns at validation time for performance. The default global allowlist skips common placeholder patterns (`true`, `false`, `null`), environment variable references (`$MY_VAR`), GitHub Actions expressions, and binary/media file paths.

### Scan Modes

Gitleaks offers five distinct scan modes:

| Command | Source | Description |
|---------|--------|-------------|
| `gitleaks git [repo]` | `sources.Git` | Scans full git history via `git log -p` |
| `gitleaks git --pre-commit` | `sources.Git` | Scans working tree diff via `git diff` |
| `gitleaks git --staged` | `sources.Git` | Scans staged changes via `git diff --staged` |
| `gitleaks dir [path]` | `sources.Files` | Walks a directory tree, scanning each file |
| `gitleaks stdin` | `sources.File` | Reads from stdin, treats as a single file |

The git mode uses `go-gitdiff` to parse unified diff output streamed from `git log -p -U0`. Each diff file yields `TextFragment` objects containing only added lines (`gitdiff.OpAdd`). Binary files are skipped unless they are archives and `--max-archive-depth` is set.

The directory mode uses `filepath.WalkDir` and respects `.gitleaks.toml` allowlist paths, file size limits, and symlink settings.

A **baseline** mechanism (`--baseline-path`) allows loading a previous JSON report and ignoring findings that match it — useful for incremental scanning of legacy repositories.

### Archive Scanning

The `File` source (`sources/file.go`) includes archive awareness. Using the `mholt/archives` library, it can recursively extract and scan inside archives (zip, tar, 7z, etc.) and compressed files (gzip, bzip2, xz, lz4, etc.) up to a configurable depth (`--max-archive-depth`, default 0 = disabled). Inner paths are represented using `!` as a separator (e.g., `archive.zip!config/credentials.json`).

### Report Formats

Gitleaks supports five output formats:

| Format | Reporter Class | Use Case |
|--------|---------------|----------|
| **JSON** | `JsonReporter` | Default; programmatic consumption |
| **SARIF** | `SarifReporter` | GitHub Code Scanning integration |
| **CSV** | `CsvReporter` | Spreadsheet analysis |
| **JUnit** | `JunitReporter` | CI/CD test result integration |
| **Template** | `TemplateReporter` | Custom Go template output (using Sprig functions) |

Format is auto-detected from file extension when `--report-format` is not specified. The template reporter uses `text/template` with Sprig functions (minus `env`, `expandenv`, `getHostByName` for security). Several themed templates ship in `report_templates/`.

Findings include: rule ID, description, file path, line/column numbers, matched secret, commit SHA, author, email, date, commit message, entropy value, fingerprint, SCM link, and tags. The `--redact` flag partially or fully masks secrets in output.

### Performance and Concurrency

Gitleaks uses **`semgroup`** (semaphore-bounded goroutine pool) with a concurrency limit of **40 goroutines** for parallel fragment processing. Both the `Git` and `Files` sources dispatch fragment scanning through `s.Sema.Go()`.

Additional performance features:
- **Aho-Corasick prefilter** avoids running regex against fragments that contain no relevant keywords
- **File type detection** (`h2non/filetype`) skips binary files
- **Max file size** (`--max-target-megabytes`) skips oversized files
- **Streaming git parsing** — `git log -p` output is streamed through a pipe and parsed incrementally, not loaded into memory
- **Slow fragment warning** logs fragments taking >5 seconds in debug mode
- **Built-in diagnostics** (`--diagnostics`) supports CPU profiling, memory profiling, execution tracing, and an HTTP pprof endpoint

### Integration

**Pre-commit hooks**: The `.pre-commit-hooks.yaml` file provides three hook variants (golang, docker, system), all running `gitleaks git --pre-commit --redact --staged --verbose`.

**GitHub Actions**: The project uses `gitleaks/gitleaks-action` in its own CI workflow with `fetch-depth: 0` for full history scanning. The SARIF output integrates directly with GitHub Code Scanning alerts.

**SCM link generation**: Findings include clickable links to the exact file/line on GitHub, GitLab, Bitbucket, Azure DevOps, or Gitea, auto-detected from the git remote URL or specified via `--platform`.

**Config flexibility**: Config can be loaded from `--config`, `GITLEAKS_CONFIG` env var, `GITLEAKS_CONFIG_TOML` env var (inline content), or `.gitleaks.toml` in the target directory. The `.gitleaksignore` file supports fingerprint-based suppression for both global (`file:rule-id:start-line`) and commit-scoped (`commit:file:rule-id:start-line`) patterns.

## Assessment

### Strengths

- **Well-architected**: Clean separation between sources, detection, and reporting via interfaces. The `Source` → `Fragment` → `Detector` pipeline is elegant and extensible.
- **Comprehensive rule coverage**: 131 provider-specific rule definitions covering every major cloud provider, SaaS platform, and common secret format, each with test vectors for true/false positives.
- **Encoding-aware detection**: Multi-pass decoding (base64, hex, percent, unicode) catches obfuscated secrets that simpler scanners miss.
- **Performance-conscious design**: Aho-Corasick prefiltering, streaming git parsing, bounded concurrency, and binary file skipping demonstrate deliberate optimization.
- **Excellent CI/CD integration**: Pre-commit hooks, GitHub Action, SARIF output, and exit code control make it straightforward to integrate into any pipeline.
- **Extensible configuration**: Config extension, custom rules, targeted allowlists, and template-based reporting provide deep customization without forking.

### Concerns

- **Regex-only detection**: The engine relies entirely on regex pattern matching and entropy. It cannot detect secrets that don't match known patterns (e.g., random hex strings with no prefix) beyond the generic rules, and has no semantic understanding of code context.
- **Global state in config parsing**: The `extendDepth` global variable and Viper's singleton pattern make config parsing stateful and difficult to test in parallel.
- **Deprecated API surface**: The codebase carries significant deprecated surface area (`DetectReader`, `DetectGit`, `detect`/`protect` commands, `DirectoryTargets`) that adds maintenance burden. The v8 → v9 migration plan is noted in multiple TODO comments.
- **No incremental scanning**: Full history scans re-process all commits. The baseline mechanism helps but is a workaround, not true incremental tracking.
- **Allowlist complexity**: The interaction between global, per-rule, and targeted allowlists with AND/OR conditions is powerful but can be difficult to reason about.

### Recommendations

- Consider using gitleaks as a **pre-commit hook** in every repository to catch secrets before they enter history
- For large monorepos, use `--log-opts` to limit scan scope and `--baseline-path` to track known findings
- Enable `--max-archive-depth` if repositories contain nested archives with config files
- Create a custom `.gitleaks.toml` extending the default config with organization-specific rules and allowlists
- Pair gitleaks with tools like [[analyzing-prowler]] for broader infrastructure security coverage and [[analyzing-cloudsplaining]] for IAM policy analysis

## Related

- [[analyzing-prowler]] — AWS security assessment tool
- [[analyzing-cloudsplaining]] — AWS IAM policy analysis
- [[analyzing-ship-safe]] — Supply chain security scanning
