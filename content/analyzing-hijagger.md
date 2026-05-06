---
title: "Analyzing hijagger"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/firefart/hijagger
tags: [go, supply-chain-security, npm, pypi, dns, whois, cli]
---

# Analyzing hijagger

## How It Works

Hijagger is a Go CLI tool that systematically scans every package on NPM and PyPI, extracts maintainer email addresses, and checks whether the domain portion of those emails is unregistered or has unregistered MX records. The attack vector is straightforward: if a maintainer's email domain has lapsed, an attacker can register the domain, initiate a password reset on the package registry, and hijack the package to inject malicious code.

The tool operates in two phases. First, it ingests a full package index — for NPM, a pre-downloaded CouchDB dump from `skimdb.npmjs.com`; for PyPI, it scrapes the HTML listing at `/simple/`. Second, it fans out across all packages in parallel (default 10 goroutines, configurable), querying each package's registry API for maintainer emails, then running DNS and WHOIS checks against the extracted domains.

Results are logged to both stdout and a file, color-coded by severity (log level maps to download count: packages with 1M+ downloads use `ERROR`, 100K+ use `WARN`, everything else `INFO`). This makes high-impact findings immediately visible when grepping the output.

## Architecture

```
main.go          CLI setup (urfave/cli), app struct, goroutine orchestration
├── npm.go       NPM registry API: package listing, maintainer extraction, download counts
├── pypi.go      PyPI registry API: package listing (HTML scrape), maintainer extraction
├── http.go      Shared HTTP helper with context support
├── check.go     Core logic: domain checking pipeline, result formatting
├── dns.go       DNS resolution (MX, NS, A/AAAA) + WHOIS queries, caching
├── helper.go    Root domain extraction (go-tld)
└── error.go     Custom WhoisError type for repeated-error suppression
```

The `app` struct is the central object — it holds HTTP and DNS clients, five mutex-protected caches (MX results, NS results, DNS records, WHOIS results, WHOIS errors), and a logger. Everything is a method on `app`.

## The Spine

**Entry point:** `main()` → `cli.App` with two subcommands: `npm` and `pypi`. Both call `run()`.

**Request lifecycle for a single package:**

1. `run()` loads the full package list, creates a weighted semaphore, and dispatches each package name to a goroutine calling `checkPackage()`
2. `checkPackage()` queries the registry API for maintainer emails (via `npmGetPackageMaintainer` or `pypiGetPackageMaintainer`)
3. For each email, it extracts the domain, skips known-safe domains (`users.noreply.github.com`, empty, `@`-prefixed)
4. `checkDomain()` runs two independent checks:
   - **Domain registration:** queries NS records → if none, falls back to WHOIS. If WHOIS returns `ErrNotFoundDomain`, the domain is unregistered
   - **MX registration:** queries MX records → for each MX target, checks A records first (fast path to skip WHOIS). If no A records, runs WHOIS on the MX domain
5. If `--expired` flag is set, also checks WHOIS for domains expiring within 7 days
6. Results are printed via `printResult()`, which uses log level as a severity proxy based on download count

## Key Patterns

**Aggressive caching.** Five separate `sync.RWMutex`-protected maps deduplicate DNS and WHOIS calls. Since many maintainers share the same email domain, this avoids re-querying the same domain hundreds of times. The WHOIS error cache is particularly important — WHOIS servers rate-limit aggressively, so remembering which domains failed prevents wasted queries.

**Layered domain checking.** DNS is checked first (NS for domain registration, A records for MX targets) before falling back to WHOIS. WHOIS is treated as expensive and rate-limited, so DNS results short-circuit the pipeline whenever possible.

**TLD-aware root domain extraction.** `getRootDomain()` uses `jpillora/go-tld` to always check the registrable root domain, not subdomains. This prevents false positives from checking `mail.example.com` instead of `example.com`.

**Severity via log levels.** Rather than building a custom severity system, hijagger abuses logrus levels: `Error` for high-download packages, `Warn` for medium, `Info` for low. This means you can filter the output file by severity without any custom parsing.

## Non-Obvious Details

**The PyPI package list is HTML-scraped.** Unlike NPM which provides a proper JSON dump, PyPI's `/simple/` page is parsed with a regex (`<a href="/simple/(.+?)/">`). This is fragile — a change in PyPI's HTML template would silently return zero packages rather than erroring out. The regex match returns `nil` (no error), so the tool would just appear to find nothing.

**NPM's maintainer API is unreliable.** The README notes this: "the returned maintainers from the API not always reflect the real maintainers." The code pulls from both `_npmUser.email` and the `maintainers[]` array and deduplicates, but the underlying data may be stale or incomplete.

**PyPI download counts are intentionally omitted.** The code sets downloads to `-1` for PyPI packages, meaning all PyPI results log at `INFO` level regardless of actual popularity. The README explains this is because PyPI download data is only available via Google BigQuery, which was deemed too complex to integrate.

**The semaphore goroutine launch has a subtle issue.** The `run()` function iterates sequentially, acquiring the semaphore and spawning a goroutine for each package. Since acquire is synchronous in the main goroutine, this creates a bottleneck: the main loop blocks on `sem.Acquire()` while goroutines finish. For very large package sets, this works fine, but it means the maximum concurrency is bounded by the goroutine spawn rate in the main loop, not just the semaphore count.

> [!question]
> The `Before` hook in both CLI commands opens the log file but never closes the file handle. This is a minor resource leak that's acceptable for a long-running CLI tool (the OS reclaims it on exit), but would be an issue if the tool were used as a library.

**WHOIS error suppression.** The custom `WhoisError` type carries a `repeatedError` flag. When the same domain fails WHOIS twice, the second call returns nil instead of an error, silently skipping the domain. This prevents log spam from rate-limited WHOIS servers but means legitimate failures are invisible after the first occurrence.

## Assessment

**Code quality:** Clean, readable Go. Consistent error handling with `%w` wrapping. Single test file covers the domain parsing edge case. The codebase is small (~1,000 LOC across 9 files) and easy to follow.

**Architecture fitness:** The flat method-on-struct pattern is appropriate for a single-purpose CLI tool. Five mutexes for caches is slightly verbose — a `sync.Map` or a single cache struct with its own mutex would reduce boilerplate — but it's clear and correct.

**Operational concerns:** The tool is designed to run for days. The WHOIS error cache is essential for this. No checkpointing or resume support exists — if the process crashes, it restarts from scratch. The DNS server list is configurable, which is important since running this at scale will get your IP noticed.

**Security posture:** No auth or input validation concerns — this is an offensive research tool, not a service. The Dockerfile correctly uses a non-root user and multi-stage build.

**DX/ergonomics:** Minimal but sufficient. Binary releases via GoReleaser for Linux/macOS/Windows. Docker support for isolation. The `--debug`, `--threads`, and `--dnsserver` flags cover the main tuning knobs. No config file support — all configuration is via CLI flags.

## Related

- [[analyzing-datadog-guarddog]] — PyPI supply chain security scanner using static analysis
- [[analyzing-packj]] — dependency risk analysis tool covering NPM and PyPI
