---
title: "Analyzing Insomnia"
date: 2025-05-09
type: codebase-analysis
status: complete
source: https://github.com/Kong/insomnia
tags: [api-client, rest, graphql, grpc, electron, typescript, kong]
---

## Overview

Insomnia is Kong's open-source API development platform — a cross-platform desktop application for designing, debugging, and testing APIs. It supports REST, GraphQL, gRPC, WebSocket, and Socket.IO protocols, along with cloud sync, Git-backed version control, MCP (Model Context Protocol) integration, and AI-assisted features. This analysis examines the codebase at commit `c124a66` on the `develop` branch, covering its monorepo architecture, Electron + React stack, embedded database layer, plugin system, and build pipeline.

The project is licensed under Apache-2.0 and is actively maintained by Kong Inc. The main Electron app is at version `12.5.1-alpha.0`, indicating active development toward a major release.

## Key Findings

### Monorepo Architecture

Insomnia uses **npm workspaces** for its monorepo, with seven packages under `packages/`:

| Package | Purpose |
|---------|---------|
| `packages/insomnia` | Main Electron desktop app (core UI, networking, database) |
| `packages/insomnia-api` | Cloud API client library (shared between app and CLI) |
| `packages/insomnia-inso` | CLI tool (`inso`) for CI/CD and automation |
| `packages/insomnia-testing` | Test execution framework (Chai-based assertions) |
| `packages/insomnia-scripting-environment` | Pre/post-request scripting runtime objects |
| `packages/insomnia-smoke-test` | Playwright E2E test suite |
| `packages/insomnia-component-docs` | Component documentation tooling |

The root `package.json` orchestrates builds across all workspaces. The monorepo requires Node.js >= 24 and npm >= 11, which is notably aggressive — the project tracks very recent Node releases. Build tooling centers on **esbuild** (via `esbuild-runner`) for fast TypeScript compilation and **Vite** for the dev server and React bundling.

### Tech Stack

**Desktop Shell:** Electron 41.0.3 with context isolation and `contextBridge` for secure IPC. The `entry.preload.ts` file exposes a typed bridge API (`window.main`, `window.dialog`, `window.app`, etc.) to the renderer process, keeping Node.js APIs out of the browser context.

**UI Framework:** React 18 with React Router 7 (using the file-system routing plugin `@react-router/fs-routes`). The routing system generates 170 route files from `src/routes/`, each following React Router's `clientLoader`/`clientAction` pattern for data loading and mutations. Components use React Aria Components (`react-aria`, `react-aria-components`) for accessible interactive elements.

**Styling:** TailwindCSS 4 with the `@tailwindcss/vite` plugin. Utility classes only — no CSS modules or styled-components. Conditional classes use `tailwind-merge` and `clsx`. Theming is handled through a plugin-based system in `src/plugins/themes.ts`.

**Database:** `@seald-io/nedb` — an embedded NoSQL document database (a maintained fork of NeDB). The database layer uses an **Inversion of Control (IoC)** pattern defined in `src/insomnia-data/src/database/types.ts`: the main process initializes with `NeDBDatabaseImpl` while the renderer uses a bridge implementation that proxies calls over IPC. The `IDatabase` interface provides CRUD operations (`docCreate`, `docUpdate`, `remove`, `find`, `findOne`), change buffering (`bufferChanges`, `bufferChangesIndefinitely`, `flushChanges`), and hierarchical queries (`withAncestors`, `getWithDescendants`).

**Request Engine:** HTTP requests are executed via `@getinsomnia/node-libcurl` (a native libcurl binding), with separate handlers in `src/main/network/` for WebSocket, Socket.IO, gRPC (`@grpc/grpc-js`), and MCP connections. The `src/network/network.ts` file (~1,138 lines) orchestrates the full request lifecycle: template rendering, authentication, cookie handling, plugin hooks, and response processing.

**Templating:** Nunjucks templates run in a Web Worker (`src/templating/worker.ts`) to avoid blocking the UI. Variables use the `{{ _.variable_name }}` syntax. Custom template tags are contributed by plugins and bundled plugins (like AI features).

### Data Model Hierarchy

The data model is defined in `src/insomnia-data/src/models/` with ~45 model files. The hierarchy follows:

```
Organization
  → Project (local | remote/cloud | git-backed)
    → Workspace (scope: 'collection' | 'design')
      → Environment (base + sub-environments)
      → Cookie Jar
      → Request Group (folders)
        → Request (HTTP, GraphQL, gRPC, WebSocket, Socket.IO)
```

Key models include `Request`, `GrpcRequest`, `WebSocketRequest`, `SocketIORequest`, `McpRequest`, `Environment`, `ApiSpec`, `ProtoFile`, `MockRoute`, `MockServer`, `UnitTest`, and `UnitTestSuite`. Each model has a corresponding service in `src/insomnia-data/src/services/` following a service-layer pattern.

The services layer also uses IoC — `initServices()` in `src/insomnia-data/src/services/index.ts` accepts a platform-specific implementation (`servicesNodeImpl` for main/Node, bridge proxy for renderer). This is a clean pattern that allows the same codebase to run in both Electron's main process and a CLI context.

### Services and IoC Pattern

The codebase employs a sophisticated **dependency injection** approach using JavaScript `Proxy` objects. Both the database and services modules start as Proxy-based stubs that throw errors if accessed before initialization:

- **Database** (`src/insomnia-data/src/database/index.ts`): A Proxy that lazily resolves to the real implementation after `initDatabase()` is called. The main process injects `NeDBDatabaseImpl`; the renderer injects a bridge that forwards calls over IPC.
- **Services** (`src/insomnia-data/src/services/index.ts`): A nested Proxy that supports destructuring before initialization (e.g., `const { workspace } = services`) while deferring method resolution to call time. The `initServices()` call injects the Node-specific implementation.

This is an unusual but pragmatic approach — it avoids the need for a DI container framework while keeping the codebase testable and platform-agnostic.

### Plugin System

The plugin system (`src/plugins/index.ts`) is one of Insomnia's extensibility pillars. Plugins are Node.js modules in directories matching `insomnia-plugin-*` and must declare an `insomnia` key in their `package.json`. The system supports:

- **Template tags** — custom Nunjucks extensions (e.g., custom variable generators)
- **Request/Response hooks** — functions that intercept and modify requests and responses
- **Themes** — visual theme definitions
- **Actions** — context-menu actions for requests, request groups, workspaces, and documents
- **Bundle plugins** — built-in plugins loaded from `node_modules` (e.g., `@kong/insomnia-plugin-ai`, `@kong/insomnia-plugin-external-vault`)

Bundle plugins have elevated access through `unsafePluginMainActions`, which can execute in the main process with full Node.js APIs. This is gated behind `settings.pluginsAllowElevatedAccess` and is not available to third-party plugins. The plugin discovery traverses user-configured paths with path-traversal protection (sanitizing paths and validating resolved locations).

### Network and Protocol Support

The `src/main/network/` directory contains dedicated IPC handlers for each protocol:

- **Curl** (`curl.ts`) — HTTP/HTTPS via libcurl, with proxy support and TLS configuration
- **WebSocket** (`websocket.ts`) — `ws` library for WebSocket connections
- **Socket.IO** (`socket-io.ts`) — `socket.io-client` for Socket.IO protocol
- **gRPC** (`grpc/`) — `@grpc/grpc-js` with proto file loading and server reflection
- **MCP** (`mcp.ts`) — Model Context Protocol client via `@modelcontextprotocol/sdk`, supporting both stdio and HTTP transports

Each protocol handler registers IPC channels in the main process and exposes a typed bridge API through the preload script. The MCP integration is particularly notable — it positions Insomnia as an MCP client capable of connecting to AI tool servers, with support for tools, resources, prompts, and sampling requests.

### Git Sync and Version Control

The `src/sync/` directory implements a Git-based version control system for syncing API collections:

- **VCS backend** (`src/sync/vcs/`) — wraps `isomorphic-git` for local Git operations
- **Cloud sync** (`src/main/cloud-sync/`) — syncs with Kong's cloud platform via IPC
- **Git service** (`src/main/git-service.ts`) — manages Git repositories with branch operations, diffs, and merge conflict resolution
- **Delta system** (`src/sync/delta/`) — computes and applies changesets for document sync

The sync system auto-creates backend projects for workspaces and handles the full Git lifecycle: clone, fetch, pull, push, branch, merge, and conflict resolution. Git credentials support OAuth-based authentication for GitHub and GitLab, with credential management in `src/insomnia-data/src/models/git-credentials.ts`.

### AI Features

Insomnia integrates AI capabilities through multiple pathways:

- **LLM configuration** (`src/main/llm-config-service.ts`) — manages AI backend selection and configuration, with per-feature enablement flags
- **AI plugin** (`@kong/insomnia-plugin-ai`) — bundled plugin providing AI-assisted features
- **MCP client** — connects to external AI tool servers via the Model Context Protocol
- **Commit message generation** — uses AI to generate Git commit messages from diffs (`src/main/git-commit-generation-process.mjs`)
- **Mock generation** — generates mock route data from OpenAPI specs (`src/main/mock-generation-process.mjs`)

The LLM config supports multiple backends with configurable API keys and endpoints. The `@modelcontextprotocol/sdk` enables Insomnia to act as a full MCP client, participating in the emerging ecosystem of AI tool interoperability.

### Build System

The build pipeline uses multiple tools in concert:

1. **React Router build** — `react-router build` compiles the renderer application with Vite
2. **esbuild** — compiles Electron entry points (`esbuild.entrypoints.ts`) for main process and preload scripts
3. **electron-builder** — packages the app for distribution (DMG/zip for macOS, NSIS/Squirrel for Windows, AppImage/deb/rpm/snap for Linux)
4. **esbuild-runner** (`esr`) — runs TypeScript scripts directly during build (e.g., `scripts/build.ts`)

The dev workflow runs a Vite dev server on port 3334 alongside the Electron main process, with hot reload for the renderer. Production builds use hard linking by default (configurable via `USE_HARD_LINKS`).

A notable build feature is the `check:renderer-node-imports` script, which analyzes the production build to ensure no Node.js APIs leak into the renderer bundle — important for Electron security.

### Testing Strategy

The project uses a layered testing approach:

- **Unit tests:** Vitest across all workspaces (176 test files total). Tests are co-located with source files as `filename.test.ts`. The Vitest config excludes route files and uses a custom setup file (`setup-vitest.ts`).
- **E2E tests:** Playwright in `packages/insomnia-smoke-test/`, with separate "Smoke" and "Critical" test projects. Tests run against packaged, built, or dev-mode app instances.
- **Type checking:** TypeScript strict mode with `react-router typegen` for route type generation. The `type-check` script runs `tsc` across all workspaces.
- **Linting:** ESLint 9 with flat config (`eslint.config.mjs`), enforcing import sorting (`eslint-plugin-simple-import-sort`), React hooks rules, and unicorn best practices. Prettier handles formatting.

CI workflows (`.github/workflows/`) include `test.yml`, `test-cli.yml`, `test-e2e.yml`, `sast.yml`, release workflows, and Homebrew formula updates.

### Security Architecture

Security is handled at multiple layers:

- **Electron context isolation** — Node.js APIs are not accessible from the renderer; all communication goes through the typed preload bridge
- **Vault system** — AES-GCM encryption for environment secrets, with platform-native encryption via Electron's `safeStorage` API (`src/main/ipc/secret-storage.ts`)
- **CSP headers** — Content Security Policy defined in the root layout, restricting script sources
- **Plugin sandboxing** — third-party plugins run in a restricted context; only bundle plugins can execute main-process actions
- **Path traversal protection** — plugin discovery validates resolved paths against base directories
- **Sentry integration** — error reporting with analytics opt-in gating

### Codebase Scale

The main app package (`packages/insomnia/src/`) contains approximately 1,099 TypeScript/TSX files. The routes directory alone has 170 files totaling ~20,500 lines. Key directories by responsibility:

- `src/routes/` — 170 React Router route modules (loaders, actions, UI)
- `src/ui/components/` — React component library (editors, modals, buttons, dropdowns)
- `src/insomnia-data/` — Data layer (models, database, services)
- `src/main/` — Electron main process (IPC handlers, network, Git, MCP)
- `src/network/` — Request execution engine
- `src/plugins/` — Plugin system
- `src/templating/` — Nunjucks template rendering (Web Worker)
- `src/sync/` — Git-based sync/VCS
- `src/account/` — Authentication and encryption

## Assessment

### Strengths

1. **Clean IoC architecture.** The Proxy-based dependency injection for both database and services is lightweight yet effective, enabling the same business logic to run in Electron's main process, renderer (via IPC bridge), and CLI tool without code duplication.

2. **Modern routing pattern.** The adoption of React Router 7's file-system routing with `clientLoader`/`clientAction` provides a clean separation between data fetching, mutations, and UI rendering across 170 routes.

3. **Protocol breadth.** Supporting REST, GraphQL, gRPC, WebSocket, Socket.IO, and MCP in a single application is a significant engineering achievement. Each protocol has dedicated IPC handlers and typed bridge APIs.

4. **Security-conscious design.** Context isolation, CSP headers, plugin sandboxing, AES-GCM vault encryption, and the renderer Node-import checker demonstrate a mature security posture for an Electron app.

5. **Extensible plugin system.** The plugin architecture supports template tags, hooks, themes, and actions, with both user-installed and bundled plugin pathways. The separation between third-party and bundle plugin capabilities is well-designed.

6. **MCP integration.** Being an early adopter of the Model Context Protocol positions Insomnia as a bridge between API development and AI tooling ecosystems.

### Concerns

1. **Node.js version requirement.** Requiring Node >= 24 is unusually aggressive and may limit contributor onboarding. This likely reflects a dependency on very recent V8 features or native module requirements, but could be a friction point.

2. **Large dependency surface.** The main app has ~150+ production dependencies including some heavy libraries (`jsdom`, `monaco-editor`, `swagger-ui-dist`, `isomorphic-git`). This increases bundle size, attack surface, and maintenance burden.

3. **NeDB scaling limitations.** While NeDB is simple and embeddable, it stores data as newline-delimited JSON files and loads collections into memory. For users with large API collections (thousands of requests), this could become a performance bottleneck. There's no indexing beyond what NeDB provides natively.

4. **File-based routing at scale.** 170 route files in a single directory creates navigational complexity. While the file-system routing pattern is clean, the lack of sub-directory grouping by feature area could make it harder for new contributors to find relevant code.

5. **Proxy-based DI fragility.** The Proxy-based database and services stubs provide no compile-time safety for initialization ordering. Errors only surface at runtime when an uninitialized service is called, which could be caught earlier with explicit initialization patterns.

6. **Test coverage concentration.** While there are 176 test files, the route files (170 files, ~20,500 lines) are explicitly excluded from unit tests (`vitest.config.ts` excludes `src/routes/**.*.tsx`). The testing burden falls on E2E/Playwright tests, which are slower and more expensive to maintain.

### Recommendations

1. **Consider SQLite as a database backend.** NeDB's in-memory loading model will struggle at scale. A SQLite-backed implementation (e.g., via `better-sqlite3`) would provide indexing, queries, and ACID transactions without adding external database dependencies. The IoC architecture already makes this a pluggable change.

2. **Add route-level unit testing infrastructure.** The current exclusion of route files from Vitest means the bulk of application logic goes untested at the unit level. Consider extracting loader/action logic into testable service functions.

3. **Reduce dependency count.** Audit the 150+ dependencies for consolidation opportunities. Several libraries (e.g., both `codemirror` and `monaco-editor`) provide overlapping editor functionality. Standardizing on one would reduce bundle size.

4. **Document the architecture more thoroughly.** The `AGENTS.md` file is excellent for AI contributors but there's no equivalent `ARCHITECTURE.md` for human contributors. The IoC pattern, database layering, and IPC bridge design deserve human-readable documentation.

5. **Explore a migration from Nunjucks.** Nunjucks is the template engine for environment variable substitution, but it requires a Web Worker to avoid blocking the UI. A lighter-weight template engine (or a custom parser) could simplify the rendering pipeline.

## Related

- analyzing-traefik
- analyzing-litellm
- analyzing-fluent-bit
- analyzing-dockflare
