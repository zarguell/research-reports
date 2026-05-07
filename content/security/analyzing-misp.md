---
title: "Analyzing MISP"
date: 2026-05-07
type: codebase-analysis
status: complete
source: https://github.com/MISP/MISP
tags: [php, cakephp, threat-intelligence, ioc, incident-response, open-source, mysql, redis, python, rest-api, correlation]
---

# Analyzing MISP

> **Source:** [MISP/MISP](https://github.com/MISP/MISP) @ [`2b3d843`](https://github.com/MISP/MISP/commit/2b3d843cbe3ae10c4f1f5603e65e2df794834291)

## How It Works

MISP (Malware Information Sharing Platform) is a threat intelligence platform that lets organizations create, share, and correlate indicators of compromise (IOCs). At its core, every piece of intelligence is an **Event** — a container that groups related **Attributes** (individual IOCs like IP addresses, hashes, domains) and **Objects** (structured groupings of attributes, e.g., a file with its hash, filename, and size together). Events carry a five-tier **distribution model** controlling visibility: organisation-only → this community → connected communities → all communities → sharing group.

The system is built on CakePHP 2.x, a mature PHP MVC framework that MISP has heavily customized. Authentication and authorization flow through `AppController` (1,792 lines), which handles session management, ACL checks, API key validation, and CSRF protection before any controller action executes. The `Event` model (9,561 lines) is the gravitational center of the codebase — it encapsulates the full lifecycle of threat intelligence: creation, validation, enrichment (via taxonomies, galaxies, warninglists), correlation against existing data, publication, and synchronized distribution to peer MISP instances.

MISP operates as both a web application and an API-first service. The REST API under `/events`, `/attributes`, and other resources supports XML, JSON, and CSV, making it straightforward to integrate with SIEMs, IDS/IPS, and automated response pipelines. PyMISP provides the canonical Python client.

## Architecture

```
                    ┌─────────────┐
                    │  Apache/Nginx│
                    └──────┬──────┘
                           │ mod_rewrite
                    ┌──────▼──────┐
                    │ webroot/     │
                    │ index.php    │
                    └──────┬──────┘
                           │ CakePHP Router
              ┌────────────▼────────────┐
              │     AppController       │
              │  (Auth, ACL, API, CSRF) │
              └────────────┬────────────┘
          ┌─────────────────┼─────────────────┐
    ┌─────▼─────┐    ┌─────▼──────┐   ┌──────▼──────┐
    │ Events    │    │ Attributes │   │ Servers     │
    │Controller │    │Controller  │   │Controller   │
    └─────┬─────┘    └─────┬──────┘   └──────┬──────┘
          │                │                  │
    ┌─────▼─────┐    ┌─────▼──────┐   ┌──────▼──────┐
    │ Event     │    │ Attribute  │   │ Server      │
    │ Model     │◄──►│ Model      │   │ (Sync)      │
    │ (9.5K LOC)│    │            │   └─────────────┘
    └─────┬─────┘    └─────┬──────┘
          │                │
    ┌─────▼────────────────▼─────┐
    │  MySQL/MariaDB  │  Redis   │
    │  (persistence)  │  (cache, │
    │                 │   jobs)   │
    └────────────────────────────┘
          │
    ┌─────▼─────────────────────────────┐
    │ Background Job Queues (Redis)     │
    │ default | email | cache | prio    │
    │ update | scheduler                │
    │ Managed via Supervisor            │
    └───────────────────────────────────┘
```

**Key modules:**

| Layer | Count | Notable |
|-------|-------|---------|
| Models | 190 | `Event` (9.5K), `Attribute`, `Object`, `User`, `Server` |
| Controllers | 91 | `EventsController` (7.4K), `AttributesController` (3.3K) |
| Components | 17 | `RestSearchComponent`, `RestResponseComponent`, `CRUDComponent`, `ACLComponent`, `RateLimitComponent` |
| Behaviors | 10 | `DefaultCorrelationBehavior`, `AuditLogBehavior`, `OnDemandCorrelationBehavior` |
| Lib Tools | 68+ | `AttachmentTool`, `BackgroundJobsTool`, `CurlClient`, `CryptGpgExtended`, `ComplexTypeTool` |
| Console Shells | 20+ | `StartWorkerShell`, `EventShell`, `ServerShell`, `AdminShell` |
| Plugins | 15 | Auth (LDAP, OIDC, AAD, Shibboleth, Cert), Caching (APCu, Redis), Logging (ECS, Syslog) |

## The Spine

The primary request path for the REST API:

1. **Entry** — Apache routes to `app/webroot/index.php`. CakePHP's router maps `/events` to `EventsController` (or `/attributes` to `AttributesController`). REST resources are explicitly mapped via `Router::mapResources()`.

2. **Auth gate** — `AppController::beforeFilter()` runs on every request. It checks for a valid session or API key, enforces ACL rules based on the user's role, applies rate limiting, and handles blocked lists. API clients pass their key via `Authorization` header or URL param.

3. **Controller action** — The controller delegates to the model layer. `RestSearchComponent` normalizes the ~50+ query parameters (filters by type, category, tags, date ranges, threat level, sharing group, etc.) and constructs the CakePHP find query. `RestResponseComponent` formats the output as JSON/XML/CSV.

4. **Model + Behaviors** — The model executes the query with `Containable` behavior for eager loading. `AuditLogBehavior` writes an audit trail. `EventWarningBehavior` checks against warninglists (known-false-positive indicators).

5. **Correlation** — When an attribute is created/modified, the correlation engine (pluggable via behaviors: `DefaultCorrelationBehavior`, `OnDemandCorrelationBehavior`, `NoAclCorrelationBehavior`) compares it against all existing attributes. Matches are written to the `correlations` table. This is the most computationally expensive operation in MISP.

6. **Background jobs** — Heavy operations (sync, caching, notifications, export) are dispatched to Redis-backed queues managed by Supervisor workers. `BackgroundJobsTool` provides the interface — six queues (default, email, cache, prio, update, scheduler) with distinct priority levels.

7. **Sync** — The `Server` model handles synchronization with peer MISP instances. Events are pushed/pulled based on distribution rules and server-level filter rules.

## Key Patterns

**CakePHP 2.x MVC with heavy god-object tendency.** The `Event` model at 9,561 lines and `EventsController` at 7,378 lines are monolithic. They handle validation, business logic, API serialization, export formatting, and workflow orchestration. This is a known cost of the project's organic growth over 10+ years.

**Distribution as the core access control primitive.** Every Event and Attribute has a `distribution` field (0–4) plus an optional `sharing_group_id`. This model cascades — an attribute's effective distribution is the intersection of its own distribution, its parent event's distribution, and the sharing group rules. ACL logic is spread across `AppController`, `ACLComponent`, and individual model methods.

**Pluggable correlation engines.** The correlation system uses CakePHP behaviors as a strategy pattern. `DefaultCorrelationBehavior` does full correlation on every attribute change; `OnDemandCorrelationBehavior` defers correlation until query time; `NoAclCorrelationBehavior` skips ACL checks for performance. The `deadlockAvoidance` flag in the default behavior shows awareness of MySQL lock contention under load.

**Rich taxonomy and enrichment system.** MISP loads taxonomies (structured tagging vocabularies like ATT&CK, VERIS), galaxies (visual clusters of related threats), and warninglists (known-good indicators to exclude). These are JSON files in `app/files/` loaded at startup and cached. The `EventWarningBehavior` and attribute validation tools cross-reference against them.

**Multi-format IOC import/export.** Components and tools handle OpenIOC, STIX, CSV, MISP JSON, and custom formats. `IOCImportComponent` handles composite attribute parsing (e.g., combining a registry key + value into a `regkey|value` type).

## Non-Obvious Details

**AppController is the true gatekeeper.** At 1,792 lines, `AppController::beforeFilter()` and `beforeRender()` handle not just auth but also organization scope enforcement, session fixation protection, TLS enforcement, request throttling, and blocked-list checks. If you're debugging access issues, this is where 90% of the logic lives.

**Correlation is the scaling bottleneck.** The default correlation behavior inserts into a `correlations` table that can grow to hundreds of millions of rows for active instances. The `OnDemandCorrelationBehavior` exists specifically to address this — it trades storage for compute by correlating at query time. The `deadlockAvoidance` flag reorders INSERT statements to reduce MySQL deadlock frequency.

**GPG encryption for sync.** `CryptGpgExtended` in `Lib/Tools/` handles PGP encryption/decryption for synchronized events between instances. This isn't just optional — many MISP communities require encrypted sync.

**The `ComplexTypeTool` is surprisingly critical.** It validates and normalizes all attribute values — IP addresses, hashes, domains, URLs, email addresses, file paths, etc. Getting a validation wrong here means garbage data entering the correlation engine. It's also where composite types (`filename|md5`, `regkey|value`) get parsed.

**Supervisor + Redis is mandatory for production.** Background jobs are not optional — email notifications, sync, caching, and scheduled tasks all flow through Redis queues consumed by Supervisor-managed worker processes. Without Supervisor running, MISP degrades significantly.

> [!question]
> The CakePHP 2.x dependency is the biggest architectural risk. CakePHP 2.x reached end-of-life in 2018. MISP bundles its own fork of the framework in `app/Lib/cakephp/`. While this provides stability, it means no upstream security patches and increasing PHP version incompatibility. The project requires PHP 8.1+ but <9.0, which creates a narrowing upgrade window.

## Assessment

**Strengths:**
- Mature, battle-tested threat intelligence platform used by national CERTs, financial institutions, and incident response teams worldwide
- Rich data model with distribution, sharing groups, taxonomies, galaxies, and warninglists — covers real-world threat sharing requirements
- Comprehensive API with REST, XML, JSON, CSV support and the excellent PyMISP Python client
- Pluggable auth (LDAP, OIDC, AAD, Shibboleth) and modular correlation engines show pragmatic architectural decisions
- Strong audit logging via `AuditLogBehavior` and access logging

**Concerns:**
- God objects: `Event` model (9.5K lines) and `EventsController` (7.4K lines) are difficult to navigate and test. Any change risks unintended side effects.
- CakePHP 2.x is EOL since 2018 with no upstream support. MISP ships a forked copy, absorbing all maintenance burden.
- Correlation engine doesn't scale well without careful tuning. Large instances need `OnDemandCorrelationBehavior` and aggressive indexing.
- 186K+ LOC PHP monolith with limited test coverage relative to the codebase size
- No structured migration path to a modern framework — the `CLAUDE.md` and `ROADMAP.md` don't indicate a rewrite plan

**Recommendations:**
- If deploying MISP, budget time for Supervisor/Redis setup and correlation engine tuning from day one
- For programmatic integration, use PyMISP exclusively — the REST API is the cleanest interface boundary
- Monitor the `correlations` table size and consider `OnDemandCorrelationBehavior` for instances with >1M attributes
- The CakePHP 2.x dependency warrants a long-term risk assessment for any organization making MISP a critical dependency

## Related

- [[analyzing-ghidra-mcp]] — security tooling with AI integration
- [[analyzing-bloodhound]] — attack path analysis, complementary to MISP's threat intelligence
- [[analyzing-sharphound]] — data collection for Bloodhound, often used alongside threat intel platforms
- [[analyzing-mimikatz]] — credential harvesting tool whose IOCs are commonly tracked in MISP
- [[analyzing-datadog-guarddog]] — supply chain security, complementary defensive layer
