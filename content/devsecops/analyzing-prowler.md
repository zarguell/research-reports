---
title: "Analyzing Prowler"
date: 2026-05-09
type: codebase-analysis
status: complete
source: https://github.com/prowler-cloud/prowler
tags: [cloud-security, compliance, aws, python, django, nextjs, devsecops]
---

> **Source**: [`prowler-cloud/prowler`](https://github.com/prowler-cloud/prowler) at commit `832516be` (832516be2a354709bcf2e8e3485c51c9352c1d1e), master branch.

## How It Works

Prowler is an open-source cloud security platform that scans multi-cloud environments — AWS, Azure, GCP, Kubernetes, GitHub, M365, and 12 other providers — and evaluates resources against 1,300+ security checks and 100+ compliance frameworks (CIS, NIST, PCI-DSS, SOC2, GDPR, MITRE ATT&CK, etc.). At its core, Prowler is a check execution engine: each check is a Python class that inherits from `Check`, implements an `execute()` method returning a list of typed report objects (`Check_Report_AWS`, `Check_Report_Azure`, etc.), and is paired with a JSON metadata file that defines severity, remediation guidance, categories, and compliance mappings.

The system operates through three surfaces. The **CLI** (`prowler <provider>`) is the primary interface for running scans — it discovers checks via filesystem traversal, instantiates provider sessions, and executes checks against cloud APIs. The **API** (Django + DRF) wraps the SDK into a multi-tenant SaaS platform with Row-Level Security enforced at the PostgreSQL level, Celery task queues for long-running scans, and JSON:API-compliant endpoints. The **UI** (Next.js 15 + React 19) consumes the API with server components, server actions, and Zustand state management, presenting findings dashboards, compliance heatmaps, and attack path visualizations.

What makes Prowler distinctive is the tight coupling between checks and compliance: every check's metadata JSON maps to specific controls within compliance frameworks stored as separate JSON files in `prowler/compliance/{provider}/`. The SDK resolves these mappings at runtime, so a single check like `iam_root_mfa_enabled` automatically appears in CIS, NIST 800-53, SOC2, PCI-DSS, and any other framework that references that control. This "write once, comply everywhere" architecture is the product's core value proposition.

## Architecture

The monorepo has five distinct components:

| Component | Location | Stack | Purpose |
|-----------|----------|-------|---------|
| **SDK** | `prowler/` | Python 3.10+, Poetry | Check engine, providers, outputs |
| **API** | `api/` | Django 5.1, DRF, Celery, PostgreSQL | Multi-tenant SaaS backend |
| **UI** | `ui/` | Next.js 15, React 19, Tailwind 4, shadcn | Web dashboard |
| **MCP Server** | `mcp_server/` | FastMCP, Python 3.12+ | AI agent integration |
| **Dashboard** | `dashboard/` | Dash, Plotly | Local CLI dashboard |

The SDK is the heart. Its provider architecture follows a strict convention: `prowler/providers/{provider}/services/{service}/{check_name}/`. Each provider has a `_provider.py` class (auth, session), services have `_service.py` (API client) and `_client.py` (singleton), and checks are self-contained directories with implementation + metadata JSON. The SDK supports 18 providers.

The API runs a four-database PostgreSQL architecture — `default` and `replica` (RLS-enforced, tenant-scoped) plus `admin` and `admin_replica` (RLS-bypassed for migrations and auth). Row-Level Security is enforced via PostgreSQL policies set per-request using `SET api.tenant_id = 'uuid'`. Celery workers execute scans by invoking the SDK within `rls_transaction(tenant_id)` contexts and bulk-inserting findings.

The MCP server exposes three namespaced sub-servers: `prowler_hub_*` (check catalog, no auth), `prowler_app_*` (cloud management, auth required), and `prowler_docs_*` (documentation search, no auth). Tools extend a `BaseTool` ABC with auto-registration.

## The Spine

### CLI Lifecycle

1. `prowler/__main__.py` parses CLI arguments and selects the provider
2. The provider's `_provider.py` authenticates and builds a session (boto3 for AWS, azure-identity for Azure, etc.)
3. `checks_loader.py` discovers all checks for the provider via filesystem scanning (`CheckMetadata.get_bulk()`), then filters by `--check`, `--service`, `--severity`, `--compliance`, or `--category` flags
4. `check.py::execute_checks()` imports each check module dynamically, instantiates the `Check` subclass, and calls `execute()`
5. Each check reads from its service's singleton client, evaluates resources, and returns `Check_Report_*` objects
6. The `outputs/` layer formats findings into JSON (OCSF and ASFF), CSV, HTML, SARIF, or compliance-specific reports
7. Compliance frameworks are resolved: `compliance.py` walks `prowler/compliance/{provider}/*.json` and maps checks to requirements using `get_check_compliance()`

### API Scan Lifecycle

1. Request hits `BaseRLSViewSet.initial()` which extracts `tenant_id` from JWT and calls `SET api.tenant_id`
2. A scan request enqueues a Celery task via `tasks/jobs/scan.py`
3. The worker calls `rls_transaction(tenant_id)`, invokes the Prowler SDK for the given provider, and processes results
4. Findings are bulk-inserted into partitioned PostgreSQL tables with RLS constraints
5. Post-scan jobs run: ThreatScore calculation, compliance aggregation, attack path ingestion (Neo4j), and report generation

## Key Patterns

### Check System (Convention over Configuration)

Every check follows an identical structure enforced by the `Check.__init__` constructor, which validates that `CheckID == class_name == file_name`. Metadata is loaded from a co-located `.metadata.json` file parsed by Pydantic v1 with extensive validators (severity, categories, service name consistency, CheckType hierarchy for AWS). The `execute()` method is the single extension point — it receives nothing and returns `list[Check_Report_Provider]`.

### Provider Pattern

Providers are plugin-like modules with a consistent internal structure: provider class, service clients (singletons), argument parsers, and mutelist support. Adding a new provider means scaffolding the directory tree and implementing the abstract `Provider` base class (type, identity, session, audit_config properties). The system uses `importlib` for runtime discovery — there's no central provider registry.

### Compliance Mapping

The four-layer compliance system connects SDK models → JSON catalogs → output formatters → API/UI. Each compliance JSON defines a `Framework` with `Requirements`, each containing `Checks` (list of check IDs) and `Attributes` (framework-specific metadata like CIS Profile, NIST Control). The runtime linker builds a key as `"{Framework}-{Version}"` and loads all frameworks by scanning the compliance directory. Output formatters follow a per-provider class pattern with table dispatchers registered via `startswith` predicates.

### Row-Level Security (API)

RLS is implemented as a Django model constraint (`RowLevelSecurityConstraint`) that issues `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and creates policies scoped to `current_setting('api.tenant_id')::uuid`. All tenant-scoped models inherit from `RowLevelSecurityProtectedModel`. The `rls_transaction(tenant_id)` context manager is mandatory for any database query outside the ViewSet request lifecycle (Celery tasks, management commands).

## Non-Obvious Details

> [!note] **Metadata-Driven Check Discovery**
> There is no central check registry. Checks are discovered by scanning `prowler/providers/{provider}/services/` for `.metadata.json` files. The `CheckMetadata.get_bulk(provider)` method walks the filesystem and parses every metadata file it finds. This means adding a check is purely additive — create the directory, write the files, and it's automatically picked up.

**The Pydantic v1/v2 split**: The SDK uses Pydantic v1 for check metadata and compliance models (imported via `from pydantic.v1 import`), while the output layer uses Pydantic v2 for CSV models in compliance formatters. This is intentional — the v1 union-ordering behavior is critical for `Compliance_Requirement.Attributes` where `Generic_Compliance_Requirement_Attribute` must be last in the Union.

**Attack Paths with Neo4j**: AWS scans can optionally produce attack path graphs by combining Prowler findings with Cartography's cloud inventory in Neo4j. The API worker enqueues an openCypher ingestion job after each scan, writing to per-tenant Neo4j databases.

**The prowler_check_kreator utility**: A separate tool in `util/prowler_check_kreator/` uses Gemini LLM to auto-generate check scaffolding — implementation, metadata JSON, and tests — from a natural language description. This reveals how the project scales check creation.

**M2M through models for RLS**: Django's default Many-to-Many fields don't work with RLS because they lack `tenant_id`. Every M2M relationship in the API requires an explicit through model with a `tenant_id` column — a non-obvious constraint that affects all API model design.

**Vercel provider**: The newest addition (at this commit), showing the provider pattern extends beyond traditional cloud — Prowler checks Vercel projects, deployments, domains, and team security settings.

## Assessment

### Strengths

- **Exceptional multi-cloud breadth**: 18 providers with 1,300+ checks is unmatched in open-source cloud security. The provider architecture makes adding new platforms straightforward.
- **Compliance depth**: 104 compliance frameworks with automatic check-to-control mapping. The four-layer system ensures a single check contributes to every relevant framework without duplication.
- **Production-grade multi-tenancy**: PostgreSQL RLS enforced at the database level (not application level) is the correct approach for SaaS isolation. The four-database architecture separates operational concerns cleanly.
- **Rigorous check conventions**: The enforced CheckID/class/file name triplet, Pydantic metadata validation, and directory structure create a consistent, navigable codebase despite having hundreds of contributors.
- **Excellent developer experience tooling**: The `AGENTS.md` skill system with auto-invoke rules, the check kreator utility, and comprehensive testing infrastructure (moto for AWS mocking, pytest-django for RLS isolation tests, Playwright for UI E2E) show investment in DX.

### Concerns

- **Pydantic v1 dependency in the SDK**: The check and compliance models rely on Pydantic v1 behavior (union ordering, `parse_file`, `parse_raw`). This is a technical debt anchor that blocks migration to modern Pydantic and introduces cognitive overhead for contributors.
- **Filesystem-based discovery has scaling limits**: Scanning directories for `.metadata.json` files at startup works for 1,300 checks but has no indexing. Cold-start latency will grow as checks accumulate.
- **The `__main__.py` is 1,468 lines**: The CLI entry point is a monolithic command dispatcher mixing argument parsing, provider setup, check execution orchestration, and output formatting. It would benefit from decomposition.
- **Provider SDK dependency weight**: The root `pyproject.toml` bundles all provider SDKs (boto3, azure-mgmt-*, google-api-python-client, kubernetes, msgraph-sdk, cloudflare, etc.) into a single dependency list. Users scanning only AWS still install Azure and GCP libraries.

### Recommendations

- For teams adopting Prowler: start with the CLI for CI/CD pipeline integration (it outputs SARIF, OCSF, and ASFF natively), then layer on the API/UI for multi-team visibility. The MCP server is worth exploring for security teams using AI-assisted workflows — see [[analyzing-ghidra-mcp]] for MCP patterns in security tooling.
- For contributors: the skill-based `AGENTS.md` system is unusually well-structured for an open-source project. Following the `prowler-sdk-check` skill when writing checks ensures consistency with the existing 1,300+ checks.
- For comparison with other scanners: Prowler's check breadth and compliance mapping depth distinguish it from tools like [[analyzing-nuclei]] (which focuses on vulnerability scanning with YAML-based templates) or [[analyzing-opencti]] (which is a threat intelligence platform rather than a compliance scanner).

## Related

- [[analyzing-nuclei]] — scanner comparison (template-based vulnerability scanning)
- [[analyzing-ghidra-mcp]] — MCP server patterns in security tooling
- [[analyzing-opencti]] — threat intelligence platform architecture
- [[analyzing-clawdstrike]] — cloud security tool analysis
- [[analyzing-ship-safe]] — DevSecOps pipeline tooling
