---
title: "Analyzing Ghidraaas"
date: 2026-08-03
type: codebase-analysis
status: complete
source: https://github.com/Cisco-Talos/Ghidraaas
tags: [python, flask, ghidra, reverse-engineering, decompilation, docker, rest-api]
---

# Analyzing Ghidraaas

> **Source:** [Cisco-Talos/Ghidraaas](https://github.com/Cisco-Talos/Ghidraaas) @ [`ba235c4`](https://github.com/Cisco-Talos/Ghidraaas/commit/ba235c4ec48a866973d58c0cd7d8fdef74a4266a) · Apache-2.0

## How It Works

Ghidraaas wraps Ghidra's [Headless Analyzer](https://ghidra.re/ghidra_docs/analyzeHeadlessREADME.html) behind a Flask REST API. Submit a binary, get back a decompilation — no Ghidra GUI needed. It is a thin orchestration layer: 564 lines of Flask routes that shell out to Ghidra's `analyzeHeadless` command, three Ghidra Python plugins (called via `-postScript`) that extract function listings and decompiled output to JSON files, and a cleanup endpoint for lifecycle management.

The server does not embed Ghidra or use any Java bridge — each API call spawns a subprocess (`subprocess.Popen`) that runs `analyzeHeadless`, waits for it to complete, and reads the JSON output file the plugin wrote. This means every decompile or function-listing call cold-starts a Ghidra JVM instance against a persisted `.gpr` project.

There are two API families: **generic APIs** for standalone use (upload → analyze → decompile → cleanup), and **GhIDA-specific APIs** that serve as a backend for the IDA Pro plugin [GhIDA](https://github.com/Cisco-Talos/GhIDA), which lets IDA users decompile functions via Ghidra's decompiler without leaving IDA.

## Architecture

```
┌──────────────────────┐     HTTP POST/GET      ┌───────────────────────┐
│   Client (curl, IDA) │ ◄────────────────────► │  Flask API (gunicorn)  │
│   or test.py)         │                        │  flask_api.py (564LN)  │
└──────────────────────┘                        └───────┬───────────────┘
                                                         │ subprocess.Popen
                                                         ▼
                                        ┌───────────────────────────────┐
                                        │  Ghidra Headless Analyzer     │
                                        │  analyzeHeadless <project>    │
                                        │    -import <sample>           │
                                        │    -process <sha256>          │
                                        │    -postScript plugin.py      │
                                        └───────────┬───────────────────┘
                                                     │ writes JSON file to
                                                     ▼
                                        ┌───────────────────────────────┐
                                        │  ghidra_plugins/              │
                                        │    FunctionsList.py           │
                                        │    FunctionsListA.py          │
                                        │    FunctionDecompile.py       │
                                        └───────────────────────────────┘
                                        Output saved to /opt/ghidra_projects/
                                        as .gpr + .rep (persistent projects)
```

**Deployment:** Docker single-container — OpenJDK 11 base, Ghidra 9.1.2 extracted, Flask dependencies installed, entrypoint runs `gunicorn -w 2 -t 300 -b 0.0.0.0:8080 flask_api:app`.

## The Spine

A full decompile cycle hits four endpoints in sequence:

1. **`POST /ghidra/api/analyze_sample/`** — accepts a binary via multipart form (`"sample"` field), hashes it to SHA-256, saves to `SAMPLES_DIR`, checks if a `.gpr` project already exists (idempotent — skips re-analysis if cached). If not, runs `analyzeHeadless <PROJECT_DIR> <SHA256> -import <SAMPLE_PATH>`. Removes the sample file after analysis. Returns `"Analysis completed"`.

2. **`GET /ghidra/api/get_functions_list/<sha256>`** — runs `FunctionsList.py` via `-postScript` against the existing project. Plugin iterates `currentProgram.getFunctionManager().getFunctions(True)` and writes `{address: name}` pairs to a JSON file. Returns that JSON.

3. **`GET /ghidra/api/get_decompiled_function/<sha256>/<offset>`** — runs `FunctionDecompile.py` with the hex offset. Plugin creates a `DecompInterface`, finds the function at that entry point, calls `decompileFunction(function, 30, monitor)`, writes the decompiled C pseudocode to JSON.

4. **`GET /ghidra/api/analysis_terminated/<sha256>`** — removes the `.gpr` file and `.rep` project folder from disk. This is explicit lifecycle management: projects persist until the client says they're done.

The GhIDA-specific endpoints (`ida_plugin_checkin`, `ida_plugin_get_decompiled_function`, `ida_plugin_checkout`) follow the same subprocess pattern but accept `.bytes` and `.xml` files exported from IDA Pro — they reconstruct an importable binary fragment, run the decompiler, and clean up after themselves.

## Key Patterns

- **Process-per-request concurrency.** Each API call spawns its own Ghidra JVM subprocess. The Flask server uses gunicorn with 2 workers (`-w 2`), so exactly two Ghidra sessions can run concurrently. Blocking `p.wait()` means each worker is occupied for the full duration of the analysis — the 300-second gunicorn timeout is generous for a reason.

- **File-system-based IPC.** The Flask routes and Ghidra plugins communicate through JSON files on disk. The plugin writes to `<SHA256>functions_list.json` or `<SHA256>function_decompiled.json`, the Flask route reads that file and returns its content. No sockets, no pipes, no shared memory.

- **Idempotent analysis by SHA-256.** The `analyze_sample` endpoint checks for an existing `.gpr` file before re-running analysis. If the sample was already analyzed, it skips the import step and returns success immediately. The `.rep` project folder is the cache.

- **Error isolation.** Every endpoint wraps in try/except where `BadRequest` is re-raised and any other exception is caught as `"Sample analysis failed"`. The error handler always returns a string and status code — no HTML, no structured JSON error bodies.

- **Config on disk.** All paths (samples dir, output dir, Ghidra install path, script path, project dir) come from a `config.json` file loaded at module scope. The Docker build copies `docker_config.json` as `config.json` — swapping the config file is how the two deployment modes differ.

## Non-Obvious Details

- **400 MB upload limit.** `app.config["MAX_CONTENT_LENGTH"] = 400 * 1024 * 1024` in `server_init()` — tiny by Ghidra's standards. Ghidra itself handles multi-GB firmware images with ease, but this server won't. Unclear whether this is a deliberate safety cap or a legacy choice from the demo era.

- **The `launch.sh.patch` is the essential runtime fix.** The Dockerfile applies a patch to Ghidra's `support/launch.sh` that replaces the `-Xmx${MAXMEM}` heap flag (which would default to 0 if unset in headless mode) with `-XX:InitialRAMPercentage=20 -XX:MinRAMPercentage=20 -XX:MaxRAMPercentage=80`. Without this patch, the headless analyzer would crash on start. This is the single most important operational detail for anyone deploying this project.

- **No authentication at all.** Every endpoint is public. The server binds to `0.0.0.0:8080` with no API key, no token, no IP allowlist. In a Docker deployment this could be proxied behind Nginx, but the application itself has zero auth plumbing.

- **GhIDA checkin stores data by filename, not hash.** The generic API keys everything by SHA-256, but the IDA plugin endpoints use the original filename (from IDA's IDB). If two IDA users check in files with the same filename, they'll collide. The `.bytes` and `.xml` files are stored in `IDA_SAMPLES_DIR` unhashed.

- **Dependencies are frozen and ancient.** `Flask==1.0.2`, `Werkzeug==0.15.3`, `gunicorn==19.9.0`, `coloredlogs==10.0` — all pinned from the 2018–2019 era. Werkzeug 0.15.3 has known vulnerabilities. This would need updating for any modern deployment.

- **`ida_plugin_checkout` stores metadata in plain JSON in the request body, while the other IDA endpoints use multipart form.** Inconsistent: `ghida_checkout` reads `request.json` (JSON body), then calls `json.loads(request.json)` — a nested JSON-in-JSON pattern that suggests a bug. The checkin and decompile endpoints use `request.files['data'].stream.read()` for the same metadata role.

- **No test runner, no CI.** Tests are a single `test.py` that goes through all 8 API calls sequentially with `assert`-style checks and prints "All tests PASSED". No pytest, no GitHub Actions, no linting.

## Assessment

**Strengths:**

- Minimal and correct for its niche. The architecture (Flask routes → subprocess → Ghidra headless → JSON files) is exactly the right amount of complexity for a service that wraps a non-network-safe desktop analysis tool.
- The persistence strategy (keep `.gpr` projects, key by SHA-256) avoids redundant re-analysis and is operationally simple.
- Docker packaging means it deploys with one command — important because Ghidra's dependency chain (Java, native libraries, specific directory layout) is fragile.

**Concerns:**

- **No auth.** Every endpoint is public. This is a service that accepts arbitrary binaries and runs them through a full Ghidra analysis pipeline — a natural RCE vector if exposed. In practice this is meant to run behind a VPN or on localhost (the Docker uses `-p 8080:8080`), but the project doesn't say that.
- **Stale dependencies.** Werkzeug 0.15.3 has CVEs. Flask 1.0.2 is 5+ years old. Ghidra 9.1.2 (Feb 2020) is ancient — current Ghidra is at 11.x with dramatically improved decompilation.
- **Process-per-request concurrency model caps throughput.** Two gunicorn workers means at most two simultaneous analyses. Each analysis spawns a full JVM. This is fine for a team of 2–3 analysts but won't scale to CI/batch workloads.
- **Magic numbers.** The 30-second decompile timeout (`decompileFunction(function, 30, monitor)`) is hardcoded in the plugin. Larger functions will silently fail.
- **No structured error responses.** All errors return plain strings — a JSON client has to parse status codes and text, not reliable `{"error": "..."}` bodies.
- **Last commit Feb 2020.** This is an unmaintained project. It still works because the core abstraction (headless Ghidra) hasn't changed fundamentally, but new Ghidra versions may break the plugin API.

**Use when:** You need a simple, stateless Ghidra-as-a-service for a small team or local workflow, and you can accept the auth-gap by putting it behind a VPN/Tailscale. The cost of building this yourself is low (~500 lines) but the Docker packaging and the `launch.sh.patch` heap fix are the parts worth reusing.

**Don't use when:** You need auth, you need to scale beyond 2 concurrent analyses, you're using Ghidra >10.x, or you're exposing this to the internet without a reverse proxy.

## Related

- [[analyzing-ghidra-mcp]] — A newer project (2025) that exposes Ghidra's analysis to LLMs via MCP. Different architecture (Java HTTP server embedded in Ghidra GUI + Python MCP bridge), different use case (interactive AI-driven reversing vs batch API service). Ghidraaas is simpler and predates GhidraMCP by ~5 years.
