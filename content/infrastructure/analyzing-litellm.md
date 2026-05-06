---
title: "Analyzing LiteLLM"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/BerriAI/litellm @ `6ff668c`
tags: [python, ai-gateway, llm-proxy, openai-compatible, multi-tenant]
---

# Analyzing LiteLLM

> **Source:** [BerriAI/litellm](https://github.com/BerriAI/litellm) @ [`6ff668c`](https://github.com/BerriAI/litellm/commit/6ff668c7aa01a73738ed39aa64913a089a183565)

## Overview

LiteLLM is a dual-mode Python library that serves as both a direct SDK for calling 100+ LLM providers and a production-grade AI gateway (proxy server). The project originated as a unified interface to normalize the chaos of calling multiple LLM APIs — each with different request formats, auth patterns, and error shapes — into a single OpenAI-compatible interface. It has since grown into a full-featured proxy with virtual keys, spend tracking, guardrails, and observability integrations. At 43K+ GitHub stars, it is one of the most widely deployed open-source AI gateways.

The codebase has two primary surfaces:

- **`litellm/` SDK** — imported as a Python library, exposes `completion()`, `acompletion()`, `embedding()` as the core API surface.
- **`litellm/proxy/`** — a FastAPI application deployed as a service, adding auth, rate limiting, budgets, and management APIs on top of the SDK.

Both share the same provider implementations (`litellm/llms/`), translation layer, and cost calculator.

## How It Works

The core insight driving LiteLLM's architecture is that every LLM provider can be modeled as an OpenAI-compatible endpoint with a transformation layer in front of it. A client sends an OpenAI-format request (standard `POST /chat/completions` body); LiteLLM inspects the `model` string to determine the provider, applies a provider-specific transformation to map OpenAI params into the provider's native format, fires the HTTP request, then transforms the response back to OpenAI format before returning.

This normalization happens in two places: `litellm/litellm_core_utils/get_llm_provider_logic.py` resolves `model` strings (e.g., `"anthropic/claude-sonnet-4-20250514"` → provider `"anthropic"`) and per-provider `transformation.py` files handle the request/response mapping. Because every provider is reduced to a common interface, the rest of the system — caching, streaming, cost calculation, retries — is provider-agnostic.

The **Proxy Server** wraps this SDK in a FastAPI application. When a request arrives, it flows through: auth middleware (API key validation against a PostgreSQL-backed store) → budget and rate limit checks (Redis-backed) → optional guardrails → the SDK's `completion()` call → response transformation → spend logging. The response path mirrors this: streaming chunks are normalized by `litellm/litellm_core_utils/streaming_handler.py`, costs are calculated, and the request is logged.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Request                           │
│   POST /v1/chat/completions   (OpenAI-compatible format)       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  LiteLLM Proxy Server (FastAPI)                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Auth Layer  │─▶│ Rate Limit  │─▶│   Guardrail Hooks       │  │
│  │ (API Keys   │  │ (Redis +    │  │ (prompt injection,      │  │
│  │  Prisma/PG) │  │  TTL bucket)│  │  content safety, etc.)   │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      LiteLLM SDK Core                           │
│  ┌─────────────────────┐  ┌──────────────────────────────────┐  │
│  │  Router / Load      │  │  get_llm_provider()               │  │
│  │  Balancer           │─▶│  (model → provider resolution)    │  │
│  │  (retry, fallback,  │  └──────────────────────────────────┘  │
│  │   cooldown, health) │                                        │
│  └─────────────────────┘                                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Translation Layer (per-provider)                 │
│  llms/{provider}/chat/transformation.py                        │
│  OpenAI-format request ──▶ Provider-native request               │
│  Provider-native response ──▶ OpenAI-format response            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   LLM Provider APIs                             │
│  OpenAI | Anthropic | Azure | Bedrock | Gemini | Groq | ...    │
│  (100+ providers, 1000+ models)                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key directories:**

| Directory | Purpose |
|-----------|---------|
| `litellm/main.py` | SDK entry points (`completion()`, `acompletion()`, `embedding()`) |
| `litellm/router.py` | Load balancer with routing strategies, retry/fallback, health tracking |
| `litellm/utils.py` | Provider resolution, exception mapping, optional param handling |
| `litellm/llms/{provider}/` | Per-provider implementations with transformation classes |
| `litellm/litellm_core_utils/streaming_handler.py` | `CustomStreamWrapper` — normalizes streaming across providers |
| `litellm/caching/` | Layered cache (in-memory, Redis, S3, GCS, Qdrant semantic) |
| `litellm/cost_calculator.py` | Provider-specific per-token cost calculation |
| `litellm/proxy/proxy_server.py` | FastAPI app — routes, management endpoints, middleware |
| `litellm/proxy/auth/` | API key auth, JWT, OAuth2, RBAC |
| `litellm/proxy/hooks/` | Proxy-level interceptors (rate limiting, budget, caching) |
| `litellm/proxy/guardrails/` | Guardrail registry and per-guardrail implementations |
| `litellm/proxy/spend_tracking/` | Cost logging, batch DB writes, spend dashboards |
| `litellm/integrations/` | Observability callbacks (Langfuse, LangSmith, Lunary, etc.) |
| `deploy/charts/litellm-helm/` | Helm chart for Kubernetes deployment |

## The Spine

### SDK Entry: `litellm/main.py`

The public SDK surface is small: three functions (`completion`, `acompletion`, `embedding`) plus their non-chat variants. These delegate to a shared `completion()` helper that:

1. Resolves the model string to a provider via `get_llm_provider()` in `utils.py`.
2. Handles retries via `tenacity` (configurable `num_retries`, exception-aware backoff).
3. Routes to the provider's HTTP handler (`llms/custom_httpx/llm_http_handler.py`).
4. Wraps the response in `CustomStreamWrapper` if streaming.

The `utils.py` `get_llm_provider()` function is the first critical normalization point. It parses model strings of the form `provider/model-name` (e.g., `openai/gpt-4o`, `anthropic/claude-sonnet-4`) and also matches bare model names against a hardcoded registry of known models. An important security detail in `get_llm_provider_logic.py` is the `_endpoint_matches_api_base()` check, which validates that a caller-supplied `api_base` URL actually matches a registered endpoint's hostname before forwarding credentials — preventing credential leakage to attacker-controlled servers.

### Provider Translation: `llms/{provider}/chat/transformation.py`

Each provider has a `BaseConfig`-subclassed transformer. The transformer defines how to map OpenAI params to the provider's API and how to map the provider's response back to OpenAI format. For example, `llms/anthropic/chat/transformation.py` handles Anthropic's specific `messages` format, `system` parameter differences, and `thinking` blocks; `llms/gemini/` handles Gemini's format. The `llms/openai_like/` directory provides a generic base for providers that use the OpenAI API format but aren't the official OpenAI endpoint — covering dozens of providers from Groq to vLLM to Cloudflare Workers AI.

### Router: `litellm/router.py`

The `Router` class is the load-balancer SDK. When initialized with a `model_list`, it maintains a set of "deployments" (specific model + endpoint combinations) organized into model groups. The key capabilities:

- **Routing strategies**: `simple-shuffle` (round-robin), `latency-based-routing` (choose fastest recent response), `least-busy` (lowest concurrent requests), `cost-based-routing` (cheapest model within budget), `usage-based-routing` (distribute by TPM/RPM quota).
- **Deployment cooldowns**: Failed deployments are placed in a cooldown cache (backed by Redis or in-memory) for a configurable time period.
- **Fallback chains**: On failure, the router iterates through `fallbacks`, `context_window_fallbacks`, and `content_policy_fallbacks` lists before giving up.
- **Health tracking**: A `DeploymentHealthCache` (`DualCache` backed) tracks deployment health. Optional health checks ping deployments on a configurable interval.
- **TPM/RPM tracking**: The router's `DualCache` (`litellm/caching/dual_cache.py`) stores TPM/RPM counters per deployment, enabling usage-based routing and quota enforcement without a central DB hit per request.

### Proxy Server: `litellm/proxy/proxy_server.py`

The FastAPI application (~15K lines) exposes:

- **LLM routes** (`@router.post("/v1/chat/completions")`, `/v1/embeddings`, etc.) — these call the SDK internally.
- **Management routes** (`/v1/model/info`, `/v1/key/*`, `/v1/team/*`, `/v1/spend/*`) — admin API for key management, team administration, spend queries.
- **Health routes** (`/health`, `/health/liveness`, `/health/readiness`).
- **Metrics** (`/metrics` for Prometheus scraping).

Startup initialization (`proxy_startup_event()`) sets up the Prisma DB client, Redis connections, initializes the `Router`, registers guardrails, starts background scheduler jobs (APScheduler), and warms up caches.

## Key Patterns

### Model String Convention

LiteLLM uses a `provider/model-name` string format as the canonical identifier. If no provider prefix is given, `get_llm_provider()` looks up the bare model name in `litellm/model_prices_and_context_window.json` — a comprehensive registry of 1000+ models with their context windows, token prices, and default providers. This file is the single source of truth for cost calculation and provider resolution.

### DualCache: In-Memory + Redis

Rather than choosing between in-memory (fast, single-instance) and Redis (distributed, durable), LiteLLM uses `DualCache` (`litellm/caching/dual_cache.py`) which wraps both. Reads check memory first; writes go to both. This pattern is used for:

- **API key cache**: Validated keys are cached in-memory to avoid Prisma hits on every request.
- **Rate limit counters**: TPM/RPM counters for each deployment.
- **Deployment cooldown state**: Failed deployments flagged in both layers.
- **Spend tracking**: Near-real-time spend without per-request DB writes.

### Async-First HTTP Layer

LiteLLM's HTTP calls go through `llms/custom_httpx/http_handler.py` and `llm_http_handler.py`, built on `httpx` (sync and async). The handler maintains a connection pool per deployment with configurable limits. The `LLMClientCache` (`router_utils/client_initalization_utils.py`) caches initialized HTTP clients per deployment, reusing connections across requests. A known pitfall (documented in the codebase's AGENTS.md) is never closing clients inside cache eviction paths — evicted clients may still have in-flight requests.

### Streaming: `CustomStreamWrapper`

The `CustomStreamWrapper` class (`litellm/litellm_core_utils/streaming_handler.py`) normalizes SSE/chunked responses from all providers into OpenAI `chat.completion.chunk` format. It handles:

- Provider-specific chunk formats (SSE delimiters, different JSON shapes).
- Assembling tool-call chunks across multiple provider round-trips.
- `stream_options={{"include_usage": true}}` support (sends a usage-carrying final chunk).
- Audio/image delta attributes mapped to standard OpenAI chunk fields.
- Concurrent async iteration via `asyncio.to_thread` with a sentinel to avoid `StopIteration`→`RuntimeError` PEP 479 issues.

### Callback/Observability System

LiteLLM uses a `CustomLogger` callback interface (`litellm/integrations/custom_logger.py`). Callbacks are invoked at predefined hook points: `log_success_event`, `log_failure_event`, `async_log_success_event`, `async_log_failure_event`, `log_retry_event`, `log_pre_call`, `log_post_call`. Each integration (Langfuse, LangSmith, Lunary, etc.) implements this interface. The proxy additionally uses `DBSpendUpdateWriter` to batch spend writes to Prisma, reducing DB load.

### Prisma ORM for Multi-Tenant Data

The proxy uses Prisma (Python client via `prisma-client-py`) against PostgreSQL. The schema (`schema.prisma`) defines tables for:

- `LiteLLM_VerificationToken` — API keys with associated budgets, teams, user roles.
- `LiteLLM_TeamTable` — Teams that share budgets and model access.
- `LiteLLM_BudgetTable` — Per-team, per-user, per-key budget configurations.
- `LiteLLM_EndUserTable` — End-user tracking (for customer-facing cost attribution).
- `LiteLLM_OrganizationTable` — Org-level grouping with model allowlists.
- `LiteLLM_ProjectTable` — Project-level granularity within organizations.

Budget enforcement happens at multiple levels: key-level (`LiteLLM_BudgetTable` attached to the `VerificationToken`), team-level, organization-level, and end-user-level. The `BudgetManager` (`budget_manager.py`) orchestrates these checks before forwarding requests.

## Non-Obvious Details

### Guardrails Are Callback Chains, Not Middleware

LiteLLM's guardrail system (`litellm/proxy/guardrails/`) is not implemented as traditional middleware — instead, each guardrail (Lakera, Presidio, Azure Content Safety, Bedrock Guardrails, LLM-as-Judge, etc.) is a `CustomGuardrail` subclass with `async def async_pre_call(kwargs)` and `async def async_post_call(kwargs, response)` hooks. These are wired into the request lifecycle through `guardrail_registry.py` and `guardrail_helpers.py`. The `guardrail_name_config_map` (`init_guardrails.py`) maps human-readable names to the actual callback functions. Guardrails can be enabled per-request via `metadata.guardrails` or configured globally in `config.yaml`.

### Cost Calculation Is Provider-Specific, Centralized

The `cost_calculator.py` delegates to per-provider `cost_per_token()` functions. The key design is that costs are calculated from the raw `usage` object in the response (prompt tokens + completion tokens), multiplied by provider-specific per-token prices from `model_prices_and_context_window.json`. This means costs are calculated from actual usage, not from estimated token counts via tiktoken. The `_ProxyDBLogger` callback (`proxy/hooks/proxy_track_cost_callback.py`) is the sink — it batches writes via `DBSpendUpdateWriter` to avoid DB write storms on high-throughput deployments.

### Virtual Key Auth Flow

When a request hits the proxy with a Bearer token, `user_api_key_auth.py` performs a multi-step auth flow:

1. Check if the route is public (health, docs, etc.).
2. Extract the key from the `Authorization` header.
3. Check `UserApiKeyCache` (in-memory + Redis) for the key object — avoids DB hit.
4. If not cached, query Prisma `VerificationToken` table.
5. Verify key is not expired, not revoked.
6. Load associated `LiteLLM_TeamTable`, `LiteLLM_BudgetTable`, `LiteLLM_UserTable` for authorization.
7. Run budget checks (max spend, TPM/RPM, model allowlist).
8. Attach `UserAPIKeyAuth` object to the request state for downstream handlers.

### The Auto-Router

A lesser-known feature is the `auto_router` (`litellm/proxy/management_endpoints/auto_router.py`) — a self-configuring router that introspects available API keys in the environment (OpenAI, Anthropic, Azure, etc.) and automatically creates a model list without requiring a `config.yaml`. This is useful for quick dev setups but production deployments typically use explicit config.

### The Enterprise Layer

`enterprise/` and `litellm_enterprise/` directories contain enterprise-only features: RBAC with custom roles, advanced audit logging, SAML/OIDC SSO, and enhanced auth. The codebase uses lazy imports for enterprise modules, so the open-source version runs without enterprise dependencies. The `ProxyStartupEvent` checks for a valid LiteLLM license key to enable enterprise features.

### Container Strategy

LiteLLM ships four Docker images:

- `ghcr.io/berriai/litellm` — base image
- `ghcr.io/berriai/litellm-database` — includes Prisma + PostgreSQL client binaries (recommended for proxy deployments)
- `ghcr.io/berriai/litellm-non-root` — runs as non-root user for security-sensitive environments
- `ghcr.io/berriai/litellm-alpine` — Alpine-based minimal image

The `docker-compose.yml` wires together the proxy, PostgreSQL, and Redis containers. The Helm chart (`deploy/charts/litellm-helm/`) manages the deployment on Kubernetes with PostgreSQL and Redis as optional dependencies via Bitnami subcharts.

## Assessment

**Strengths:**

- **100+ provider coverage** with a consistent interface is the core value proposition and it delivers — the per-provider translation layer is well-isolated and testable.
- **Router abstraction** is genuinely useful for production multi-deployment setups. The ability to route by latency, cost, or TPM quota without code changes is a significant operational win.
- **Multi-tenant isolation** is well-thought-out: keys, teams, organizations, projects, and end users each have their own budget enforcement paths. The Prisma schema reflects real enterprise billing needs.
- **Observability depth** — the callback system with first-class Langfuse, LangSmith, OpenTelemetry, and Prometheus integrations means teams don't need to instrument their own tracing.
- **Guardrail extensibility** — 30+ guardrail integrations via the callback pattern means LiteLLM can slot into existing safety infrastructure without requiring a rewrite.

**Concerns:**

- **Schema complexity** — the Prisma schema has 40+ models with non-trivial relations. Running migrations in production requires care, and the prisma-client-py binary targets are a deployment complexity (LiteLLM ships a `-database` image specifically for this).
- **Callback execution order** — guardrails, caching, and logging all use the callback/hook system with no guaranteed ordering. A guardrail that needs to run before cost calculation, or a cache check that needs to run before auth, requires careful configuration.
- **Config drift risk** — the `config.yaml` approach works for small deployments but managing multi-environment config (dev/staging/prod) across dozens of model deployments becomes fragile. The enterprise version likely has better config management.
- **DualCache consistency** — the in-memory + Redis cache layer assumes a Redis backend. Without Redis, the in-memory cache is local to each proxy instance, meaning rate limits and API key caches are not shared across replicas. This is documented but easy to miss.
- **Testing burden** — with 100+ provider implementations, even a bug in one provider's transformation can silently produce incorrect outputs for a subset of requests. The test suite covers many cases but provider-specific quirks are constantly changing.

**Recommendations:**

- For production proxy deployments, always use the `-database` image with a shared PostgreSQL and Redis instance.
- Use the `latency-based-routing` strategy only with a warm cache — cold latency measurements are noisy and can thrash routing decisions.
- When adding custom guardrails, implement both `async_pre_call` and `async_post_call` hooks and use the `should_proceed_based_on_metadata` pattern for per-request opt-in/opt-out.
- Prefer the Router SDK over the proxy for in-process load balancing; the proxy is best for multi-team, multi-tenant, API-key-gated deployments.

## Related

[[analyzing-fluent-bit]] — infrastructure observability pipeline, relevant for correlating LiteLLM metrics with downstream system telemetry.
