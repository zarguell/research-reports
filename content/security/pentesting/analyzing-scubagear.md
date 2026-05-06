---
title: "Analyzing ScubaGear"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/cisagov/ScubaGear
tags: [powershell, security, compliance, m365, opa, rego, cisagov, cloud-security]
---

# Analyzing ScubaGear

> **Source:** [cisagov/ScubaGear](https://github.com/cisagov/ScubaGear) @ [`274ce8e`](https://github.com/cisagov/ScubaGear/commit/274ce8ec984af2d0d062b5a4e09e8c59461ca24a)

## How It Works

ScubaGear is CISA's automated assessment tool for evaluating Microsoft 365 tenant configurations against the agency's Secure Cloud Business Applications (SCuBA) security baselines. It answers a simple but critical question: *does my M365 tenant conform to CISA's published security baselines?*

The tool operates in three sequential phases. First, PowerShell provider modules query M365 APIs—Microsoft Graph, Teams PowerShell, Exchange Online, SharePoint Online, and Defender APIs—to snapshot the tenant's current configuration. Second, those snapshots are fed as JSON into [Open Policy Agent](https://www.openpolicyagent.org) (OPA), which evaluates them against Rego policy files derived from the CISA baseline documents. Third, OPA's structured results are rendered into HTML, JSON, and CSV outputs for human review and audit.

What makes ScubaGear architecturally interesting is the deliberate separation between *what the tenant looks like* (PowerShell providers) and *whether that's correct* (OPA/Rego). By isolating policy logic in Rego, CISA can update security rules without touching the data-collection code, and the policy layer becomes independently testable. The tool supports Entra ID, Exchange Online, SharePoint, Teams, Power Platform, and Defender (Security Suite), targeting both commercial and government cloud environments (GCC, GCCHigh, DoD).

## Architecture

```
Invoke-SCuBA (Orchestrator.psm1)
├── ScubaConfig        — singleton: loads/validates YAML config, manages defaults
├── Connection         — authenticates to M365 (interactive or SPN/cert)
├── Export-*Provider   — one per product, queries APIs, writes ProviderSettingsExport.json
│   ├── ExportAADProvider (Microsoft Graph)
│   ├── ExportEXOProvider (Exchange Online)
│   ├── ExportSharePointProvider (SPO REST)
│   ├── ExportTeamsProvider (Teams PowerShell)
│   ├── ExportPowerPlatformProvider (Power Platform REST)
│   └── ExportSecuritySuiteProvider (Defender)
├── Invoke-RunRego     — calls OPA against each product's Rego file
│   └── OPA binary     — evaluates Rego policies against provider JSON
└── Invoke-ReportCreation — renders HTML/JSON/CSV from OPA results
```

The module is a standard PowerShell module (`ScubaGear.psd1`, `ScubaGear.psm1`) published to the PowerShell Gallery. The `Invoke-SCuBA` function is the sole public entry point. All other functions are internal (`Export-*Provider`, `Invoke-RunRego`, `Invoke-ReportCreation`, `Invoke-Connection`).

OPA is bundled in the repo as `opa_windows_amd64.exe` for Windows and `opa` for Unix-like systems, downloaded during `Initialize-SCuBA`. Rego policies live in `PowerShell/ScubaGear/Rego/`, organized as one policy file per product plus a shared `Utils/` directory.

## The Spine

The spine is a straight line through `Invoke-SCuBA` in `Orchestrator.psm1`:

1. **Config resolution** — parameters come from CLI args, YAML/JSON config file, or defaults (via `ScubaConfig` singleton). Config is validated against a JSON Schema before anything runs.
2. **Authentication** — `Invoke-Connection` establishes sessions to all requested M365 products. Supports interactive credential-based login and non-interactive SPN/certificate authentication (required for CI automation).
3. **Provider execution** — for each requested product, `Invoke-ProviderList` calls the corresponding `Export-*Provider`. Each provider calls M365 APIs, serializes the results to a per-product JSON file (`ProviderSettingsExport_{Product}.json`). Failures are tracked but don't halt the run.
4. **OPA evaluation** — `Invoke-RunRego` invokes `opa eval` for each product, passing the provider JSON as input and the product's Rego file plus `Utils/` as data modules. The OPA output (`values` format) is the test result set.
5. **Report creation** — `Invoke-ReportCreation` transforms OPA results into `BaselineReports.html`. `Merge-JsonOutput` produces a consolidated `ScubaResults_{uuid}.json`. `ConvertTo-ResultsCsv` produces both a summary CSV and an action-plan CSV template.

The critical path: *M365 API → Provider JSON → Rego input → OPA eval → Results JSON → HTML report*.

## Key Patterns

**Provider pattern.** Each M365 product has its own `Export{Product}Provider.psm1` that exports a function returning a JSON snapshot. The `CommandTracker` class wraps every API call in try/catch, records successes and failures, and allows partial results even when some calls fail. This means a missing license or permission doesn't crash the entire assessment—individual controls are marked as errors instead.

**Dual API access.** The AAD provider can call either the Microsoft Graph PowerShell module cmdlets directly (`Get-MgBetaIdentityConditionalAccessPolicy`) or hit the Graph REST API via `Invoke-GraphDirectly`. The `GraphDirect` flag on each `TryCommand` call controls which path is used. This provides resilience: if a Graph cmdlet is missing or misbehaving, the REST path is available as a fallback.

**Rego package structure.** Every product's Rego file follows the same pattern: a `package` declaration, imports of utility functions, constants, then one rule per baseline control (e.g., `MS.AAD.1.1v1`). Each rule collects matching policies from `input.*` (the provider JSON) and returns a `tests` array with `PolicyId`, `Criticality`, `Commandlet`, `ActualValue`, `ReportDetails`, and `RequirementMet`. OPA's `eval` on `data.{package}.tests` returns the full results object. Unit tests live in `Testing/Unit/Rego/` and use `data.test.assert.*` helpers from `Utils/TestAssertions.rego`.

**ScubaConfig singleton.** The `ScubaConfig` class manages all configuration state as a singleton. It lazy-loads defaults and JSON schema from cached JSON files, provides static accessor methods for each default, and exposes a `Configuration` property (a `PSObject`) that flows through every function call. Command-line parameters override config-file values, which override hardcoded defaults—this layering is explicit in `Invoke-SCuBA`.

**Logging.** `ScubaLogging.psm1` provides `Write-ScubaLog` and `Initialize-ScubaLogging`, writing structured JSON logs to `DebugLogs/` in the output folder. When `-Transcript` is specified, full PowerShell transcript is also captured. Logging is gated by a module-scoped flag and wrapped around key functions via `Trace-ScubaFunction`.

## Non-Obvious Details

**OPA is a subprocess, not a library.** `Invoke-ExternalCmd` simply calls `& $OPAExecutable eval data.$PackageName.tests -i $InputFile -d $RegoFile -d $UtilsDir -f values`. PowerShell spawns OPA as a child process, captures stdout, and parses it as JSON. This means the Rego evaluation is fully sandboxed but introduces process-spawn overhead per product. The `opa` binary is ~60MB and is committed in the repo.

**Conditional Access helper is a mini-parser.** `AADConditionalAccessHelper.psm1` does more than its name suggests—it transforms the raw CA policy JSON into a structured table for HTML rendering. This includes converting conditions into a human-readable format, resolving GUID-based references, and formatting grant controls. The provider passes the raw policies AND the formatted table to the JSON output, so the HTML report can show both raw data and pretty-printed summaries.

**Config file can be YAML or JSON.** The `ScubaConfig.LoadConfig()` method accepts either format. It uses `Import-PowerShellDataFile` behavior which auto-detects. The schema (`ScubaConfigSchema.json`) validates both.

**The `tests` rule is the output contract.** Every Rego file must expose a `tests` rule that OPA can evaluate. The naming is not a Rego convention—it's a ScubaGear convention that `Invoke-Rego` hard-codes when building the `opa eval` call: `data.$PackageName.tests`. This is the implicit contract between Rego authors and the PowerShell caller.

**Baseline documents are markdown, policy files are Rego.** The `baselines/` directory contains human-readable CISA baseline documents (`.md`), while `PowerShell/ScubaGear/baselines/` contains PowerShell-friendly versions of those same baselines. The Rego policies are derived from the baselines but live separately. Changes to baselines require corresponding Rego updates—a two-document workflow.

## Assessment

ScubaGear is a well-structured, operationally mature tool from a credible government source. The architectural choice to decouple data collection from policy evaluation via OPA is sound: it makes the security rules independently testable and allows non-PowerShell consumers to use the Rego policies. The per-product provider pattern is clean and extensible.

The codebase is readable and consistent. PowerShell 5.1 compatibility is maintained, which is necessary for government Windows environments. The CommandTracker pattern for graceful degradation on API failures is thoughtful and prevents noisy single-point-of-failure crashes. The embedded OPA binary is practical for an air-gapped/C2MS environment but adds ~60MB to the repo and requires updating out-of-band when OPA releases security patches.

The main concerns are operational rather than architectural. The tool requires significant M365 permissions (documented in `docs/prerequisites/permissions.md`)—an assessment tool that needs read-all is a high-value target if credentials leak. The certificate-based SPN path is the right answer for automation, but the interactive path is still the path of least resistance for human operators. The Rego policies are dense and tightly coupled to the provider JSON structure: a change to the provider output format will silently break Rego rules unless both are updated together.

For teams adopting ScubaGear, the key to a sustainable workflow is treating the YAML config file as a living artifact—documenting every exclusion and annotation, running regularly, and treating the action-plan CSV as the start of a remediation ticket, not the end.
