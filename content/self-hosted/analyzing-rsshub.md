---
title: "Analyzing RSSHub"
date: 2026-05-10
type: codebase-analysis
status: complete
source: https://github.com/DIYgod/RSSHub
tags: [rss, self-hosted, typescript, nodejs, feed-generator]
---

# Analyzing RSSHub

> **Source:** [DIYgod/RSSHub](https://github.com/DIYgod/RSSHub) @ [a98de2e](https://github.com/DIYgod/RSSHub/commit/a98de2effd0a59fdf003fd0762fe3b9188ba8fe5)

## How It Works

RSSHub is an RSS feed generator that turns websites without native RSS support into subscribable feeds. At its core, it's a web server that maps URL paths to route handlers — each handler knows how to scrape or API-call a specific website, extract structured data, and return it as a standardized `Data` object. The framework then serializes that object into RSS 2.0 XML, Atom, JSON Feed, or RSS3 format.

The mental model is simple: a URL like `/github/trending/daily/javascript` triggers the GitHub trending route handler, which fetches GitHub's trending page, enriches the results via the GraphQL API, and returns a list of feed items. Middleware layers handle caching, filtering, access control, and output formatting — route authors only concern themselves with data extraction.

The project ships over 400 namespaces (one per website/service) with thousands of individual routes. It runs as a Node.js server using Hono, supports Cloudflare Workers, Vercel, and Docker deployments. Self-hosters typically run it behind a reverse proxy like [[analyzing-traefik]] with Redis for caching.

## Architecture

The codebase is organized around a few clear modules:

```
lib/
  index.ts              # Entry point — starts Hono server (with cluster support)
  app.ts                # Imports request-rewriter, delegates to app-bootstrap
  app-bootstrap.tsx     # Wires middleware pipeline + registry routes onto Hono
  registry.ts           # Auto-discovers route modules, builds Hono routes
  config.ts             # ~1200 lines: all env-driven configuration
  types.ts              # Core types: Data, DataItem, Route, Namespace, RadarItem
  middleware/           # ~12 middleware modules (cache, parameter, access-control, etc.)
  routes/               # ~400+ namespaces, each with namespace.ts + route files
  views/                # RSS, Atom, JSON, RSS3 serializers (Hono JSX components)
  utils/                # Cache backends, proxy, puppeteer, request-rewriter, etc.
  worker.ts             # Cloudflare Worker entry point
```

The route plugin system is the architectural center of gravity. Every website gets a folder under `lib/routes/<namespace>/` containing a `namespace.ts` (metadata) and one or more route files exporting a `Route` object with a `path`, `handler`, `name`, `example`, and `maintainers`. The registry (`lib/registry.ts`) auto-discovers these at startup — in dev mode via dynamic imports, in production from a pre-built manifest.

Cache backends are pluggable: memory (LRU), Redis, or HTTP-based. The cache layer sits as middleware and stores fully-rendered `Data` objects keyed by request path + format + limit, hashed with xxhash64.

## The Spine

A request flows through these stages:

1. **Entry** — `lib/index.ts` creates a Hono app via `@hono/node-server`, optionally using Node.js cluster mode for multi-process serving.

2. **Request Rewriter** — Before the app even boots, `lib/app.ts` imports the request-rewriter (`lib/utils/request-rewriter/index.ts`), which monkey-patches `globalThis.fetch`, `http.get`, and `https.get` to inject proxy support, custom User-Agent headers, and retry logic. This is a global side effect — every HTTP request in the process goes through this wrapper.

3. **Middleware Pipeline** — `app-bootstrap.tsx` registers middleware in order:
   - `trimTrailingSlash` + `compress`
   - `logger` → `trace` → `honeybadger` → `sentry` (observability)
   - `accessControl` (key-based auth via query param)
   - `debug` → `template` → `header` → `antiHotlink`
   - `parameter` (the big one: post-processes Data — filtering, fulltext extraction, OpenAI summarization, Chinese conversion, etc.)
   - `cache` (checks/stores cached Data objects)

4. **Route Matching** — The registry registers all discovered routes onto Hono with `subApp.get(path, wrappedHandler)`. The wrapped handler lazy-loads the route module (in production, routes are code-split for lazy loading), calls `routeData.handler(ctx)`, and stores the result in `ctx.set('data', response)`.

5. **Response Rendering** — The `template` middleware (which runs *after* `next()`) picks up the `data` from context, formats it (title trimming, whitespace collapsing, Unicode cleanup), and renders it using Hono JSX views — RSS XML by default, or Atom/JSON/RSS3 based on the `?format=` query parameter.

## Key Patterns

**Route as declaration.** Each route is a self-contained TypeScript module exporting a typed `Route` object. The `handler` function receives a Hono `Context`, extracts path params, fetches data, and returns a `Data` object. Route metadata (name, example, parameters, features, radar rules) doubles as API documentation — a build script generates docs from route declarations.

**Convention over configuration for routes.** The filesystem is the registry: `lib/routes/github/trending.tsx` automatically registers at `GET /github/trending/:since/:language/:spoken_language?`. No central router file. The `namespace.ts` file in each folder provides metadata for the group.

**Middleware as post-processing pipeline.** The `parameter` middleware is a 400+ line workhorse that runs *after* the route handler. It handles entity decoding, lazy image loading fixes, relative URL resolution, regex-based filtering (`?filter=`, `?filterout=`), fulltext extraction via Mercury Parser, OpenAI-based summarization, Sci-Hub redirection, and Chinese character conversion. This is powerful but creates a hidden coupling — route authors must understand what the middleware will do to their output.

**`tryGet` caching pattern.** Route handlers use `cache.tryGet(key, asyncFn, maxAge)` as a memoization helper — if the key exists in cache, return it; otherwise call the function, cache the result, and return. This is used heavily for individual item enrichment (e.g., fetching full article content in a loop).

**Multi-platform builds.** The same codebase targets Node.js, Cloudflare Workers, and Vercel. Platform-specific code uses `.worker.ts` file suffixes that tsdown aliases at build time. The Worker build uses a noop cache and platform-specific fetch/puppeteer stubs.

## Non-Obvious Details

> [!warning] Global fetch monkey-patching
> The request-rewriter (`lib/utils/request-rewriter/index.ts`) patches `globalThis.fetch`, `http.get`, `https.get`, and `https.request` at module load time. This means *every* HTTP call — including from dependencies — goes through the proxy/retry/User-Agent injection layer. Powerful for consistency, but it's an implicit global side effect that can surprise debugging.

> [!note] Cache-based request deduplication
> The cache middleware implements a polling-based request deduplication scheme. When a cache miss occurs, it sets a `controlKey` to `'1'`. Subsequent requests for the same path poll (up to 10 retries, 6 seconds each) waiting for the control key to clear. If it doesn't clear, they throw `RequestInProgressError`. This prevents thundering-herd scenarios for expensive routes but can cause 60-second delays.

> [!note] Lazy route loading in production
> In production, routes are pre-compiled into a manifest (`assets/build/routes.js`). Route handlers aren't loaded at startup — they're loaded on first request via dynamic `import()`. This keeps cold-start fast but means the first request to any route pays an import penalty.

> [!question] The `parameter` middleware does too much
> At 400+ lines, the parameter middleware handles filtering, fulltext extraction, AI summarization, Chinese conversion, Telegram instant view, Sci-Hub redirect, and brief mode. These are conceptually separate features bundled into one middleware because they all operate on the `Data` object after the route handler returns. It works, but it's the single most complex file in the middleware layer.

**Route sorting by literal vs. parameter segments.** The registry sorts routes so literal path segments take priority over parameter segments (e.g., `/github/user` before `/github/:user`). Without this, a parameter route could shadow a literal one.

**The `_extra` escape hatch.** `DataItem` has an `_extra` field typed as `Record<string, any>`, used for things like RSS3 links and quoted content. It's an intentional type escape for features that don't map cleanly to the RSS data model.

## Assessment

**Strengths:**

- **Extensible by design.** Adding a new feed source is as simple as dropping a file into `lib/routes/`. The convention-based discovery, typed `Route` interface, and `tryGet` caching helper make the contribution loop fast. This is why the project has thousands of routes and hundreds of contributors.
- **Multi-deployment model.** The same codebase runs on Node.js, Cloudflare Workers, and Vercel with build-time platform switching. Self-hosters get Docker/Node; the official instance runs on Cloudflare.
- **Mature middleware stack.** Caching, filtering, fulltext extraction, AI summarization, and format conversion are all handled at the framework level — route authors don't need to think about them.
- **Strong type system.** The `Route`, `Data`, `DataItem`, and `Namespace` types in `lib/types.ts` form a clear contract. The `ViewType` enum, `RadarItem` type, and feature flags make route metadata machine-readable.

**Concerns:**

- **Global side effects.** The request-rewriter monkey-patches Node.js globals at import time. This works but makes the system harder to test in isolation and can cause surprising behavior in edge cases.
- **Parameter middleware complexity.** The `parameter.ts` middleware is a grab-bag of post-processing features. It needs decomposition — at minimum, filtering, AI features, and content transformation should be separate middleware.
- **Cache coupling.** The cache middleware stores serialized `Data` JSON and deserializes it on hit. Any change to the `Data` type or post-processing logic can silently invalidate or corrupt cached responses. There's no cache versioning strategy.
- **Security surface.** Routes execute arbitrary HTTP requests to third-party websites. The access control model is a single shared key via query parameter (`?key=...`). There's no per-route or per-namespace access control, and no rate limiting at the framework level. Self-hosters behind [[analyzing-traefik]] should add their own rate limiting.

**Recommendations for self-hosters:**

- Use Redis as the cache backend for multi-instance deployments. Memory cache is fine for single-instance.
- Set `ACCESS_KEY` to prevent unauthorized use, especially if exposed to the internet.
- Run behind a reverse proxy that handles TLS and rate limiting.
- Disable NSFW routes with `DISABLE_NSFW=true` if not needed.
- The `PROXY_URI` config is essential if your target sites block your server's IP.

## Related

- [[analyzing-traefik]] — RSSHub self-hosters commonly deploy behind Traefik as a reverse proxy with TLS termination.
