---
title: "Analyzing Maester"
date: 2026-05-10
type: codebase-analysis
status: complete
source: https://github.com/maester365/maester
tags: [powershell, microsoft-365, entra, security-testing, devsecops, config-as-code]
---

# Analyzing Maester

> **Source:** [maester365/maester](https://github.com/maester365/maester) @ [d9ce458](https://github.com/maester365/maester/commit/d9ce458733a192c035501fa6557653f4ddf06ee0)

## How It Works

Maester is a PowerShell module that wraps Pester — PowerShell's standard testing framework — to provide a batteries-included system for auditing Microsoft 365 security configurations. You install the module, run `Connect-Maester` to authenticate against Microsoft Graph (and optionally Exchange Online, Azure, Teams, and Dataverse), then run `Invoke-Maester` to execute a suite of 200+ pre-built Pester tests against your tenant. Each test calls a `Test-Mt*` function that queries live Microsoft Graph APIs (or Exchange/Intune/Defender endpoints) and asserts that specific security baselines are met.

The test library covers a broad surface: Entra ID Conditional Access policies, authentication methods, privileged identity management, Exchange Online anti-spam/anti-phishing, Defender for Endpoint antivirus settings, Intune device compliance, Azure DevOps organization policies, Copilot Studio AI agent security, and more. Tests are tagged with identifiers like `MT.1001` or `CISA.MFA` and organized by framework — Maester's own baselines, CISA benchmarks, CIS Microsoft 365 Foundations, EIDSCA (Entra ID Secure Configuration Analyzer), and ORCA (Office 365 Recommended Configuration Analyzer).

Results flow through a pipeline: Pester produces raw test results, `ConvertTo-MtMaesterResult` enriches them with tenant metadata and deep-links to the Entra admin portal, and then outputs are generated in HTML, Markdown, JSON, CSV, or Excel. Notifications can be sent via email (Graph Mail.Send) or Teams (channel messages or webhooks). The whole thing is designed to run both interactively at a workstation and non-interactively in CI/CD pipelines (GitHub Actions, Azure DevOps, GitLab).

## Architecture

```
┌─────────────────────────────────────────────────┐
│  User / CI Pipeline                             │
│  Connect-Maester → Invoke-Maester               │
└──────────┬──────────────────────────┬───────────┘
           │                          │
           ▼                          ▼
┌────────────────────┐   ┌────────────────────────┐
│  Microsoft Graph   │   │  Exchange Online /      │
│  Azure / Teams /   │   │  Security & Compliance  │
│  Dataverse APIs    │   │  PowerShell              │
└────────┬───────────┘   └──────────┬──────────────┘
         │                          │
         ▼                          ▼
┌─────────────────────────────────────────────────┐
│  Maester PowerShell Module                      │
│                                                 │
│  powershell/                                    │
│  ├── Maester.psm1 (module loader)               │
│  ├── internal/  (caching, config, telemetry)    │
│  │   ├── Invoke-MtGraphRequestCache.ps1         │
│  │   ├── ConvertTo-MtMaesterResult.ps1          │
│  │   ├── Get-MtMaesterConfig.ps1                │
│  │   ├── eidsca/  orca/  defender/  xspm/       │
│  │   └── ...                                    │
│  ├── public/  (392 exported functions)           │
│  │   ├── Connect-Maester.ps1                    │
│  │   ├── Invoke-Maester.ps1                     │
│  │   ├── Invoke-MtGraphRequest.ps1              │
│  │   └── maester/ (156 Test-Mt* functions)      │
│  │       ├── entra/  exchange/  teams/           │
│  │       ├── defender/  intune/  azure/          │
│  │       └── aiagent/ azuredevops/ drift/        │
│  └── assets/ (Adaptive Card templates)          │
│                                                 │
├─────────────────────────────────────────────────┤
│  tests/  (213 .Tests.ps1 files)                 │
│  ├── Maester/   (Entra, Defender, Intune, ...)  │
│  ├── EIDSCA/    (auto-generated from EIDSCA)    │
│  ├── CISA/      (CISA benchmark tests)          │
│  ├── XSPM/      (XSPM privileged access)        │
│  ├── ORCA/      (Exchange Online config)        │
│  └── Custom/    (user-defined overrides)        │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│  Output Pipeline                                │
│  Pester Results → ConvertTo-MtMaesterResult     │
│  → HTML report / JSON / CSV / Markdown          │
│  → Email / Teams / Slack notifications           │
└─────────────────────────────────────────────────┘
```

Key modules by role:

| Module | Role |
|--------|------|
| `Maester.psm1` | Module bootstrap — dot-sources all `internal/` and `public/` `.ps1` files |
| `Invoke-Maester` | Orchestrator — configures Pester, runs tests, produces all output |
| `Connect-Maester` | Multi-service connection handler (Graph, EXO, Azure, Teams, Dataverse) |
| `Invoke-MtGraphRequest` | Graph API client with paging, batching, and caching |
| `ConvertTo-MtMaesterResult` | Transforms Pester output into enriched Maester result objects |
| `Get-MtMaesterConfig` | Layered config resolution (default → tenant-specific → custom) |

## The Spine

The primary request lifecycle traces through:

1. **`Connect-Maester`** — authenticates to Microsoft Graph via `Connect-MgGraph` with a curated set of scopes (`Get-MtGraphScope`), then optionally connects to Azure (`Connect-AzAccount`), Exchange Online (`Connect-ExchangeOnline`), Teams (`Connect-MicrosoftTeams`), and Security & Compliance (`Connect-IPPSSession`). Connection state is stored in `$__MtSession.Connections`.

2. **`Invoke-Maester`** — clears module state, reads `maester-config.json`, validates Graph context/scopes via `Test-MtContext`, then configures and runs Pester against all `*.Tests.ps1` files in the test directory.

3. **Individual `Test-Mt*` functions** — each test function (e.g., `Test-MtCaMfaForAllUsers`) calls `Invoke-MtGraphRequest` to fetch live tenant configuration, evaluates it against a security rule, and returns `$true`/`$false`/`$null` (null = skipped). Results are enriched via `Add-MtTestResultDetail` which stores human-readable descriptions and deep-links.

4. **Result processing** — `ConvertTo-MtMaesterResult` wraps Pester output with tenant info, version metadata, and the original command string. Output is then rendered to HTML (via a React/Vite report template in `report/`), JSON, Markdown, CSV, or Excel, and optionally dispatched via email or Teams.

The `Invoke-MtGraphRequest` function is the data spine — every test that queries Graph flows through it, and it provides automatic paging (following `@odata.nextLink`), request batching (`$batch` endpoint), and an in-memory cache (`$__MtSession.GraphCache`) that persists for the duration of a test run.

## Key Patterns

**Test naming and tagging.** Tests follow a strict naming convention: `Test-Mt{Category}{Check}` for functions, `MT.NNNN` for Maester-native test IDs, with parallel prefixes for CISA (`Test-MtCisa*`), CIS (`Test-MtCis*`), EIDSCA (`Test-MtEidsca*`), ORCA (`Test-ORCA*`), and XSPM (`Test-MtXspm*`). Each Pester `It` block is tagged with its test ID so users can filter runs with `-Tag`.

**License-aware skipping.** Most `Test-Mt*` functions check `Get-MtLicenseInformation` at the top and return `$null` with a skip reason if the tenant lacks the required license tier (e.g., Entra ID P2 for Identity Protection tests). This prevents false failures on lower-tier tenants.

**Module session state.** All runtime state lives in a single script-scoped hashtable `$__MtSession`, initialized in `Maester.psm1`. This includes the Graph cache, connection list, EXO cache, ORCA cache, Dataverse URLs, and the resolved config. This is a pragmatic choice for PowerShell — no dependency injection, just a shared mutable bag.

**Layered configuration.** Config resolution in `Get-MtMaesterConfig` walks up to 5 parent directories looking for `maester-config.json`, supports tenant-specific overrides (`maester-config.{TenantId}.json`), and merges a `Custom/maester-config.json` on top. This allows per-tenant settings in multi-tenant CI/CD scenarios.

**Separation of test function and test definition.** The `Test-Mt*` functions (in `powershell/public/maester/`) are pure assertion logic. The Pester `.Tests.ps1` files (in `tests/`) are thin wrappers that call them with `Should -Be $true`. This means the test functions can be used independently of Pester — e.g., in monitoring scripts or custom workflows.

## Non-Obvious Details

**EIDSCA and ORCA are auto-generated.** The `build/eidsca/Update-EidscaTests.ps1` and `build/orca/Update-OrcaTests.ps1` scripts generate test files from external data sources (the EIDSCA control catalog and ORCA checks respectively). These generated tests live alongside hand-written ones and are refreshed via `Update-MaesterTests`.

**Telemetry is opt-out, not opt-in.** `Write-Telemetry` sends tenant ID to a PostHog endpoint on every `Invoke-Maester` run unless `-DisableTelemetry` is passed. The PostHog API key is hardcoded in the function. This is documented in the command help but not called out prominently.

**The `$batch` optimization.** `Invoke-MtGraphRequest` supports piping multiple Graph requests that get automatically batched into `$batch` endpoints (max 20 per batch). This is critical for performance in large tenants — a single `Invoke-Maester` run might make hundreds of Graph calls, and batching reduces that to a handful of HTTP requests.

**Security & Compliance session hack.** `Connect-Maester` includes a workaround (credited to issue #1045) where `Connect-IPPSSession` overwrites `Get-AdminAuditLogConfig` with a broken version. The code explicitly removes the broken cmdlet and re-imports the working one from the EXO session module. This kind of defensive coding against upstream module bugs is a recurring pattern.

**Dataverse auto-discovery.** When connecting with `-Service Dataverse`, the module auto-discovers the Copilot Studio environment URL via a Global Discovery Service API call, then stores the resolved OData base URL in session state for AI agent security tests.

**`Install-MaesterTests` / `Update-MaesterTests` are a package manager.** These functions copy the test files from the installed module into a user's test directory, essentially treating the test suite as a versioned artifact separate from the module logic. This allows users to add custom tests in `tests/Custom/` while still getting upstream updates.

## Assessment

**Strengths:**
- Impressive breadth — 392 exported functions covering Entra, Exchange, Defender, Intune, Azure, Teams, Azure DevOps, and Copilot Studio security baselines. The CISA, CIS, EIDSCA, and ORCA integration means it maps directly to recognized compliance frameworks.
- Clean separation between test functions and Pester wrappers makes the `Test-Mt*` API reusable beyond the testing context.
- The `Invoke-MtGraphRequest` client with caching, paging, and batching is a legitimate piece of infrastructure — it solves real performance problems for large tenants.
- First-class CI/CD support with GitHub Action, national cloud environments, and non-interactive mode.

**Concerns:**
- The `$__MtSession` global mutable state is a fragile pattern. Any test that accidentally modifies shared state (e.g., clearing the cache mid-run) can corrupt other tests' results.
- No unit test isolation — all tests hit live APIs. There's no mocking layer for offline testing or CI validation. The `build/` directory has Pester configurations for CI, but the tests themselves require a real M365 tenant.
- The 392-function module is monolithic. Every function is dot-sourced at import time, with no lazy loading. Import time and memory footprint could become concerns as the module grows.

**Recommendations:**
- Consider adding a mock/testing mode that reads from cached JSON responses for CI validation without requiring live tenant access.
- Document the telemetry behavior more prominently and consider making it opt-in rather than opt-out.
- The test ID namespace (`MT.1001`, etc.) should be formalized in a machine-readable registry to support automated tooling and cross-referencing with compliance frameworks.

## Related

- [[analyzing-scubagear]] — Microsoft security auditing tool (similar M365 surface area, different approach)
- [[analyzing-prowler]] — AWS security testing framework (analogous role for AWS, comparable Pester-like test structure)
