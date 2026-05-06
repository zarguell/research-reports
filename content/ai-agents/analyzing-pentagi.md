---
title: "Analyzing PentAGI"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/vxcontrol/pentagi @ 2ec8ef3
tags: [go, typescript, security, pentesting, multi-agent, langchaingo]
---

# Analyzing PentAGI

> **Source:** [vxcontrol/pentagi](https://github.com/vxcontrol/pentagi) @ [`2ec8ef3`](https://github.com/vxcontrol/pentagi/commit/2ec8ef3d9b075eabee65389fd0966de974e3acc9)

## How It Works

PentAGI is a fully autonomous AI-powered penetration testing platform built as a Go monorepo. At its core, it's a multi-agent orchestration system where specialized AI agents (Researcher, Developer, Executor, and others) collaborate to conduct penetration tests against target systems. The system uses a hierarchical execution model: **Flows** contain **Tasks**, which contain **SubTasks**, which contain **Actions** and **Artifacts**.

The architecture separates concerns cleanly: a Go backend handles all agent orchestration, LLM provider abstraction, Docker sandboxing, and database persistence, while a React/TypeScript frontend provides the UI for flow management and real-time monitoring. All tool execution happens inside isolated Docker containers, preventing accidental damage to the host system.

The key innovation is the memory system: results, successful attack patterns, and semantic relationships between findings are stored in PostgreSQL with pgvector for semantic search. This allows the system to learn across flows and improve its attack strategies over time.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Frontend (React/TS)                         │
│  Apollo Client (GraphQL) + WebSocket Subscriptions                  │
└────────────────────────────────────┬────────────────────────────────┘
                                     │ GraphQL/REST
┌────────────────────────────────────▼────────────────────────────────┐
│                         Backend (Go)                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │ REST API │  │ GraphQL  │  │  Queue   │  │  Multi-Agent System  │  │
│  │ (Gin)    │  │ (gqlgen) │  │          │  │  - Primary Agent    │  │
│  └──────────┘  └──────────┘  └──────────┘  │  - Researcher        │  │
│                                             │  - Developer         │  │
│  ┌─────────────────────────────────────────│  - Executor          │  │
│  │         LLM Provider Abstraction         │  - Adviser           │  │
│  │  OpenAI │ Anthropic │ Gemini │ Ollama  │  - Reflector         │  │
│  │  Bedrock │ DeepSeek │ GLM │ Kimi │    │  - Memorist          │  │
│  │  Qwen │ Custom HTTP                    │  └──────────────────────┘  │
│  └─────────────────────────────────────────┘                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐   │
│  │PostgreSQL│  │  Neo4j   │  │  Docker  │  │  Observability       │   │
│  │+pgvector │  │(optional)│  │ Sandbox  │  │  OpenTelemetry       │   │
│  └──────────┘  └──────────┘  └──────────┘  │  Langfuse            │   │
│                                              │  VictoriaMetrics     │   │
│  ┌──────────────────────────────────────────└──────────────────────┘   │
│  │                         Tools (20+ Built-in)                        │
│  │  nmap │ metasploit │ sqlmap │ Burp Suite │ FFUF │ Nuclei │ etc.  │
│  └──────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### Data Model Hierarchy

```
Flow (penetration test session)
└── Task (atomic objective)
    └── SubTask (agent work unit with type + context)
        └── Action → Artifact / Memory
```

## The Spine

### Entry Point Flow

1. **User creates a Flow** via UI or REST API, specifying the target and scope
2. **Backend queues the Flow** and spawns goroutines for the agent system
3. **Primary Agent** orchestrates: invokes Researcher, Developer, Executor agents based on context
4. **Executor runs tools** in isolated Docker containers via `pkg/docker/`
5. **Results stored** in PostgreSQL with pgvector embeddings for semantic memory
6. **Real-time updates** pushed to frontend via GraphQL subscriptions

### Key Packages

| Package | Role |
|--------|------|
| `pkg/providers/` | LLM provider adapters (10+ providers) + agent chain execution |
| `pkg/tools/` | Tool registry, terminal execution, sandbox management |
| `pkg/docker/` | Docker SDK wrapper for container lifecycle |
| `pkg/database/` | GORM models, SQLC queries, goose migrations |
| `pkg/graph/` | GraphQL schema (gqlgen) + resolvers |
| `pkg/csum/` | Chain summarization for context window management |
| `pkg/graphiti/` | Knowledge graph (Neo4j) integration |

## Key Patterns

### Multi-Agent Orchestration

The agent system uses a performer pattern in `pkg/providers/performer.go`. Each agent type (primary, pentester, coder, adviser, etc.) is assigned a role with specific tool call limits:

- **General agents** (Assistant, Primary, Pentester, Coder, Installer): max 100 tool calls
- **Limited agents** (Searcher, Enricher, Memorist, Generator, Reporter, Adviser, Reflector, Planner): max 20 tool calls

The `Reflector` agent is invoked when an LLM fails to generate tool calls, providing contextual guidance based on failure patterns.

### Chain Summarization

Context window management is handled via `pkg/csum/` using a ChainAST representation. It selectively summarizes older messages while preserving the last section intact. This is critical given the token costs of maintaining long agent conversations.

### Tool Execution

All penetration testing tools run inside Docker containers via `pkg/tools/terminal.go`. The terminal wrapper:
- Executes commands in isolated containers
- Handles ANSI escape codes for output formatting
- Provides timeout management (default 5 minutes per command)
- Logs all terminal output to the database

### Provider Abstraction

The `pkg/providers/` package implements a `provider.Provider` interface, with concrete implementations for each LLM. Adding a new provider requires:
1. Creating the provider package
2. Registering in `providers.go`
3. Adding to the GraphQL schema
4. Creating a database migration for the enum

## Non-Obvious Details

### Tool Call Limits and Graceful Shutdown

When approaching tool call limits, the system automatically invokes the Reflector agent to guide graceful termination. This prevents abrupt cutoffs that could leave the system in an inconsistent state.

### Execution Monitoring (Beta)

When enabled via `EXECUTION_MONITOR_ENABLED=true`, the system monitors for:
- Identical tool calls (configurable threshold, default 5)
- Total tool calls (configurable threshold, default 10)

When thresholds are exceeded, the Adviser agent is auto-invoked to course-correct. The README notes this can improve result quality by 2x at the cost of 2-3x more tokens/time.

### Runtime Provider Switching

As of v2.0.0, flows can switch LLM providers mid-execution without restart. The backend applies conditional chain normalization to preserve reasoning cache when the provider is unchanged, and converts tool call IDs when switching providers.

### Knowledge Graph Integration

The optional Neo4j integration via `pkg/graphiti/` creates semantic relationships between findings, allowing the system to build a graph of discovered vulnerabilities, affected assets, and successful attack paths.

### langchaingo Fork

The project uses a forked version of `github.com/vxcontrol/langchaingo` (instead of the upstream `sqrty-lv/langchaingo`), which provides custom provider implementations and reasoning support.

## Assessment

### Strengths

- **Clean multi-agent architecture**: Well-separated concerns with clear agent role definitions
- **Robust tool sandboxing**: All tool execution in Docker containers prevents host damage
- **Excellent LLM flexibility**: Native support for 10+ providers with standardized interface
- **Memory system**: Vector embeddings + knowledge graph provide genuine learning across flows
- **Observability**: OpenTelemetry tracing, Langfuse for LLM analytics, comprehensive logging
- **Security-first design**: Sandboxed execution, anonymization of sensitive data, Bearer token auth

### Concerns

- **Complexity**: The agent system has many moving parts (reflector, adviser, summarizer, planner), making debugging challenging
- **Cost**: Long-running flows with multiple agent types and reasoning models can accumulate significant LLM costs
- **EULA restrictions**: The EULA prohibits using the system for unauthorized security testing—self-hosting doesn't eliminate legal liability
- **Large attack surface**: 20+ built-in tools and sandbox bypass vulnerabilities could theoretically be exploited

### Recommendations

- **For evaluation**: Use the included test harnesses (`cmd/ftester`, `cmd/ctester`) before running against production targets
- **For cost control**: Enable execution monitoring selectively and set appropriate tool call limits
- **For security teams**: The system is designed for authorized testing only—ensure compliance with applicable laws and scope

> [!note]
> The project uses a forked langchaingo library (`github.com/vxcontrol/langchaingo`), which means provider implementations may diverge from upstream. When adding new providers, reference the CLAUDE.md guidance carefully—the multi-step process includes a critical REST API whitelist step that will silently fail without.
