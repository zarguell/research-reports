---
title: "Analyzing Multica"
date: 2025-05-10
type: codebase-analysis
status: complete
source: https://github.com/multica-ai/multica
tags: [ai-agents, task-management, go, typescript, nextjs, electron, monorepo, open-source]
---

## Overview

Multica is an open-source managed AI agent platform that turns coding agents into first-class team members. The name is a nod to Multics — the pioneering time-sharing OS — repurposed for an era where autonomous agents and humans share the same project board. Instead of copy-pasting prompts into individual agent sessions, teams assign issues to agents the same way they'd assign them to human colleagues. Agents pick up work, write code, report blockers, and update statuses autonomously.

The platform supports 11 agent runtimes (Claude Code, Codex, GitHub Copilot CLI, OpenClaw, OpenCode, Hermes, Gemini, Pi, Cursor Agent, Kimi, Kiro CLI) through a local daemon that auto-detects installed CLIs. It provides a full task lifecycle — enqueue, claim, start, complete/fail — with real-time progress streaming via WebSocket. Skills (reusable solutions) compound over time across the team.

Licensed under a modified Apache 2.0 with commercial hosting restrictions, Multica targets 2–10 person AI-native teams and offers both a cloud-hosted edition and self-hosted Docker deployment.

## Key Findings

### Architecture

Multica uses a Go backend + TypeScript monorepo frontend architecture with clear separation of concerns:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│   Next.js    │────>│  Go Backend  │────>│   PostgreSQL     │
│   Frontend   │<────│  (Chi + WS)  │<────│   (pgvector)     │
└──────────────┘     └──────┬───────┘     └──────────────────┘
                            │
                     ┌──────┴───────┐
                     │ Agent Daemon │  runs on developer machine
                     └──────────────┘
```

**Backend** (`server/`): 344 Go source files (~70K lines) organized into a clean internal package structure:

- `internal/handler/` — HTTP/WS handlers (auth, issues, agents, autopilot, chat, comments, etc.)
- `internal/service/` — Business logic layer (task service, autopilot service)
- `internal/realtime/` — WebSocket hub with optional Redis-backed sharded relay for multi-node deployments
- `internal/daemonws/` — Separate WebSocket hub for daemon-to-server communication
- `internal/events/` — In-process event bus for decoupled listeners
- `pkg/db/` — sqlc-generated database queries from raw SQL in `pkg/db/queries/`
- `pkg/protocol/` — Shared protocol types for daemon ↔ server messages

The server main (`server/cmd/server/main.go`) wires up PostgreSQL via pgxpool, an event bus, a WebSocket hub, optional Redis relay (configurable in sharded/dual/legacy modes), background workers (runtime sweeper, autopilot scheduler, heartbeat scheduler, DB stats logger), and a Prometheus metrics endpoint.

**Frontend** (`packages/` + `apps/`): ~66K lines of TypeScript/TSK organized as a pnpm workspace monorepo with Turborepo:

- `packages/core/` — Headless business logic: Zustand stores, React Query hooks, API client, WebSocket client, i18n, navigation abstraction. Zero `react-dom`, zero `localStorage`, zero `process.env`.
- `packages/ui/` — Atomic UI components (shadcn/Base UI). Zero `@multica/core` imports.
- `packages/views/` — Shared business pages and components. Zero `next/*` or `react-router-dom` imports.
- `apps/web/` — Next.js 16 App Router frontend. Platform-specific code lives in `app/` and `platform/`.
- `apps/desktop/` — Electron desktop app via electron-vite. Multi-tab workspace UI with per-tab memory router.
- `apps/docs/` — Documentation site (Fumadocs) with i18n (English + Chinese).

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend Language | Go 1.26 |
| HTTP Router | Chi v5 |
| Database | PostgreSQL 17 + pgvector |
| DB Access | sqlc (compile-time SQL generation) |
| Realtime | gorilla/websocket + optional Redis streams |
| Auth | JWT (golang-jwt/v5) + email verification (Resend) + Google OAuth |
| CLI Framework | Cobra |
| Frontend Framework | Next.js 16 (App Router) |
| Desktop Framework | Electron (electron-vite) |
| State Management | Zustand (client) + TanStack Query (server) |
| UI Components | shadcn (Base UI primitives, not Radix) |
| Styling | Tailwind CSS v4 |
| Monorepo Tooling | pnpm workspaces + Turborepo |
| Package Management | pnpm catalog for version pinning |
| Schema Validation | Zod v4 (API response boundary) |
| CI | GitHub Actions |
| Containerization | Docker multi-stage builds |
| Analytics | PostHog (optional) |

### Code Quality

**Strengths:**

- **Exceptional architectural documentation.** `CLAUDE.md` (390 lines) and `AGENTS.md` provide comprehensive guidance on architecture, state management rules, package boundaries, coding conventions, and testing strategies. This is some of the most thorough internal documentation I've seen in a codebase.

- **Strict package boundaries enforced by convention.** The `packages/core/ → packages/ui/ → packages/views/` dependency direction is documented and enforced. Rules like "zero react-dom in core" and "zero next/* in views" enable true cross-platform reuse between Next.js and Electron.

- **Defensive API boundary pattern.** All API responses go through `parseWithFallback` from `packages/core/api/schema.ts` using Zod schemas. This addresses the real-world problem of desktop apps hitting newer backend versions — the codebase documents three specific incidents (#2143, #2147, #2192) that motivated this pattern.

- **Robust UUID parsing conventions.** After incident #1661 (silent zero-UUID DELETE), the handler layer enforces typed UUID parsing: `parseUUIDOrBadRequest` for user input, loader-based resolution for polymorphic identifiers, and `parseUUID` (panics) only for trusted round-trips.

- **Comprehensive test coverage:** 72 TS/TSX test files in packages, 13 in apps, 133 Go test files. E2E tests via Playwright with self-contained fixtures (`TestApiClient`).

- **Reserved slug system.** Route namespace collisions are prevented by a single JSON source of truth (`server/internal/handler/reserved_slugs.json`) with a generated TypeScript counterpart, validated in CI.

**Observations:**

- The `server/internal/handler/handler.go` at 590 lines holds a large `Handler` struct with many dependencies — this could benefit from further decomposition, though the per-domain handler files (auth, issue, agent, etc.) show clear functional separation.

- The `Makefile` at 310 lines is well-organized with clear target categories, worktree support, and defensive checks (`REQUIRE_ENV`).

### Security

- **Auth:** Email-based OTP verification with optional Google OAuth. JWT tokens with configurable secrets. Personal Access Tokens for CLI/daemon auth. Signup can be restricted by email domain or exact address.
- **Production hardening:** `APP_ENV=production` disables dev verification codes. `JWT_SECRET` warning on startup. CORS is configurable via environment variables.
- **WebSocket authorization:** A scope-based authorizer (`scope_authorizer.go`) gates realtime subscriptions per workspace membership.
- **Secrets management:** AWS Secrets Manager support for CloudFront private keys. S3 for file uploads with CloudFront signed URLs.
- **Known concern:** The `.env.example` contains placeholder values that could be accidentally deployed (`JWT_SECRET=change-me-in-production`). The self-hosting Docker Compose defaults to this insecure value.

### Realtime Architecture

The realtime system has evolved from a simple in-memory hub to a production-grade multi-node relay:

- **Single-node mode:** In-memory `realtime.Hub` goroutine handles WebSocket fanout.
- **Multi-node mode:** When `REDIS_URL` is set, events are published to Redis streams and relayed across nodes. Supports three modes: `sharded` (default, per-workspace hash slots), `dual` (mirrored sharded + legacy), and `legacy` (single stream).
- **Daemon WebSocket hub:** Separate from the user-facing hub. Daemons connect, register runtimes, receive task assignments, stream output. Wakeup notifications route through the realtime relay when Redis is enabled.
- **Background sweepers:** Runtime sweeper marks stale runtimes offline. Heartbeat scheduler batches heartbeat writes. Autopilot scheduler and failure monitor run as goroutine workers.

### Cross-Platform Design

The desktop app (`apps/desktop/`) demonstrates sophisticated engineering:

- **Multi-tab architecture:** Per-workspace tab groups with isolated memory routers. Cross-workspace navigation is intercepted and translated into workspace switches rather than in-tab navigation.
- **Route categories:** Session routes (workspace pages), transition flows (WindowOverlay state, not routes), and error/stale states (auto-heal by dropping stale tabs). This prevents bugs from mixing URL-bar paradigms with windowed desktop UX.
- **Bundled CLI:** The desktop app bundles the `multica` CLI binary and manages its own daemon instance with isolated profiles.
- **Auto-update:** Version decision logic in `version-decision.ts` handles update flow.

### Developer Experience

- **`make dev`**: One command bootstrap — creates env, installs deps, starts PostgreSQL, runs migrations, launches backend + frontend.
- **Worktree support:** First-class git worktree workflow with per-worktree databases and ports, all sharing one PostgreSQL container.
- **Full-stack isolated testing:** Automated test environment with dynamic profile naming, CLI config generation, and daemon startup from source — designed for CI/AI workflows.
- **Bilingual documentation:** English + Chinese docs site with i18n infrastructure.

## Assessment

### Strengths

1. **Architectural maturity beyond typical early-stage projects.** The strict separation between server/client state, the defensive API boundary pattern, and the cross-platform package architecture show lessons learned from production incidents. The documentation explicitly references bug numbers motivating each convention.

2. **Agent runtime abstraction is well-designed.** Supporting 11 different agent CLIs through a unified daemon interface is ambitious and well-executed. The daemon auto-detects CLIs, manages lifecycle, and streams output through a consistent protocol.

3. **Operational depth.** Redis-backed realtime relay with sharding, batched heartbeat writes, runtime sweepers, Prometheus metrics, graceful shutdown ordering — these are production concerns that many open-source projects defer indefinitely.

4. **Documentation quality.** `CLAUDE.md` is effectively an architectural decision record combined with a coding style guide. It's rare to see this level of internal documentation.

### Concerns

1. **Monorepo complexity.** Three frontend apps + three shared packages + Go backend + E2E tests is a lot of surface area. The pnpm catalog and Turborepo help, but onboarding cost is non-trivial despite excellent docs.

2. **License ambiguity.** The modified Apache 2.0 with commercial hosting restrictions may deter contributions from companies that need license clarity. The contributor agreement (section 2) granting broad commercial use rights to "the producer" is aggressive.

3. **Single-storage assumption.** The PostgreSQL + optional Redis model is sound, but the sqlc-generated queries are tightly coupled to PostgreSQL (using pgtype, pgvector). Migrating to another database would require substantial rewrite.

4. **Desktop app version drift.** The architecture explicitly addresses this with schema validation and defensive parsing, but the fundamental tension — installed Electron apps talking to evolving backends — remains an ongoing maintenance burden.

### Recommendations

- **Consider extracting the agent daemon protocol** as a standalone spec. The `pkg/protocol/` package could become a public interface enabling third-party runtime integrations.
- **Add OpenAPI/JSON Schema generation** for the REST API. Currently the API contract exists only as Go handler code and Zod schemas on the frontend — a machine-readable spec would benefit both documentation and client generation.
- **Investigate HTTP/2 or gRPC streaming** for daemon communication as an alternative to the current WebSocket-based approach, which requires custom ping/pong and reconnection logic.

## Related

- [[analyzing-paperclip]] — Multica's README explicitly compares itself to Paperclip (solo agent company simulator vs. team collaboration platform)
- [[analyzing-hermes-agent]] — Hermes is one of the 11 supported agent runtimes in Multica's daemon
- [[analyzing-picoclaw]] — Related AI agent tool; similar space of agent orchestration
- [[analyzing-bifrost]] — Infrastructure comparison; Bifrost operates in the AI gateway/proxy layer that could complement Multica's agent management
- [[analyzing-graphify]] — Another AI-native tool analysis
