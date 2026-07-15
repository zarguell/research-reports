---
title: "Building a Platform on Pi: Fork, Strip, Serve"
date: 2026-07-15
type: technical-deep-dive
status: complete
tags: [typescript, ai-agent, architecture, pi, platform-engineering]
---

# Building a Platform on Pi: Fork, Strip, Serve

## What It Is

Pi is a coding-agent CLI built on reusable agent and LLM packages. Its core loop accepts an application-owned transcript, system prompt, tools, model configuration, and abort signal, then emits lifecycle events while it streams model output and executes tool calls.[1]

That makes Pi a practical foundation for a custom agent service: keep your server, identity, persistence, authorization, channels, and UI outside the loop; use Pi for the parts that are expensive to rebuild correctly — streaming provider integration, tool-call orchestration, transcript management, and context handling. Start by consuming its packages; fork only when you need to control upstream changes or modify internal behavior.

At the commit analyzed here ([`dcfe36c`](https://github.com/earendil-works/pi/commit/dcfe36c79702ec240b146c45f167ab75ecddd205)), the relevant source packages are `packages/agent` and `packages/ai`; the coding-agent CLI and terminal UI are consumers layered on top.

OpenClaw proved the extreme version: fork both packages, add a server, build a multi-channel gateway. But the common case doesn't require a fork — Pi's `agentLoop()` and `Agent` class are public, designed to be driven from application code.

## The Mental Model

```
Your Platform Layer (your code)
├── Server / Gateway / Channel Adapter
├── Your Tools (only what you need)
├── Your Persistence Layer
├── Your Auth / Security / Rate Limiting
└── Your UI (web, mobile, CLI, whatever)

Pi Packages (consumed, not forked)
├── packages/agent (loop, Agent class, types, compaction)
├── packages/ai (LLM providers)
└── packages/tui (optional, only for terminal UI)
```

Agent imports types from `ai` but doesn't import `tui` at all — the TUI is a separate consumer. Drop it and the loop works fine.

## Build on Pi First, Fork When You Must

Pi's `agentLoop()` is exported directly — feed it messages, get back events.[1] The `Agent` class wraps that loop with state management, event subscriptions, queuing, tool execution, and abort handling.[1]

Start by consuming these packages from npm. Only fork when you need to:

- Alter internal loop behavior (custom tool-call scheduling, non-standard retry logic)
- Eliminate the full provider SDK dependency tree
- Pin every transitive dep for a compliance/air-gapped deployment
- Permanently diverge from upstream API changes

Otherwise you're maintaining a fork for no benefit.

## How to Build Your Platform

### Step 1: Wire the Agent

The Agent class is the per-conversation unit you instantiate for each active session:

```typescript
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";

const agent = new Agent({
  initialState: {
    model: myModel,
    systemPrompt: "You are a helpful assistant.",
    messages: [],                    // restored from persistence
    tools: myTools,
  },
});

// Subscribe to lifecycle events
agent.subscribe(async (event) => {
  if (event.type !== "turn_end") return;
  await db.sessions.upsert({
    id: sessionId,
    lastModel: agent.state.model.id,
    updatedAt: new Date(),
  });
});

// Feed a user message and await the full response
await agent.prompt("What's the weather in London?");
```

The raw `agentLoop()` function works too, if you want to control context threading yourself:

```typescript
import { agentLoop } from "@earendil-works/pi-agent-core";

const stream = agentLoop(
  [message],
  { systemPrompt, messages: storedMessages, tools: myTools },
  { model, convertToLlm: (msgs) => msgs },
  signal,
);

for await (const event of stream) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
```

That is the smallest viable request path. Production requirements begin immediately afterward.

### Step 2: Wire Your Own Tools

Pi's tool system is schema-driven via `typebox`. Only register the tools your domain needs:

```typescript
import { Type, defineTool } from "@earendil-works/pi-agent-core";

const searchWeb = defineTool({
  name: "search_web",
  description: "Search the web for current information",
  parameters: Type.Object({ query: Type.String() }),
  execute: async (toolCallId, params, signal, onUpdate) => {
    const results = await searchEngine.search(params.query);
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  },
});
```

No `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` tools unless you need them. Your platform ships only the tools your use case requires.

**Tenant-scoped tools.** The low-level tool call doesn't pass an application session object. Wrap tools with closure-bound auth:

```typescript
function makeSubmitExpenseTool(auth: AuthContext) {
  return defineTool({
    name: "submit_expense",
    async execute(_id, params) {
      await db.forUser(auth.userId).expenses.insert(params);
      return { content: [{ type: "text", text: "Expense saved" }] };
    },
  });
}
```

Tenant isolation is an application guarantee — not information the model is trusted to provide.

### Step 3: Strip What You Don't Need

If you do fork, you can drop:

- **The CLI harness** — `harness/agent-harness.ts`, `harness/skills.ts`, `harness/prompt-templates.ts` are for Pi's CLI mode. Your server calls `agentLoop()` or `Agent.prompt()` directly.
- **Compaction strategies you don't use** — `branch-summarization.ts` is for session tree browsing; if sessions are linear, keep only `compaction.ts`.
- **AI providers you won't call** — Pi ships 8+ provider SDKs. Keep only the 1-3 you use.
- **pi-tui entirely** if you want a web UI instead of a terminal one.

But avoid changing loop internals until a concrete product requirement forces it.

### Step 4: Add a Server

Minimum server: accept a message, create/restore session, call Agent, stream response.

```typescript
const sessions = new Map<string, Agent>();

app.post("/chat", async (req, res) => {
  const { message, sessionId } = req.body;
  let agent = sessions.get(sessionId);
  if (!agent) {
    agent = new Agent({ initialState: { model, systemPrompt, tools: myTools } });
    sessions.set(sessionId, agent);
  }

  res.setHeader("content-type", "text/event-stream");
  agent.subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  await agent.prompt(message);
  res.end();
});
```

Everything else — auth, rate limiting, channel connectors, persistence — is infrastructure *around* this core.

### Step 5: Add Persistence

Persistence isn't one knob. The agent loop emits events and executes tools — both are hooks where data can land anywhere. Three patterns, each right for different data.

**A) Reuse the coding agent's JSONL session format.** The coding-agent CLI writes append-only JSONL as its session log. If you build around that session layer, you get it for free. This is an optional compatibility choice, not storage automatically provided by the low-level agent package — the loop operates on in-memory `AgentContext` and emits events; it doesn't write session files itself.[1]

**B) Dedicated session DB (SQLite, Postgres).** Indexed queries, search across sessions, tag filters, user-specific history paging. Keep database loading, authorization checks, and transcript assembly in your application boundary; use `transformContext` for request-time shaping, truncation, retrieval injection, or redaction — it's a context transformation hook, not a general session-store interface.[2][1]

**C) Event/tool-driven persistence.** Subscribe to events and persist whatever subset you want wherever you want — Postgres with RLS, Kafka, S3, a webhook. Tools themselves write to a DB as part of execution:

```typescript
// Event hook persists conversation metadata
agent.subscribe(async (event) => {
  if (event.type !== "turn_end") return;
  await db.sessions.upsert({
    id: sessionId,
    turnCount: agent.state.messages.length,
    lastModel: agent.state.model.id,
  });
});

// Tool persists domain data — tenant bound via closure
function makeSubmitExpenseTool(auth: AuthContext) {
  return defineTool({
    name: "submit_expense",
    async execute(_id, params) {
      await db.forUser(auth.userId).expenses.insert(params);
      return { content: [{ type: "text", text: "Expense saved" }] };
    },
  });
}
```

| | JSONL | Session DB (SQLite/PG) | Event/Tool-driven |
|---|---|---|---|
| What persists | Full conversation | Full conversation + metadata | Selective — whatever a tool or hook writes |
| Write path | Append-only | INSERT | Any backend, any schema |
| Read path | Parse + filter | Indexed queries | Via your app's normal data layer |
| Cross-session search | Grep or streaming | `SELECT WHERE` | Your app queries its own tables |
| RLS / auth | Not applicable | Application-level | **Natively** (Postgres RLS, etc.) |
| Audit trail | Full log | Full log | Whatever the hook captures |

You'll likely use all three — JSONL as Pi's native write path (if using the coding-agent layer), a session DB for the history UI, and event/tool-driven persistence for the data your platform owns. They're not alternatives; they serve different purposes.

## Server-Side Boundaries

A platform needs more than an agent loop. Add these at the application layer:

- **Treat all tool arguments as untrusted input**, even when schema-valid. Schema validation means well-typed, not authorized.
- **Authorize every tool call** against server-side identity and tenant scope. Don't let the model decide what data a user can access.
- **Capability-scoped tools.** Make read/write/network tools scope-limited. Do not expose generic shell access in a multi-tenant service.
- **Policy chokepoint.** Use `beforeToolCall` to enforce policy (block, rate-limit, require approval) and `afterToolCall` for redaction, result normalization, auditing, and safety checks. Both are supported in Pi's Agent options.[1]
- **Bound resources.** Cap tool concurrency, execution time, result size, retries, total turns, token spend, and per-user request rates.

## Gotchas

- **The `@earendil-works/pi-ai/compat` entry point** is what agent-core imports. If you fork ai, keep the compat re-export layer intact — `streamSimple`, `Model`, `Message` etc.
- **Provider SDK versions matter.** Pi pins provider SDKs (Anthropic, OpenAI, etc.) and they update frequently. Schedule Renovate/Dependabot on provider deps.
- **Session compaction is essential for long-running agents.** Pi's compaction summarizes older turns to stay within context windows. Don't drop it — it's the hardest part to get right and Pi already did it.
- **Stream from day one.** Pi's `streamSimple` streams tokens as they arrive. A synchronous request-response wrapper loses the UX benefit. Use SSE or WebSocket.
- **The Agent class vs agentLoop() directly.** `agent.ts` provides state management, event subscriptions, and abort handling. `agent-loop.ts` is raw loop control. Start with the Agent class; drop to the raw loop when you need custom flow control.

## What This Enables

| Build | Packages | Tools | Server | Persistence | ~Effort |
|---|---|---|---|---|---|
| **Chat API** | agent + ai | 3-5 custom | Express/Fastify | SQLite | prototype: 1-2d; production: varies with identity, auth, observability |
| **Slack bot** | agent + ai | 3-5 tools + channel adapter | Bolt/Express | SQLite | same |
| **DevOps agent** | agent + ai | bash, read, write, exec | API server | JSONL or SQLite | same |
| **Research assistant** | agent + ai | web search, fetch, read | API + web UI | SQLite + vector | same |
| **Full platform** | agent + ai | your tools + MCP | Gateway + channels + cron | SQLite + vector | 1-2wks |

## When to Do This (and When Not To)

**Do it when:**
- You need custom domain tools and don't want to reinvent the loop
- You want multi-channel delivery (web + Telegram + Slack) sharing one agent backend
- You want to vendor or pin the agent loop for stability

**Don't do it when:**
- Pi's CLI already does what you need
- You're experimenting with a new agent loop paradigm (Pi's loop is standard tool-calling — you'd replace too much)
- One channel, one user, one session — `npx pi` works

## Related

- [[analyzing-openclaw-pi]] — the case study proving this pattern works at scale

> [1] Based on reading `packages/agent/src/agent-loop.ts`, `packages/agent/src/agent.ts`, and `packages/agent/src/types.ts` at commit [`dcfe36c`](https://github.com/earendil-works/pi/commit/dcfe36c79702ec240b146c45f167ab75ecddd205).
