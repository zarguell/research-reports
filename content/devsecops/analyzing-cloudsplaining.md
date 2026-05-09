---
title: "Analyzing Cloudsplaining"
date: 2026-05-09
type: codebase-analysis
status: complete
source: https://github.com/salesforce/cloudsplaining
tags: [aws, iam, security, python, policy-analysis, least-privilege]
---

# Analyzing Cloudsplaining

> **Source:** [salesforce/cloudsplaining](https://github.com/salesforce/cloudsplaining) @ [`31860d1`](https://github.com/salesforce/cloudsplaining/commit/31860d1a7d73167ab4886b9b3d23161cd4f88b17)

## Overview

Cloudsplaining is an AWS IAM security assessment tool by Salesforce that identifies violations of least privilege in IAM policies and generates risk-prioritized HTML reports. It analyzes the JSON output of `aws iam get-account-authorization-details` to flag over-permissive policies — those granting actions without resource ARN constraints — and classifies risks into categories like privilege escalation, data exfiltration, resource exposure, and credentials exposure.

## How It Works

Cloudsplaining operates on a straightforward pipeline: ingest IAM authorization data, parse every policy document into structured objects, evaluate each statement against a knowledge base of risky action patterns, and render the results as an interactive HTML report.

The core insight is that many IAM policies grant actions like `s3:GetObject` or `iam:CreateAccessKey` with `Resource: "*"` — meaning the action applies to every resource in the account. Cloudsplaining expands wildcard actions (e.g., `s3:*`) into their full set of concrete IAM actions using the `policy_sentry` library's IAM database, then classifies each action by access level (Read, Write, Permissions Management, Tagging). Actions that lack resource ARN constraints at sensitive access levels are flagged as violations.

A second layer of analysis examines trust policies (assume-role documents) to identify roles assumable by compute services (EC2, Lambda, ECS, EKS), cross-account principals, or any principal (`*`). This is particularly useful for penetration testers evaluating attack surface via `ssm:SendCommand` or similar vectors.

Results are filtered through a YAML-based exclusions system that supports glob patterns (e.g., `AWSServiceRoleFor*`) for policies, roles, users, and groups, allowing teams to suppress known false positives and focus on actionable findings.

## Architecture

The codebase is organized into four clear layers:

| Layer | Package | Responsibility |
|-------|---------|---------------|
| CLI | `cloudsplaining.bin`, `cloudsplaining.command` | Click-based command dispatch |
| Scanning | `cloudsplaining.scan` | Policy parsing, statement analysis, trust policy evaluation |
| Output | `cloudsplaining.output` | Finding aggregation, HTML report generation via Jinja2 |
| Shared | `cloudsplaining.shared` | Exclusions, validation, constants, utilities |

```
CLI (click)
  └─► scan command
       └─► AuthorizationDetails
            ├─► ManagedPolicyDetails → PolicyDocument → StatementDetail
            ├─► RoleDetailList → AssumeRolePolicyDocument
            ├─► UserDetailList
            └─► GroupDetailList
       └─► HTMLReport (Jinja2 template + Vue.js SPA)
```

The HTML report is a self-contained single-page application. Python serializes scan results as a JavaScript variable (`var iam_data = ...`), then injects them into an HTML template alongside a pre-built Vue.js bundle. The `--minimize` flag offloads JS to a CDN instead of inlining it.

## The Spine

**Entry point:** `cloudsplaining/bin/cli.py` registers seven Click commands. The primary workflow is `cloudsplaining scan -i <authz-file>`.

**Request lifecycle (scan command):**

1. Load and validate the authorization details JSON against a schema (requires `UserDetailList`, `GroupDetailList`, `RoleDetailList`, `Policies`)
2. Load exclusions from YAML (defaults to `default-exclusions.yml`)
3. Construct `AuthorizationDetails` — the top-level orchestrator that parses all policies, roles, users, and groups
4. Each principal (role, user, group) resolves its attached managed policies via `ManagedPolicyDetails.get_policy_detail(arn)` and parses inline policies directly
5. Each `PolicyDocument` decomposes into `StatementDetail` objects, which expand wildcard actions via `policy_sentry`
6. `PolicyFinding` aggregates risk categories per policy
7. `HTMLReport` renders the final output using Jinja2 + embedded Vue.js

**Alternative entry points:** `scan-policy-file` for single-policy analysis (no account-wide context), `scan-multi-account` for batch processing, `download` for fetching authorization details via boto3.

## Key Patterns

**Deep object graph with property-driven evaluation.** Nearly all analysis is done through `@property` and `@cached_property` methods on domain objects. `PolicyDocument.allows_privilege_escalation` doesn't run until accessed, and `StatementDetail.expanded_actions` is cached after first computation. This keeps the API clean but makes the actual computation graph opaque — there's no explicit scan "plan."

**Exclusions as first-class concept.** The `Exclusions` class is threaded through every scanner object. Glob matching (`is_name_excluded`) supports prefix (`AWSServiceRoleFor*`), suffix (`*ServiceRolePolicy`), and exact matches. Every entity check (policy, role, user, group) normalizes to lowercase before comparison.

**Two-pass resolution.** The `AuthorizationDetails` constructor first builds all principal and policy objects, then calls `set_iam_data()` on each to provide cross-references. This allows managed policies to know which roles they're attached to, enabling the "AttachedTo" field in the report.

**Severity-based filtering.** Each risk category has a hardcoded severity level (e.g., `PrivilegeEscalation` → high, `AssumableByAnyPrincipal` → critical). The `--filter-severity` CLI flag causes findings below the threshold to return empty arrays, reducing noise in the report.

## Non-Obvious Details

> [!note]
> The `flag_conditional_statements` and `flag_resource_arn_statements` flags implement a deliberate hack: setting `flag_conditional_statements=True` makes `_has_condition()` return `False`, effectively pretending conditions don't exist so that conditionally-scoped actions still get flagged. The code comment acknowledges the hackiness.

**Hardcoded action lists.** The constants file contains manually curated lists of ~40 actions that return credentials and ~5 data exfiltration actions. These are not derived from AWS documentation programmatically — they require manual maintenance as AWS adds new services.

**Privilege escalation detection uses set subset matching.** The 16 escalation methods from Rhino Security Labs research are stored as action sets. Detection checks if a policy's unrestricted actions are a superset of each escalation method's required actions. This catches combinations like `iam:PassRole` + `ec2:RunInstances` but doesn't consider resource-level constraints on the escalation path itself.

**Vue.js bundle shipped as compiled JS.** The report frontend is a Vue.js app in `cloudsplaining/output/dist/js/`. There's a `vue.config.js` at the project root suggesting it was built as part of the project. The vendor bundle filename can include hashes, handled by `get_vendor_bundle_path()` which scans the directory.

> [!question]
> The `package.json` at root and `vue.config.js` suggest the Vue frontend was once actively developed here, but the compiled JS is committed directly to the package. Is the frontend still actively maintained or is it in maintenance mode?

**SHA256 as policy ID.** Inline policies lack AWS-assigned IDs, so Cloudsplaining generates one via `sha256(json.dumps(policy_document))` in `get_non_provider_id()`. This is used as the key in results dictionaries, meaning the same inline policy attached to multiple principals will share an ID.

## Assessment

**Strengths:**
- Clean domain model. The `PolicyDocument → StatementDetail` decomposition maps directly to IAM policy structure, making the code intuitive for anyone familiar with AWS IAM.
- Practical risk categorization. The six risk types (privilege escalation, data exfiltration, resource exposure, credentials exposure, service wildcard, infrastructure modification) plus trust policy analysis cover the most important IAM misuse scenarios.
- Good exclusion system for real-world use. Teams running this across hundreds of accounts need the ability to suppress known-safe patterns.
- Dual output: self-contained HTML for human review, JSON data files for programmatic consumption and CI/CD integration.

**Concerns:**
- Heavy dependency on `policy_sentry` for action expansion and classification. Changes to `policy_sentry`'s IAM database directly affect Cloudsplaining's results. The version is pinned (`>=0.15.0,<0.16.0`), which limits compatibility.
- The severity filtering pattern — repeated `if severity in self.severity or not self.severity` blocks — is duplicated extensively across `ManagedPolicy.json`, `ManagedPolicy.json_large`, `PolicyFinding.results`, and `RoleDetail.json`. A single helper function would reduce the surface area for bugs.
- No unit test coverage for the HTML report generation, CLI commands, or data file output (explicitly omitted in coverage config).
- The `scan` command has two nearly identical code paths for single-file vs. directory input with significant duplication (lines 144–206 in `scan.py`).

**Recommendations:**
- Extract severity filtering into a reusable utility to eliminate the repeated conditional pattern.
- The `_has_condition` hack for `flag_conditional_statements` works but is fragile — consider restructuring to pass flags explicitly to evaluation methods rather than lying about internal state.
- Consider decoupling the Vue.js frontend build from the Python package to allow independent versioning and smaller package size.

## Related

[[analyzing-pacu]] — AWS exploitation framework for offensive testing
[[analyzing-clawdstrike]] — Cloud security tooling analysis
[[analyzing-stride-gpt]] — Threat modeling with AI assistance
