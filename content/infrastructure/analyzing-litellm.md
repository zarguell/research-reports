---
title: "Analyzing LiteLLM"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/BerriAI/litellm
tags: [infrastructure, llm, ai-gateway, api-proxy]
---

# Analyzing LiteLLM

> **Source:** [BerriAI/litellm](https://github.com/BerriAI/litellm) @ [`487479e`](https://github.com/BerriAI/litellm/commit/487479eff76da099b358d06cfea0b6508fac4ef0)

## How It Works

LiteLLM is a Python library that provides a **unified interface across 100+ LLM providers** — OpenAI, Anthropic, Azure, Bedrock, Gemini, Ollama, and dozens more — by normalizing all calls to a single OpenAI-compatible API format. Internally it translates incoming requests into each provider's native API schema, makes the HTTP call, then translates the response back to OpenAI format. This means you can swap models by changing a model name string, without touching application code.

The project ships in two layers. The **SDK** (`litellm/`) is a standalone Python library for direct use — `litellm.completion()`, `litellm.embedding()`, etc. The **AI Gateway** (`litellm/proxy/`) wraps the SDK with a FastAPI server, adding authentication (API keys, JWT, SSO), rate limiting, multi-tenant budgets, spend tracking, guardrails, and observability callbacks. Both layers share the same provider translation layer (`llms/{provider}/`). The SDK is the engine; the proxy is the managed service built on top of it.

## Architecture

```
Client (OpenAI SDK / any HTTP client)
        │
        ▼
┌─────────────────────────────────────────────────────┐
│              AI Gateway (litellm/proxy/)             │
│  proxy_server.py (FastAPI)                           │
│    ├─ auth/ (API key, JWT, SSO validation)           │
│    ├─ hooks/ (max_budget_limiter, rate_limiter, etc.) │
│    ├─ management_endpoints/ (admin API)              │
│    ├─ guardrails/ (content filtering)                │
│    └─ db/ (Prisma ORM, spend writer)                 │
└────────────────────┬────────────────────────────────┘
                     │ route_request()
        ┌────────────▼────────────┐
        │     Router (router.py)  │  load balancing, retries, fallbacks
        │  ├─ router_strategy/    │  (lowest_latency, simple_shuffle, etc.)
        │  └─ router_utils/       │  (cooldowns, health checks, retry logic)
        └────────────┬────────────┘
                     │ litellm.acompletion()
        ┌────────────▼────────────┐
        │   SDK Core (litellm/)    │
        │  main.py ──► utils.py   │  provider resolution
        │  llms/custom_httpx/     │  central HTTP handler
        │  cost_calculator.py     │  token × price cost tracking
        │  caching/               │  Redis + in-memory cache
        │  integrations/          │  async callbacks (Langfuse, etc.)
        └────────────┬────────────┘
                     │
        ┌────────────▼──────────────────────────┐
        │  llms/{provider}/chat/transformation.py │
        │  transform_request()  OpenAI → Provider │
        │  transform_response() Provider → OpenAI  │
        └────────────┬──────────────────────────┘
                     │ HTTP
                LLM Provider API
```

**Key directory breakdown:**

| Path | Role |
|------|------|
| `litellm/main.py` | SDK entry: `completion()`, `acompletion()`, `embedding()` |
| `litellm/router.py` | Load-balancer across multiple deployments, retry/fallback |
| `litellm/llms/custom_httpx/llm_http_handler.py` | Central HTTP orchestrator |
| `litellm/llms/{provider}/` | 90+ provider directories, each with its own `Config` transform class |
| `litellm/cost_calculator.py` | Token-count × price-per-token cost computation |
| `litellm/proxy/proxy_server.py` | FastAPI app, ~15K lines of endpoints and lifecycle management |
| `litellm/proxy/auth/` | API key validation, JWT decoding, SSO |
| `litellm/proxy/hooks/` | Pre-call budget/rate-limit enforcement |
| `litellm/proxy/guardrails/` | Content filtering and moderation hooks |
| `litellm/proxy/schema.prisma` | PostgreSQL schema (Prisma ORM) for keys, teams, spend logs |
| `litellm/integrations/` | 40+ observability callback adapters (Langfuse, Datadog, Prometheus, etc.) |
| `litellm/router_strategy/` | Routing algorithms (latency-based, cost-based, tag-based, etc.) |
| `litellm/caching/` | `DualCache` (in-memory + Redis), Redis-only, semantic (Qdrant) variants |

## The Spine

**SDK path — request lifecycle:**

1. User calls `litellm.completion(model="anthropic/claude-3-sonnet", messages=[...])`
2. `main.py` passes through to `utils.py` → `get_llm_provider()` resolves `model` string to a provider + any override params
3. `BaseLLMHTTPHandler.completion()` (`llms/custom_httpx/llm_http_handler.py`) receives the call
4. For the matched provider, it loads the `Config` class (e.g. `llms/anthropic/chat/transformation.py`) and calls `transform_request()` — this maps the OpenAI request schema to the provider's API format (auth headers, body shape, tool calling syntax, etc.)
5. HTTP call fires via `httpx` / `aiohttp`
6. Raw response lands in `transform_response()` → normalized back to `ModelResponse` (OpenAI format with `choices`, `usage`, etc.)
7. `litellm_logging.py` runs callbacks: cost calculation, observability integrations, async logging
8. `cost_calculator.py` is called with the usage object — it looks up model prices from `cost.json` and multiplies `input_tokens × input_price + output_tokens × output_price`

**Proxy path — request lifecycle:**

1. FastAPI route `/v1/chat/completions` in `proxy_server.py` receives the request
2. `user_api_key_auth()` (`proxy/auth/user_api_key_auth.py`) validates the API key — first against a Redis in-memory cache, falling back to PostgreSQL via Prisma if needed
3. Pre-call hooks run: `max_budget_limiter` checks spend remaining; `parallel_request_limiter` enforces concurrent-request limits; cache-control validation
4. `route_request()` (`proxy/route_llm_request.py`) selects a deployment via the `Router` — strategies include `simple_shuffle` (round-robin), `lowest_latency`, `lowest_cost`, `tag_based_routing`, and others
5. The Router calls `litellm.acompletion()` internally (same SDK path above)
6. After the response, `proxy/common_request_processing.py` extracts `response._hidden_params["response_cost"]` and attaches it to response headers as `x-litellm-response-cost`
7. `_ProxyDBLogger.async_log_success_event()` fires callbacks; `DBSpendUpdateWriter.update_database()` queues a Redis-increment for the user's spend
8. A background APScheduler job (`update_spend`, every 60s) flushes the queued spend increments to PostgreSQL

**The Prisma multi-tenant schema** (`schema.prisma`) models three levels of hierarchy:

- `LiteLLM_OrganizationTable` → contains multiple `LiteLLM_TeamTable`
- `LiteLLM_TeamTable` → contains multiple `LiteLLM_VerificationToken` (API keys) and `LiteLLM_EndUserTable`
- `LiteLLM_BudgetTable` → a shared budget config linked to organizations, projects, keys, end users, and tags

Each key has its own spend counter (`spend`), token-per-minute (`tpm_limit`) and request-per-minute (`rpm_limit`) limits, and model restrictions (`allowed_models`).

## Key Patterns

**Translation layer isolation.** Each provider lives in `llms/{provider}/` with a `Config` class inheriting from `BaseConfig`. `transform_request()` and `transform_response()` are the only public interface between the central HTTP handler and the provider. Adding a new provider means implementing these two methods — no changes to the handler itself. This is the core extensibility mechanism.

**DualCache.** Redis-backed caching with an in-memory LRU fallback. `caching/dual_cache.py` (`DualCache`) is used by the Router for TPM/RPM tracking, deployment cooldowns, and client-side response caching. The proxy also uses it for API key cache and rate-limit counters. If Redis is absent, it degrades gracefully to in-memory only.

**Router as the load balancer.** The `Router` class is a first-class citizen — usable as a Python SDK object (`from litellm import Router`) or as the internal proxy routing engine. It maintains a deployment list (from a YAML config, Litellm config, or database), tracks health status per deployment, enforces cooldown periods after errors, and routes based on a configurable strategy. Strategies live in `router_strategy/` and implement `RoutingStrategy`.

**Cost tracking as a first-class concern.** Every response has its cost computed and stored in `response._hidden_params["response_cost"]`. The `cost_calculator.py` reads model pricing from `cost.json` (pinned at library init), with per-provider overrides (e.g. `llms/azure/cost_calculation.py`). Provider-specific quirks are handled: Anthropic counts cached tokens at a discount, video models use cost-per-second, etc.

**Async-first with sync wrappers.** `main.py` provides both `completion()` (sync) and `acompletion()` (async). The sync version wraps the async internals with `asyncio.run()` or `anyio.to_thread`. Callbacks in `integrations/` are all async (`async_log_success_event`, `async_log_failure_event`) and fire off the main thread.

**Observability via callbacks.** The `CustomLogger` base class in `integrations/` is the integration pattern. Each adapter (Langfuse, Datadog, Prometheus, etc.) implements `async_log_success_event()`, `async_log_failure_event()`, `async_log_retry_event()`. These are registered via `litellm.callbacks` or `LITELLM_CALLBACKS` env var and fire after every SDK call.

**Guardrails as proxy hooks.** Content moderation (input/output) is implemented as proxy hooks in `proxy/guardrails/`. Custom guardrails can be added by implementing `CustomLogger` and registering in the proxy config. There's also a `proxy/llamaguard_prompt.txt` referencing LlamaGuard integration.

## Non-Obvious Details

**The `_hidden_params` convention.** Responses carry a `_hidden_params` dict that flows cost, original response object, API key used, and model used through the system without polluting the public response schema. This is the seam between the SDK and proxy — the proxy reads `_hidden_params["response_cost"]` to attach the `x-litellm-response-cost` header, and `_hidden_params["api_key_used"]` to attribute spend.

**Router deployment cooldowns.** After an error, deployments enter a cooldown period tracked in `DualCache` (Redis, with in-memory fallback). This prevents hammering a failing deployment while a health check runs. The cooldown logic lives in `router_utils/cooldown_handlers.py` and is driven by callbacks on the httpx client.

**The `DBSpendUpdateWriter` batching.** Direct database writes on every request would be catastrophic at scale. Instead, `proxy/db/db_spend_update_writer.py` queues spend increments to Redis (using a Redis sorted set keyed by user ID + timestamp). An APScheduler job runs every 60s, reads the queue, and does a batch upsert to PostgreSQL. This is the primary write path for spend attribution.

**Prisma with a mixed client model.** The proxy uses Prisma ORM for database access but the SDK itself is pure Python with no Prisma dependency. This keeps the SDK lightweight. The Prisma client is instantiated in `proxy/utils.py` (`PrismaClient`) and only initialized when `DATABASE_URL` is set and the proxy starts.

**Streaming is handled in the core handler.** `litellm_core_utils/streaming_handler.py` handles SSE parsing, chunk accumulation, and re-assembles tool calls from streaming deltas. Each provider's `transform_response()` contributes to this — streaming deltas come back from the provider and the handler reassembles them into OpenAI's `chat.completion.chunk` format.

**MCP (Model Context Protocol) support.** LiteLLM has experimental MCP client support in `experimental_mcp_client/` and an MCP server registry in `proxy/mcp_registry.json`. MCP tools are transformed to OpenAI function-calling format and back. This enables LiteLLM to act as an agent intermediary for external MCP servers (Zapier, Jira, Linear, etc.).

**Container-native deployment.** `deploy/kubernetes/` and `deploy/charts/` provide Helm charts. The Dockerfile is multi-stage. `litellm/deploy/start.sh` is the entrypoint that reads `proxy_config.yaml` and `model_config.yaml` at startup.

## Assessment

**Strengths:**

- The translation layer abstraction is genuinely elegant — adding a provider requires no changes outside its own directory
- The SDK and proxy separation keeps the core library clean and composable
- Cost tracking is built in at every layer, with provider-specific adjustments, not just a flat token count
- The DualCache pattern provides real operational value: Redis for production scale, graceful fallback for development
- Routing strategies are pluggable and well-separated (`router_strategy/` base class + implementations)
- 40+ observability integrations means LiteLLM drops into existing stacks without custom instrumentation

**Concerns:**

- `proxy_server.py` is ~15K lines in a single file — this is a maintenance risk. Even with clear sections, that file will accumulate technical debt as features grow
- The Prisma schema has grown to 1,376 lines with deeply nested relations. Schema migrations at this complexity level are non-trivial
- No request ID propagation between proxy and SDK layers — tracing a request across the two codebases requires manual correlation through the logging callbacks
- `router.py` is ~10K lines — same concern as proxy_server.py. The Router has become a kitchen-sink class handling retries, fallbacks, cooldowns, routing strategies, health checks, and caching all in one place
- The `_hidden_params` convention is implicit, not typed — nothing enforces its use or documents its contract
- Enterprise features are gated behind `litellm-enterprise` pip extras with no clear distinction in the codebase structure between open-source and enterprise code paths

**Recommendations:**

- Extract logical groups from `proxy_server.py` into sub-modules (e.g., `proxy/chat_completion.py`, `proxy/batches.py`, `proxy/embeddings.py`) as the first step toward a maintainable proxy
- Introduce a typed `RequestContext` or `ProxyContext` object that flows from proxy through to SDK, carrying the API key, user info, and request ID — this would also enable proper distributed tracing
- Consider a formal plugin interface for routing strategies rather than the current base-class-plus-registration pattern in `router_strategy/`
- Document the `_hidden_params` contract in a type stub or comment in `main.py` to prevent accidental breakage

> [!question]
> The Prisma dependency is a significant constraint — it pulls in Rust toolchain requirements for the Prisma CLI. This may complicate deployment in some environments (e.g., AWS Lambda layers, Alpine-based containers). Worth verifying whether there's an active effort to abstract the DB layer or if Prisma is a hard dependency for all proxy deployments.
