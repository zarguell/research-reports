---
title: "Analyzing Teleport"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/gravitational/teleport
tags: [go, typescript, infrastructure-security, zero-trust, mcp, ai-agents]
---

# Analyzing Teleport

> **Source:** [gravitational/teleport](https://github.com/gravitational/teleport) @ [`2f27df2`](https://github.com/gravitational/teleport/commit/2f27df252ee3fd4eacf01173ffe7901057cd3b16)

## How It Works

Teleport is an identity-aware access proxy that replaces long-lived credentials (SSH keys, Kubernetes tokens, database passwords) with short-lived, auto-expiring mTLS and SSH certificates. It sits between users (human, machine, or AI agent) and infrastructure resources — SSH servers, Kubernetes clusters, databases, web apps, cloud consoles, and MCP servers — enforcing authentication, authorization, and audit on every connection.

The core insight: instead of managing secrets, Teleport issues ephemeral certificates tied to identity. A user authenticates once (via SSO, local auth, or hardware key), receives a short-lived certificate from Teleport's Certificate Authority, and presents that certificate to access any resource they're authorized for. The certificates auto-expire, eliminating secret rotation and credential sprawl.

In v18/v19, Teleport has expanded beyond SSH and Kubernetes to position itself as the identity plane for AI agents. The Model Context Protocol (MCP) Access feature — implemented in v18.1 — lets organizations proxy, authorize, and audit all MCP-based agent-to-tool communication through Teleport's RBAC engine. The Agentic Identity Framework (introduced in v19) adds Digital Twins (delegated agent identity), LLM access governance, and MCP server discovery.

## Architecture

Teleport is a three-service architecture, deployable as a single binary or as separate services:

```
User/AI Agent → [Proxy Service] → [Auth Service] → [Backend]
                    ↓
              [Teleport Agent] → Resource (SSH/DB/K8s/MCP Server)
```

| Service | Role |
|---------|------|
| **Auth Service** | Certificate Authority, identity provider, RBAC engine, audit log. Issues all certificates, manages users and roles. |
| **Proxy Service** | Edge gateway. Handles TLS termination, multiplexes protocols (SSH, HTTP, gRPC), forwards to the right agent. |
| **Teleport Agent** | Lightweight daemon running alongside each resource. Registers with the cluster, terminates tunnels, enforces local access. |

The **backend** is a pluggable storage layer supporting SQLite (single-node), etcd, AWS DynamoDB, Firestore, and CockroachDB. Everything — users, roles, certificates, audit events, session recordings — is stored here.

The monorepo structure mirrors this separation:

```
lib/              ← Go backend (auth, services, tbot, client libraries)
  auth/           ← Auth service: certificate issuance, identity, RBAC
  service/        ← Service bootstrap and runtime
  backend/        ← Pluggable storage backends
  proxy/          ← Proxy service: reverse tunnel, multiplexer
  srv/            ← Teleport Agent (SSH server, K8s integration)
  web/            ← Web API handlers (served to browser clients)
  reversetunnel/  ← Tunnel management for agents behind NAT/firewalls
api/              ← Go client library (protobuf types, gRPC stubs)
web/              ← TypeScript frontend (React-based web UI)
tool/             ← CLI tools (tsh, tctl, tbot)
  tsh/            ← User CLI (ssh client, K8s proxy, DB proxy)
  tctl/           ← Admin CLI (cluster management)
  tbot/           ← Machine/bot identity agent (workload identity)
proto/            ← Protobuf definitions (API contract)
docs/             ← Documentation site content
rfd/              ← RFDs (design documents)
```

## The Spine

### Entry Points

1. **`tctl`** — Admin CLI. Creates users, roles, tokens. Bootstrap operations.
2. **`tsh`** — User CLI (`tsh ssh`, `tsh proxy db`, `tsh kube`, `tsh mcp`). Main user-facing tool.
3. **`tbot`** — Machine identity daemon. Renews certificates for CI/CD, bots, and AI agents. The non-human counterpart to `tsh`.
4. **Teleport Agent** — Runs alongside SSH servers, DB instances, Kubernetes pods, or as a standalone MCP proxy. Registers with the cluster and maintains a reverse tunnel.
5. **Auth Service** — gRPC API server (via connectrpc). All certificate issuance, user management, role evaluation flows through this service.
6. **Web UI** — Served by the proxy service. React SPA with code-split routing, communicates via gRPC-web through the proxy.

### Request Lifecycle (User SSH Flow)

```
User runs: tsh ssh user@server.example.com

1. tsh → Proxy Service (443/TCP): establishes TLS connection
2. Proxy → Auth Service (gRPC): validates tsh's certificate
3. Auth Service → Backend: looks up user's roles, resource permissions
4. Proxy → Teleport Agent (reverse tunnel): forwards SSH connection
5. Teleport Agent → SSH Server: executes the SSH session locally
6. All I/O is recorded as a session (Keystroke + IO audit)
```

The MCP flow extends this pattern — instead of SSH, the proxy routes MCP tool calls through the same auth and RBAC layer, with per-tool allow/deny rules.

### Core Abstractions

| Type | Package | Purpose |
|------|---------|---------|
| `Identity` | `lib/auth/identity.go` | The authenticated principal — contains user metadata, roles, traits |
| `User` | `api/types/user.go` | User resource (human, bot, or agent) — stored in backend |
| `Role` | `api/types/role.go` | RBAC policy — defines access rules across all resource types |
| `CertAuthority` | `api/types/certauth.go` | Teleport's CA — issues and signs TLS/SSH certificates |
| `Trait` | `api/types/trait.go` | Key-value claims from SSO providers used for role mapping |
| `Backend` | `lib/backend/backend.go` | Pluggable storage interface (`Get/Create/Update/Delete/ConditionalUpdate`) |
| `Services` | `lib/services/` | CRUD operations for all resource types (users, roles, tokens, etc.) |

## Key Patterns

### Short-Lived Certificate Authentication

Everything revolves around certificates. SSH certs, TLS certs, database client certs — all issued by Teleport's CA with `NotAfter` set to `ttl` (typically 1-24 hours). This eliminates secret rotation as an operational concern.

### Protocol Multiplexing on a Single Port

The proxy service multiplexes SSH, HTTP, and gRPC on a single port. It inspects the initial bytes of each connection and routes to the appropriate handler. This is why Teleport can replace SSH bastion hosts, K8s API proxies, and database proxies with a single endpoint.

### Reverse Tunnels

Teleport Agents behind NAT or firewalls establish outbound reverse tunnels to the proxy. The proxy keeps a registry of connected agents and their capabilities. When a user connects, the proxy finds the right agent and forwards the connection through the tunnel.

### Role-Based Access Control

Roles are the atomic unit of authorization. Every role contains allow/deny rules for SSH logins, Kubernetes groups, database names/apps, and (new in v18) MCP tools. Role evaluation is deny-takes-precedence. Roles can also enforce session recording, MFA requirements, and approval workflows.

### Web UI Pattern

The web UI (`web/packages/teleport/src/`) is a React SPA with feature-based code splitting:
- **Auth** at `/web/login` — SSO redirect, local auth, passwordless WebAuthn
- **Main app** routes: Clusters, Servers, Databases, Kubernetes, Applications, MCP Servers, Activity/Audit
- Communication is gRPC-web through the proxy's connectrpc implementation (not REST)
- Built with PNPM workspace, webpack-based bundling, TypeScript

### Pluggable Backend Interface

The `Backend` interface in `lib/backend/backend.go` provides `Get`, `Create`, `Update`, `Delete`, `ConditionalUpdate`, and `ConditionalDelete` — with a `watch` API for change notification. Implementations: SQLite (bbolt-backed), etcd, DynamoDB, Firestore, CockroachDB. This is the foundation for Teleport's HA/scale capabilities.

## Non-Obvious Details

### MCP Access is Built on the Same Auth Pipeline

The MCP feature (`rfd/0209-mcp-access.md`, implemented v18.1) is not a bolted-on experiment — it reuses Teleport's existing certificate-based identity, RBAC engine, reverse tunnel infrastructure, and audit pipeline. An MCP server registers as a Teleport resource (like a database), gets a certificate, and the proxy enforces `mcp.tools` allow/deny rules on each tool invocation. The audit system already has `mcp.session.start`, `mcp.session.end`, `mcp.session.request`, and `mcp.session.notification` event types.

### The tbot Daemon is More Interesting Than It Looks

`tbot` is Teleport's machine identity agent — it's the component that handles non-human access (CI/CD, bots, workloads). It implements the Machine/Workload Identity spec, supports SPIFFE-compatible identities, and is the natural foundation for the Agentic Identity Framework's "identity for long-running agents." `tbot` can attest its identity via systemd, Kubernetes service accounts, instance metadata (AWS/GCP/Azure), or join tokens.

### Teleport Clones Its Own AGENTS.md Pattern

Teleport includes a repo-root `AGENTS.md` following Anthropic's "Make AGENTS.md" initiative, with security-focused review guidelines for AI coding assistants. The AGENTS.md explicitly prohibits commiting LLM-generated code — it's for exploration and prototyping only. This is notable given Teleport's heavy investment in AI agent infrastructure.

### Digital Twins (RFD 0238) Is Architecturally Ambitious

The concept of "Delegation Sessions" — where a user can lend a subset of their privileges to an AI workload for a limited time — requires Teleport to track identity delegation chains. The user's privileges are filtered through the workload's own identity, creating a constrained permission set. This is still in draft but represents a significant departure from the simple user-or-machine identity model.

### LLM Access Governance Is TBD

The "LLM Access" pillar of the Agentic Identity Framework (rate limiting, budgets, guardrails, prompt/response tracking) is marked as "Not started." Teleport hasn't shipped any LLM gateway functionality — it's on the roadmap but currently the Agentic Identity Framework covers MCP (shipped) and Digital Twins (draft RFD) only.

### Rust in the Stack

Teleport ships a Rust-based BPF (eBPF) component for enhanced session recording (in `bpf/` directory, with a `Cargo.toml` at the root). This is used for Linux kernel-level tracking of executed binaries during recorded SSH sessions — not a core part of the identity/auth flow, but an example of the project's commitment to defense-in-depth.

### No Separate Enterprise Repository

Unlike many enterprise open-source projects (GitLab EE/CE, HashiCorp), Teleport doesn't use a separate private repo for enterprise features. The `e/` directory at repo root is a symlink target for proprietary extensions, but the vast majority of the codebase — including MCP Access and the Agentic Identity Framework — lives in the open-source repo.

## Assessment

**Strengths:**
- **Architectural coherence** — one auth pipeline for SSH, K8s, DB, web apps, and MCP. Everything flows through the same certificate-based identity layer.
- **Pluggable backend** — SQLite for development, etcd/DynamoDB for HA. The backend interface is clean and well-defined.
- **Short-lived certificate model** elegantly solves the secret rotation problem. No shared secrets, no vault dependencies.
- **MCP support is genuinely thoughtful** — it reuses existing infrastructure rather than building a parallel system. Per-tool RBAC on MCP tool calls is a first-class feature.
- **Agentic Identity Framework is well-architected** — clean separation into identity, access, security, and orchestration pillars, with clear status indicators on each component.
- **RFD-driven design culture** — every significant feature has a design document. The RFDs are thorough and readable (RFD 0209 on MCP Access is particularly well-structured).

**Concerns:**
- **Codebase scale** — 14K+ files in Go + TypeScript. The `lib/` directory alone is 48MB. Onboarding to change a specific subsystem requires understanding the entire auth pipeline.
- **LLM Access governance is vaporware** — rate limiting, guardrails, and prompt tracking are listed as features on the Agentic Identity Framework landing page but are marked as "Not started." Customers evaluating Teleport for LLM gateway use cases should verify current capabilities carefully.
- **eBPF/session recording complexity** — the Rust BPF component adds significant build complexity (requires `libbpf`, kernel headers, cargo toolchain) for a feature that most users don't need.
- **Backend interface is transactional** — `ConditionalUpdate` with revision counters means optimistic concurrency. Under contention, clients must retry. This is fine for etcd but can be surprising with SQLite/PostgreSQL backends.

**Recommendations:**
- If evaluating Teleport for AI agent infrastructure: the MCP Access feature (v18.1+) is production-ready and well-designed. The broader Agentic Identity Framework (Digital Twins, LLM governance) is not — treat it as a roadmap, not a shipping product.
- Teleport's sweet spot remains infrastructure access (SSH, K8s, DB) with the added benefit of MCP proxy. Don't over-index on the AI agent marketing unless your primary use case is MCP server access control.
- For self-hosted deployments, use etcd or DynamoDB as the backend — SQLite (bbolt) is suitable for single-node dev/test but not production HA.

## Related

— [[analyzing-hermes-agent]] — [[analyzing-picoclaw]] — [[analyzing-rtk]] — [[analyzing-ship-safe]] — [[analyzing-stride-gpt]]