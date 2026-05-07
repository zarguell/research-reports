---
title: "Analyzing OpenCTI"
date: 2026-05-07
type: codebase-analysis
status: complete
source: https://github.com/OpenCTI-Platform/opencti
tags: [typescript, python, react, graphql, threat-intelligence, stix2, elasticsearch, opensearch, redis, rabbitmq, sklearn, ai-ml, open-source]
---

# Analyzing OpenCTI

> **Source:** [OpenCTI-Platform/opencti](https://github.com/OpenCTI-Platform/opencti) @ [`cefc0ca`](https://github.com/OpenCTI-Platform/opencti/commit/cefc0cad77d1315467eca9175e95e4cb47e4147d)

## How It Works

OpenCTI is an open-source cyber threat intelligence (CTI) platform that structures, stores, and visualizes threat data using the [STIX 2.1](https://oasis-open.github.io/cti-documentation/) standard. It lets analysts ingest indicators, observables, TTPs, and adversary profiles from numerous sources, then correlate them through a graph-based knowledge model to surface non-obvious relationships.

The platform has a Community Edition (Apache 2.0) and an Enterprise Edition with additional features gated behind a runtime license check. Enterprise features include playbooks, organizational segregation (PIR), and advanced data sharing.

Data flows through the system in a pipeline: external sources push STIX bundles via connectors to a RabbitMQ message broker, a Python-based worker consumes and forwards them to the GraphQL API, and the Node.js backend normalizes, deduplicates, and indexes them into Elasticsearch/OpenSearch. Redis provides caching, pub/sub for real-time events, and distributed locking. MinIO/S3 stores file uploads and exports.

## Architecture

The repository is a monorepo managed by [Nx](https://nx.dev/) with three primary packages:

| Package | Language | Role |
|---|---|---|
| `opencti-platform/opencti-graphql` | TypeScript (Node.js ≥ 20) | GraphQL API, business logic, data engine |
| `opencti-platform/opencti-front` | TypeScript (React) | SPA frontend with Relay/GraphQL |
| `opencti-worker` | Python | RabbitMQ consumer that dispatches to connectors |
| `client-python` | Python | SDK (`pycti`) for building external connectors |

The backend alone contains ~1,042 TypeScript/JavaScript source files and 65 GraphQL schema files. The frontend has ~2,084 React components. The overall repo spans roughly 5,900+ files.

### Infrastructure Dependencies

OpenCTI requires four external services at runtime:

- **Elasticsearch or OpenSearch** — primary data store (all STIX entities, relationships, internal objects, history)
- **Redis** — session store, cache, pub/sub streams, distributed locks
- **RabbitMQ** — message broker for connector orchestration
- **MinIO / S3** — file storage for uploads, exports, and support packages

PostgreSQL is notably absent from the stack; all persistence goes through the search engine.

## The Spine

### Entry Points

The backend boots from `src/back.js` → `boot.platformStart()`. Initialization follows a strict sequence:

1. Feature flag checks
2. Dependency health checks (ES, S3, RabbitMQ, Redis, SMTP, Python bridge)
3. Lock manager (Redis-based distributed locking via forked processes)
4. Cache manager (Redis)
5. Database schema initialization + migrations
6. Default data seeding (admin user, entity settings, decay rules, notifiers)
7. Module startup (background managers, rule engine, ingestion, sync, playbooks)

The HTTP server (`src/http/httpServer.js`) exposes an Express 5 app with Apollo Server 5 for GraphQL, WebSocket subscriptions (`graphql-ws`), a TAXII server, rolling feeds (CSV/STIX), and a chatbot proxy for AI features.

### Core Data Model

The schema layer in `src/schema/` defines a rich type hierarchy rooted in STIX 2.1:

```
BasicObject
├── StixObject
│   ├── StixCoreObject
│   │   ├── StixDomainObject (ThreatActor, Malware, Indicator, Vulnerability, Report, ...)
│   │   └── StixCyberObservable (IPv4, Domain, File, URL, Artifact, ...)
│   ├── StixMetaObject (MarkingDefinition, Label, KillChainPhase, Identity, ...)
│   └── StixRelationship (StixCoreRelationship, StixSightingRelationship, StixRefRelationship)
└── InternalObject (User, Group, Connector, Settings, Workspace, ...)
```

Each module under `src/modules/` registers its entity types via a module definition system (`schema/module.ts`), specifying attributes, relationships, validators, STIX converters, and overview layout customizations. This is how the ~60+ STIX types and ~20 internal types are composed.

### Data Engine

`src/database/engine.ts` (~4,900 lines) is the largest file and the heart of the data layer. It wraps the Elasticsearch/OpenSearch client and provides:

- **Index management** — separate index patterns for entities, relationships, inferred data, internal objects, history, and deleted objects
- **CRUD operations** — `elPaginate`, `elUpdateElement`, `elIndexElements`, `elDeleteElements`, `elAggregationCount`
- **Connection resolution** — `elUpdateEntityConnections` / `elUpdateRelationConnections` maintain embedded relationship metadata for fast traversal

`src/database/middleware.ts` sits above the engine and implements the full write pipeline: validation, ID generation (STIX standard IDs + internal UUIDs), attribute normalization, confidence enforcement, marking propagation, and relationship side-effect handling. It uses DataLoader for batched reads.

### Rule Engine

The `src/rules/` directory contains ~40 inference rules (each a subdirectory with `*.js` files). These rules run on data changes to automatically generate new relationships. Examples:

- `attribution-indicator-indicates` — infers that an indicator observed on infrastructure used by a threat actor indicates attribution
- `infrastructure-observable-related` — links observables found on shared infrastructure
- `sighting-indicator` — creates sighting relationships when indicators are observed

Rules fire during the middleware write path, meaning every entity creation or update can trigger cascading graph mutations.

### Stream Architecture

Real-time events flow through Redis Streams (`src/database/stream/`). Every create, update, merge, and delete publishes a structured event. External consumers (connectors, sync peers) read from these streams via the `pycti` SDK. The stream system supports SSE for live frontend updates.

## Key Patterns

**Module-driven schema composition.** Each STIX type is a self-contained module that registers itself into a central schema registry. Adding a new entity type means creating a module directory with type definitions, GraphQL schema, converters, and resolvers — no central file to modify. This keeps the codebase navigable despite its size.

**TypeScript/JavaScript coexistence.** The codebase is mid-migration from JS to TS. Core domain logic (`src/domain/`) and database layer files like `engine.ts` are TypeScript, while many modules remain JavaScript. The build uses esbuild for both backend and frontend.

**Embedded relationships for performance.** Rather than relying solely on ES joins or relationship documents, OpenCTI embeds relationship metadata directly on entities. When a `ThreatActor` targets an `Identity`, the actor document gets updated connection fields. This denormalization enables fast paginated queries at the cost of write complexity.

**Background managers.** The `src/manager/` directory contains ~25 long-running services: `indicatorDecayManager` (time-based indicator score decay), `expiredManager` (retention cleanup), `ruleManager` (periodic rule re-evaluation), `historyManager` (activity logging), `notificationManager`, `syncManager`, and others. These run as async loops with configurable intervals.

**Multi-language Python bridge.** The Node.js backend embeds a Python runtime (`src/python/`) for tasks requiring native Python libraries: Suricata rule parsing, YARA matching, Sigma rule conversion, and EQL query parsing. The bridge uses a fork-based execution model.

## Non-Obvious Details

### STIX Graph Without a Graph Database

OpenCTI implements a graph model on top of Elasticsearch — not Neo4j, not a property graph store. Entities and relationships are both indexed as flat documents. Graph traversal is achieved through embedded connection fields and dedicated relationship indices with `from`/`to` fields. Inferred relationships (generated by the rule engine) are written to separate `inferred_*` indices, keeping them distinct from user-authored data.

### Connector Architecture

Connectors are external Python processes that consume from RabbitMQ queues. The worker (`opencti-worker/src/worker.py`) manages a thread pool, consuming messages from priority queues (REALTIME vs. STANDARD) and dispatching to connector instances. Connectors are registered in the platform's internal entity store and can be enabled/disabled per-instance. The `pycti` SDK provides a `OpenCTIApiClient` class and a connector helper that handles configuration, state management, and bundle pushing.

The connector ecosystem is maintained in a separate repository ([OpenCTI-Platform/connectors](https://github.com/OpenCTI-Platform/connectors)) with 80+ connectors for platforms like MISP, MITRE ATT&CK, VirusTotal, Recorded Future, and more.

### AI Integration (NLQ)

The `src/modules/ai/` module implements a Natural Language Query feature. Users type questions in plain English, which are converted to structured platform filters via an LLM. The system supports OpenAI, Azure OpenAI, and Mistral AI as backends, using LangChain for prompt management. A Zod schema defines the output structure for parsed queries, ensuring type-safe filter generation. The feature includes few-shot examples to improve parsing accuracy.

### Indicator Decay Engine

Indicators have a time-based decay model (`src/modules/decayRule/`). Each indicator type can be assigned a decay rule with parameters: lifetime (days), decay points (reactivation thresholds), and revoke score. The `indicatorDecayManager` runs periodically to recalculate scores based on time elapsed since last reaction. This creates a continuous "freshness" signal — indicators naturally degrade unless new sightings or context refresh them.

### Enterprise Feature Gating

Enterprise Edition features are gated at runtime through `isEnterpriseEdition()` checks scattered throughout the codebase. The check reads a boolean from the `Settings` entity in the database. There's no code-level separation — EE code lives in the same repository alongside CE code, differentiated only by these conditional checks. This includes playbooks, PIR (Priority Intelligence Requirements), organizational data sharing, and advanced workflow features.

## Assessment

**Architectural fitness.** OpenCTI's architecture is well-suited to its domain. The STIX-native schema, module system, and rule engine provide a solid foundation for threat intelligence work. The choice of Elasticsearch as a primary store enables powerful full-text search and faceted filtering that analysts expect, though it makes graph operations more expensive than a native graph database would.

**Operational complexity.** The four-service dependency chain (ES + Redis + RabbitMQ + S3) is the platform's biggest operational burden. The Docker Compose setup hides this during development, but production deployments require careful orchestration. The embedded Python bridge adds another runtime dependency.

**Code quality.** The codebase is large (~12,600 lines just in domain files, ~4,900 in the engine) but well-organized. The migration from JS to TS is ongoing. Error handling uses a typed error hierarchy (`src/config/errors.js`). The build system (Nx + esbuild) is fast. Test coverage exists across unit, integration, and e2e levels with Vitest and Playwright.

**Security posture.** RBAC is implemented through capability-based access controls on entity types and operations. SSO is supported via SAML (`@node-saml/passport-saml`), OpenID Connect, and LDAP. Marking definitions enforce data classification. Certificate-based client authentication is available for HTTPS. Rate limiting is applied at the HTTP layer.

> [!warning] The `engine.ts` file at ~4,900 lines is a significant concentration of complexity. It handles index management, CRUD, connection resolution, aggregation, and migration — responsibilities that could benefit from further decomposition.

> [!tip] The rule engine's ability to automatically infer new relationships from existing data is one of OpenCTI's most powerful features for analysts. It surfaces connections that would be difficult to find manually in large datasets.

**Developer experience.** The module system makes extending the platform tractable. GraphQL schema generation uses `graphql-codegen` for type safety between frontend and backend. The `pycti` SDK simplifies connector development. Documentation is comprehensive at [docs.opencti.io](https://docs.opencti.io).

## Related

- [[analyzing-misp]] — MISP is another major open-source threat intelligence platform. OpenCTI takes a graph-centric approach with native STIX2 support, while MISP focuses on event-based correlation.
