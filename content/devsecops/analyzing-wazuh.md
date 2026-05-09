---
title: "Analyzing Wazuh"
date: 2026-05-09
type: codebase-analysis
status: complete
source: https://github.com/wazuh/wazuh
tags: [siem, xdr, intrusion-detection, vulnerability-detection, compliance, file-integrity-monitoring, security-monitoring, devsecops]
---

## Overview

Wazuh is an open-source security monitoring platform providing SIEM, XDR, intrusion detection, vulnerability detection, compliance checking, and file integrity monitoring. Originating from the OSSEC project started by Daniel Cid, Wazuh has evolved into a comprehensive security operations platform deployed across on-premises, cloud, containerized, and virtualized environments.

This analysis examines the Wazuh monorepo at commit `bf4d529` (v5.0.0-beta1), covering the server/manager, agent, rules engine, API framework, and related infrastructure. The codebase totals approximately **810K lines of code** across C, C++, Python, and supporting languages — a mature and substantial project.

## Key Findings

### Architecture

Wazuh follows a classic agent-server architecture with a centralized manager and distributed endpoint agents:

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Wazuh Agent │────▶│  Wazuh Manager   │────▶│ Wazuh Indexer│
│  (C/C++)     │     │  (C/Python)      │     │ (OpenSearch) │
└─────────────┘     ├──────────────────┤     └──────────────┘
                     │ REST API (Py)    │     ┌──────────────┐
                     │ Rule Engine (C)  │────▶│Wazuh Dashboard│
                     │ wazuh-db (C)     │     │  (Kibana)    │
                     │ Cluster (Py)     │     └──────────────┘
                     └──────────────────┘
```

The monorepo is organized into these major directories:

| Directory | Purpose | Primary Language |
|-----------|---------|-----------------|
| `src/` | Core C/C++ components (agent, manager, modules) | C / C++ |
| `src/engine/` | New wazuh-engine (C++17, modular) | C++ |
| `api/` | REST API server | Python |
| `framework/` | Python framework (management, RBAC, cluster) | Python |
| `ruleset/` | SCA policies, MITRE ATT&CK data | YAML / JSON |
| `wodles/` | Cloud integration modules (AWS, Azure, GCP) | Python |
| `packages/` | Packaging for DEB, RPM, macOS, Windows, WPK | Shell |
| `tests/` | Integration tests (pytest) | Python |
| `tools/` | Agent upgrade, dev containers, testing utilities | Mixed |

### Codebase

**Language breakdown (excluding vendored `src/external/`):**

| Language | Files | Lines of Code |
|----------|-------|---------------|
| C | 633 | ~293K |
| C++ | 699 | ~261K |
| Python | 774 | ~156K |
| C/C++ Headers | 525 | ~100K |
| Go | 5 | minimal (engine tooling) |
| Shell | 98 | packaging/scripts |
| YAML | 786 | tests, CI, config |

The largest C++ subsystem is the **wazuh-engine** (`src/engine/`, ~116K LOC), a modular C++17 event processing engine with components for parsing, routing, key-value storage, and geo-IP lookup. The second largest is **wazuh_modules** (`src/wazuh_modules/`, ~60K LOC) including the vulnerability scanner (~23K LOC), inventory sync, SCA, and agent upgrade.

The **shared_modules** directory (~53K LOC) provides reusable C++ libraries: `dbsync` (database synchronization), `content_manager`, `indexer_connector` (OpenSearch/Wazuh Indexer integration), `router` (pub/sub message routing), and `keystore`.

Legacy C code (from the OSSEC heritage) lives in `src/shared/` (~105 C files), `src/logcollector/` (27 files), `src/remoted/` (15 files), `src/client-agent/` (16 files), `src/rootcheck/` (17 files), and `src/syscheckd/` (file integrity monitoring).

### Security Features

Wazuh implements a wide range of security monitoring capabilities:

- **File Integrity Monitoring (FIM):** `src/syscheckd/` — monitors file changes, permissions, ownership, and attributes. Supports eBPF (`src/syscheckd/src/ebpf/`), inotify, and Windows registry monitoring.
- **Rootkit Detection:** `src/rootcheck/` — scans for rootkits, hidden files, cloaked processes, and suspicious anomalies.
- **Vulnerability Detection:** `src/wazuh_modules/vulnerability_scanner/` (C++, ~23K LOC) — correlates installed software with CVE databases.
- **Security Configuration Assessment (SCA):** `ruleset/sca/` — 73 YAML policy files covering AlmaLinux, Amazon Linux, CentOS, Debian, macOS, Ubuntu, and applications (MongoDB, Nginx, OracleDB).
- **Log Collection:** `src/logcollector/` — reads OS and application logs, forwards to manager for analysis.
- **Active Response:** `src/active-response/` — automated countermeasures (IP blocking on Unix, macOS, Windows; account disabling).
- **Cloud Integrations:** `wodles/` — Python modules for AWS, Azure, and GCP security data collection.
- **MITRE ATT&CK:** `ruleset/mitre/enterprise-attack.json` — 754K-line MITRE ATT&CK dataset for threat classification.

### API and RBAC

The REST API (`api/`) is built on **connexion** (OpenAPI 3.0) with **uvicorn**/**starlette** for ASGI serving. The OpenAPI spec at `api/api/spec/spec.yaml` is over 10,000 lines, defining endpoints for agents, cluster management, security, MITRE, tasks, and overview.

**Authentication** uses JWT (JSON Web Tokens) with configurable expiration (default 900 seconds). **RBAC** is implemented through SQLAlchemy ORM models in `framework/wazuh/rbac/orm.py` with entities: `User`, `Roles`, `Rules`, `Policies`, and junction tables (`RolesRules`, `RolesPolicies`, `UserRoles`). Both whitelist and blacklist RBAC modes are supported.

API integration tests use the **Tavern** framework (26 `.tavern.yaml` files) covering CRUD endpoints with RBAC permutations.

### Cluster and Distributed Architecture

`framework/wazuh/core/cluster/` implements a master-worker cluster model enabling horizontal scaling of the manager. Components include:
- `master.py` / `worker.py` — cluster node roles
- `local_client.py` / `local_server.py` — inter-node communication
- `dapi/` — distributed API request handling
- `hap_helper/` — HAProxy load balancing support

The cluster architecture allows multiple manager nodes with agent load distribution and configuration synchronization.

### Build System

The project uses a hybrid build system:
- **Legacy C components:** GNU Make (`src/Makefile`) — builds agent, manager, and shared libraries.
- **New C++ components:** CMake (`src/CMakeLists.txt` requiring 3.12.4+, `src/engine/CMakeLists.txt` requiring 3.22.1) — builds the engine, shared modules, and data provider.
- **Python framework:** Makefile (`framework/Makefile`) — installs the embedded CPython and dependencies.
- **API:** Makefile (`api/Makefile`) — installs the API service.

The C++ standard is C++20 for the main server, C++17 for the engine. The project uses **GoogleTest** for C++ unit testing and **Google Benchmark** for performance testing.

### Deployment

Wazuh supports diverse deployment targets:
- **Packages:** DEB (`packages/debs/`), RPM (`packages/rpms/`) for amd64/arm64, macOS (`packages/macos/`), Windows (`packages/windows/`), and WPK (agent upgrade packages).
- **Docker:** 37 Dockerfiles for building, testing, and running; 5 docker-compose files.
- **Orchestration:** External repos for Ansible, Chef, Puppet, Kubernetes, CloudFormation, Salt, and Bosh.
- **Config:** XML-based configuration (`etc/wazuh-manager.conf`, `etc/ossec-agent.conf`) with 16 localized template languages in `etc/templates/`.

### Testing

Testing is extensive with a tiered approach:

| Tier | Type | Count | Framework |
|------|------|-------|-----------|
| Unit tests (C) | `src/unit_tests/` | 184 test files | CMocka / GoogleTest |
| Unit tests (C++) | Per-module `tests/` dirs | ~50+ test suites | GoogleTest |
| Integration tests | `tests/integration/` | 269 Python files | pytest |
| API integration | `api/test/integration/` | 26 Tavern specs | Tavern |
| Framework unit | `framework/wazuh/tests/` | 8 test files | pytest |
| Engine tests | `src/engine/test/` | Acceptance + integration | Custom |

The **CI/CD pipeline** is remarkably comprehensive with **137 GitHub Actions workflows**, of which **99 are test-related**. Code analysis workflows include:
- **Coverity** static analysis (Scan Coverity project #10992)
- **Clang-Tidy** with an extensive `.clang-tidy` config (bugprone, cert, cppcoreguidelines, google, misc, modernize checks)
- **Clang-Format** enforced (`.clang-format` config)
- **Python Bandit** security scanning
- **ScanBuild** (Clang Static Analyzer)

### Community

The project demonstrates mature open-source governance:
- **16 issue templates** covering API/framework tests, integration tests, Python unit tests, UI regression, rules/decoders requests, and workload benchmarks.
- **SECURITY.md** with responsible disclosure policy (90-day disclosure timeline, `security@wazuh.com` contact).
- **CONTRIBUTORS** file listing OSSEC heritage contributors.
- Based on **OSSEC** (started by Daniel Cid), licensed under **GPLv2** (engine under **AGPLv3**).
- Community channels: Slack, Google Groups, Twitter, YouTube, LinkedIn.

## Assessment

### Strengths

- **Breadth and depth of security capabilities** — FIM, vulnerability detection, rootkit detection, SCA, active response, log collection, and cloud integrations in a single platform.
- **Massive test infrastructure** — 137 CI workflows, tiered testing from unit through integration, covering C, C++, and Python code. The Coverity badge and Bandit scanning show investment in code quality.
- **Rigorous code quality enforcement** — clang-format, clang-tidy with extensive check sets, and multiple static analysis tools.
- **The new wazuh-engine** (`src/engine/`, ~116K LOC C++17) represents a significant modernization effort with clean modular architecture (routing, parsing, key-value stores, geo-IP).
- **Multi-platform support** — Linux, Windows, macOS, containers, and cloud providers with proper packaging for each.
- **Comprehensive RBAC** with SQLAlchemy ORM, JWT auth, and both whitelist/blacklist modes.
- **MITRE ATT&CK integration** with a full enterprise-attack dataset.

### Concerns

- **Dual build system complexity** — Maintaining both Make and CMake build systems adds maintenance burden. The legacy Makefile dates from the OSSEC era.
- **Language heterogeneity** — C, C++, and Python with different testing frameworks and tooling per language creates a steep learning curve for contributors.
- **Engine AGPLv3 vs. core GPLv2 licensing** — The wazuh-engine is AGPLv3 while the main platform is GPLv2, which may create confusion for downstream users.
- **Massive OpenAPI spec** — `spec.yaml` at 10,141 lines is difficult to maintain and review. Auto-generation from code would improve this.
- **Shallow git history** — The analyzed commit appears to be a squash merge, making historical analysis of contributor patterns difficult.

### Recommendations

- Consolidate the build system to CMake for all C/C++ components, deprecating the legacy Makefile.
- Consider auto-generating the OpenAPI spec from Python controller annotations to reduce maintenance burden.
- Investigate the wazuh-engine as a standalone component — its modular architecture (routing, parsing, KV stores) could serve broader use cases beyond Wazuh.
- The SCA ruleset (73 files) could benefit from community contributions — consider a clearer contribution workflow for new SCA policies.
- Continue the C++ modernization path; the newer C++17/20 modules are significantly cleaner than the legacy C code.

## Related

- [[analyzing-prowler]] — Cloud security assessment tool; complementary to Wazuh's cloud monitoring modules.
- [[analyzing-gitleaks]] — Secret detection tool; Wazuh's FIM and log analysis can detect credential exposure differently.
- [[analyzing-trufflehog]] — Another secret scanning tool; Wazuh provides runtime monitoring vs. Trufflehog's repository scanning.
- [[analyzing-opencti]] — OpenCTI is a threat intelligence platform; Wazuh integrates MITRE ATT&CK data similarly.
- [[analyzing-nuclei]] — Nuclei is a vulnerability scanner; Wazuh's vulnerability detector serves a related but different role (installed software CVE correlation vs. active scanning).
