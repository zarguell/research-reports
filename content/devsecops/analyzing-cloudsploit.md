---
title: "Analyzing CloudSploit"
date: 2026-05-09
type: codebase-analysis
status: complete
source: https://github.com/aquasecurity/cloudsploit
tags: [nodejs, javascript, cloud-security, cspm, aws, azure, gcp, compliance, security-auditing]
---

> Source: [aquasecurity/cloudsploit](https://github.com/aquasecurity/cloudsploit) at [af8618a](https://github.com/aquasecurity/cloudsploit/commit/af8618a4f9b98340d76e30201d6f4127c23e2b88)

## How It Works

CloudSploit is a Cloud Security Posture Management (CSPM) scanner that operates in two distinct phases: **collect** and **analyze**. In the collect phase, it enumerates which cloud API calls are needed by the active plugins, calls those APIs across all relevant regions, and caches the raw responses in a nested JSON structure keyed by `service → call → region`. In the analyze phase, each plugin reads from this pre-built cache — never calling cloud APIs directly — and produces an array of results with a numeric status code (0=OK, 1=WARN, 2=FAIL, 3=UNKNOWN).

This two-phase design is deliberate. By decoupling data collection from analysis, CloudSploit avoids redundant API calls — dozens of plugins that all need `S3:listBuckets` share a single collection. It also enables a "collection export" mode where raw API data can be dumped to JSON and analyzed offline. The trade-off is that plugins have no way to call additional APIs at analysis time; every data dependency must be declared upfront via the plugin's `apis` array.

The system supports six cloud providers (AWS, Azure, GCP, Oracle, GitHub, Alibaba), with AWS receiving by far the deepest coverage — roughly 80 AWS service categories with ~600+ individual checks. Plugins can optionally declare compliance mappings (HIPAA, PCI, CIS benchmarks), remediation logic with rollback, and ASL (Aqua Security Language) rules for declarative policy checks. A suppression system allows regex-based filtering of results.

## Architecture

```
index.js              ← CLI entry point, credential resolution
engine.js             ← Core orchestrator: collect → analyze → output
exports.js            ← Registry of all plugins (1772 lines of require() calls)
collectors/           ← Per-cloud API collectors (AWS, Azure, GCP, Oracle, etc.)
  aws/collector.js    ← AWS API executor with pagination, retry, rate-limit handling
  aws/index.js        ← Maps API call names to AWS SDK methods
helpers/              ← Per-cloud helper modules + shared utilities
  shared.js           ← addResult(), addSource(), addError(), date utilities
  aws/functions.js    ← AWS-specific: open port checks, encryption helpers
  aws/api.js          ← Low-level remediation API wrappers
plugins/              ← 1565+ plugin files across 6 clouds
  aws/                ← ~90 service directories, each with 1-30 checks
  azure/              ← Similar structure for Azure services
postprocess/
  output.js           ← Multi-format output: console table, CSV, JSON, JUnit XML
  suppress.js         ← Regex-based result suppression
```

The plugin-to-collector contract is the architectural backbone. Each plugin declares an `apis` array like `['S3:listBuckets', 'S3:getBucketEncryption']`. The engine aggregates these across all active plugins, deduplicates, and passes the unique set to the collector. The collector returns a nested cache object. Plugins then read from this cache via `helpers.addSource(cache, source, ['s3', 'listBuckets', region])`.

## The Spine

1. **`index.js`** — Parses CLI arguments with `argparse`, resolves credentials from config files, environment variables, or the AWS default credential chain. Falls back to AWS if no config provided. Calls `engine(cloudConfig, settings)`.

2. **`engine.js`** — The orchestrator. Filters plugins by `--plugin`, `--compliance`, and `--cloud` flags. Aggregates required API calls from active plugins. Invokes the cloud-specific collector.

3. **Collector** (e.g., `collectors/aws/collector.js`) — Iterates over requested API calls, spawns AWS SDK calls across all regions with concurrency limits (`async.eachOfLimit` at 10 services, 15 calls per service, 6 regions at a time). Handles pagination, retry with exponential backoff, and rate limiting. Returns the collection cache.

4. **Plugin execution** — `async.mapValuesLimit(plugins, 10, ...)` runs plugins with 10 concurrent. Each plugin's `run(cache, settings, callback)` reads from cache and produces results.

5. **Output** — A multiplexed output handler writes to console (tty-table), CSV, JSON, and/or JUnit XML simultaneously. Suppression filtering happens before output. Optional `--exit-code` sets process exit code to the worst status for CI integration.

## Key Patterns

**Plugin convention.** Every plugin exports a standard object:
```javascript
module.exports = {
    title: 'S3 Bucket Encryption',
    category: 'S3',
    severity: 'High',
    apis: ['S3:listBuckets', 'S3:getBucketEncryption', ...],
    settings: { /* tunable parameters with regex validation */ },
    run: function(cache, settings, callback) { ... },
    remediate: function(config, cache, settings, resource, callback) { ... },
    rollback: function(config, cache, settings, resource, callback) { ... }
};
```

**Status code system.** Plugins emit numeric statuses: 0 (OK), 1 (WARN), 2 (FAIL), 3 (UNKNOWN/ERROR). The engine tracks `maximumStatus` and can exit with it for CI gating.

**Settings as tunables.** Plugins declare settings with `name`, `description`, `regex` (validation), and `default` values. This allows organizations to customize thresholds (e.g., `s3_encryption_require_cmk: true`) without modifying code.

**Helper composition.** Cloud-specific helpers (e.g., `helpers/aws/index.js`) merge shared utilities, cloud-specific functions, and API wrappers into a single exported object. This gives every plugin a consistent `helpers.addResult()`, `helpers.addSource()`, `helpers.regions()` interface regardless of cloud provider.

**Remediation as opt-in.** Plugins can declare `remediate` and `rollback` methods with explicit `actions` and `permissions` metadata. Remediation uses separate credentials (`cloudConfig.remediate`) to enforce least privilege.

## Non-Obvious Details

> [!warning] `exports.js` is a 1772-line require() manifest
> Every plugin is eagerly loaded via `require()` at startup regardless of which cloud or plugin is being run. This means the entire plugin tree (1565+ files) is parsed on every invocation, even if only one plugin is selected. The memory impact is non-trivial for large installations.

> [!note] Collection cache as shared mutable state
> The collector populates a single `collection` object that all plugins read from. While plugins don't write to it, the `addSource` helper in `shared.js` also builds a parallel `source` object for provenance tracking. Both are passed by reference.

> [!question] ASL (Aqua Security Language) path
> The engine supports a declarative policy language via `--run-asl`. When enabled, it loads an ASL runner from `helpers/asl/asl-{version}.js` and passes the collection and resource maps. This appears to be a bridge to Aqua's commercial platform, but the ASL files (`asl-1.js`, `asl-old.js`) are present in the open-source tree.

> [!warning] GitHub plugin filtering has a logic bug
> In `engine.js` lines 99-108, the GitHub plugin filtering checks both `plugin.types.indexOf('org') === -1` for the organization case *and* the non-organization case, but the conditions are identical — both skip plugins that don't contain 'org' in their types array. This means non-org GitHub plugins are always skipped regardless of the account type.

> [!note] `--run-asl` defaults to `false` via `store_false`
> The argparse action is `store_false` (not `store_true`), meaning `settings['run-asl']` is `true` by default and the flag *disables* ASL. This is counterintuitive and suggests the flag name was inverted at some point.

## Assessment

**Strengths:**
- **Extensibility model.** Adding a new check is straightforward: create a file in the right directory, add it to `exports.js`, implement `run()`. The plugin contract is well-defined and consistent across all clouds.
- **API call deduplication.** The two-phase collect-then-analyze design avoids redundant API calls across hundreds of plugins. This is critical for avoiding rate limits and scan duration.
- **Multi-cloud breadth.** Real support for six cloud providers, not just AWS. Each cloud has its own collector, helpers, and plugin directory.
- **CI-friendly output.** JUnit XML, JSON, CSV, and `--exit-code` make integration with CI/CD pipelines straightforward.

**Concerns:**
- **Eager loading of all plugins.** The 1772-line `exports.js` loads every plugin on every run. Lazy loading by cloud would improve startup time and memory usage significantly.
- **No type safety.** Pure JavaScript with no TypeScript, no JSDoc consistency, and heavy use of dynamic property access on nested objects. The cache structure (`collection.s3.listBuckets['us-east-1']`) relies entirely on convention.
- **Callback-based async throughout.** The codebase uses Node callbacks and `async` library exclusively — no Promises, no async/await. This makes error handling verbose and control flow harder to follow.
- **Large monolithic helpers.** `helpers/aws/functions.js` is 1658 lines. `engine.js` mixes orchestration with remediation setup and Azure blob upload logic.
- **Testing coverage appears limited.** Spec files exist for some plugins but the framework doesn't have comprehensive integration tests. Plugin correctness relies heavily on manual testing.

> [!tip] For teams adopting CloudSploit
> Use Docker mode for reproducible scans. Leverage `--compliance` flags to scope scans to relevant frameworks. Enable `--exit-code` in CI pipelines. For custom checks, study `plugins/aws/s3/bucketEncryption.js` as a reference implementation — it demonstrates the full plugin lifecycle including settings, remediation, and multi-API dependency handling.

## Related

- [[analyzing-nuclei]] — Scanner for a different domain (network/web) with a similar plugin-based architecture
- [[analyzing-clawdstrike]] — Cloud security tool analysis
- [[analyzing-pasteguard]] — Security auditing tool
- [[analyzing-ship-safe]] — DevSecOps pipeline tool
- [[analyzing-stride-gpt]] — Security threat modeling tool
