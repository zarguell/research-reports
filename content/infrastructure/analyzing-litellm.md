---
title: "Analyzing LiteLLM: AI Gateway for 100+ LLM Providers"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/BerriAI/litellm @ [6ff668c](https://github.com/BerriAI/litellm/commit/6ff668c7aa01a73738ed39aa64913a089a183565)
tags: [python, ai-gateway, llm, multi-provider, load-balancing, guardrails, fastapi, observability, open-source]
---

# Analyzing LiteLLM: AI Gateway for 100+ LLM Providers

> **Source:** [BerriAI/litellm](https://github.com/BerriAI/litellm) @ [`6ff668c`](https://github.com/BerriAI/litellm/commit/6ff668c7aa01a73738ed39aa64913a089a183565) | Python 3.10+ | ~43K GitHub stars | 119 LLM provider directories

## Overview

LiteLLM is a dual-mode project: a Python SDK that provides a unified interface for calling 100+ LLM APIs using the OpenAI request/response format, and an AI Gateway (proxy server) that wraps the SDK with authentication, rate limiting, spend tracking, guardrails, and multi-tenant management. The project solves the fundamental fragmentation problem in the LLM ecosystem — every provider has its own SDK, auth mechanism, and API schema — by normalizing everything through a translation layer that sits between the caller and the provider.

The codebase is large and structured. At commit `6ff668c`, the core files alone account for ~43K lines: `proxy_server.py` (15K LOC FastAPI), `router.py` (10.8K LOC), `utils.py` (9.6K LOC), and `main.py` (7.8K LOC). The `llms/` directory contains 119 provider implementations, each with its own transformation logic.

## How It Works

The mental model has two distinct layers:

**The SDK layer** (`litellm/`) is a library you import directly. You call `litellm.completion(model="anthropic/claude-3-5-sonnet", messages=[...])` and it resolves the provider, translates the OpenAI-format request into the provider's native format, fires an HTTP request, translates the response back to OpenAI format, and returns a `ModelResponse`. The `Router` class adds retry/fallback logic across multiple deployments.

**The Proxy layer** (`litellm/proxy/`) is a FastAPI server you deploy as a service. It exposes OpenAI-compatible HTTP endpoints (`/v1/chat/completions`, `/v1/embeddings`, etc.), authenticates requests via virtual API keys, enforces rate limits and budgets, tracks spend per key/team/user, runs guardrail checks, and routes calls through the SDK. The proxy is the production deployment target for teams that need centralized access control and observability.

The critical insight is that the proxy *uses the SDK internally*. Every LLM call that passes through the proxy ultimately calls `litellm.acompletion()` or similar — the proxy is a thin orchestration layer around the SDK, not a separate HTTP proxy.

## Architecture

### Top-Level Directory Structure

```
litellm/
├── main.py              # SDK entry: completion(), acompletion(), embedding()
├── utils.py             # get_llm_provider(), exception_type(), helpers
├── router.py           # Router class: load balancing, retries, fallbacks (10.8K LOC)
├── cost_calculator.py  # Token-based cost computation across providers (2.3K LOC)
│
├── llms/               # 119 provider implementations
│   ├── base_llm/       # BaseConfig, BaseLLMException, abstract interface
│   ├── custom_httpx/    # HTTP client abstraction
│   │   ├── http_handler.py         # Low-level httpx client
│   │   └── llm_http_handler.py     # Central LLM HTTP orchestrator
│   └── {provider}/     # One directory per provider
│       └── chat/transformation.py  # Provider-specific request/response translation
│
├── litellm_core_utils/
│   ├── streaming_handler.py        # SSE/chunk processing (2.4K LOC)
│   └── ...
│
├── caching/
│   ├── dual_cache.py    # Redis + in-memory LRU (DualCache)
│   ├── redis_cache.py   # Redis implementation
│   ├── in_memory_cache.py
│   └── caching_handler.py  # LLMCachingHandler (cache on top of SDK)
│
├── integrations/        # Observability callbacks
│   ├── datadog/
│   ├── helicone/
│   ├── langfuse/
│   ├── lunary/
│   └── ... (40+ integrations)
│
├── proxy/              # AI Gateway (FastAPI server)
│   ├── proxy_server.py  # Main app, routes, startup events (15K LOC)
│   ├── auth/           # Authentication & authorization
│   ├── hooks/          # Pre/post-call interceptors
│   ├── guardrails/     # Request/response validation
│   ├── management_endpoints/  # Admin API: keys, teams, users
│   ├── db/             # Prisma DB client, spend writer
│   └── _experimental/  # A2A, MCP gateway
│
├── router_strategy/    # Routing algorithms
│   ├── lowest_latency.py
│   ├── lowest_cost.py
│   ├── simple_shuffle.py
│   └── ...
│
└── types/              # Pydantic type definitions
```

### The Translation Layer

Every provider in `llms/{provider}/chat/transformation.py` implements a `Config` class that inherits from `BaseConfig`. The two core methods are:

```python
class ProviderConfig(BaseConfig):
    def transform_request(self, model, messages, optional_params, litellm_params, headers):
        # Convert OpenAI format → Provider-specific format
        return {"messages": transformed, "model": provider_model, ...}
    
    def transform_response(self, model, raw_response, model_response, logging_obj, ...):
        # Convert Provider response → OpenAI ModelResponse format
        return ModelResponse(choices=[...], usage=Usage(...))
```

This isolation is the architectural linchpin. The `BaseLLMHTTPHandler` (`llms/custom_httpx/llm_http_handler.py`) calls these transform methods — you never modify the handler to add a provider. The architecture doc shows this explicitly: to add a new provider, create `llms/{provider}/chat/transformation.py` and implement the two methods.

The `BaseConfig` class (`llms/base_llm/chat/transformation.py`) also defines the exception hierarchy. `BaseLLMException` carries `status_code`, `message`, `headers`, `request`, and `response` — every provider exception inherits from this so LiteLLM can always translate provider errors into OpenAI-compatible HTTP responses.

## The Spine

### SDK Request Lifecycle

```
litellm.completion(model="anthropic/claude-sonnet-4", messages=[...])
  → main.py:completion() [sync] or acompletion() [async]
  → utils.py:get_llm_provider()  # resolves "anthropic/claude-sonnet-4" → provider="anthropic"
  → BaseLLMHTTPHandler.completion()
  → ProviderConfig.transform_request()  # OpenAI → Anthropic format
  → HTTPHandler.post()  # httpx client fires request
  → Provider API response
  → ProviderConfig.transform_response()  # Anthropic → OpenAI format
  → CustomStreamWrapper  # handles SSE/chunking
  → ModelResponse + cost attribution
```

### Proxy Request Lifecycle

```
Client → POST /v1/chat/completions
  → proxy_server.py:chat_completion() [FastAPI endpoint]
  → auth/user_api_key_auth.py  # validate virtual key, check budgets
    → InternalUsageCache  # in-memory cache of key metadata
      → Redis  # falls back on cache miss
        → PostgreSQL (Prisma)  # source of truth for key/team/user data
  → proxy/hooks/max_budget_limiter.py  # pre-call budget enforcement
  → proxy/hooks/parallel_request_limiter_v3.py  # RPM/TPM rate limiting
  → route_llm_request.py  # route to SDK or Router
  → router.py:aroute_request()  # load balancing, retries
    → litellm.acompletion()
      → [SDK lifecycle above]
  → response cost extracted from hidden_params
  → hooks/proxy_track_cost_callback.py  # _ProxyDBLogger
    → DBSpendUpdateWriter  # batches spend writes
      → Redis queue → PostgreSQL (60s flush)
  → x-litellm-response-cost header in response
  → Client ← ModelResponse
```

### Background Jobs (APScheduler)

The proxy runs scheduled jobs initialized in `proxy_server.py` → `ProxyStartupEvent.initialize_scheduled_background_jobs()`:

| Job | Interval | Purpose |
|-----|----------|---------|
| `update_spend` | 60s | Batch-write spend logs to PostgreSQL |
| `reset_budget` | ~11min | Reset periodic budgets for keys/users/teams |
| `add_deployment` | 10s | Sync new model deployments from DB |
| `cleanup_old_spend_logs` | cron | Delete aged spend log rows |
| `check_batch_cost` | 30min | Calculate costs for OpenAI batch jobs |
| `_run_background_health_check` | continuous | Liveness-check model deployments |
| `send_weekly/monthly_spend_report` | weekly/monthly | Slack alerting |

## Key Patterns

### 1. DualCache: Two-Tier Caching

`caching/dual_cache.py` implements a two-tier cache used by both the proxy and the SDK's Router. Every `set_cache` writes to both Redis and an LRU in-memory dict simultaneously. Every `get_cache` checks in-memory first, then Redis. The in-memory cache has a TTL to prevent stale reads when Redis is updated by another pod.

```python
class DualCache:
    def get_cache(self, key):
        # 1. Check in-memory LRU
        # 2. On miss, check Redis
        # 3. Populate in-memory from Redis
        # 4. Return
```

This is critical for multi-pod deployments: the in-memory tier gives sub-millisecond reads while Redis provides cross-instance consistency. The cache is used for rate limit counters, API key metadata, TPM/RPM tracking, deployment cooldowns, and LLM response caching.

### 2. Provider Resolution via Model String Prefix

Model identifiers use a `{provider}/{model}` naming convention. `utils.py:get_llm_provider()` parses the model string to extract the provider. If no prefix is present, it falls back to a heuristic (e.g., Azure models start with `azure/`). This is how a single `completion()` call dispatches to 119 different implementations without a registry lookup table in the hot path.

### 3. Router: Pluggable Routing Strategies

`router.py` (10.8K LOC) implements load balancing across multiple deployments of the same model. The `RoutingStrategy` base class (`router_strategy/base_routing_strategy.py`) defines the interface; implementations include:

- **`simple_shuffle.py`** — random selection
- **`lowest_latency.py`** — picks the deployment with lowest historical latency (TTFT for streaming)
- **`lowest_cost.py`** — picks cheapest deployment
- **`lowest_tpm_rpm.py`** — picks least-used deployment by TPM/RPM
- **`budget_limiter.py`** — skips deployments that would exceed budget
- **`tag_based_routing.py`** — routes by custom tags

Each strategy is a `CustomLogger` subclass that receives `log_success_event` callbacks and updates latency/cost/TPM state in `Router.cache` (a `DualCache`). The Router picks the best deployment by querying the cache, then calls `litellm.acompletion()`.

### 4. Translation-Per-Provider, Not Adapters

There are no generic OpenAI-to-X adapters. Every provider has its own `transform_request()` and `transform_response()` in a dedicated file. This means each translation can handle the idiosyncratic details of its provider — Bedrock has multiple APIs (Converse vs. Invoke), Anthropic has `thinking.budget_tokens` and `output_config.effort`, Gemini has `generationConfig` — without affecting other providers.

The architecture doc explicitly calls this out: translations are designed to be unit-testable without making actual API calls, using the `llm_translation/` test suite.

### 5. Cost Calculation

`cost_calculator.py` (2.3K LOC) is the spend attribution engine. Every LLM response passes through `_response_cost_calculator()`, which looks up `litellm.model_cost` (a JSON map of model → pricing per 1M input/output tokens) and multiplies by the actual token counts. Provider-specific overrides exist for models with non-standard pricing (Anthropic cached tokens, Gemini per-character billing, xAI reasoning tokens, OpenAI video/audio).

The cost flows into `response._hidden_params["response_cost"]`, is extracted by the proxy, and is eventually written to PostgreSQL via `DBSpendUpdateWriter` (batched, 60-second flush to avoid write amplification).

### 6. Observability: Async Callbacks via `CustomLogger`

The SDK's `Logging` object (`litellm_logging.py`) fires async callbacks to all registered `CustomLogger` subclasses after each LLM call. Integrations in `integrations/` include:

- **Langfuse** — prompt tracing
- **Lunary** — monitoring
- **Datadog** — metrics + tracing
- **Helicone** — prompt logging
- **Arize Phoenix** — observability
- **Braintrust** — eval + logging
- **Argilla** — human feedback
- **GCS/Athina/AIMonitor** — additional observability targets

Each integration fires its callbacks off the main request thread. The proxy additionally registers `_ProxyDBLogger` (in `proxy/hooks/proxy_track_cost_callback.py`) which handles the spend log write path.

### 7. Guardrails: Pre/Post-Call Interceptors

The guardrail system (`proxy/guardrails/`) runs at the proxy layer with two execution points:

- **Pre-call** (`guardrail_hooks/`): validate request content before it reaches the LLM
- **Post-call** (`guardrail_hooks/`): validate response content before it's returned to the client

Supported integrations via the registry:
- **Lakera** (PII/malicious content detection)
- **Presidio** (Microsoft PII anonymization)
- **Bedrock** (AWS content moderation)
- **Hide Secrets** (credential redaction)
- **Tool Permission** (restrict which tools a key can call)
- **LLM-as-a-Judge** (arbitrary LLM-based policies)
- **GraySwan** (custom guardrail framework)

Guardrails are configured via YAML and instantiated at proxy startup. Each guardrail implements `CustomGuardrail` (from `integrations/custom_guardrail.py`).

### 8. Virtual Keys and Multi-Tenant Auth

The auth system (`proxy/auth/user_api_key_auth.py`, 2.5K LOC) validates virtual API keys on every request. Keys are stored in PostgreSQL (`LiteLLM_VerificationToken` model) and cached in Redis. The `UserAPIKeyAuth` object returned from authentication carries the full permission context: key metadata, team membership, user ID, budget limits, allowed models, and access group grants.

The proxy supports:
- **Virtual keys** — team-scoped or user-scoped tokens with individual budgets
- **JWT/OAuth2** — for UI dashboard users
- **RBAC** — `PROXY_ADMIN`, `PROXY_ADMIN_VIEW_ONLY`, team roles with fine-grained route permissions
- **End-user tracking** — optional `user` param per request for end-user attribution

### 9. Streaming: `CustomStreamWrapper`

`litellm_core_utils/streaming_handler.py` (2.4K LOC) handles Server-Sent Events (SSE) from providers that stream tokens. The `CustomStreamWrapper` class wraps an async iterator and yields OpenAI-format `ChatCompletionChunk` objects. Key responsibilities:

- Transforms provider-specific streaming formats (Anthropic's `message_start`/`content_block_start`/`content_block_delta`/`message_delta` event types) into OpenAI `delta` format
- Aggregates usage information across chunks (for providers that report token counts per-chunk)
- Handles `function_call` and `tool_call` streaming (which requires buffering multiple chunks before emitting a coherent function call)
- Thread-safe via `asyncio.to_thread` + sentinel `_SYNC_ITER_EXHAUSTED` for bridging sync iterators into async contexts

### 10. Prisma Schema: Multi-Tenant Data Model

The database schema (`proxy/schema.prisma`) models a three-tier hierarchy:

```
Organization
  └── Team
        ├── Key (LiteLLM_VerificationToken)
        └── User (LiteLLM_UserTable)
  └── End User
```

The `LiteLLM_BudgetTable` model is the budget/rate-limit unit that can be attached to keys, users, teams, organizations, or end-users independently. Fields include `max_budget`, `soft_budget`, `tpm_limit`, `rpm_limit`, `max_parallel_requests`, `model_max_budget` (per-model JSON map), and `budget_duration` (periodic reset).

Supporting tables include `LiteLLM_AgentsTable` (A2A agent registry), `LiteLLM_ProxyModelTable` (model registry with `litellm_params` JSON), `LiteLLM_CredentialsTable` (named credential sets), `LiteLLM_ObjectPermissionTable` (RBAC permissions), and `LiteLLM_SpendLogs` (detailed per-request spend records).

## Non-Obvious Details

### The `_hidden_params` Pattern

LLM responses (`ModelResponse`) carry an `_hidden_params` dict that transports internal data without surfacing it in the public API. The cost is stored here after calculation (`response._hidden_params["response_cost"]`), the raw provider response is preserved, and metadata about routing (which deployment was used, latency, etc.) is attached. The proxy extracts these at the HTTP boundary and discards them before returning to clients.

### Budget Reservations for Concurrent Requests

LiteLLM uses a **reservation pattern** for concurrent budget enforcement. When a request arrives without a known `max_tokens` (so the cost is unknown upfront), the system atomically pre-reserves the smallest plausible spend (or a configurable minimum) against the user's budget counter in Redis. After the response cost is known, the reservation is adjusted to the actual amount. This prevents a burst of concurrent requests from collectively exceeding a budget that each individual request would pass.

The recent commit `6ff668c` specifically fixed an edge case where the reservation path and the legacy `_PROXY_MaxBudgetLimiter` hook both checked the same counter with different comparison operators (`<` vs `>=`), causing a request that the reservation already admitted to be rejected by the hook.

### Deployment Cooldowns

When a deployment returns a rate-limit error (HTTP 429), the Router marks it as "cooled down" in `Router.cache` (a `DualCache`) for a configurable cooldown period. During this time, the routing strategy skips that deployment. This is a lightweight in-process + Redis-backed circuit breaker.

### Access Groups: Cross-Team Model Allowlists

LiteLLM supports **access groups** — named groups of models that can be granted to keys or teams. This enables cross-team model sharing without duplicating allowlist entries. A key's effective model access is the intersection of its own grants and its team's grants, with the latest fix preventing team members from injecting foreign group IDs that their team wasn't granted.

### Semantic Cache with Qdrant

Beyond simple Redis key-based caching, LiteLLM supports a **semantic cache** backed by Qdrant (a vector database). When enabled, cache keys are computed as embeddings of the request, and cache hits are determined by cosine similarity against a threshold rather than exact key match. This allows semantically equivalent prompts (different phrasings of the same question) to share cache entries.

### Multi-Architecture Docker Builds

The Dockerfiles use multi-architecture OCI index digests for base images (Chainguard Wolfi, Astral `uv`), ensuring builds produce correct binaries for both `linux/amd64` and `linux/arm64` targets. This was a recent fix — previous single-platform pins caused arm64 runners to silently receive amd64 binaries.

### Enterprise Layer

The codebase references `litellm_enterprise` (an internal package, not in this repo) for enterprise-only features like SCIM provisioning, advanced RBAC, and custom auth handlers. The `enterprise/` directory at the repo root contains enterprise-specific patches applied at build time.

## Assessment

### Strengths

- **Truly universal provider abstraction.** The per-provider translation pattern cleanly isolates the heterogeneous aspects of each API while sharing the HTTP orchestration, streaming, cost calculation, and observability infrastructure. Adding a new provider means writing two transform methods — the rest of the system requires no changes.
- **Production-grade multi-tenancy.** The Prisma schema, virtual key auth, budget hierarchies, access groups, and end-user attribution together form a coherent multi-tenant model that handles real organizational structures.
- **Observability is first-class.** The async `CustomLogger` callback system means integrations never block the hot path. The `_ProxyDBLogger` batching strategy (60-second flush) avoids write amplification on high-throughput deployments.
- **Smart caching.** The `DualCache` pattern solves the cross-pod consistency problem elegantly — in-memory L1 with Redis L2 means most reads hit memory while updates propagate to all pods.
- **Comprehensive feature set out of the box.** Load balancing, retries, fallbacks, rate limiting, spend tracking, guardrails, streaming, function calling, observability, caching, Helm charts, Docker images — the project has an unusually complete feature set for a single open-source repo.

### Concerns

- **Monolithic single-process design.** The proxy is one FastAPI app. While it scales horizontally (Redis + PostgreSQL are shared state), features like per-deployment circuit breaking and RPM tracking are in-process counters backed by Redis. At very high RPS (LiteLLM advertises 8ms P95 at 1k RPS), the in-process + Redis read path for rate limiting can become a bottleneck. The `parallel_request_limiter_v3.py` uses Redis atomic operations but still requires a Redis round-trip per request for rate limit checks.
- **Schema complexity.** The Prisma schema (1,376 lines) is sophisticated but complex. Budget inheritance across the Organization→Team→Key→User hierarchy, periodic reset logic, and budget reservations all require careful operational understanding.
- **Test coverage pressure on a large surface area.** With 119 providers, each with its own translation file, the translation test suite (`tests/llm_translation/`) is critical. A bug in one provider's `transform_request` silently produces incorrect requests. The QA matrix described in the architecture doc (6 model families × 3 routes × 17 effort cases) is good but manually maintained.
- **Security surface.** The proxy accepts arbitrary request bodies and proxies them to LLM providers. The guardrail system adds content filtering, but the fundamental attack surface (prompt injection, SSRF via `api_base` overrides, malicious batch file submissions) requires careful operator configuration. The recent batch file model validation fix (`_enforce_batch_file_model_access`) and MCP credential redaction fix are evidence that this surface is actively being hardened.
- **Enterprise dependency.** `litellm-enterprise` is referenced as a runtime dependency. Some features (advanced RBAC, SCIM) live only in the enterprise package. Operators need to understand which features are open-source vs. enterprise to avoid surprises.

### Recommendations

- **For high-throughput deployments**, consider Redis Sentinel or Cluster for rate limiting, and validate that `InternalUsageCache` TTLs are tuned for your deployment size. The per-request Redis round-trip for key metadata caching (on cache miss) could be optimized with a longer TTL or a local write-through cache.
- **For security-sensitive deployments**, enable guardrails explicitly and review `LITELLM_ALLOWED_URLS` / `LITELLM_PROXY_BASE_URL` restrictions to prevent SSRF. The `drop_params` option for Anthropic `output_config.effort` is a useful safety knob for deployments that front Claude Code.
- **For cost governance**, use the budget reservation feature (` LITELLM_RESERVATION_ENABLED`) for workloads with variable `max_tokens`, and configure `budget_duration` for periodic reset if teams need monthly allowances.

### Technical Debt

- The `proxy_server.py` at 15K LOC is a large FastAPI app. While it's organized into endpoint modules in subdirectories, the monolithic file structure makes navigation difficult. The `route_llm_request.py` file has a linting warning (`# Complex routing — PLR0915 — refactoring tracked`) acknowledging this.
- The Prisma client is used synchronously in many places. LiteLLM wraps it with `PrismaClient` in `proxy/utils.py`, but synchronous Prisma calls block the async FastAPI worker thread. This is mitigated somewhat by the APScheduler background jobs, but the management endpoints (key generation, team management) are synchronous.
- The `model_prices_and_context_window.json` file (checked into the repo) is the source of truth for model pricing and capabilities. Out-of-band model releases (a new GPT-4o tier from OpenAI) require a LiteLLM release to update the JSON. The codebase acknowledges this with `supports_adaptive_thinking`, `supports_max_reasoning_effort`, etc. per-model flags in the JSON.

## Related

- [[analyzing-fluent-bit]] — another infrastructure component with plugin architecture
- [[analyzing-kanidm]] — Rust-based identity management with similar multi-tenant auth concerns
