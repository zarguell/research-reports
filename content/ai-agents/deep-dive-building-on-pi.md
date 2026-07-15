---
title: "Building a Platform on Pi: Fork, Strip, Serve"
date: 2026-07-15
type: technical-deep-dive
status: complete
tags: [typescript, ai-agent, architecture, pi, platform-engineering]
---

# Building a Platform on Pi: Fork, Strip, Serve

## What It Is

[Pi](https://github.com/earendil-works/pi) is not a product — it's an **agent engine SDK** that ships as a coding agent CLI. The CLI is the demo, not the point. The real value is the three packages under the hood:

| Package | What it gives you |
|---|---|
| `@earendil-works/pi-agent-core` | Agent class, agent loop, session management, compaction, tool execution |
| `@earendil-works/pi-ai` | Unified multi-provider LLM API (OpenAI, Anthropic, Google, Mistral, Bedrock) |
| `@earendil-works/pi-tui` | Terminal UI with differential rendering, editor, overlays |

OpenClaw proved the pattern: **fork agent-core + ai, add a server, and you've built a platform.** The agent loop is transport-agnostic — it doesn't know or care whether messages come from a TTY, a Telegram bot, an HTTP endpoint, or a WebSocket. You feed it `AgentMessage[]`, it emits `AgentEvent[]`, you wire the I/O.

## The Mental Model

```
Your Platform Layer (your code)
├── Server / Gateway / Channel Adapter
├── Your Tools (only what you need)
├── Your Persistence Layer
├── Your Auth / Security
└── Your UI (web, mobile, CLI, whatever)

Pi Layer (forked packages)
├── agent-core (loop, Agent class, types, compaction)
├── ai (LLM providers — can trim to just the ones you need)
└── [optional] tui (only if you want a terminal UI)
```

The separation is clean because Pi's `agent-core` imports types from `pi-ai` but doesn't import `pi-tui` at all. The TUI is a separate consumer of the agent, not a dependency of it. You can drop the TUI entirely and the agent loop works fine.

## How to Fork It

### Step 1: Fork the Two Packages

Create your own monorepo with:

```
packages/
  agent-core/     ← fork of @earendil-works/pi-agent-core
  ai/             ← fork of @earendil-works/pi-ai (or keep as dep)
  llm-core/       ← optional: extract the types pi-ai uses into a thinner package
```

OpenClaw forked `agent-core` and `ai` directly, then created `llm-core` as a lightweight types package that both import from. The key change: re-point imports from `@earendil-works/pi-ai` to `../../ai/src/index.ts` (or your own `@you/ai` package).

```typescript
// Before (Pi):
import { Model, Message, streamSimple } from "@earendil-works/pi-ai/compat";

// After (forked):
import { Model, Message, streamSimple } from "../../ai/src/index.ts";
```

That's — genuinely — the bulk of the diff. A few hundred import path changes and you own the agent loop.

### Step 2: Strip What You Don't Need

Pi's `agent-core` is ~4,500 lines across 30 files. Don't touch the loop logic, but you can:

- **Drop the CLI harness** — `harness/agent-harness.ts`, `harness/skills.ts`, `harness/prompt-templates.ts` are for Pi's CLI mode. Your platform calls `agentLoop()` directly.
- **Drop compaction strategies** you don't need — `branch-summarization.ts` is for session tree browsing; if you have linear sessions, keep only `compaction.ts`.
- **Trim the AI provider list** — Pi ships 8+ provider SDK deps. Your platform likely needs 1-3. Drop Anthropic + Mistral + Bedrock SDKs if you only use OpenAI and Google.
- **Drop `pi-tui` entirely** if you want a web UI instead of a terminal one.

### Step 3: Add a Server

The minimum server layer is an HTTP endpoint that:

1. Accepts a user message
2. Creates or retrieves a session
3. Calls `agentLoop()` with the message and the session context
4. Streams the response back (SSE or WebSocket)

```typescript
import { Agent, agentLoop, type AgentMessage } from "@you/agent-core";
import { streamSimple } from "@you/ai";

const agent = new Agent({ streamFn: streamSimple });

app.post("/chat", async (req, res) => {
  const { message, sessionId } = req.body;
  const context = loadSession(sessionId);

  const stream = agentLoop(
    [{ role: "user", content: [{ type: "text", text: message }] }],
    context,
    { tools: myTools },
    req.signal,
  );

  res.setHeader("content-type", "text/event-stream");
  for await (const event of stream) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
});
```

That's it. That's the platform. Everything else — auth, rate limiting, channel connectors, persistence — is infrastructure *around* this core, not inside it.

### Step 4: Wire Your Own Tools

Pi's tool system is schema-driven via `typebox`. You define tools exactly like Pi's built-in tools, but you only register the ones your use case needs:

```typescript
import { Type, defineTool } from "@you/agent-core";

const searchWeb = defineTool({
  name: "search_web",
  label: "Search Web",
  description: "Search the web for current information",
  parameters: Type.Object({ query: Type.String() }),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    const results = await searchEngine.search(params.query);
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  },
});
```

No `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` tools unless you need them. Your platform ships with *only* the tools your domain requires.

### Step 5: Add Persistence

Persistence isn't one knob. The agent loop emits events and executes tools — both are hooks where data can land anywhere. There are three patterns, each right for different data.

**A) Pi's native JSONL.** The coding agent already writes append-only JSONL as the canonical session log. You parse it on read. No dual-write, no sync, no migration. Streaming-parseable by design. Best for: session history when you don't need cross-session queries.

**B) Dedicated session DB (SQLite, Postgres).** Indexed queries, search across sessions, tag filters, user-specific history paging. You own the schema so you add metadata columns. Pi's `transformContext` hook injects stored state before each turn. Best for: multi-user, dashboards, any platform that surfaces history.

**C) Event/tool-driven persistence.** The agent loop emits `AgentEvent` objects (`message_start`, `turn_end`, `tool_result`, etc.). Subscribe to the event stream and persist whatever subset you want, wherever you want — Postgres with RLS, Kafka, S3, a webhook. Tools themselves can also write to a DB as part of execution:

```typescript
// Tool persists directly to app DB with RLS
const submitExpense = defineTool({
  name: "submit_expense",
  execute: async (id, params, signal, onUpdate, ctx) => {
    await db.expenses.insert({
      amount: params.amount,
      category: params.category,
      userId: ctx.session.userId,  // from your auth layer
    });
    // Postgres RLS enforces tenant isolation —
    // the agent never needs to think about it.
    return { content: [{ type: "text", text: "Expense saved" }] };
  },
});

// Event hook persists conversation metadata
agent.on("turn_end", async (event) => {
  await db.sessions.upsert({
    id: event.sessionId,
    turnCount: event.turnCount,
    lastModel: event.model.id,
  });
});
```

This is where RLS, audit logs, billing records, and domain-specific data live. The agent loop doesn't need to know about any of it.

| | JSONL | Session DB (SQLite/PG) | Event/Tool-driven |
|---|---|---|---|
| What persists | Full conversation | Full conversation + metadata | Selective — whatever a tool or hook writes |
| Write path | Append-only | INSERT | Any backend, any schema |
| Read path | Parse + filter | Indexed queries | Via your app's normal data layer |
| Cross-session search | Grep or streaming parser | `SELECT WHERE` | Your app queries its own tables |
| Schema changes | No-op | Migration | Your app's normal migration |
| RLS / auth | Not applicable | Application-level | **Natively** (Postgres RLS, etc.) |
| Audit trail | Full log | Full log | Whatever the hook captures |
| When to use | 1 user, linear sessions | Multi-user, search, dashboards | Domain data, compliance, multi-tenant |

You'll likely use all three — JSONL as Pi's native write path, a session DB for the history UI, and event/tool-driven persistence for the data your platform actually owns. They're not alternatives; they serve different purposes.

## What This Enables

| Build | Fork scope | Tools | Server | Persistence | ~Effort |
|---|---|---|---|---|---|
| **Chat API** | agent-core + ai + drop tui | 3-5 custom tools | Express/Fastify | SQLite | 1-2 days |
| **Slack bot** | agent-core + ai + drop tui | 3-5 tools + channel adapter | Bolt/Express | SQLite | 2-3 days |
| **DevOps agent** | agent-core + ai + drop tui | bash, read, write, exec | API server | JSONL or SQLite | 2-3 days |
| **Research assistant** | agent-core + ai + drop tui | web search, fetch, read | API + web UI | SQLite + vector store | 3-5 days |
| **Full platform** | agent-core + ai + [tui optional] | your tools + MCP | Gateway + channels + cron | SQLite + vector | 1-2 weeks |

## Gotchas

- **The `@earendil-works/pi-ai/compat` entry point** is what agent-core imports. If you fork ai, make sure the compat entry point still exports the same surface (`streamSimple`, `Model`, `Message`, etc.). Pi's `compat.ts` is a thin re-export layer — just keep it in your fork.
- **Provider SDK versions matter.** Pi pins provider SDKs (Anthropic, OpenAI, etc.) and they update frequently. Your fork inherits the pinning; schedule Renovate or Dependabot on your fork's provider deps.
- **Session compaction is essential for long-running agents.** Pi's compaction summarizes older turns to stay within context windows. Don't drop it — it's the hardest thing to get right and Pi already did it.
- **Streaming is the default.** Pi's `streamSimple` streams tokens as they arrive. If you build a synchronous request-response wrapper, you lose the UX benefit. Use SSE or WebSocket from day one.
- **The Agent class vs agentLoop() directly.** `agent.ts` provides a convenient OOP wrapper with state management. `agent-loop.ts` gives you raw loop control. Prefer the Agent class initially; drop to the raw loop when you need custom flow control.

## When to Do This (and When Not To)

**Do it when:**
- You need a custom agent with your own domain tools and you don't want to reinvent the loop
- You want multi-channel delivery (web + Telegram + Slack) sharing one agent backend
- You want to vendor the agent loop for stability (pin a Pi version, control upgrades)

**Don't do it when:**
- Pi's CLI already does what you need (why build?)
- You're experimenting with a new agent loop paradigm (Pi's loop is standard tool-calling — you'd replace too much)
- You need only 1 channel and 1 user and 1 session (just use `npx pi`)

## Related

- [[analyzing-openclaw-pi]] — the case study proving this pattern works
