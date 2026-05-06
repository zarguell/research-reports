---
title: "Analyzing LiteLLM: The Unified AI Gateway for 100+ LLM Providers"
tags:
  - AI infrastructure
  - API gateway
  - LLM orchestration
  - OpenAI-compatible API
  - load-balancing
date: 2026-05-06
---

## Introduction

LiteLLM is an open-source Python library that serves as a unified interface ("AI gateway") for calling 100+ LLM APIs using the OpenAI chat completions format. Founded by Krrish and Ishaan Berri, it abstracts away provider-specific quirks — authentication, request/response transformation, rate limiting, cost tracking, retries — behind a single consistent SDK and proxy server. The project has become a foundational piece of infrastructure for teams that need to route, balance, observe, and govern LLM traffic across heterogeneous model deployments.

This report examines the codebase at commit `6ff668c7aa01a73738ed39aa64913a089a183565`, analyzing its architecture, key components, and operational characteristics.

## Architecture Overview

LiteLLM is structured around three layers: the **Python SDK** (`litellm/`), the **AI Gateway/Proxy** (`litellm/proxy/`), and the **Router** (`litellm/router.py`). The SDK provides the core LLM-calling functionality. The Proxy wraps the SDK with HTTP endpoints, authentication, rate limiting, and management REST APIs. The Router provides load balancing, fallback orchestration, and deployment management on top of the SDK.

```
User Request → Proxy Server (FastAPI) → Router → SDK → Provider API
                ├── Auth & AuthZ
                ├── Rate Limiting
                ├── Guardrails
                ├── Cost Tracking
                ├── Caching
                └── Observability
```

### Technology Stack

- **Python 3.9+** — the entire codebase is Python
- **FastAPI** — proxy server (`proxy_server.py` is the main application)
- **Pydantic v2** — request/response validation
- **httpx / aiohttp** — HTTP client for provider calls
- **Prisma** — ORM for PostgreSQL (multi-tenant data)
- **Redis** — caching, rate limiting, spend tracking, cooldowns
- **tiktoken** — token counting for cost calculation

## The SDK Layer

### Entry Points (`litellm/main.py`, 7,853 lines)

The SDK's public API is `litellm.completion()`, `litellm.acompletion()`, `litellm.embedding()`, and `litellm.aembedding()`. These are the functions users import directly. `main.py` is the largest single file in the project and handles:

1. **Parameter normalization** — maps provider-specific parameter names (e.g., `maxTokens` → `max_tokens`, `temperature` → `temperature`) into a canonical form via `get_optional_params()`
2. **Provider resolution** — `get_llm_provider()` in `utils.py` determines which provider a model belongs to based on the model name prefix (e.g., `gpt-4` → `openai`, `claude-3` → `anthropic`)
3. **Streaming vs. non-streaming dispatch** — routes to either `_acompletion()` or `_completion()` internally
4. **Fallback chain** — if `litellm.model_fallbacks` is configured and a call fails, the SDK automatically tries the next model in the fallback list via `async_completion_with_fallbacks()`
5. **Mock responses** — supports test mode with `mock_response`, `mock_delay`, `mock_timeout`

The `completion()` function (sync) wraps `acompletion()` (async) via `asyncio.run_in_executor()`, which means the sync API is non-blocking at the executor level.

### HTTP Orchestration (`litellm/llms/custom_httpx/`)

The HTTP layer is organized around two classes:

- `BaseLLMHTTPHandler` — base class with retry logic, timeout handling, and response parsing
- `LLMHTTPHandler` — concrete implementation; uses `httpx.AsyncClient` for async HTTP calls

This is where the actual provider HTTP calls are made. The handler is instantiated per-request and manages connection pooling, retries, and error classification.

### Provider Adapters (`litellm/llms/{provider}/`)

Each supported LLM provider has a directory under `litellm/llms/` containing:

- `chat/` — transforms OpenAI-format requests into the provider's format, and the provider's response back into OpenAI format
- `transformation.py` — the core transformation logic
- `__init__.py` — exports the relevant classes

This adapter pattern is the mechanism by which LiteLLM normalizes 100+ providers. The transformation layer maps the OpenAI chat completions schema to/from each provider's proprietary schema. For example:

- **Anthropic** needs `messages` converted to `prompt` with system prompt extracted
- **Azure OpenAI** needs `api-version`, `azure-api-key`, and a different base URL
- **AWS Bedrock** uses a completely different request envelope with `messages` encoded as JSON in a `body` field
- **Google Vertex AI** needs auth via service account and a different inference endpoint

The provider registry in `litellm/llms/` lists all supported providers with their model families, base URLs, and authentication requirements.

### Utilities (`litellm/utils.py`, 9,647 lines)

`utils.py` contains the helper functions that `main.py` depends on:

- `get_llm_provider()` — model → provider resolution
- `get_optional_params()` — parameter normalization
- `get_litellm_params()` — extracts LiteLLM-specific params (not passed to providers)
- `exception_type()` — classifies HTTP errors and SDK errors into LiteLLM exception types (`RateLimitError`, `AuthenticationError`, `Timeout`, etc.)
- `EmbeddingTokens` / token counting utilities

### Streaming Handler (`litellm/litellm_core_utils/streaming_handler.py`, 2,430 lines)

Handles SSE (Server-Sent Events) streaming responses from providers. The `StreamingLLMResponse` class:

- Parses SSE `data:` lines from provider responses
- Handles chunked transfer encoding
- Assembles `delta` objects for the OpenAI streaming format
- Manages `completion_start_time` for time-to-first-token measurement
- Handles `usage` field emission at the end of streams (some providers return usage in the final chunk)

The streaming handler is critical for real-time token streaming and powers LiteLLM's latency-based routing (time-to-first-token is a key metric).

### Cost Calculator (`litellm/cost_calculator.py`)

LiteLLM maintains a per-token pricing table for all supported models. The `calculate_cost()` function takes:

- `prompt_tokens` — input token count
- `completion_tokens` — output token count
- `model` — model identifier

And returns the total cost using the pricing table. The table is a large dictionary mapping model names to `(prompt_cost_per_1k, completion_cost_per_1k)` tuples. The calculator also handles special cases like per-character billing for certain providers and different pricing tiers for context windows.

## The Router (`litellm/router.py`)

The Router is the load-balancing and orchestration layer that sits between the proxy and the SDK. It is a major component: approximately 2,500+ lines handling deployment management, routing strategies, health checks, and cache coordination.

### Deployment Model

The Router accepts a `model_list` — a configuration list of model deployments, each with:

```python
{
    "model_name": "gpt-4",
    "litellm_params": {
        "model": "gpt-4-0613",
        "api_key": "...",
        "rpm": 500,       # requests per minute limit
        "tpm": 100000,    # tokens per minute limit
    },
    "model_info": {
        "id": 1,
        "model_group": "gpt-4",
        "rpm": 500,
        "tpm": 100000,
    }
}
```

Multiple deployments can share the same `model_name`, forming a **model group**. Requests to `model_name="gpt-4"` are distributed across all deployments in the group.

### Routing Strategies (`litellm/router_strategy/`)

The Router supports multiple routing strategies, pluggable via `RoutingStrategy` enum:

| Strategy | File | Behavior |
|---|---|---|
| `simple-shuffle` | `simple_shuffle.py` | Random pick; weighted by `weight`/`rpm`/`tpm` if provided |
| `latency-based-routing` | `lowest_latency.py` | Picks deployment with lowest average latency per token; for streaming uses time-to-first-token |
| `usage-based-routing` | `usage_allocation.py` | Distributes load evenly by remaining TPM/RPM budget |
| `cost-based-routing` | `cost_allocation.py` | Routes to cheapest model that can handle the request |
| `least-busy` | `least_busy.py` | Picks deployment with fewest concurrent requests |

**Lowest Latency Strategy** (`lowest_latency.py`, 621 lines) — this is the most sophisticated strategy. It maintains a rolling window of latency observations per deployment, updated via a `LowestLatencyLoggingHandler` callback that hooks into LiteLLM's success/failure logging. On each request:

1. Filters out deployments exceeding their RPM/TPM limits
2. Computes average latency from the rolling window
3. Applies a latency buffer (`lowest_latency_buffer`) as a tolerance threshold
4. Adds a 1000-second penalty for deployments that timed out (via `async_log_failure_event`)
5. Picks the deployment with the lowest adjusted latency

For streaming requests, it uses **time-to-first-token** instead of total response time, since that's what users actually experience. The strategy maintains a 10-element rolling window of latency observations per deployment, keyed by deployment `id` within a model group map.

**BaseRoutingStrategy** (`base_routing_strategy.py`, 261 lines) — abstract base class providing:
- Redis pipeline batching for incrementing spend counters
- Periodic sync task (configurable interval, default 60s) that pushes in-memory increments to Redis
- Handles the dual-cache consistency problem: in-memory updates are immediately applied but Redis writes are batched for performance

### Health Checks

The Router manages a health check system. Deployments that fail repeatedly are placed in **cooldown** — they are excluded from routing for a configurable period. Health state is stored in the dual cache (Redis + in-memory), so all instances in a multi-instance deployment share health state.

### Cache Layer

The Router uses `DualCache` (in-memory + Redis) for:
- TPM/RPM tracking per deployment
- Deployment cooldown state
- Latency observations per deployment
- Client response caching

The cache key pattern uses deployment IDs and model group names, enabling multi-instance coordination via Redis while maintaining sub-millisecond in-memory read latency.

## The AI Gateway / Proxy Server (`litellm/proxy/`)

### `proxy_server.py` (FastAPI Application)

This is the main proxy application, approximately 3,000+ lines. The FastAPI app (`app = FastAPI(...)`) is initialized in `proxy_server.py` and assembles the full application from dozens of sub-routers. At startup (`proxy_startup_event`), it:

1. Initializes the Prisma database client and runs migrations
2. Loads the Router from config file and/or database
3. Initializes Redis connections
4. Loads guardrails from config and database
5. Sets up background scheduled jobs (spend writer, budget resetter, health check flusher)
6. Initializes the Prometheus middleware
7. Starts the adaptive router flusher loop

The proxy server includes 20+ FastAPI sub-routers for different endpoint groups:

- `/chat/completions` — via `route_llm_request.py`
- `/embeddings` — via `embedding_endpoints/`
- `/images/generations` — via `image_endpoints/`
- `/audio/transcriptions` — via `audio_endpoints/`
- `/rerank` — via `rerank_endpoints/`
- `/batches` — via `batches_endpoints/`
- `/v1/responses` — via `response_api_endpoints/`
- Health: `/health`, `/health/lite`, `/health/llm`
- Management: `/key`, `/team`, `/user`, `/spend`, `/model`, `/config`
- Observability: `/metrics` (Prometheus), `/logs`
- Pass-through: `/passthrough/*` for forwarding to arbitrary endpoints

The middleware stack includes `InFlightRequestsMiddleware` (limits concurrent in-flight requests) and `PrometheusAuthMiddleware`.

### Request Routing (`proxy/route_llm_request.py`, 589 lines)

This is the core request processing pipeline. When a chat completions request arrives:

1. **Authentication** — validates the API key via `user_api_key_auth.py`
2. **Guardrail pre-call** — runs pre-call guardrails (PII detection, prompt injection detection, content filtering)
3. **Budget check** — verifies the user/team still has budget remaining
4. **Rate limit check** — enforces RPM/TPM limits from cache
5. **Prompt template processing** — applies prompt templates/macros
6. **LLM call** — calls the Router's `acompletion()`
7. **Guardrail post-call** — runs post-call guardrails on the response
8. **Cost tracking** — calculates and records response cost
9. **Logging** — fires all registered logging callbacks

### Authentication (`proxy/auth/user_api_key_auth.py`, 2,491 lines)

The auth system is comprehensive. It validates API keys passed as `Bearer` tokens or `x-api-key` headers:

1. **Key lookup** — checks Redis cache first, then Prisma DB
2. **Key validation** — verifies key exists, is not expired, is not revoked
3. **User/Team lookup** — loads user and team objects, checks `user_id`/`team_id`
4. **Role check** — verifies the caller has the required role (`admin`, `app_owner`, `internal_user`, `external_user`)
5. **Permission check** — verifies the key has permission for the requested model/endpoint
6. **Budget check** — verifies the user/team has remaining budget
7. **Fallback check** — if the primary model fails, checks if fallback models are allowed
8. **JWT/OAuth2 support** — supports JWT tokens (signed with a secret) and OAuth2 authorization codes

API keys are stored in Prisma with hashed values. The system supports:
- **Virtual keys** — teams can create sub-keys with restricted permissions
- **Key expiration** — keys can have an `expires_at` timestamp
- **Spending limits** — per-key and per-team budgets
- **RPM/TPM limits** — per-key rate limiting
- **Model restrictions** — keys can be restricted to specific model groups

### Cost Tracking (`proxy/utils.py`, 5,950 lines + `proxy/hooks/proxy_track_cost_callback.py`)

Cost tracking is implemented through the `_ProxyDBLogger` callback class that hooks into LiteLLM's logging system. On every successful response:

1. `calculate_cost()` computes the response cost from token counts and model pricing
2. `_increment_spend_counters()` updates in-memory counters and queues Redis increments
3. `DBSpendUpdateWriter` batches DB writes — writes to PostgreSQL `spend_logs` table every 60 seconds rather than per-request (critical for throughput)
4. The Prisma schema tracks spend at user, team, key, end-user, and tag levels

The spend tracking supports:
- **Reserved budgets** — pre-reserve budget before a request to prevent overspend
- **Window-based limits** — daily/weekly/monthly spend caps
- **Per-model pricing** — custom pricing tables for enterprise deployments
- **Tag-based tracking** — arbitrary string tags on requests for department/cost-center attribution

### Guardrails System (`proxy/guardrails/`)

LiteLLM has a pluggable guardrail architecture. Guardrails are callbacks that run at pre-call, during-call, and post-call stages. The `GuardrailRegistry` manages guardrail registration and persistence. The `InMemoryGuardrailHandler` initializes guardrails and adds them to the callback manager.

Guardrail hook implementations are in `guardrail_hooks/` with 45+ integrations:

| Category | Integrations |
|---|---|
| **PII/Content Safety** | Presidio (1,396 lines), Lakera AI (v1 + v2), AWS Bedrock Guardrails, PromptGuard, Javelin, Pillar, CrowdStrike AI/DR, Qualifire, Panw Prisma AirS |
| **Secret Detection** | `HIDE_SECRETS` built-in (scans for API keys, tokens, credentials in prompts/responses) |
| **LLM-as-Judge** | `llm_as_a_judge` — uses a separate LLM call to evaluate prompts/responses |
| **Tool Control** | `tool_permission` (857 lines) — restricts which tools/functions can be called |
| **Custom** | `custom_guardrail` — user-defined Python guardrail implementations |
| **Enterprise** | GraySwan, Pangea, Onyx, XECGuard, Zscaler AI Guard, DynamicAI, BizSafe, EnkryptAI, IBM Guardrails, Apache APISIX, AKTO Security, AIM, Custom Code |

Guardrails are discovered via dynamic import scanning — `guardrail_registry.py` walks the `guardrail_hooks/` directory, looking for `__init__.py` files that export `guardrail_initializer_registry` or `initialize_guardrail` functions.

### Rate Limiting (`proxy/hooks/`)

Rate limiting is implemented as FastAPI middleware and pre-call hooks. The `InFlightRequestsMiddleware` limits concurrent in-flight requests per key or globally. RPM/TPM limits are enforced by checking Redis counters before each request. If a limit is exceeded, the request is rejected with HTTP 429.

Rate limit state lives in Redis (shared across proxy instances) with in-memory fallback for single-instance deployments. The dual-cache approach ensures sub-millisecond limit checks while supporting horizontal scaling.

### Caching (`litellm/caching/`)

LiteLLM supports two levels of caching:

1. **LLM Response Caching** (`caching/caching_handler.py`, `caching/caching.py`) — caches LLM responses by hash of `(model, messages, params)`. Supports Redis backend. TTL is configurable. Reduces cost and latency for repeated prompts.

2. **Router Cache** (`caching/redis_cache.py`, 1,710 lines + `caching/dual_cache.py`, 539 lines) — the `DualCache` class provides:
   - Synchronous in-memory cache (for hot paths)
   - Async Redis cache (for multi-instance coordination)
   - Automatic cache warming on startup
   - TTL management per key type
   - `async_increment_pipeline` for batch Redis increments

The `RedisCache` class wraps `redis.asyncio` with serialization/deserialization. It supports hash operations (`HINCRBYFLOAT`) for atomic increment of spend counters and `SCAN` for pattern-based key iteration.

### Observability Integrations (`litellm/integrations/`)

LiteLLM ships with 70+ integrations for logging and observability:

| Category | Integrations |
|---|---|
| **LLM Platforms** | LangSmith, Langfuse, Lunary, Weights & Biases, Galileo, AgentOps, Traceloop |
| **Tracing** | OpenTelemetry, Langtrace, OpenMeter |
| **Monitoring** | Prometheus (with `prometheus_helpers/` for metrics helpers), Datadog, Logfire, Arize |
| **Evaluation** | Braintrust, DeepEval |
| **Feedback** | Slack alerting, Email alerting |
| **Storage** | S3, GCS, Azure Storage, DynamoDB, Supabase, SQL (SQS, GCS Pub/Sub) |
| **Feature Flags** | Dynamite AI |
| **Product Analytics** | Posthog, Lago (usage-based billing) |
| **Error Tracking** | Capture exception logging |

Each integration implements `CustomLogger` (or `CustomCallback`) and hooks into LiteLLM's logging events: `log_success_event`, `log_failure_event`, `log_retry_event`, `log_streaming_metrics`. The logging system (`litellm_core_utils/litellm_logging.py`) manages these callbacks and fires them asynchronously after each LLM call.

### Prometheus Metrics

The Prometheus integration (`integrations/prometheus.py`) exposes a comprehensive metrics endpoint:

- `litellm_requests_total` — total requests by model, provider, status
- `litellm_request_duration_seconds` — latency histogram
- `litellm_deployment_latencies` — per-deployment latency percentiles
- `litellm_tokens_total` — prompt/completion token counts
- `litellm_spend_total` — cumulative spend by model, team, user
- `litellm_rpm` / `litellm_tpm` — current rate metrics
- `litellm_guardrail_triggered_total` — guardrail trigger counts

The `PrometheusServices` module provides a separate service for scraping and exposing deployment-level metrics in Kubernetes environments.

## Database Schema (Prisma)

LiteLLM uses PostgreSQL via Prisma ORM. The schema (`schema.prisma`) defines a multi-tenant data model:

- **`User`** — authenticated users (hashed passwords, roles, spend limits)
- **`APIKey`** — virtual API keys (hashed, with permissions, RPM/TPM limits, expiration)
- **`Team`** — organizational grouping of users and keys (shared budgets, members)
- **`Project`** — sub-grouping within a team (for environment separation like dev/staging/prod)
- **`EndUser`** — end-user tracking (for tracking per-end-user spend/usage in customer-facing apps)
- **`LiteLLMConfig`** — stores proxy configuration snapshots
- **`LiteLLMGuardrailTable`** — guardrail definitions
- **`LiteLLMSpendLogs`** — individual request logs (batched writes via `DBSpendUpdateWriter`)
- **`LiteLLMBatchTable`** — batch job metadata

Key relationships:
- `APIKey` belongs to a `User` and optionally a `Team`
- `EndUser` is associated with a `Team`
- `Project` belongs to a `Team`
- `SpendLogs` reference `APIKey`, `User`, `Team`, `EndUser`, and `Project` for granular attribution

## Deployment

### Docker

Official Docker images are published to `ghcr.io/berriai/litellm`. The image is based on Python and includes LiteLLM with all dependencies. Entrypoints:

- `docker/entrypoint.sh` — development mode startup
- `docker/prod_entrypoint.sh` — production mode with Prometheus metrics
- `docker/build_admin_ui.sh` — builds the admin dashboard
- `docker/install_auto_router.sh` — installs model configuration

All published images are signed with `cosign` using a pinned commit key (`0112e53046018d726492c814b3644b7d376029d0`).

### Helm Chart (`deploy/charts/litellm-helm/`)

The Helm chart (version 1.1.0, app version v1.80.12) provides Kubernetes deployment:

- **Deployment** — with configurable replica count, environment variables, and resource limits
- **Horizontal Pod Autoscaler (HPA)** — for CPU/memory-based scaling
- **KEDA** — for event-driven scaling (queue depth, custom metrics)
- **Pod Disruption Budget (PDB)** — ensures availability during updates
- **ServiceMonitor** — for Prometheus Operator scraping
- **ConfigMap** — for `config.yaml` injection
- **Secrets** — for `DATABASE_URL`, Redis credentials, master key
- **Ingress** — with TLS configuration
- **ServiceAccount** — with optional RBAC
- **Prisma Migrations Job** — runs `prisma migrate deploy` on upgrade
- **Dependencies** — PostgreSQL (Bitnami chart) and Redis (Bitnami chart) as optional sub-charts

### Configuration

LiteLLM is configured via `config.yaml` (or environment variables). Key configuration sections:

```yaml
model_list:
  - model_name: gpt-4
    litellm_params:
      model: gpt-4-0613
      api_key: os.environ/AZURE_API_KEY
      api_base: https://example.openai.azure.com
      rpm: 500

litellm_settings:
  drop_params: true
  set_verbose: true
  json_logs: false

general_settings:
  master_key: os.environ/MASTER_KEY
  database_url: os.environ/DATABASE_URL
  redis_host: os.environ/REDIS_HOST
```

Environment variables follow `LITELLM_*` prefix convention and are loaded via `python-dotenv`.

## Code Quality and Engineering Practices

LiteLLM follows the **Google Python Style Guide**. CI enforces:

- **Black** — code formatting (line length 88)
- **Ruff** — linting (targets PLR0915 for function length, PLR2004 for magic values)
- **MyPy** — strict type checking
- **Circular import detection** — `PYTHONPATH=.. python -c "import litellm"` validates no circular deps
- **Import safety checks** — verifies all imports are safe

The codebase is actively maintained with a high velocity of contributions. The repository is MIT licensed, with some enterprise features under the LiteLLM Commercial License.

## Summary of Key Design Patterns

1. **Adapter Pattern** — 100+ provider adapters transform OpenAI-format requests/responses to/from each provider's proprietary format. Adding a new provider means adding a new `llms/{provider}/` directory.

2. **Strategy Pattern** — pluggable routing strategies (simple-shuffle, latency-based, usage-based, cost-based) enable different load-balancing policies without changing the routing core.

3. **Dual-Cache Pattern** — in-memory cache for hot paths + Redis for multi-instance coordination. Immediate in-memory updates + batched Redis writes minimize latency while maintaining consistency.

4. **Hook/Callback Pattern** — LiteLLM's callback manager fires hooks at pre-call, during-call, post-call, streaming-metrics, and failure stages. Guardrails, logging, and cost tracking are all implemented as callbacks.

5. **Background Batch Writing** — DB writes (spend logs) are batched in a background writer to avoid per-request latency overhead. The `DBSpendUpdateWriter` flushes every 60 seconds.

6. **Dynamic Discovery** — guardrail integrations are discovered at startup by scanning the `guardrail_hooks/` directory for `__init__.py` files with registry exports. This enables plugin-style addition of new integrations without modifying core code.

7. **Fallback Chain** — the SDK supports model fallback chains: if one model fails (rate limit, timeout, error), it automatically retries with the next model in the chain.

## Strengths and Trade-offs

**Strengths:**
- **Massive provider coverage** — single SDK call works across 100+ providers with consistent interface
- **Production-hardened** — comprehensive auth, rate limiting, cost tracking, caching, and observability
- **Multi-tenant** — team/key/user hierarchy with granular spend limits
- **Observable** — 70+ integrations for tracing, logging, and monitoring
- **Horizontal scaling** — Redis-backed state enables multi-instance deployments

**Trade-offs:**
- **Complexity** — the codebase is large and deeply nested (7,853-line main.py, 2,491-line auth, 5,950-line utils)
- **Prisma coupling** — the proxy is tightly coupled to Prisma for persistence; alternative backends are not supported
- **Monolithic proxy** — the proxy_server.py aggregates 20+ routers; modularization is limited
- **Dynamic imports** — guardrail discovery via importlib at startup adds startup latency and potential import-time failures
- **Dual-write consistency** — the dual-cache pattern with batched Redis writes introduces eventual consistency; in edge cases (crash between in-memory write and Redis flush), spend counters may drift

## Conclusion

LiteLLM represents a pragmatic, production-focused approach to LLM infrastructure. Its core value proposition — calling any LLM with a single OpenAI-compatible interface — addresses a real pain point as teams adopt heterogeneous model portfolios. The proxy layer adds the operational controls that enterprises need: authentication, rate limiting, cost attribution, guardrails, and observability.

The codebase demonstrates that it was grown incrementally by a small team solving real problems, rather than designed up-front. The result is feature-rich but structurally complex. For teams already invested in LiteLLM, the architecture is well-understood and the community is active. For teams evaluating it fresh, the key question is whether the operational control plane (proxy, Prisma, Redis) fits their deployment model, or whether a lighter-weight approach — using only the SDK — would suffice.

---

*Report generated from codebase analysis of BerriAI/litellm at commit `6ff668c7aa01a73738ed39aa64913a089a183565`. LiteLLM version v1.80.12.*
