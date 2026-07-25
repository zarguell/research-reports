---
title: "Analyzing AiSOC — Open-Source AI-Powered Security Operations Center"
date: 2026-07-25
type: codebase-analysis
status: complete
source: https://github.com/beenuar/AiSOC
tags: [python, typescript, go, security, siem, soar, ai-agents, langgraph, soc, threat-detection, incident-response, neo4j, clickhouse, mitre-attack]
---

# Analyzing AiSOC — Open-Source AI-Powered Security Operations Center

> **Source:** [beenuar/AiSOC](https://github.com/beenuar/AiSOC) @ [`9605121`](https://github.com/beenuar/AiSOC/commit/960512195dd8054f3d037cadb3e9b7b706192468)

## How It Works

AiSOC is a self-hostable, MIT-licensed AI Security Operations Center that ingests security events from 78 data connectors, normalizes them to OCSF, runs them through a detection pipeline (Sigma, YARA, KQL) plus ML-based alert fusion, then routes fused alerts through a LangGraph-powered AI investigation agent that triages, investigates, and recommends responses — all logged to an immutable Investigation Ledger.

The core insight: instead of a closed-source AI SOC where the agent's reasoning is opaque, AiSOC publishes every LLM prompt, tool call, and evidence citation as a replayable ledger. The substrate — the deterministic detection engine, fusion logic, and eval harness — is CI-gated against a 200-incident synthetic dataset with per-template macros, so regressions are caught before they ship. The orchestrator is ~600 lines of Python and small enough to read end-to-end.

The project is a pnpm monorepo (v7.6.0, 1,652 stars on GitHub) with 21 microservices across Python (FastAPI, LangGraph), Go (OCSF ingest, enrichment), TypeScript (Next.js, WebSocket), and Node. The full stack spans PostgreSQL, ClickHouse, OpenSearch, Qdrant, Neo4j, and Redis.

## Architecture

The system follows a classic event-driven pipeline terminated by a stateful API:

```
External Sources (EDR · SIEM · Cloud · Identity)
        │
        ▼
Connectors (78 vendor classes, APScheduler poll loop)
  ─ or direct-write POST /api/v1/alerts/submit
        │
        ▼
services/ingest (Go) — OCSF normalization, ATT&CK tagging, enrichment
        │
        ▼
Apache Kafka spine
        │
   ┌────┼──────────┬──────────────┐
   ▼    ▼          ▼              ▼
Fusion  UEBA    Detections    Threat Intel
(ML +   (Z-     (Sigma YARA   (TAXII MISP
 RBA)   score)   KQL EQL DAC)  OTX KEV)
   │    │          │              │
   └────┴──────────┴──────────────┘
               │
      PostgreSQL · ClickHouse · OpenSearch
      Qdrant (vectors) · Neo4j (graph) · Redis
               │
        FastAPI Core API (port 8000)
               │
   ┌───────────┼──────────┬──────────────┐
   ▼           ▼          ▼              ▼
Next.js Web   Agents    Realtime WS     MCP Server
(console +    (LangGraph, (WebSocket    (13 tools
 Responder     port 8001)  + Web Push)   for IDE)
 PWA)
```

Key differentiator: the **Investigation Ledger** is a first-class architectural component, not an afterthought. Every agent step is stored with prompt hash, response hash, evidence references, and cost — replayable per case in the console.

### Storage Tier — deliberate polyglot

| Store | Role |
|-------|------|
| **PostgreSQL** | Primary state — cases, alerts, users, connectors, auth, rules, playbooks |
| **ClickHouse** | Event lake — raw and normalized OCSF events, analytics |
| **OpenSearch** | Search and aggregation over events and alerts |
| **Neo4j** | Knowledge graph — entities, relationships, attack paths, blast radius |
| **Qdrant** | Vector store — RAG for agent context (full ATT&CK bundle pre-loaded) |
| **Redis** | Dedup bloom filters, entity risk TTL, UEBA signal cache |

## The Spine

Trace one fused alert through the system end-to-end:

### 1. Connector poll → Kafka
`services/connectors/app/` runs an APScheduler loop. Each connector subclass (e.g., `SplunkConnector`) implements `fetch_alerts()`, normalizes to a common schema, and pushes via `services/ingest`. 78 classes, registered in a `_CONNECTOR_CLASSES` dict.

The **direct-write path** (for demos) skips Kafka entirely: `POST /api/v1/alerts/submit` synthesises an alert from raw OCSF events in the API service, no broker required.

### 2. Ingest → OCSF → Kafka
`services/ingest` (Go) normalizes raw events to the OCSF schema, tags ATT&CK techniques (in-process index), runs Shodan enrichment (TTL-cached), and correlates CISA KEV matches. Output lands on two Kafka topics: `ocsf.events` and `vulnerability.matches`.

### 3. Fusion → FusedAlert
`services/fusion` (Python) consumes both topics and orchestrates a pipeline:
- **Deduplicator** — simhash-based via Redis
- **Correlator** — entity + ATT&CK technique correlation across events
- **MLScorer** — Isolation Forest outlier detection + LightGBM ranker
- **AttackChainGrouper** — Tactic-order chains for multi-stage incidents
- **EntityRiskEngine** — time-decayed entity risk scoring (RBA)
- **ConfidenceScorer** — assigns `high/medium/low` with evidence chain
- **NarrativeBuilder** — deterministic (no LLM on read) correlation narrative

### 4. API → Investigation → Ledger
`services/api` (FastAPI) receives fused alerts. When a case is created, `services/agents` runs a **two-tier LangGraph**:

**Tier 1 (Fast-track triage):** `services/agents/app/graph/workflow.py`
```
auto_triage ─┬─ (high-confidence FP/benign) ──► END
              └─ (else) ──► triage ──► enrichment ──► investigation
                        ──► attack_path (Neo4j blast radius) ──► END
```

**Tier 2 (Deep investigation):** `services/agents/app/investigator/orchestrator.py`
```
START → recon → forensic → responder → report_writer → END
```

Each tier wraps LangGraph nodes with OpenTelemetry spans, a `_safe_node` exception catcher (so one failing agent doesn't kill the whole graph), and the `InvestigationLedger` persistence layer.

### 5. Surface (Console / MCP / Slack)
The `apps/web` Next.js console renders the Investigation Rail, `/hunt` workbench, `/explore` data explorer, and Responder PWA. `services/mcp` exposes 13 tools for IDE-side AI agents. `services/slack-bot` handles HMAC-signed ChatOps approvals.

## Key Patterns

### ~600-line orchestrator, not a framework
The LangGraph orchestrator is deliberately small — `services/agents/app/graph/workflow.py` is 117 lines plus ~400 in the investigator orchestrator. The agent implementations (recon, forensic, responder, report_writer) are standalone async functions that receive and return a Pydantic `InvestigatorState` dict. This makes it trivial to swap models, add steps, or audit.

### State-as-dict threading
LangGraph uses dict state; AiSOC wraps it in Pydantic models (`InvestigationState`, `InvestigatorState`). Every node function converts `dict → Pydantic → mutate → dict`, keeping the state schema validated at every transition. The `_state_dict()` / `_from_dict()` pair is the only adapter, repeated mechanically across nodes.

### `_safe_node` wrapper for fault isolation
Every investigator node is wrapped in `_safe_node()` (a decorator) that catches exceptions, records them in the state as `failed`, logs to OpenTelemetry, and continues the graph. One agent failing doesn't crash the pipeline — the final state includes the error for debugging.

### Dual-path connector architecture
Connectors have a production path (Kafka spine via `services/ingest`) and a direct-write path (`POST /api/v1/alerts/submit`). The direct path exists so a `git clone` + `aisoc submit` lights up the console with zero infrastructure. The architecture doc explicitly names this as "founder-flow" — pragmatic dual-path design.

### Credential vault with read-path isolation
`services/api` holds the encrypt authority for `AISOC_CREDENTIAL_KEY`. `services/connectors` ships a vendored `decrypt_dict()` that reads without write permission. Key rotation uses `MultiFernet`. The `Test connection` button skips the vault entirely (forwards raw form values to a stateless endpoint), so bad credentials never touch the DB.

### Evaluation harness as CI gate
Five suites gate every PR to `main`/`develop`:
- **Alert reduction** — measured against a fixed 1,000-alert stream
- **MITRE accuracy, investigation completeness, response quality** — substrate self-consistency over a 200-incident (55-template) dataset with per-template macros
- **Synthetic telemetry coverage** — validates the backing corpus

All deterministic, no LLM, runs in milliseconds. Wet eval (live agent with real LLM calls) runs weekly. Each badge on the README is a live CI endpoint.

### Pseudonymization at the boundary
The `redactor.py` in agents replaces internal IPs/emails/hostnames/secrets with opaque tokens (`USER_1`, `HOST_2`) before they reach the LLM provider. The ledger stores both raw and tokenized views; the console re-hydrates locally. External indicators (public domains/IPs) are preserved.

## Non-Obvious Details

### The eval harness is the truth table
The README's claims about detection count (947 executable, 869 native) link to a `docs/detections/truth-table.md`. Every product claim has a corresponding gate in CI — the `CLAIM_TO_GATE_MATRIX.md` lists 33 GATED / 7 PARTIAL / 0 NO GATE. This is unusually rigorous for an open-source security project.

### Fusion narrative is deterministic, not LLM-generated
The Investigation Rail's correlation narrative is built by `services/fusion/app/services/narrative.py` using structured `NarrativeInputs` — no LLM call on read. The same builder is vendored into `services/api/app/_vendor/` for the API's lazy-fill path. Fusion-time narrative is frozen at alert creation; the LLM agent writes the _deep_ investigation report separately.

### Playbooks are schema-validated YAML
`playbook.schema.json` is a standalone JSON Schema that validates playbooks. The schema lives at the repo root, and CI runs `scripts/validate_playbooks.py` on every PR. Detection rules follow the same pattern — Sigma YAML with positive/negative fixtures.

### Market-driven v1.5 expansion
The architecture doc explicitly names G2 and Gartner Peer Insights as the source of v1.5's feature additions (5 new agents, 8 new pages, 4 new API surfaces, 10 connectors). This is refreshingly transparent product management — most projects don't cite their competitive research in architecture docs.

### The wedge CLI (`aisoc-lite`) is a separate package
`packages/aisoc-lite/` is a standalone CLI that scores alerts without any LLM dependency — it uses a deterministic engine ported from the production triage scorer. `npx aisoc triage --demo` runs in 0.1s, no keys, no clone. This is the on-ramp for anyone who wants to evaluate the noise-reduction math before deploying the full stack.

## Assessment

**Strengths:**
- **Auditability as a feature.** The Investigation Ledger, prompt hashing, evidence chain, and replayability are architectural primitives, not add-ons. This is the strongest argument for open-source AI SOC.
- **CI-gated evaluation.** A 200-incident synthetic dataset with per-template macros, gated on every PR, is rare in any security project. The claim-to-gate matrix makes it verifiable.
- **Pragmatic architecture.** Dual-path connector (Kafka vs direct-write), `_safe_node` error isolation, vendored narrative builder, and read-path-isolated credential vault all show production experience.
- **Small orchestrator.** The ~600-line LangGraph agent is easy to understand, patch, or replace. You could swap in a different agent framework without touching the rest.
- **Clear data residency model.** Three modes (air-gapped, pseudonymized, raw) with documented trade-offs and a CI gate for the redactor.

**Concerns:**
- **Operational complexity.** 21 microservices, 6 storage backends, Kafka, and a full Kubernetes Helm chart is a lot for a self-hosted project. The demos and `aisoc-lite` wedge CLI mitigate this, but production deployment is serious infrastructure.
- **ML model reliance.** The fusion pipeline's MLScorer (Isolation Forest + LightGBM) and UEBA baseline both need training data and tuning. How well these work with cold-start or small-tenants is undocumented.
- **Connector maintenance.** 78 vendor-specific connector classes is a significant ongoing burden. Each vendor API change breaks a connector — there's no vendor-neutral protocol layer abstracting the polling.
- **Planned vs. shipped.** The README has many "lands in v8.0" markers (npm publish, aisoc-action Marketplace, etc.). v8.0 wave-2 is in flight. Some polish features (screenshots, MP4 walkthrough) are SVG placeholders.

**Recommendations:**
- For evaluation: start with `npx aisoc triage --demo` (the wedge CLI) to assess noise-reduction math. Then try the Docker compose demo to see the investigation ledger. Only deploy the Helm chart after proving the value with synthetic data.
- The project is strongest in environments that already have SIEM data and want AI-assisted triage — it's probably overkill for security teams that are still building basic detection coverage.
- Among the self-hosted alternatives ([[analyzing-wazuh|Wazuh]], the defunct SIEMonster, commercial open-core), AiSOC's investigation ledger and CI-gated eval are unique. Everyone publishes detection rules; nobody else publishes the agent decision trail as an immutable, replayable artifact.

## Related

- [[analyzing-wazuh|Analyzing Wazuh]] — Open-source SIEM/XDR platform (the primary self-hosted alternative to AiSOC)
- [[analyzing-velociraptor|Analyzing Velociraptor]] — DFIR platform that complements AiSOC's investigation capabilities
- [[analyzing-misp|Analyzing MISP]] — Threat intelligence platform that feeds into AiSOC's threat intel pipeline
