---
title: "Analyzing OWASP Threat Dragon"
date: 2026-05-09
type: codebase-analysis
status: complete
source: https://github.com/OWASP/threat-dragon
tags: [threat-modeling, owasp, security, devsecops, strided, diagramming]
---

# Analyzing OWASP Threat Dragon

> **Source:** [OWASP/threat-dragon](https://github.com/OWASP/threat-dragon) @ [`ac6c0fd`](https://github.com/OWASP/threat-dragon/commit/ac6c0fd8ccf61e98feb766c8e5f7af3050cb7b50)

## Overview

OWASP Threat Dragon is a free, open-source, cross-platform threat modeling application — an OWASP Lab Project that provides an intuitive, diagram-driven way to create and manage threat models. It lets users draw data flow diagrams (DFDs), attach threats to diagram elements, and track mitigations. Originally created by Mike Goodwin in AngularJS (v1.x), it was rewritten for v2.x using Vue.js and Express.

Threat Dragon was analyzed because it sits at the intersection of developer tooling and security practice: it's the kind of tool a DevSecOps team would adopt to integrate threat modeling into their workflow. Understanding its architecture, capabilities, and limitations informs both users and potential contributors.

## Key Findings

### Architecture

Threat Dragon is a monorepo with two primary packages:

- **`td.vue`** — the front-end, a Vue 3 + Vuex SPA that handles diagram editing, threat management, and UI. Built with Vue CLI and uses AntV X6 as its diagramming engine.
- **`td.server`** — the back-end, an Express 5 API server that handles authentication (GitHub, GitLab, Bitbucket, Google OAuth), session management with JWTs, and acts as a proxy for reading/writing threat model files stored in Git repositories or Google Drive.

The desktop variant packages `td.vue` with Electron, running the Vue app locally with filesystem-based storage and no external Git provider access. The web app can be self-hosted via Docker or deployed to Heroku.

The Dockerfile is multi-stage: it builds both front-end and back-end, generates SBOMs via CycloneDX, builds Jekyll documentation, and assembles a lean production image running on Node.js Alpine.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Front-end framework | Vue 3 (with `@vue/compat` migration layer) |
| State management | Vuex 4 |
| Diagram engine | AntV X6 with plugins (clipboard, history, keyboard, scroller, selection, snapline, transform, export) |
| UI components | Bootstrap Vue, Font Awesome |
| Back-end runtime | Express 5 on Node.js 24 |
| Auth | Passport-style OAuth via octonode (GitHub), gitbeaker (GitLab), bitbucket SDK, googleapis |
| Desktop | Electron 26 with electron-builder |
| i18n | vue-i18n with 17 languages (ar, de, el, en, es, fi, fr, hi, id, ja, ms, pt, pt-br, ru, uk, zh) |
| Build | Vue CLI, Babel, npm-run-all2 |
| Testing | Jest (unit), Cypress (e2e), Mocha+Chai+Sinon (server), BrowserStack (cross-browser) |
| Container | Docker with multi-stage build, Node Alpine base |
| Security tooling | ZAP web scanning, Trivy image scanning, SBOM generation, Helmet security headers, express-rate-limit |

### Threat Modeling Approach

Threat Dragon supports **six threat modeling frameworks**, each mapping threat categories to DFD element types (Actor, Process, Store, Flow):

| Framework | Categories | Element Mapping |
|-----------|-----------|----------------|
| **STRIDE** | Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege | Per-element (e.g., Actor gets S+R; Process gets all six) |
| **CIA** | Confidentiality, Integrity, Availability | Uniform across all elements |
| **CIA+DIE** | CIA + Distributed, Immutable, Ephemeral | Uniform across all elements |
| **LINDDUN** | Linkability, Identifiability, Non-repudiation, Detectability, Disclosure of Information, Unawareness, Non-compliance | Actor gets subset (L, I, U); others get full set |
| **PLOT4ai** | Technique/Processes, Accessibility, Identifiability/Linkability, Security, Safety, Unawareness, Ethics/Human Rights, Non-compliance | Per-element (7 categories for Actor, 4 for Flow) |
| **EOP (Cornucopia)** | Card-based gamification using OWASP Cornucopia decks (web app, mobile app) with multilingual support (EN, ES, FR, RU) | Not element-based; uses suit/card metaphor |

The threat suggestion engine (`context-generator.js`) provides context-aware recommendations based on element properties. For example, a Flow marked as `isPublicNetwork` and not `isEncrypted` triggers an "Use encryption" suggestion. A Process with `handlesCardPayment` triggers carding and card cracking threats. These suggestions draw heavily from the OWASP Automated Threat Handbook (OATS). The engine cross-maps threat types between frameworks (e.g., LINDDUN linkability maps to STRIDE information disclosure).

Threats are tracked with status (Open/Mitigated), severity, description, mitigation, and a model type tag. A frequency map tracks which threat categories have been applied, and new threats default to the least-used category — encouraging coverage across all categories.

### Diagram Elements

The diagram engine (AntV X6) supports these DFD element types:
- **Actor** — external entity / person
- **Process** — computation or service
- **Store** — data store
- **Flow** — data flow edge between elements
- **Trust Boundary Box** — logical boundary (dashed rectangle)
- **Trust Boundary Curve** — logical boundary (dashed curve)
- **Text Block** — annotation

Each element carries properties relevant to threat context: `providesAuthentication`, `isPublicNetwork`, `isEncrypted`, `isWebApplication`, `handlesCardPayment`, `handlesGoodsOrServices`, `storesCredentials`, `storesInventory`, `isALog`, `privilegeLevel`, etc.

### Import/Export and Interoperability

Threat Dragon supports importing models from several formats, validated via JSON Schema (Ajv):
- **Threat Dragon v1** — legacy AngularJS format, with full migration path including diagram cell/edge conversion
- **Threat Dragon v2** — current native format
- **Open Threat Model (OTM)** — an open standard for threat model interchange
- **TM-BOM** — threat model BOM format, with conversion for assumptions, boundaries, flows, threats, controls, and personas
- **Templates** — reusable model templates with metadata (id, name, description, tags)

### Code Quality

- **Server tests:** ~40 test files covering all controllers, helpers, env configs, and providers. Uses Mocha + Chai + Sinon + Supertest with nyc coverage.
- **Vue unit tests:** ~145 test files. Jest + Vue Test Utils.
- **E2E tests:** Cypress for web, WebdriverIO/Mocha for desktop (Electron). BrowserStack for cross-browser smoke tests.
- **Linting:** ESLint with standard config for both server and Vue.
- **CI pipeline** is comprehensive: lint → unit tests → Docker build → e2e smokes → full e2e → ZAP security scan → Trivy vulnerability scan → SBOM generation → deploy.

> [!tip] The project pins all GitHub Actions to specific commit SHAs (not tags), which is a strong security practice for CI/CD.

### Storage and Authentication

The web application supports multiple threat model storage backends:
1. **Local filesystem** — browser-local storage for the web app, filesystem for desktop
2. **Git providers** — GitHub, GitLab, Bitbucket (via OAuth, reading/writing JSON files in repos)
3. **Google Drive** — via Google OAuth and Drive API

Authentication uses JWT tokens with refresh tokens, encrypted session keys, and bearer token middleware on protected API routes. The server uses Helmet for security headers and express-rate-limit (6000 requests per 30 minutes in production).

## Assessment

### Strengths

- **Mature threat modeling coverage.** Six frameworks (STRIDE, CIA, CIA+DIE, LINDDUN, PLOT4ai, Cornucopia) with proper per-element categorization is more comprehensive than most commercial tools.
- **Context-aware threat suggestions** based on element properties, leveraging the OWASP OATS taxonomy, provide genuine value beyond static checklists.
- **Excellent CI/CD security practices.** Pinned action SHAs, SBOM generation (CycloneDX), ZAP scanning, Trivy image scanning, CodeQL SARIF upload — this project practices what it preaches.
- **Cross-platform delivery.** Web (Docker/Heroku), desktop (Windows/macOS/Linux via Electron), with matching test coverage for each.
- **Strong internationalization.** 17 languages is impressive for an open-source security tool.
- **Interoperability.** Support for importing from OTM and TM-BOM formats, plus v1 migration, shows commitment to ecosystem compatibility.
- **Template system.** Downloadable and loadable templates with UUID regeneration for diagram cells make it easy to share and reuse threat model patterns.

### Concerns

- **Vue 2/3 migration incomplete.** The app uses `@vue/compat` (Vue 3 compatibility build) and `--legacy-peer-deps` for installs. Bootstrap Vue is still the v2 version. Comments in the Dockerfile and CI explicitly flag this as in-progress.
- **Threat suggestion engine is rule-based and static.** The context generator (`context-generator.js`) is a long chain of if/else blocks with hardcoded suggestions. It's useful but not extensible — adding new suggestion rules requires code changes. No AI/LLM-assisted threat generation exists.
- **No real-time collaboration.** Threat models are file-based (JSON in Git repos or local filesystem). There's no multi-user editing or review workflow — it's a single-user diagramming tool.
- **Monolithic Vuex store.** The front-end state management uses a large Vuex store with many modules and manual `Vue.set` calls, which is a Vue 2 pattern. A migration to Vue 3 Composition API + Pinia would be cleaner but represents significant effort.
- **Desktop security.** The Electron app stores threat models locally with no encryption at rest. For a security tool, this is worth noting — though threat models themselves may not be highly sensitive depending on context.

### Recommendations

- **Prioritize Vue 3 migration completion.** The compat layer adds bundle size and complexity. Moving to native Vue 3 + Pinia + a modern UI library (e.g., PrimeVue, Naive UI) would modernize the stack.
- **Make threat suggestions pluggable.** Consider a plugin or rule-file system for context-aware suggestions so the community can contribute suggestion rules without modifying core code.
- **Consider an API-first architecture** that would enable automation and CI/CD integration — the ability to generate or update threat models programmatically would make Threat Dragon much more useful in DevSecOps pipelines.
- **Add threat model diffing/review.** Since models are stored as JSON in Git, a structured diff view (what threats were added, removed, changed status) would enable code-review-style threat model reviews.

## Related

- [[analyzing-stride-gpt]] — AI-powered STRIDE threat modeling using LLMs, a different approach to automated threat generation
- [[analyzing-prowler]] — security scanning tool for cloud environments, complementary to threat modeling in a DevSecOps pipeline
- [[analyzing-cloudsplaining]] — IAM security analysis tool, useful for identifying the kinds of threats Threat Dragon helps model
