---
title: "Analyzing ScubaGear"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/cisagov/ScubaGear @ 274ce8ec984af2d0d062b5a4e09e8c59461ca24a
tags: [powershell, security, compliance, m365, opa, rego, cisagov, cloud-security]
---

> **Source:** [cisagov/ScubaGear](https://github.com/cisagov/ScubaGear) @ [`274ce8e`](https://github.com/cisagov/ScubaGear/commit/274ce8ec984af2d0d062b5a4e09e8c59461ca24a)

## How It Works

ScubaGear is CISA's automated assessment tool for Microsoft 365 security baselines. It follows a three-stage pipeline: **query**, **evaluate**, and **report**.

The tool connects to M365 APIs using PowerShell modules (providers) to extract current tenant configuration. This raw data is fed into Open Policy Agent (OPA) which evaluates it against Rego policy files encoding CISA's Secure Configuration Baseline requirements. Finally, results are rendered as interactive HTML reports alongside JSON and CSV outputs for further processing.

The critical insight is the **separation between data collection and policy logic**. Providers are purely extractors—they pull configuration from Entra ID, Exchange Online, SharePoint, Teams, Power Platform, and Defender. They don't make security judgments. That responsibility belongs entirely to the Rego policies, which can be updated independently as baselines evolve. This makes the tool audit-friendly: you can trace any finding back to a specific policy rule.

## Architecture

```
Invoke-SCuBA (Orchestrator)
    │
    ├─► ScubaConfig (singleton) ─► config.yaml validation
    │
    ├─► Connection module ─► M365 authentication (interactive or service principal)
    │
    ├─► Invoke-ProviderList
    │       ├─► Export-AADProvider ──► conditional_access_policies, users, roles...
    │       ├─► Export-EXOProvider ──► transport rules, spam policies...
    │       ├─► Export-SecuritySuiteProvider ──► Defender settings
    │       ├─► Export-PowerPlatformProvider ──► Power Apps, Flows...
    │       ├─► Export-SharePointProvider ──► site policies, sharing settings
    │       └─► Export-TeamsProvider ──► messaging, meeting policies
    │
    ├─► Invoke-RunRego
    │       └─► OPA ─► AADConfig.rego, EXOConfig.rego, etc.
    │
    └─► Invoke-ReportCreation
            ├─► HTML report (styled with dark mode support)
            ├─► ScubaResults.json (consolidated)
            └─► ScubaResults.csv + ActionPlan.csv
```

The codebase lives in `PowerShell/ScubaGear/` with these key directories:
- `Modules/Orchestrator.psm1` — 2,400+ lines, the main entry point and pipeline coordinator
- `Modules/Providers/` — one exporter per M365 product
- `Modules/ScubaConfig/` — configuration singleton and JSON schema validation
- `Modules/CreateReport/` — HTML generation, CSV export, annotation handling
- `Modules/RunRego/` — thin wrapper around the OPA binary
- `Rego/` — policy files (AADConfig.rego, DefenderConfig.rego, EXOConfig.rego, etc.)

## The Spine

The spine runs through `Invoke-SCuBA` in `Orchestrator.psm1`. Tracing one assessment:

1. **Entry**: User calls `Invoke-SCuBA -ProductNames aad,exo -ConfigFilePath config.yaml`
2. **Config loading**: `ScubaConfig` singleton loads and validates the YAML against a JSON schema. Command-line parameters override file values.
3. **Authentication**: `Invoke-Connection` establishes sessions to M365 (either interactive login or certificate-based service principal auth). Results are cached in `$ConnectionResult`.
4. **Provider execution**: `Invoke-ProviderList` loops over each requested product, calling the corresponding `Export-*Provider` function. Each returns JSON snippets that are concatenated into a single `ProviderSettingsExport.json`.
5. **OPA evaluation**: `Invoke-RunRego` invokes the OPA binary for each product's Rego file, passing the provider output as input. Results go to `TestResults.json`.
6. **Report generation**: `Invoke-ReportCreation` reads the provider and Rego outputs, applies annotations from the config file, and renders HTML.
7. **Output**: Three files in `M365BaselineConformance_<timestamp>/`: `BaselineReports.html`, `ScubaResults_<uuid>.json`, `ScubaResults.csv`.

The critical data transformation happens at step 4→5: raw API responses become Rego-friendly JSON, then OPA evaluates those JSON documents against policy rules. The `Export-*Provider` functions do the work of normalizing disparate API responses into a consistent schema that the Rego policies expect.

## Key Patterns

**Singleton configuration**: `ScubaConfig` uses a static singleton pattern with lazy initialization. The `ScubaDefault()` static method resolves default values by naming convention ("Default" prefix maps to the defaults section). Path defaults like OPA path and output directory get `~` expansion and `.` resolution at access time.

**Provider-per-product**: Each M365 product has its own provider module. They share no common interface but follow a consistent pattern: authenticate, query APIs, return JSON. This makes adding new products relatively straightforward but means the extraction logic is duplicated across modules.

**Rego policy versioning**: Policies are numbered (e.g., `MS.AAD.1.1v1`, `MS.AAD.2.1v1`) and include "Criticality" fields ("Shall", "Should", "3rd Party", "Not-Implemented"). The `RequirementMet` boolean in test results drives pass/fail/warning logic in the report generator.

**Exclusion annotations**: The YAML config supports `UserExclusions`, `GroupExclusions`, `AppExclusions`, and `GuestUserExclusions` per control. Rego policies check these via helper functions like `UserExclusionsFullyExempt()` before flagging a policy. This lets organizations document intentional deviations without modifying policy code.

**OPA as external process**: The `RunRego.psm1` module shells out to the OPA binary. It builds command arguments like `opa eval "data.aad.tests" -i input.json -d policy.rego -d utils/ -f values` and parses the JSON output. No native .NET/PowerShell OPA library is used.

## Non-Obvious Details

**UTF-8 BOM handling**: PowerShell 5 writes UTF-8 files with a byte-order mark, but OPA (as of 0.68) can't parse JSON with BOM when it contains `\/` escape sequences. The code explicitly saves provider output as `utf8NoBom` to avoid `unable to parse input: yaml` errors.

**Config file parameter precedence**: The config system has nuanced precedence rules. Authentication parameters (AppID, CertificateThumbprint, Organization) are handled specially—they're not in the config schema's defaults, so they're pulled from the config file only if not on the command line. All other parameters from `$PSBoundParameters` override config values after the file is loaded.

**Service principal authentication asymmetry**: Not all providers support service principal auth equally. Teams has a special code path that checks `$ServicePrincipalAuth` and passes `-CertificateBasedAuth`, while other products handle it differently. This suggests uneven implementation across providers.

**Debug logging as first-class concern**: The logging system (`ScubaLogging.psm1`) is sophisticated: it's initialized before any other step, captures module snapshots post-authentication, redacts sensitive parameters like certificate thumbprints, and creates a `DebugLogs` subfolder in every output directory. This is production-grade observability for a government tool.

**Omissions vs Annotations**: The config supports both `OmitPolicy` (skip the test entirely) and `AnnotatePolicy` (run the test but override the result). `Get-OmissionState` in `CreateReport.psm1` handles the former, while `Add-Annotation` handles the latter. They serve different audit purposes.

## Assessment

**Strengths**:
- Clean separation between data extraction, policy evaluation, and reporting enables independent versioning and auditing
- Rego as the policy language is well-suited for policy-as-code and is readable by non-PowerShell developers
- Comprehensive test coverage with unit tests for core functions
- Supports all M365 Government Cloud environments (commercial, GCC, GCC High, DoD)
- Production-grade logging and error handling with graceful degradation when individual products fail

**Concerns**:
- Provider modules have significant duplicated logic (authentication, error handling). A shared base class or helper module would reduce maintenance burden.
- OPA invoked as external process adds startup overhead and requires binary distribution. A PowerShell-native policy evaluation approach could simplify packaging.
- Documentation of the JSON schema that providers output is implicit in Rego imports—breaking changes to provider output can be hard to trace.
- The 2,400-line Orchestrator.psm1 handles many concerns. Refactoring into smaller, focused functions would improve maintainability.

**Recommendations**:
- Add integration tests that verify provider output against the Rego input schema
- Document the expected JSON structure for each provider to ease future development
- Consider extracting connection management into a shared provider helper to reduce duplication