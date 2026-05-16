---
title: "Analyzing n8n-as-code"
date: 2026-05-16
type: codebase-analysis
status: complete
source: https://github.com/EtienneLescot/n8n-as-code
tags: [typescript, n8n, workflow-automation, infrastructure-as-code, gitops, vscode, mcp, ai-skills]
---

# Analyzing n8n-as-code

> **Source:** [EtienneLescot/n8n-as-code](https://github.com/EtienneLescot/n8n-as-code) @ [`e86c39f`](https://github.com/EtienneLescot/n8n-as-code/commit/e86c39fa20aae6ad3d27165df4869d4011b4295c)
>
> TypeScript monorepo · 1,204 ★ · 149 forks · MIT license · Created January 2026

## Overview

n8n-as-code turns a git repository into a full n8n development workspace — letting you build, edit, sync, and validate n8n workflows using TypeScript, VS Code, CLI tools, and AI agents. It bridges the gap between n8n's visual workflow builder and a code-first development workflow: workflows can be authored as decorated TypeScript classes, stored in version control, synced bidirectionally with n8n instances, and handed off to AI coding agents with grounded knowledge of n8n's 537 nodes and 7,700+ templates.

The project is a TypeScript monorepo with 8 packages, 1 plugin, and an AI skills layer. Its core value proposition is making n8n workflows **reviewable, diffable, and composable** — treating them as code rather than opaque JSON blobs managed through a web UI.

> [!note]
> n8n-as-code is an independent community project, not affiliated with or endorsed by n8n.

## How It Works

The system has three conceptual layers:

1. **Workflow Authoring** — A decorator-based TypeScript DSL (`@workflow`, `@node`, `@links`) that represents n8n workflows as classes. The transformer package converts bidirectionally between n8n JSON and TypeScript via an intermediate AST. The TypeScript form includes a machine-readable `workflow-map` comment block that AI agents can scan before reading the full file.

2. **Sync & Environments** — A GitOps-style sync engine (explicit pull/push, no background sync) maps local workflow files to n8n instances through named **environments**. Each environment binds an instance target, an n8n project, and a physical sync folder. Workflow promotion between environments (dev → staging → prod) is an explicit command, not a background operation.

3. **AI Agent Skills** — A knowledge base of 537 node schemas, enriched with documentation, parameter gating rules, and 7,700+ template workflows indexed with FlexSearch. This layer provides grounded context to AI agents (Claude Code, Cursor, any MCP client) so they can author, validate, and troubleshoot n8n workflows without hallucinated node types or connections.

The separation of concerns is clean: the transformer owns the JSON↔TS representation, the skills package owns the agent knowledge layer, the CLI orchestrates sync and environments, and the VS Code extension provides the visual workspace.

## Architecture

```
packages/
  cli/             — Commander.js CLI (n8nac): sync, env, promote, test, convert
  transformer/     — Bidirectional JSON ↔ TypeScript (decorators + ts-morph)
  skills/          — AI knowledge base: node schemas, docs, search, validation
  mcp/             — MCP server exposing n8n-as-code tools to any MCP client
  workflow-core/   — Shared contracts and public workflow authoring API
  vscode-extension/ — Editor experience: sidebar, canvas, Agent Workbench
  telemetry/       — Usage telemetry
  manager-adapter/ — Bridge to n8n-manager for local instance lifecycle
plugins/
  openclaw/        — OpenClaw plugin integration
skills/
  n8n-architect/   — Portable AI skill for agents working with n8n-as-code
```

The data flow for the core transform is:

```
n8n JSON ──[JsonToAstParser]──► WorkflowAST ──[AstToTypeScriptGenerator]──► .workflow.ts
  .workflow.ts ──[TypeScriptParser]──► WorkflowAST ──[WorkflowBuilder]──► n8n JSON
```

Both directions share the same AST representation. The AST includes explicit tracking of n8n's AI agent connections (`ai_languageModel`, `ai_memory`, `ai_tool`, etc.) as first-class `aiDependencies` on nodes, rather than flattening them into generic connections.

## The Spine

A workflow's lifecycle through the system:

1. **Pull** — `n8nac pull <id>` fetches JSON from the n8n API, transforms it to AST, generates a `.workflow.ts` file with the decorator DSL and an embedded workflow-map comment for agent orientation.

2. **Edit** — A developer or AI agent edits the `.workflow.ts` file. The decorators carry all metadata (node IDs, positions, credentials, retry policies). Connections are expressed as method chains: `this.ScheduleTrigger.out(0).to(this.HttpRequest.in(0))`.

3. **Validate** — `n8nac skills validate <file>` checks the workflow against n8n's node schemas and parameter gating rules (e.g., "this parameter only exists when resource=`message`").

4. **Push** — `n8nac push <file> --verify` converts the TS back to JSON and POSTs/PUTs to the n8n API. The sync engine handles conflict detection, optimistic concurrency checks, and state tracking.

5. **Test** — `n8nac test <file>` inspects the workflow for trigger nodes, builds a test plan (detecting webhook URLs, form endpoints, chat triggers), and can execute the webhook to verify the workflow runs.

The environment model routes all of this through a specific n8n instance + project + sync folder combination, making multi-environment workflows (dev/staging/prod) explicit and safe.

## Key Patterns

**Decorator-based DSL, not runtime eval.** The TypeScript workflow files are *notation*, not executable code. The transformer uses `ts-morph` for static AST parsing — it walks the TypeScript AST to extract decorator metadata, node parameters, and connection definitions. There's no `eval()`, no runtime execution. This means workflow files are safe to open and parse even from untrusted sources.

**Explicit sync with conflict detection.** Unlike tools that continuously sync in the background, n8n-as-code requires explicit pull/push commands. The sync engine tracks workflow state via a `WorkflowStateTracker` that records hash-based signatures. Four sync statuses drive behavior: `EXIST_ONLY_LOCALLY`, `EXIST_ONLY_REMOTELY`, `TRACKED`, `CONFLICT`. Conflicts halt execution and require explicit resolution — no silent overwrites.

**AI-first design.** Every generated `.workflow.ts` file includes a `workflow-map` comment block that agents can cheaply scan before reading the full file: it lists all nodes with their types and flags, and renders an ASCII routing map of connections. The skills package indexes 7,700+ workflow templates so agents can search by natural language descriptions and find relevant examples.

**Environment abstraction over raw instances.** Version 2+ introduced a deliberate two-step model: first define an *instance target* (either a global reference to a managed local instance, or an embedded public URL descriptor), then create an *environment* that binds that target to a specific project and sync folder. Commands run against the pinned environment, and promotion between environments is an explicit deployment action. This replaces the earlier singleton workspace model (one active instance, one sync folder, one project).

**AST-based separation of concern types.** n8n has two kinds of connections: regular main/error connections between nodes, and AI-specific sub-node dependencies (`ai_languageModel`, `ai_tool`, `ai_memory`, etc.). The AST and parser handle these differently — AI connections are stored as `aiDependencies` on the consumer node, while regular connections are standalone `ConnectionAST` entries. This matters because AI tool arrays and document arrays need to serialize/deserialize correctly across the JSON↔TS boundary.

**Unicode-aware naming.** The property name generator uses `\p{Letter}` Unicode property escapes, supporting CJK, Hangul, Arabic, Cyrillic, and other scripts in generated identifiers. The TypeScript parser uses the same pattern so round-trips are consistent.

## Non-Obvious Details

**The `workflowDir` is opaque.** Users configure a `syncFolder`, but the actual `workflowDir` (where files land on disk) is computed by the backend from the sync folder, instance identifier, and project slug. The skill tells agents to never reconstruct this path manually — always resolve it from `n8nac env status --json`. This prevents path drift when identifiers change.

**The transformer's static evaluator is intentionally limited.** `extractValueFromASTNode` in the TypeScript parser handles only literal values (strings, numbers, booleans, null, undefined, plain objects, arrays, negative numbers). Any expression involving function calls, variable references, or template substitutions throws an error. This is by design — workflow files are notation, not programs.

**Promotion rewrites project metadata.** When you promote a workflow from Dev to Prod, the command strips source-only IDs for new targets, rewrites `projectId`/`projectName` to the target project, and can preserve the existing target workflow ID if the file already exists. Promotion also pushes to the target remote by default — it's a deploy, not just a copy.

**The architecture spec is both current-state and target-state.** The `architecture/target/workspace-environments-and-promotion.md` file is 2,500 lines long and mixes specification of the desired model with annotations about what's already implemented. The MVP contract section explicitly lists what's in scope vs deferred — useful for contributors but a risk for documentation drift.

**Manual testing doc is bilingual.** `MANUAL_TESTING.md` is written in French with English code snippets, reflecting the primary author's language and the project's small-team origins.

**Multiple testing frameworks.** The monorepo uses both Vitest (CLI, transformer, VS Code extension) and Jest (skills, MCP server). This is common in rapidly-assembled monorepos but adds CI complexity.

## Assessment

**Strengths**

- **Deep n8n integration.** The transformer handles n8n's entire node model including AI agent sub-node dependencies, credentials, retry policies, error routing, and webhook triggers. This isn't a shallow mapping — it captures the full workflow surface.
- **Clean bidirectional transform.** The AST-based approach with static ts-morph parsing avoids the fragility of regex-based transformers and the security risks of runtime eval. The decorator DSL is genuinely readable.
- **Agent-oriented by design.** The workflow-map comments, AI skills package, MCP server, and Claude Code plugin show consistent thinking about how AI agents interact with n8n workflows. This is the project's differentiator.
- **Explicit operations, no magic.** Pull, push, promote — every state mutation is intentional. The sync engine's four-way status model makes the sync state legible.
- **Well-scoped CLI.** Commander.js with clean command groups (`env`, `workspace`, `skills`, `workflow`, `test`) and sensible defaults.

**Concerns**

- **Bus factor of 1.** The primary author (EtienneLescot) is the sole significant contributor. For a project with 1,200 stars and published npm packages, this is the biggest risk.
- **Very young codebase.** The repo was created January 2026 — 4.5 months old. The API surface is still evolving (V1→V2 migration, workspace model changes).
- **Heavy architecture spec.** A 2,500-line spec that mixes target architecture with current-state annotations is hard to maintain. As the implementation evolves, the spec will diverge unless continuously updated.
- **Dual test frameworks.** Jest and Vitest coexist. This works but adds cognitive overhead and CI configuration burden. Standardizing on one would be a quality-of-life improvement.
- **Limited integration tests.** The manual testing doc suggests several features (TS→JSON conversion, batch convert, skills validate for TS) were still unchecked at the time of writing. The `test:integration` script exists but depends on a live n8n instance.

> [!question]
> How stable is the V2 environment model? The architecture doc indicates it's the target but not fully realized — several MVP items are marked as deferred. The CLI already exposes `n8nac env` commands, so the API surface may still shift.

**Bottom line:** n8n-as-code is a thoughtfully designed toolkit that fills a real gap in the n8n ecosystem. Its agent-oriented architecture is forward-looking and aligns with the direction of AI-assisted development. The main risk is maintainer bandwidth — the project has strong fundamentals but needs community contribution depth to sustain its trajectory.
