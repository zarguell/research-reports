---
title: "Analyzing Stirling-PDF"
date: 2026-05-11
type: codebase-analysis
status: complete
source: https://github.com/Stirling-Tools/Stirling-PDF
tags: [java, spring-boot, pdf, self-hosted, docker, python, react, document-processing]
---

# Analyzing Stirling-PDF

> **Source:** [Stirling-Tools/Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF) @ [`d8b4302`](https://github.com/Stirling-Tools/Stirling-PDF/commit/d8b43029dbf18b3b8f518d2bbea4e0bf4694c802)

## How It Works

Stirling-PDF is a self-hosted PDF processing platform built on three cooperating runtimes: a **Java/Spring Boot backend** that does the actual PDF work, a **React frontend** (also compiled to a Tauri desktop app), and an optional **Python FastAPI "engine"** that provides AI-powered features like document Q&A, editing via natural language, and automated review. The backend is the center of gravity — it exposes ~50+ REST endpoints for operations like merge, split, OCR, sign, compress, convert, and redact, each backed by Apache PDFBox or external CLI tools (LibreOffice, Tesseract, qpdf, etc.).

Every POST endpoint is annotated with a custom `@AutoJobPostMapping` annotation rather than Spring's standard `@PostMapping`. This triggers an AOP aspect (`AutoJobAspect`) that transparently adds async execution, retry with exponential backoff, timeout enforcement, progress tracking, and file reference resolution via a `FileStorage` service. Callers opt in by appending `?async=true` to any POST request. The pipeline system chains multiple API calls internally using `InternalApiClient`, which makes loopback HTTP requests through an allowlist-validated URL pattern — essentially treating the app's own API as a workflow engine.

The Python engine is a separate FastAPI service on port 5001. The Java backend proxies requests to it via `AiEngineClient`. The engine uses `pydantic-ai` agents (orchestrator, PDF edit, PDF questions, math auditor, etc.) to reason about documents. It does not execute PDF operations itself — it plans them and delegates back to the Java API through the proxy layer.

## Architecture

The project is organized as a Gradle multi-module build with three Java modules plus two satellite codebases:

| Module | Location | Role |
|--------|----------|------|
| `common` | `app/common/` | Shared config, models, services, AOP, annotations |
| `stirling-pdf` (core) | `app/core/` | PDF controllers, services, external tool wrappers |
| `proprietary` | `app/proprietary/` | Security (SSO/SAML/OAuth2), audit, AI proxy, workflows, database |
| Frontend | `frontend/` | React + Vite + Mantine UI, also builds as Tauri desktop app |
| Engine | `engine/` | Python FastAPI AI service (pydantic-ai agents) |

The codebase is substantial: ~275 Java files in core (50K LOC), ~147 in common (27K LOC), ~246 in proprietary (33K LOC), ~1410 TypeScript files in the frontend, and ~65 Python files in the engine.

Spring Boot 4.x on Java 21+ (toolchain targets JDK 25). Tomcat is explicitly excluded — the app uses Undertow. PDF processing is primarily Apache PDFBox 3.0.7. The frontend uses Mantine + MUI, embedded PDF viewer via `@embedpdf`, and Tailwind CSS.

> [!note] Open-core licensing
> The root is MIT-licensed, but `app/proprietary/`, `engine/`, `frontend/src/proprietary/`, `frontend/src/desktop/`, and `frontend/src/saas/` each carry separate commercial licenses. The "security" Spring profile activates only when the proprietary JAR is on the classpath.

## The Spine

A typical API request flows through these layers:

1. **HTTP entry** — `EndpointInterceptor` checks if the endpoint is enabled via `EndpointConfiguration` (admins can disable individual tools in `settings.yml`).
2. **Security filter chain** — If the proprietary security module is present, Spring Security filters handle JWT, OAuth2, or SAML2 authentication. A `PremiumEndpointAspect` or `EnterpriseEndpointAspect` may block access based on license tier.
3. **Audit aspect** — `AuditAspect` (proprietary) captures who did what, if auditing is enabled.
4. **AutoJob aspect** — `AutoJobAspect` intercepts every `@AutoJobPostMapping`. It resolves file references (replacing `MultipartFile` args with disk-backed references for async mode), then delegates to `JobExecutorService`.
5. **Job execution** — `JobExecutorService` runs the controller method synchronously or asynchronously (virtual threads). Async jobs get a UUID, timeout tracking via `TaskManager`, and optional queueing through `JobQueue` with a `ResourceMonitor` semaphore.
6. **Controller logic** — Each controller uses `CustomPDFDocumentFactory` to load PDFs (which handles temp files, metadata stripping, and memory management) and `WebResponseUtils` to return the result as a byte-array download.
7. **Response** — PDF bytes streamed back with `Content-Disposition: attachment`.

The pipeline system (`PipelineProcessor`) chains steps by deserializing a JSON pipeline config, resolving each operation's parameters against the OpenAPI spec (fetched from the running app itself via `ApiDocService`), and calling `InternalApiClient` to dispatch each step as an internal HTTP POST.

## Key Patterns

**Annotation-driven cross-cutting concerns.** The `@AutoJobPostMapping` + `@GeneralApi` / `@MiscApi` / `@SecurityApi` meta-annotations encapsulate routing, OpenAPI documentation, async execution, and progress tracking in a single declaration per endpoint. This is the most important pattern — almost every POST endpoint uses it.

**Controller per tool, grouped by category.** Controllers are organized into `api/converters/`, `api/misc/`, `api/security/`, `api/filters/`, `api/form/`, and `api/pipeline/`. Each controller is small (50-400 LOC) and handles one PDF operation. Request DTOs live in parallel `model/api/` packages.

**`CustomPDFDocumentFactory` as the PDF standard library.** Every controller receives this via DI. It wraps PDFBox's `Loader`, handles temp file creation through `TempFileManager`, and adds metadata management. It uses a `Semaphore` to bound concurrent PDF processing.

**Internal loopback for pipelines and AI.** Both `PipelineProcessor` and `AiWorkflowService` reuse the app's own REST API via `InternalApiClient`. This is a pragmatic choice — it means pipeline steps are always consistent with the external API contract. The allowlist regex (`^/api/v1/(general|misc|security|convert|filter)/...`) prevents SSRF-like abuse.

**Three-tier profile activation.** The app detects its tier at startup by checking if `SecurityConfiguration` is on the classpath. If so, it activates the `security` Spring profile, enabling login, SSO, and premium features. Otherwise it runs in `default` (open) mode.

## Non-Obvious Details

> [!warning] `EndpointConfiguration` is a 690-line service that manually maps ~50 endpoint names to groups and dependency requirements. It's essentially a hand-maintained registry that could drift out of sync with actual controllers. Any new endpoint must be registered here or it won't be toggleable.

The pipeline system bootstraps its API knowledge by fetching the app's own OpenAPI spec at runtime via `ApiDocService`. This means the first pipeline request after startup may fail if the spec hasn't been fetched yet.

`InternalApiClient` includes an SSRF protection regex but also carves out `/api/v1/ai/tools/*` specifically. The comment explains this is intentional — AI tool dispatch needs to call through, but the broader `/api/v1/ai/` surface (orchestrate, health) is blocked to prevent plan steps from re-entering the orchestrator.

The `AutoJobAspect` has a retry mechanism with exponential backoff, but retries only apply to async jobs. Synchronous calls fail immediately. The aspect also performs in-place argument mutation — replacing `MultipartFile` parameters with disk-backed file references when running async, so large uploads don't sit in memory during queue waits.

> [!question] The `ApplicationProperties` class is annotated with `@ConfigurationProperties(prefix = "")` — it binds the entire Spring environment to a single Java object. This is unusual and means any YAML key in `settings.yml` could theoretically map to a field. The class has grown to ~1000+ lines with deeply nested inner classes (`Security`, `System`, `Ui`, `Endpoints`, `Metrics`, `Mail`, `Telegram`, `Premium`, `AutoPipeline`, `ProcessExecutor`, `PdfEditor`, `AiEngine`, etc.).

## Assessment

**Strengths.** The annotation-driven `AutoJobPostMapping` pattern is genuinely elegant — it adds async, retry, timeouts, and progress tracking without polluting controller logic. The three-module split (common/core/proprietary) cleanly separates open-source from commercial code. The pipeline system reusing the REST API contract ensures consistency. PDFBox 3.x with temp-file-based loading avoids the OOM issues that plagued earlier versions.

**Concerns.** `EndpointConfiguration` is a maintenance liability at 690 lines of hand-maintained endpoint mappings. `ApplicationProperties` binding to an empty prefix creates a fragile god-object. The internal loopback HTTP pattern for pipelines and AI adds network hops and startup-order fragility. The proprietary module is deeply woven into the DI container via aspect ordering (`@Order` annotations at 10, 20, etc.), making the open-source build harder to reason about without reading the proprietary code.

**Operational.** The app depends on external CLI tools (LibreOffice, Tesseract, qpdf, `weasyprint`) that must be installed in the container — the Docker image handles this via a pre-built base image. Python AI engine is optional but requires separate deployment. Database is used only in proprietary mode (H2 default, configurable). Temp file cleanup via `TempFileManager` and `TempFileCleanupService` is critical — PDF processing generates large temporary files.

> [!tip] For self-hosters, the standard Docker image is the recommended deployment. The ultra-lite variant excludes OCR and conversion tools. The "fat" variant includes everything. All are defined in `docker/embedded/Dockerfile` with a multi-stage build that compiles both Java and frontend, then layers onto a pre-built base image.

## Related

- [[analyzing-nextcloud-server]]
- [[analyzing-firefly-iii]]
- [[analyzing-ocis]]
