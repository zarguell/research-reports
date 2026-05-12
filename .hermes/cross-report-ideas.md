# Cross-Repo Report Ideas

Generated: 2025-05-11
Source: 98 research reports in /opt/data/repos/research-reports

---

## Tier 1: Same 13 CI/CD Repos — Easy Lift

These reuse the repos already cloned at /tmp/cicd-repos and follow the same extraction pattern as the CI/CD reference guide.

### 1. ~~Best Container Security Hardening~~ ✅ DONE
- **Report:** `content/devsecops/container-security-hardening-reference-guide.md`

### 2. Open Source Release Engineering
- **Champions:** Traefik, OpenTofu, Grype, ZAP, Insomnia, dep-scan
- **Patterns to extract:**
  - GoReleaser configurations (Traefik's dynamic per-arch config generation, OpenTofu's signing setup, Grype's snapshot + release split)
  - semver enforcement and tag validation (OpenTofu's branch check, Grype's version-available gate)
  - Changelog generation (Checkov's release-changelog-builder, Insomnia's changelog-updater-action)
  - Artifact signing: cosign (Grype, OpenTofu), Chalk (ZAP), Notary (Insomnia)
  - Multi-registry Docker pushes: Docker Hub + GHCR (ZAP, dep-scan, Gitleaks)
  - Package manager publishing: PyPI trusted publishing (dep-scan), npm (Insomnia), Homebrew (Insomnia, Gitleaks), Snap (OpenTofu, ZAP, Threat Dragon)
  - Release channels: stable/weekly/nightly Docker images (ZAP's 4 Dockerfile variants)
  - macOS code signing + notarization (Insomnia, Threat Dragon, ZAP)
  - Install4J for cross-platform desktop installers (ZAP)
  - Automated version bumping (Insomnia's release-start workflow)
- **Why it works:** Every repo has a release process and they're all different. Extremely practical reference.

### 3. ~~Testing Philosophy Spectrum~~ ✅ DONE
- **Report:** `content/devsecops/testing-philosophy-spectrum.md`
- **Champions:** Wazuh (99 test workflows), Gitleaks (1 test workflow), oCIS (506-line acceptance), dep-scan (per-language suites)
- **Patterns to extract:**
  - The testing pyramid in practice: unit → integration → e2e → acceptance
  - Targeted testing via change detection (Checkov's changed-files approach)
  - Parallel test execution with load monitoring (oCIS vmstat pattern)
  - Test isolation strategies: Docker containers (Threat Dragon), separate runner environments (dep-scan's OS matrix)
  - Test fixtures and snapshot testing (Grype's quality tests, dep-scan's snapshot comparison)
  - When NOT to test: Gitleaks' minimal approach (2-platform matrix, race detection, config validation)
  - Desktop app testing: xvfb for Linux, platform-specific builds (Threat Dragon, Insomnia)
  - Chaos engineering in CI: Litmus with oCIS's Drone pipeline
  - Coverage tracking: Checkov's badge generation, ZAP's jacoco + SonarCloud
- **Why it works:** Testing is the biggest CI cost center. Seeing the spectrum from "just enough" (Gitleaks) to "enterprise-grade" (Wazuh, oCIS) helps teams calibrate.

### 4. GitHub Actions Reusable Patterns
- **Champions:** Grype, Checkov, Insomnia, oCIS
- **Patterns to extract:**
  - Reusable workflows (Grype's anchore/workflows repo, Checkov's security-shared.yml, oCIS's reusable translation sync)
  - Composite actions (Grype's .github/actions/bootstrap)
  - Workflow concurrency patterns (dep-scan, Insomnia, Grype release)
  - Path-based triggers and path-ignore patterns (Traefik, Checkov, dep-scan)
  - Environment protection rules (Checkov's release/scan-security environments)
  - Self-hosted runner patterns (Checkov uses [self-hosted, public, linux, x64])
  - Matrix dynamic generation and include/exclude
  - Artifact flow: upload → download → transform (Threat Dragon's SBOM combiner)
  - Conditional step execution (if: failure(), if: matrix.os == 'ubuntu-latest')
- **Why it works:** GitHub Actions is the common platform. A patterns catalog would be immediately useful.

---

## Tier 2: Existing Vault Reports — New Groupings

These use reports we've already written but group them by cross-cutting concerns rather than by individual codebase.

### 5. Self-Hosted Infrastructure Patterns
- **Repos in vault:** Nextcloud, oCIS, Wazuh, Gitea, Forgejo, Vaultwarden, Syncthing, n8n, Homarr, Home Assistant, Traefik, Uptime Kuma
- **Patterns to extract:**
  - Docker Compose vs docker run vs K3s deployment approaches
  - Reverse proxy patterns (Traefik, Nginx, Caddy) with TLS termination
  - Backup and disaster recovery strategies
  - SSO integration: Keycloak, Authelia, Cloudflare Access, Tailscale
  - Database choices: SQLite vs PostgreSQL vs MySQL for self-hosted scale
  - Monitoring and alerting: Prometheus, Grafana, Uptime Kuma
  - Secret management in self-hosted contexts
  - Update strategies: Watchtower, manual, scripted
- **Why it works:** Self-hosting is a growing movement. A practical comparison guide would have wide appeal.

### 6. Authentication & Authorization Implementations
- **Repos in vault:** oCIS, Nextcloud, Wazuh, Gitea, Vaultwarden, Keycloak integrations
- **Patterns to extract:**
  - OAuth2/OIDC provider integration patterns
  - JWT handling: signing keys, rotation, refresh tokens
  - RBAC vs ABAC vs PBAC models
  - API key management
  - Session management and encryption at rest
  - Multi-tenant isolation patterns
  - LDAP/Active Directory integration
  - Two-factor authentication implementations
- **Why it works:** Auth is the hardest part of most applications. Real implementations are more useful than theory.

### 7. Monorepo vs Polyrepo Architecture
- **Repos in vault:** oCIS (42 Go microservices in one repo), Insomnia (npm workspaces monorepo), Nextcloud (PHP monolith with apps), Wazuh (C agent + Python manager + React UI), dep-scan (uv workspaces)
- **Patterns to extract:**
  - Workspace management: npm workspaces, Go modules, uv workspaces
  - Shared CI configuration across sub-projects
  - Cross-service testing strategies
  - Dependency management in monorepos
  - Selective CI triggers (only run tests for changed sub-projects)
  - Release coordination across multiple components
- **Why it works:** The monorepo debate is perennial. Real examples beat theoretical arguments.

---

## Tier 3: Language-Specific Deep Dives

These group repos by language and compare idiomatic patterns.

### 8. Go Project Architecture Comparison
- **Repos:** OpenTofu, Traefik, Gitleaks, Grype, oCIS, agent-scan (partially)
- **Patterns to extract:**
  - Project layout: cmd/ vs internal/ vs pkg/ structures
  - CLI framework choices: cobra (OpenTofu), kong (Grype), custom
  - Configuration management: Viper, env vars, config files
  - Error handling patterns and wrapping
  - Dependency injection approaches
  - Plugin/extension systems
  - Testing conventions: testify vs standard library, table-driven tests, mocks
  - Go version management in CI: go-version-file vs go-version
- **Why it works:** 5 substantial Go projects with different approaches to the same language.

### 9. Python Security Tool Architecture
- **Repos:** Checkov, dep-scan, agent-scan
- **Patterns to extract:**
  - Plugin/extension architectures for scanning engines
  - Database management for vulnerability data (dep-scan's VDB, Checkov's Prisma integration)
  - CLI design with Click vs argparse vs custom
  - Async scanning patterns
  - Test strategies for security tools (false positive/negative testing)
  - Package management: pipenv (Checkov) vs uv (dep-scan, agent-scan)
  - Binary distribution: PyInstaller (dep-scan, agent-scan) vs pip
- **Why it works:** Security tools have unique challenges (large databases, plugin systems, performance-sensitive scanning) that general Python guides don't cover.

### 10. Node.js/Electron Application Patterns
- **Repos:** Threat Dragon, Insomnia
- **Patterns to extract:**
  - Electron build and packaging for cross-platform desktop
  - Vue 3 vs React architecture choices
  - API server + frontend integration
  - Desktop + web dual deployment
  - npm monorepo workspace management
  - E2E testing with WebdriverIO, Playwright, BrowserStack
  - SBOM generation for Node.js projects
  - Desktop code signing and notarization (macOS, Windows)
- **Why it works:** Electron/Node.js desktop apps are common but poorly documented in CI/CD contexts.

---

## Tier 4: Thematic Cross-Cuts

### 11. Secrets Management Across Projects
- How each project handles secrets in CI: GitHub Secrets, vault integration, environment protection
- Secret detection in CI pipelines (Gitleaks, TruffleHog, Checkov)
- Rotation strategies
- CI secret scoping: repository vs environment vs organization

### 12. ~~Documentation-as-Code Patterns~~ ✅ DONE
- **Report:** `content/devsecops/documentation-as-code-patterns-reference-guide.md`

### 13. Dependency Management Strategies
- Automated dependency updates: Renovate vs Dependabot vs custom (Checkov's pipenv-update)
- Lock file handling across languages
- Vulnerability response workflows
- Dependency pinning vs ranges philosophies
- Supply chain attestation

---

## Priority Ranking

1. **Container Security Hardening** — easiest lift, universally useful
2. **Open Source Release Engineering** — highly practical, lots of variance to compare
3. **Self-Hosted Infrastructure Patterns** — widest audience appeal, but needs more vault coverage
4. **Testing Philosophy Spectrum** — intellectually interesting, helps teams calibrate investment
5. **GitHub Actions Reusable Patterns** — pure utility, but narrow audience
6. **Go Project Architecture** — strong for developer audience
7. Everything else — do when inspiration strikes or audience requests
