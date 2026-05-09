---
title: "Analyzing Snyk Agent Scan"
date: 2026-05-09
type: codebase-analysis
status: complete
source: https://github.com/snyk/agent-scan
tags: [devsecops, snyk, security-scanning, ai-agents, code-analysis]
---

## Overview

Snyk Agent Scan (v0.5.1) is a CLI-based security scanner for the AI agent supply chain. It auto-discovers agent components — MCP (Model Context Protocol) servers, agent skills, and client configurations — installed on a developer's machine, then analyzes them for prompt injections, tool poisoning, toxic flows, malware payloads, and credential leaks. The project, originally known as "mcp-scan" from Invariant Labs (acquired by Snyk), has evolved rapidly through 50+ releases and now supports 13 agent platforms across macOS, Linux, and Windows, including WSL.

In an ecosystem where developers are increasingly installing third-party MCP servers and agent skills from untrusted sources, Agent Scan fills a critical gap: there is no equivalent of `npm audit` or `snyk test` for agent extensions. The tool's "Background Mode" integration with Snyk Evo and MDM/Crowdstrike further positions it as an enterprise-grade monitoring solution, not just a one-off developer CLI.

The codebase is compact (~5,800 lines of Python across 23 source files) with a clean modular architecture, comprehensive test coverage, and thoughtful security controls like interactive consent prompts and data redaction.

## Key Findings

### Architecture and Code Structure

Agent Scan follows a pipeline architecture with clear separation of concerns across four phases: **discover → inspect → analyze → push**.

```
src/agent_scan/
├── cli.py              (791 lines) — CLI argument parsing and command dispatch
├── pipelines.py        (264 lines) — Pipeline orchestration (discover/inspect/analyze/push)
├── inspect.py          (381 lines) — Client inspection and server enumeration
├── mcp_client.py       (369 lines) — MCP protocol client (stdio, SSE, HTTP)
├── skill_client.py     (154 lines) — Agent skill parsing (SKILL.md traversal)
├── models.py           (606 lines) — Pydantic models, config parsing, type definitions
├── verify_api.py       (318 lines) — Snyk analysis API client with retry logic
├── upload.py           (149 lines) — Control server upload with retry/backoff
├── guard.py            (838 lines) — Agent Guard hook management (Claude/Cursor)
├── consent.py          (133 lines) — Interactive consent UI for stdio MCP servers
├── redact.py           (203 lines) — Sensitive data redaction before API calls
├── printer.py          (387 lines) — Rich terminal output formatting
├── direct_scanner.py   (47 lines)  — Direct scan from package URLs (npm/pypi/oci)
├── well_known_clients.py (484 lines) — Agent path definitions per OS
├── traffic_capture.py  (275 lines) — MCP protocol traffic capture for debugging
├── signed_binary.py    (72 lines)  — macOS code signature verification
├── pushkeys.py         — Push key minting/revocation for enterprise mode
├── utils.py            (164 lines) — Helper utilities
├── run.py              (16 lines)  — Entry point
├── version.py          — Version info
├── hooks/              — Agent Guard shell scripts (bash + PowerShell)
└── ...
```

The entry point `run.py` is minimal — it wraps `asyncio.run(main())` with clean exception handling for `SnykTokenError` and `MissingIdentifierError`. The `cli.py` module is the largest file at 791 lines, handling argparse setup for `scan`, `inspect`, `guard`, `evo`, and `help` commands. The actual scanning pipeline in `pipelines.py` is notably lean at 264 lines, delegating to well-defined functions in `inspect.py`, `verify_api.py`, and `upload.py`.

### Scanning Capabilities

Agent Scan detects **20+ distinct security issue codes** organized into four categories:

**Compromised MCP Servers:**
- E001 (critical): Prompt injection in tool description — hidden adversarial instructions embedded in tool metadata
- E002 (high): Cross-server tool reference / tool shadowing — a malicious server interfering with tools from another
- W001 (low): Suspicious words in tool descriptions (e.g., "important", "ignore", "override")

**Toxic Flows (MCP):**
- W015–W020: Graduated warnings for untrusted content, sensitive data exposure, and destructive capabilities, inspired by Invariant Labs' and Simon Willison's "lethal trifecta" research

**Compromised Skills:**
- E004 (critical): Prompt injection in skill instructions
- E005 (critical): Suspicious download URLs in skill content
- E006 (critical): Malicious code patterns (data exfiltration, backdoors, RCE)

**Vulnerable Skills:**
- W007–W014: Insecure credential handling, hardcoded secrets, financial execution capability, unverifiable external dependencies, system service modification

The analysis itself is performed server-side by the Snyk analysis API at `api.snyk.io/hidden/mcp-scan/analysis-machine`. The local CLI collects tool descriptions, prompts, resources, and skill content; the API returns structured issues with severity ratings. This means the scanning intelligence lives behind Snyk's API — the open-source client is primarily a data collection and presentation layer.

### Multi-Agent Discovery

The `well_known_clients.py` module defines well-known configuration paths for 13 agent platforms across three operating systems. It supports multi-user machine scanning via `--scan-all-users` and even enumerates WSL distributions on Windows to scan Linux-style paths inside `\\wsl.localhost\<Distro>\home\<user>`.

Supported agents include Windsurf, Cursor, VS Code, Claude Desktop, Claude Code, Gemini CLI, OpenClaw, Amp, Kiro, OpenCode, Antigravity, Codex, and Amazon Q. Each entry specifies `client_exists_paths` (presence detection), `mcp_config_paths` (MCP server configs), and `skills_dir_paths` (agent skill directories).

The `inspect.py` module's `get_mcp_config_per_client()` function iterates home directories, expands tilde paths, parses MCP configuration files using Pydantic models (supporting Claude, Claude Code, VS Code, and generic JSON5 formats), and discovers both MCP servers and skills.

### Consent and Security Model

The v0.5.0 release introduced an interactive consent flow (`consent.py`) that prompts the user before starting each stdio MCP server. This is important because scanning MCP configs inherently requires executing the commands defined in them. The consent UI:

1. Shows the server name, full command with arguments, and redacted environment variables
2. Requires explicit `y/N` confirmation for each stdio server
3. Records declined servers as `user_declined` errors — they are never started
4. Remote (SSE/HTTP) servers are auto-allowed since they don't spawn subprocesses

For CI/CD, `--ci` mode requires `--dangerously-run-mcp-servers` to opt into automatic execution. The naming of this flag is deliberately alarming to discourage casual use.

The `redact.py` module scrubs sensitive data before uploading to Snyk's analysis API: environment variable values are replaced with `**REDACTED**`, command-line flag values are stripped, HTTP header values and URL query parameters are masked, and absolute file paths in tracebacks are redacted. This privacy-conscious design means Snyk's servers never see raw secrets or local filesystem structures.

### Agent Guard Hooks

The `guard.py` module (838 lines, the largest in the codebase) implements "Agent Guard" — a runtime monitoring system that installs hooks into Claude Code and Cursor. These hooks intercept agent events (tool use, shell execution, file operations) and report them to a Snyk Evo endpoint for centralized monitoring.

The hook installation flow:
1. Mints a push key using the Snyk API (or accepts a pre-set `PUSH_KEY` env var for MDM/headless installs)
2. Copies a shell script (`snyk-agent-guard.sh` or `.ps1`) alongside the client config
3. Edits the client's settings/hooks JSON to register the script for all supported events
4. Sends a test event to verify connectivity
5. On uninstall, revokes the push key and removes hooks while preserving non-Agent-Guard entries

Supported hook events include `PreToolUse`, `PostToolUse`, `beforeShellExecution`, `afterMCPExecution`, and others — 9 events for Claude Code and 18 for Cursor.

### Direct Scanning

The `direct_scanner.py` module enables scanning MCP servers without a local config file by specifying a URI:

```
snyk-agent-scan scan pypi:mcp-server-fetch
snyk-agent-scan scan npm:@modelcontextprotocol/server-filesystem
snyk-agent-scan scan sse:https://example.com/mcp/sse
snyk-agent-scan scan oci:ghcr.io/example/mcp-server
```

This supports seven scan types: `streamable-https`, `streamable-http`, `sse`, `pypi`, `npm`, `oci`, and `mcpb`. Package-based scans construct the appropriate stdio command (`uvx` for PyPI, `npx` for npm, `docker run` for OCI).

### Code Quality

The project uses modern Python practices:

- **Python 3.10+** with type hints throughout (using `X | Y` union syntax)
- **Pydantic v2** for all data models with field validators and serializers
- **Ruff** for linting and formatting (configured in `pyproject.toml` with a comprehensive rule set: pycodestyle, pyflakes, isort, flake8-bugbear, flake8-comprehensions, pyupgrade, flake8-simplify)
- **mypy** for type checking with `ignore_missing_imports = true`
- **pre-commit hooks** for automated quality enforcement
- **pytest** with `pytest-cov`, `pytest-asyncio`, and `pytest-lazy-fixtures`
- Test suite: 75 Python test files totaling ~17,850 lines, a strong ~3:1 test-to-source ratio

The codebase also demonstrates attention to cross-platform compatibility: `truststore.inject_into_ssl()` for enterprise TLS proxies, Windows console UTF-8 reconfiguration, PowerShell hook scripts, WSL path enumeration, and `glob`-based command resolution that checks nvm, pyenv, homebrew, and other common installation directories.

### Build and Distribution

Agent Scan is distributed via PyPI as `snyk-agent-scan`, installable with `uvx snyk-agent-scan@latest`. The `Makefile` supports building standalone binaries via PyInstaller with optional Apple code signing (`APPLE_SIGNING_IDENTITY`), cross-architecture builds for x86_64 on Apple Silicon, and self-contained Python zipapps via `shiv`.

## Assessment

### Strengths

- **First-mover in agent supply chain security.** Agent Scan is the most comprehensive tool available for scanning MCP servers and agent skills. Its detection of 20+ issue types covering prompt injection, tool poisoning, toxic flows, malware, and credential handling addresses a real and growing threat surface.

- **Thoughtful security model.** The interactive consent flow, the deliberately scary `--dangerously-run-mcp-servers` flag, sensitive data redaction before API calls, and macOS code signature checking demonstrate that the team takes the "scanning untrusted code" problem seriously. The tool doesn't blindly execute what it finds.

- **Broad agent coverage.** Supporting 13 agent platforms across macOS, Linux, and Windows (including WSL) out of the box is impressive. The well-known path definitions make it truly zero-config for most developers.

- **Enterprise-ready features.** The `guard` command for runtime hook installation, push key minting/revocation, multi-user scanning, and Snyk Evo integration suggest this tool is designed for both individual developers and security teams managing fleets of developer machines.

- **Strong code quality.** Clean architecture, modern Python patterns, comprehensive test coverage, and automated quality tooling (ruff, mypy, pre-commit) make the codebase maintainable and trustworthy.

### Concerns

- **Server-side analysis dependency.** The core detection intelligence lives behind Snyk's proprietary API. The open-source client collects data and presents results but cannot perform analysis offline. Users must have a Snyk API token, and the tool sends tool descriptions, prompts, and skill content to Snyk servers (albeit redacted). This limits utility in air-gapped environments and creates a vendor lock-in risk.

- **Closed to contributions.** The README explicitly states "Agent Scan does not accept external contributions at this time." While understandable for a Snyk-owned security tool, this limits community-driven improvements and security auditing.

- **Subprocess execution risk.** Despite the consent flow, the fundamental approach of executing untrusted MCP server commands is inherently risky. A compromised server could exploit the scanning environment even in a sandbox, particularly through environment variable injection or malicious command arguments.

- **Large CLI module.** The `cli.py` file at 791 lines handles argument parsing, command dispatch, and guard subcommand setup in a single file. This could benefit from decomposition into separate command modules.

- **Typo in error handling.** The `skill_client.py` module at line 125 contains `"The file is not a bianry"` — a minor but notable misspelling in error messaging.

### Recommendations

- **Add offline/local analysis mode.** Even a reduced-functionality local analysis mode (pattern-matching for known prompt injection patterns, hardcoded secret detection) would significantly improve utility for air-gapped or rate-limited scenarios.

- **Sandbox guidance.** Provide official Docker images or sandboxing scripts for safe scanning of untrusted MCP configs. The README recommends running in a sandbox but doesn't provide tooling.

- **Consider modular command structure.** Break `cli.py` into separate command modules to improve maintainability as the tool grows.

- **Document the analysis API contract.** Publishing the API request/response schema would enable third-party analysis backends and reduce vendor lock-in concerns.

## Related

- [[analyzing-gitleaks]] — secret detection in git history
- [[analyzing-trufflehog]] — credential scanning across repositories
- [[analyzing-stride-gpt]] — threat modeling for AI systems
- [[analyzing-clawdstrike]] — endpoint security and fleet management
- [[analyzing-ship-safe]] — CI/CD security pipeline tooling
