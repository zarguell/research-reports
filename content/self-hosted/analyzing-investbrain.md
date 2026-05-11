---
title: "Analyzing Investbrain"
date: 2026-05-11
type: codebase-analysis
status: complete
source: https://github.com/investbrainapp/investbrain
tags: [php, laravel, livewire, self-hosted, investment-tracker, ai]
---

# Analyzing Investbrain

> **Source:** [investbrainapp/investbrain](https://github.com/investbrainapp/investbrain) @ [`a67717c2`](https://github.com/investbrainapp/investbrain/commit/a67717c2f8c614984a4ec1cd6014acf055fef6b6)

## How It Works

Investbrain is a self-hosted investment portfolio tracker that consolidates holdings across brokerages, monitors market performance, and offers an AI-powered chat assistant for investment analysis. Users create **Portfolios**, add **Transactions** (buys and sells), and the system automatically derives **Holdings** — aggregate positions tracking quantity, average cost basis, realized gains, and dividends earned. A separate **MarketData** table caches real-time quotes from configurable providers, with a built-in fallback chain ensuring reliability.

The system refreshes market data every minute on weekdays via scheduled Artisan commands, captures daily portfolio snapshots for historical charting, and syncs dividend/split data on regular cadences. Multi-currency support is first-class: every transaction and market data record carries both local-currency and base-currency (default USD) values, with daily exchange rates pulled from the Frankfurter API. An AI chat feature — powered by OpenAI, Anthropic, Gemini, Ollama, or other LLM providers — lets users "chat with their holdings," receiving grounded investment analysis.

The frontend is server-rendered Blade templates with Tailwind CSS and DaisyUI, enhanced by Alpine.js for interactivity. Authentication uses Laravel Fortify with optional social login (Laravel Socialite). A REST API (Sanctum-authenticated) exposes full CRUD for portfolios, transactions, and holdings.

## Architecture

The codebase follows standard Laravel 12 conventions across these layers:

- **`app/Models/`** — 14 Eloquent models: `User`, `Portfolio`, `Transaction`, `Holding`, `MarketData`, `DailyChange`, `Dividend`, `Split`, `CurrencyRate`, `ConnectedAccount`, `BackupImport`, `ChatWithConversation`, `AgentConversationMessage`. Models use UUIDs and carry significant business logic in scopes, boot hooks, and computed methods.
- **`app/Interfaces/MarketData/`** — Extensible provider system. `MarketDataInterface` defines `exists()`, `quote()`, `dividends()`, `splits()`, `history()`. Six implementations: `YahooMarketData`, `AlphaVantageMarketData`, `FinnhubMarketData`, `AlpacaMarketData`, `TwelveDataMarketData`, and `FakeMarketData`. `FallbackInterface` chains providers with graceful degradation.
- **`app/Actions/`** — Pipeline stages (`ConvertToMarketDataCurrency`, `EnsureCostBasisAddedToSale`, `CopyToBaseCurrency`, `EnsureDailyChangeIsSynced`) wired through Laravel's Pipeline facade on model `saving`/`saved` events.
- **`app/Ai/Agents/`** — Three AI agents (`ChatWithHoldingAgent`, `ChatWithPortfolioAgent`, `ChatWithSuggestedPromptsAgent`) using Laravel AI's `Agent` contract with conversation memory and tool support.
- **`app/Console/Commands/`** — Eight scheduled commands for market data refresh, dividend/split sync, daily change capture, currency refresh, and data reconciliation utilities.
- **`app/Imports/` & `app/Exports/`** — Excel-based backup import/export using `maatwebsite/excel`, with multi-sheet spreadsheets containing portfolios, transactions, daily changes, and config.

## The Spine

A typical web request flows through this path:

1. **Entry** — `public/index.php` → Laravel HTTP kernel → Fortify auth middleware (session-based for web, Sanctum token for API).
2. **Routing** — `routes/web.php` for server-rendered pages, `routes/api.php` for the REST API. Web routes use standard controllers; API routes use dedicated `ApiControllers` with Eloquent API Resources.
3. **Controller** — Thin controllers delegate to models and Eloquent queries. `HoldingController`, `TransactionController`, `PortfolioController`, and `DashboardController` handle the main workflows.
4. **Model Hooks** — `Transaction::boot()` is the critical orchestrator. On `saving`, a Pipeline runs currency conversion, cost-basis enforcement, and base-currency copying. On `saved`, the transaction syncs to its `Holding` (creating or updating), and deferred daily-change recalculation fires if needed.
5. **Holding Sync** — `Holding::syncTransactionsAndDividends()` re-aggregates all transactions for a symbol+portfolio pair, recalculating quantity, average cost basis, realized gains, and dividend income. This is called on every transaction save/delete.
6. **Market Data** — `MarketData::getMarketData()` checks staleness against the configured refresh interval (default 30 min), fetching fresh quotes through `FallbackInterface` only when needed.

The scheduled command spine (`routes/console.php`) runs `refresh:market-data` every minute on weekdays, `capture:daily-change` daily at a configurable time, plus periodic dividend/split/currency refreshes.

## Key Patterns

**Pipeline-driven model events.** The `Transaction` and `MarketData` models use Laravel's `Pipeline` facade in their `boot()` saving hooks. Each pipe is a single-invocation class (`__invoke(Model $next, callable $next)`) that transforms the model before persistence. This is a clean alternative to scattered mutator methods — the transformation chain is explicit and composable.

**Fallback market data provider.** `FallbackInterface` uses `__call()` magic to proxy any `MarketDataInterface` method across a comma-separated provider list. If one provider throws, it catches and tries the next. This is configured via `MARKET_DATA_PROVIDER=yahoo,alphavantage` in `.env` and resolved through `config/investbrain.php`.

**Derived holdings with auto-sync.** Holdings are never created directly — they emerge from transactions. When a transaction is saved, `syncToHolding()` calls `Holding::firstOrNew()` then `syncTransactionsAndDividends()`, which re-queries all transactions to recompute aggregates. If all shares are sold, the holding self-deletes.

**Deferred daily change sync.** The `EnsureDailyChangeIsSynced` action uses Laravel's `defer()` helper to kick off `syncDailyChanges()` asynchronously after transaction saves, with a 5-minute cache-based throttle to prevent redundant recalculations. This is a pragmatic optimization for the expensive daily change recalculation.

**Multi-currency via custom cast.** The `BaseCurrency` cast automatically converts amounts to the user's base currency on model write, leveraging the `CurrencyRate` time-series data. Currency aliases (e.g., GBX → GBP with ÷100 adjustment) are handled through a config map.

> [!note] The `FallbackInterface` uses `__call()` for method proxying rather than implementing `MarketDataInterface` directly. This means there's no compile-time type safety on the fallback — a misspelled method name would only fail at runtime.

## Non-Obvious Details

**Holding dividends query uses raw SQL with interpolated IDs.** The `Holding::dividends()` relationship builds complex raw SQL with `$this->portfolio_id` and `$this->symbol` directly interpolated into query strings rather than parameterized. While the values come from Eloquent model attributes (not user input), this pattern bypasses parameterized queries and could be fragile if symbol names contain special characters.

**Portfolio owner resolution uses a static property.** `Portfolio::$owner_id` is a static property used to pass owner context when portfolios are created from queued jobs (where `auth()->user()` is null). This works but is not thread-safe — concurrent job processing could interfere. The code does null it out after use, but in a multi-threaded runtime this could be problematic.

**Recursive close-price lookup.** `Portfolio::getMostRecentCloseData()` recursively searches up to 5 days backward when a close price is missing (e.g., weekends/holidays). This is straightforward but could be replaced with a simple loop for clarity and to avoid stack depth concerns.

**SQLite compatibility branching.** Several query scopes contain `if (config('database.default') === 'sqlite')` branches for date handling and interval syntax. This is for the test suite (which uses in-memory SQLite) but adds cognitive overhead to the production query paths.

**Daily change sync is resource-intensive.** The `sync:daily-change` Artisan command is documented as "extremely resource intensive." The `syncDailyChanges()` method fetches full price history for every holding and iterates day-by-day, which scales linearly with holding count × time range.

> [!warning] The `Portfolio::$owner_id` static property pattern is not safe in concurrent environments. If two queued jobs create portfolios simultaneously, the static value could be overwritten. This is mitigated by the null-reset, but the race window exists.

## Assessment

**Strengths.** Investbrain demonstrates a clean, idiomatic Laravel application with well-considered architecture. The extensible market data provider system with automatic fallback is excellent for reliability — users can chain providers and the system degrades gracefully. The pipeline pattern for transaction processing is elegant and composable. The derived-holding approach (holdings are always recomputed from transactions) ensures data integrity without manual reconciliation. Multi-currency support is thorough, with daily exchange rates, currency aliases, and automatic base-currency conversion. The AI chat feature is well-scoped — agents receive grounded context from actual portfolio data rather than operating as generic chatbots. The Docker Compose setup with PostgreSQL and Redis provides a production-ready deployment path. The test suite (30 test files) covers the main workflows including API endpoints, market data, dividends, and multi-currency scenarios.

**Concerns.** The raw SQL interpolation in `Holding::dividends()` is the most notable code quality issue — while safe in practice due to the source of values, it's a maintenance hazard. The static `Portfolio::$owner_id` pattern for job context could cause issues under concurrency. The daily change sync algorithm is computationally expensive and may not scale well for users with many holdings or long transaction histories. The `Holding::scopeWithPortfolioMetrics()` method is a ~160-line raw SQL query builder that would be difficult to debug or modify. There's no rate limiting on the AI chat endpoint, which could lead to unexpected API costs.

**Recommendations.** The raw SQL in `Holding::dividends()` should be refactored to use parameterized bindings. The static owner-id pattern should be replaced with explicit context passing (e.g., a job parameter). Portfolio metrics calculation could benefit from materialized views or a dedicated aggregation table to avoid the complex subqueries. The `syncDailyChanges()` method should use chunked processing or a queue-based approach for large portfolios. Adding rate limiting to the AI chat endpoint would prevent cost overruns.
