---
title: "Analyzing Lightpanda Browser"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/lightpanda-io/browser
tags: [zig, v8, headless-browser, cdp, web-automation, ai-agents, mcp, browser-engine]
---

# Analyzing Lightpanda Browser

> **Source:** [lightpanda-io/browser](https://github.com/lightpanda-io/browser) @ [`0c87fd6`](https://github.com/lightpanda-io/browser/commit/0c87fd6771ae1b5e384d523c8873b587d6390961)

## How It Works

Lightpanda is a headless browser engine written from scratch in Zig — not a Chromium fork or WebKit patch. It loads a URL, parses HTML, builds a DOM tree, executes JavaScript via V8, and exposes the result through the Chrome DevTools Protocol (CDP) over WebSocket. The entire pipeline runs in a single binary with no GPU or display server, achieving ~16× lower memory and ~9× faster execution than headless Chrome on real-world benchmarks (933 pages, EC2 m5.large).

The project serves three distinct modes: **`fetch`** (CLI one-shot page dump), **`serve`** (persistent CDP server for Puppeteer/Playwright), and **`mcp`** (Model Context Protocol server for direct LLM tool use). All three share the same core engine but differ in how results are delivered.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   main.zig / cli.zig             │
│              (parse args → dispatch mode)        │
├─────────────────────────────────────────────────┤
│                    App.zig                       │
│  (lifecycle: Network, Storage, ArenaPool,       │
│   Telemetry, Platform, Snapshot)                │
├──────────┬──────────────────┬───────────────────┤
│  CDP     │   Browser        │     MCP            │
│  Server  │   Engine         │     Server          │
│ (CDP.zig)│                  │  (mcp/Server.zig)  │
├──────────┤                  ├───────────────────┤
│  22 CDP  │  Session ── Page │  JSON-RPC 2.0      │
│  domains │  └─ Frame(s)     │  over stdio         │
│ (cdp/    │    └─ Runner     │  tools: navigate,   │
│  domains/│    └─ Factory    │  click, evaluate... │
│          │    └─ webapi/*   │                     │
├──────────┴──────────────────┴───────────────────┤
│                  js/ layer                       │
│  Env, Isolate, Context, Bridge (V8 ↔ Zig)       │
│  comptime type registration, HandleScope mgmt    │
├─────────────────────────────────────────────────┤
│              Network stack (layered)              │
│  Forward → InterceptionLayer → RobotsLayer →     │
│  WebBotAuthLayer → CacheLayer                    │
│  HTTP: libcurl + boringssl + brotli + nghttp2    │
├─────────────────────────────────────────────────┤
│              Parsing                             │
│  HTML: html5ever (Rust, via C FFI)              │
│  CSS: custom tokenizer + parser                  │
└─────────────────────────────────────────────────┘
```

**~118K lines of Zig** across 312 source files, plus ~97K lines of test HTML fixtures (370 files).

## The Spine

### CLI Entry (`main.zig` → `cli.zig`)

`main()` initializes the allocator (GPA in debug, c allocator in release), parses CLI args via `Config.parseArgs()`, and dispatches to one of three modes:

1. **`fetch`** — `Runner` loads a URL, executes JS, dumps HTML/markdown to stdout
2. **`serve`** — `Server.zig` starts a WebSocket listener on port 9222, dispatches CDP commands to `CDP.zig`
3. **`mcp`** — `mcp/Server.zig` starts a JSON-RPC 2.0 server on stdio, exposes browser tools directly to LLMs

### Request Lifecycle (serve mode)

```
CDP client sends Page.navigate via WebSocket
  → CDP.zig dispatches to domains/page.zig
    → Session.createPage() → allocates Page from pool
      → Page owns Frame + Factory + per-page arena
        → Runner: HttpClient fetches URL (through Network layer stack)
          → Parser (html5ever) constructs DOM tree
            → Factory creates webapi objects (Element, Node, Window...)
            → ScriptManager executes <script> tags in V8
            → Microtask/macrotask queues drain until settled
        → CDP returns result (DOM snapshot, console output, etc.)
```

### Key Object Hierarchy

- **App** — global lifecycle, owns Network, Storage, ArenaPool
- **Browser** — one V8 Isolate, one Session, one HttpClient
- **Session** — manages Page lifecycle and navigation state
- **Page** — owns a root Frame, per-page arena allocator, DOM Factory, origin map
- **Frame** — a document context (including iframes), owns ScriptManager and EventManager
- **Factory** — creates and manages all DOM object instances for a Page

## Key Patterns

### Comptime V8 Bridge

The most architecturally significant pattern. `js/bridge.zig` uses Zig's `comptime` to auto-generate V8 binding glue at compile time. Each Web API type (Element, Document, Window, etc.) declares its JS interface using a declarative DSL:

```zig
pub const jsclass = js.Bridge(HTMLDocument)
    .constructor(.{ .name = "HTMLDocument" })
    .accessor(.{ .get = "getCookie", .set = "setCookie" }, .{ .name = "cookie" })
    .function(.{ .name = "write", .fn = writeDoc });
```

This eliminates the macro-based or code-gen-heavy binding layers that other V8 embedders (Node.js, Deno) use. The bridge handles constructor registration, property accessors, method binding, indexed/named property access, and iterators — all at zero runtime cost.

### Arena-Based Memory Management

`ArenaPool.zig` implements a pool of `ArenaAllocator` instances. Each `Page` gets its own arena; when the page is discarded, the entire arena is freed in one shot. This matches the browser workload perfectly: pages are loaded, processed, and discarded — no need for per-object tracking or GC overhead.

### Layered Network Stack

`Network.zig` processes requests through a stack of composable layers:

| Layer | Purpose |
|-------|---------|
| `Forward` | Routes to libcurl, handles TLS via boringssl |
| `InterceptionLayer` | CDP Fetch domain request interception |
| `RobotsLayer` | `robots.txt` compliance (opt-in) |
| `WebBotAuthLayer` | Bot authentication headers |
| `CacheLayer` | HTTP caching with disk-backed `FsCache` |

Each layer wraps the next, so adding a new capability (e.g., a new auth scheme) means adding one file.

### CDP Domain Isolation

Each CDP domain (`page.zig`, `dom.zig`, `runtime.zig`, `network.zig`, etc.) is a self-contained Zig file that registers its commands and event handlers. The `lp` domain (`domains/lp.zig`) provides Lightpanda-specific extensions like markdown output and AXTree serialization that go beyond standard CDP.

## Non-Obvious Details

### 230 Web API Implementations

`src/browser/webapi/` contains 230 Zig files implementing DOM/HTML/BOM APIs. This is the bulk of the engineering effort — each file bridges a Web API surface to Zig types through the comptime V8 bridge. Coverage is partial but growing; CORS is a notable missing piece ([#2015](https://github.com/lightpanda-io/browser/issues/2015)).

### Single-Threaded V8, Multi-Client WebSocket

V8 isolates are single-threaded (as V8 requires), but `Server.zig` supports multiple concurrent WebSocket clients. This is useful for scenarios where multiple automation scripts share one browser process.

### Snapshot-Based V8 Startup

V8 snapshots serialize the JS heap state after bootstrapping, allowing subsequent starts to skip re-parsing built-in JS. `snapshot_creator` builds the snapshot, which can be embedded in the binary to achieve sub-100ms cold starts. This is a common V8 optimization but critical for a headless browser that may spawn frequently.

### html5ever via C FFI

The HTML parser is `html5ever`, a Rust crate, accessed through a C ABI wrapper (`src/browser/parser/html5ever.zig`). This is an unusual Zig↔Rust bridge — the Rust code compiles to a C shared library that Zig links directly. The CSS parser, by contrast, is implemented natively in Zig.

### AGPL-3.0 Licensing

The codebase is AGPL-3.0, which is notable. Any service using Lightpanda must provide source or offer network use rights. This is a deliberate choice that constrains commercial embedding but aligns with their open-source-first positioning. They offer a separate cloud service at `cloud.lightpanda.io`.

### Pre-Seed Stage with Strong Pedigree

Founded by Francis Bouvier (CEO), Katie Brown (COO), and Pierre Tachoire (CTO). Pre-seed funded by ISAI with angels from Mistral, Hugging Face, and Dust. Top contributor `karlseguin` is a well-known systems programmer. The team's DNA is clearly European systems-programming heavy.

## Assessment

**Strengths:**
- Clean architectural separation — CDP, MCP, and the core engine are properly isolated
- The comptime V8 bridge is an elegant solution that eliminates runtime overhead for type registration
- Arena-based memory is the right model for browser workloads and is key to the 16× memory advantage
- Native MCP integration positions them well for the AI agent use case beyond just CDP compatibility

**Concerns:**
- **AGPL limits commercial adoption** of the self-hosted binary. Companies running it as a service must open-source their modifications. The cloud offering provides an escape hatch, but it creates a two-tier model.
- **Web API coverage is partial.** 230 API implementations sounds substantial, but the long tail of Web APIs is where headless browsers fail on real sites. CORS alone being missing is a significant gap for any SPA interaction.
- **Zig ecosystem maturity.** Zig 0.15.2 is pinned as an exact requirement. Zig's language is still evolving (not yet 1.0), and the compiler's own backend is under active development. This introduces toolchain risk.
- **Testing breadth vs. depth.** 370 HTML test fixtures is a good start, but Web Platform Tests (WPT) conformance would be the meaningful signal — the README mentions WPT but requires a forked repo and custom hosts setup.

**Recommendation:** Lightpanda is worth watching for AI agent and web automation workloads where memory and speed matter more than full Chrome compatibility. For production scraping of JS-heavy sites, test against your specific targets before committing — partial API coverage means some sites will break in non-obvious ways. The MCP integration makes it particularly interesting as a native tool for LLM-powered agents.
