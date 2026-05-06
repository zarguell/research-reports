---
title: "Analyzing PasteGuard"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/sgasser/pasteguard
tags: [typescript, bun, hono, llm, privacy, pii, presidio, proxy, secrets-detection, devsecops]
---

# Analyzing PasteGuard

> **Source:** [sgasser/pasteguard](https://github.com/sgasser/pasteguard) @ [`6162bc3`](https://github.com/sgasser/pasteguard/commit/6162bc3)

## How It Works

PasteGuard is a privacy proxy that sits between LLM clients and upstream providers (OpenAI, Anthropic). It intercepts requests, detects personally identifiable information (PII) and secrets in the prompt text, then either masks them before forwarding to the cloud provider or routes the entire request to a local LLM. The masking is transparent — clients point at PasteGuard instead of the provider, and see unmasked responses.

Two modes govern behavior. **Mask mode** replaces detected entities with typed placeholders (e.g., `[PERSON_1]`, `[API_KEY_SK_1]`), sends the sanitized request to the cloud provider, then restores the originals in the response — even in streaming SSE responses. **Route mode** skips masking entirely; if any PII or secrets are detected, the request is sent to a local LLM (Ollama, vLLM, llama.cpp) instead. Clean requests pass through to the cloud provider unchanged.

PII detection uses Microsoft Presidio, which runs as a separate service (co-located in the same Docker container via supervisord). Secrets detection is pure regex via an extensible pattern registry. The two systems are independent and use separate placeholder contexts. A standalone `/api/mask` endpoint exposes the masking engine for programmatic use.

> [!note] Placeholder syntax
> PasteGuard uses double-bracket delimiters for PII and asterisk-prefixed tokens for secrets (e.g., `***API_KEY_SK_1`). This report uses single brackets in prose to avoid Obsidian wikilink conflicts with the linter.

## Architecture

```
Client Request
     │
     ▼
┌──────────────────────────────────┐
│  Hono Server (Bun)               │
│                                  │
│  ┌─────────┐  ┌──────────────┐  │
│  │ Routes   │→│ Secrets Det. │  │
│  │ OpenAI   │  │ (regex)      │  │
│  │ Anthropic│  └──────────────┘  │
│  │ API      │  ┌──────────────┐  │
│  │ Dash     │→│ PII Detect    │  │
│  └─────────┘  │ (Presidio)    │  │
│       │        └──────────────┘  │
│       ▼              │           │
│  ┌──────────────────┐│           │
│  │ Masking Service  │◄┘          │
│  │ - Conflict Res.  │            │
│  │ - Placeholders   │            │
│  │ - Streaming Buf. │            │
│  └──────────────────┘            │
│       │           │              │
│       ▼           ▼              │
│  Mask mode   Route mode          │
│  ▼    ▼      ▼    ▼             │
│ Cloud Local  Cloud Local         │
└──────────────────────────────────┘
```

Key modules:

| Module | Purpose |
|--------|---------|
| `src/routes/openai.ts`, `anthropic.ts` | Request validation, orchestration, wildcard proxying |
| `src/masking/service.ts` | Core mask/unmask orchestration |
| `src/masking/context.ts` | Placeholder mapping, text replacement algorithms |
| `src/masking/conflict-resolver.ts` | Overlapping entity resolution |
| `src/pii/detect.ts` | Presidio HTTP client with language detection |
| `src/secrets/detect.ts` | Regex-based secret detection |
| `src/secrets/patterns/` | Plugin-based pattern registry |
| `src/providers/` | Upstream API clients + stream transformers |
| `src/routes/api.ts` | Standalone masking API |

## The Spine

Tracing a chat completion request through the system:

**1. Route handler** (`src/routes/openai.ts`) validates the request body with Zod, then processes secrets first (block/mask/route\_local), then runs PII detection against Presidio (parallel per text span).

**2. Masking decision.** In mask mode, detected entities become typed placeholders. In route mode, the presence of any PII or `route_local` secrets flips the routing target from cloud to local.

**3. Provider call.** The `RequestExtractor` abstraction (`src/masking/types.ts`) decouples the masking engine from API formats. `OpenAIExtractor` and `AnthropicExtractor` each implement `extractTexts`, `applyMasked`, and `unmaskResponse` — the core masking service never knows about message structures. The provider client forwards the client's auth header (or falls back to config).

**4. Response processing.** For non-streaming responses, `restorePlaceholders` does a single-pass replacement (longest placeholders first to prevent partial matches). For streaming SSE responses, a two-buffer pipeline (one for PII, one for secrets) handles placeholders split across chunks — `findPartialPlaceholderStart` detects incomplete `[[...` sequences and buffers them until the next chunk arrives.

**5. Wildcard proxy.** Non-chat-completion requests (`/models`, `/embeddings`, `/audio/*`, `/images/*`) are transparently proxied to the upstream provider. PasteGuard acts as a full API proxy, not just a chat endpoint.

## Key Patterns

**Strategy pattern for format extraction.** The `RequestExtractor<TReq, TRes>` interface is the architectural spine. It lets the masking engine operate on plain text spans without any knowledge of OpenAI vs Anthropic message formats. Each extractor handles its own quirks — Anthropic's top-level system prompt (mapped to `messageIndex = -1`), thinking blocks, nested `tool_result` content — while the core masking logic stays clean.

**Two-pass placeholder replacement.** First pass assigns placeholders in forward order using a `reverseMapping` for deduplication (same value → same placeholder). Second pass performs actual string replacements in reverse order so earlier indices stay valid. For unmasking, placeholders are sorted longest-first to prevent shorter placeholders from partially matching longer ones (e.g., `[PERSON_1]` inside `[PERSON_10]`).

**Conflict resolution by confidence.** PII entities from Presidio have confidence scores. Overlapping same-type entities are merged (union span, max score). Cross-type conflicts use a greedy algorithm sorted by score desc → length desc → start asc. Secrets, which lack confidence scores, use simpler first-come-first-served ordering.

**Plugin-based secret detection.** Four `PatternDetector` modules (private keys, API keys, tokens, env vars) each export a `detect(text, enabledTypes)` function. Adding a new secret type means creating a pattern file and registering it in `index.ts`.

**Bun-native everything.** Uses `bun:sqlite` for the dashboard database, Bun's built-in test runner, and Bun's default export server convention (`export default { port, fetch }`). No Node.js compatibility layer.

## Non-Obvious Details

**Startup validation is fire-and-forget.** The server begins accepting requests before Presidio health validation completes (`validateStartup()` runs as `.then()`). Early requests can hit 503s if Presidio isn't ready. This is intentional for fast startup but worth knowing in production.

**Secret placeholders lack buffering.** PII placeholders use paired bracket delimiters, enabling `findPartialPlaceholderStart` to detect incomplete sequences in streaming chunks. Secret placeholders use the `***TYPE_N` format without a closing delimiter, so partial secret placeholders can't be buffered during streaming. In practice this rarely matters since secret placeholders are short, but it's a gap.

**OpenAI stream transformer has no line buffer.** The Anthropic transformer accumulates a `lineBuffer` to handle SSE lines split across TCP chunks. The OpenAI transformer doesn't — if a `data: {...}` line is split across chunks, the JSON parse will fail and the line passes through unmodified. This is noted as a potential robustness gap.

**The default whitelist hardcodes a Claude Code string.** `"You are Claude Code, Anthropic's official CLI for Claude."` is always prepended to the PII whitelist. Without it, Claude Code's system prompt triggers false positives (likely "Anthropic" being detected as a person or location). This is a pragmatic choice but means the whitelist isn't purely user-controlled.

**PII and secrets contexts are independent.** Each gets its own `PlaceholderContext` with separate counters and mappings. The `/api/mask` endpoint is the exception — it chains both into a single context for client-side use.

**The `/api/mask` endpoint exposes PII mappings.** The response includes `context.mapping` (placeholder → original) so clients can unmask locally. This is by design for tools like Claude Code but means the client temporarily holds the full PII mapping in memory.

**Auth forwarding, not auth termination.** The proxy routes have no built-in authentication. Client-provided auth headers are forwarded to the upstream provider, or config `api_key` is used as fallback. Access control is expected at the network level. Only the dashboard supports Basic Auth.

## Assessment

**Strengths.** Clean separation between detection and masking via the `RequestExtractor` abstraction. The two-mode design (mask vs route) covers both compliance and air-gapped environments. The streaming unmasking pipeline is well-thought-out. Colocated tests are comprehensive (19 test files across 5.6K LOC of source). The Docker setup bundles Presidio and Bun in one container, simplifying deployment.

**Concerns.** No authentication on proxy endpoints — fine for local dev but needs a reverse proxy in production. The fire-and-forget startup means health checks should gate traffic in container orchestrators. The OpenAI stream transformer's missing line buffer could drop data under adverse network conditions. PII detection latency scales linearly with text span count (one Presidio call per span), which could be slow for long conversation histories.

**Recommendations.** Add optional API key or token auth middleware for the proxy routes. Add a line buffer to the OpenAI stream transformer for parity with the Anthropic one. Consider batching PII detection across spans or caching repeated Presidio calls for common system prompts. The wildcard proxy is convenient but should be documented as an attack surface — a compromised upstream could see the full request body for non-chat endpoints.
