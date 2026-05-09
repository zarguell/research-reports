---
title: "Analyzing Technitium DNS Server"
date: 2025-05-09
type: codebase-analysis
status: complete
source: https://github.com/TechnitiumSoftware/DnsServer
tags: [dns, networking, csharp, dotnet, privacy, dns-server]
---

> **Source:** [TechnitiumSoftware/DnsServer](https://github.com/TechnitiumSoftware/DnsServer) @ [`aa9044d`](https://github.com/TechnitiumSoftware/DnsServer/commit/aa9044d4df9d739b6a6e428bb77cecb3356b775b)

## How It Works

Technitium DNS Server is a self-hosted, cross-platform DNS server written in C# targeting .NET 10. It functions as both an authoritative DNS server (hosting zones you define) and a recursive resolver (resolving arbitrary queries by walking the DNS hierarchy). The entire system — DNS engine, web management console, DHCP server, and plugin framework — lives in a single process launched from `DnsServerApp/Program.cs`.

The mental model is straightforward: DNS packets arrive over multiple transports (UDP, TCP, DNS-over-TLS, DNS-over-HTTPS, DNS-over-QUIC, and PROXY protocol variants). Each request flows through a pipeline: first through DNS Apps that can intercept or modify requests (rate limiting, blocking, split-horizon), then through the authoritative zone lookup, then optionally into recursive resolution or forwarding. The response passes through post-processors and query loggers before being sent back. A custom radix tree (`DomainTree`) stores zones using reversed domain-name byte keys for efficient longest-match lookups.

What makes Technitium distinctive is its plugin architecture: DNS Apps are .NET assemblies loaded at runtime via `AssemblyLoadContext`, implementing interfaces like `IDnsRequestController`, `IDnsAuthoritativeRequestHandler`, `IDnsRequestBlockingHandler`, `IDnsPostProcessor`, and `IDnsQueryLogger`. The server ships with 27 built-in apps (GeoDNS, Split Horizon, Advanced Blocking, DNS64, etc.) that plug into the request pipeline at well-defined extension points.

## Architecture

The solution has six projects:

| Project | Role | Key Size |
|---------|------|----------|
| `DnsServerApp` | Entry point, process lifecycle | ~125 lines |
| `DnsServerCore` | DNS engine + web API + DHCP | ~65K lines (8,046-line `DnsServer.cs`) |
| `DnsServerCore.ApplicationCommon` | Interfaces for DNS Apps | ~10 interfaces |
| `DnsServerCore.HttpApi` | HTTP API client library | ~7 files |
| `DnsServerWindowsService` | Windows service wrapper | Small |
| `Apps/` | 27 built-in DNS App plugins | Each ~100-500 lines |

The core namespace structure under `DnsServerCore/Dns/`:

```
Dns/
├── DnsServer.cs           # The monolith: listeners, request pipeline, resolution
├── Applications/           # Plugin loading and management
├── Zones/                  # Zone types: Primary, Secondary, Stub, Cache, etc.
├── ZoneManagers/           # AuthZoneManager, CacheZoneManager, BlockedZoneManager
├── Trees/                  # DomainTree, AuthZoneTree, CacheZoneTree (radix trees)
├── Dnssec/                 # DNSSEC key management (RSA, ECDSA, EdDSA)
├── ResourceRecords/        # Record metadata extensions
├── DirectDnsClient.cs      # Direct query bypass
├── ResolverDnsCache.cs     # Cache integration layer
└── StatsManager.cs         # Per-hour/per-day statistics
```

The web layer (`DnsWebService.cs`, 2,925 lines) uses ASP.NET Core Kestrel to serve both the admin web console and the DNS-over-HTTPS endpoint. API endpoints are split across `WebServiceApi`, `WebServiceZonesApi`, `WebServiceAppsApi`, `WebServiceSettingsApi`, etc.

## The Spine

**Entry point:** `DnsServerApp/Program.cs` → creates `DnsWebService` → calls `StartAsync()`. `DnsWebService` creates the `DnsServer` instance and starts its listeners.

**Request lifecycle** (the core pipeline in `DnsServer.cs`):

1. **Receive** — Async listeners per transport (UDP socket reads, TCP accept loops, TLS handshakes, QUIC connections, Kestrel for DoH). Each listener spawns `Environment.ProcessorCount` concurrent reader tasks on a custom `TaskScheduler`.

2. **`ProcessRequestAsync()`** (line 2580) — Runs all `IDnsRequestController` apps first (can drop silently or refuse). Validates domain names and TSIG signatures.

3. **`ProcessQueryAsync()`** (line 2702) — Dispatches by OPCODE:
   - `StandardQuery` → checks for AXFR/IXFR (zone transfer), otherwise continues
   - `Notify` → triggers secondary zone refresh
   - `Update` → dynamic DNS update (RFC 2136)

4. **`ProcessAuthoritativeQueryAsync()`** (line 3641) — Queries `AuthZoneManager` and DNS App authoritative handlers. Handles CNAME/ANAME chasing and APP record delegation. Falls through to recursion if the zone returns a delegation (NS records) and recursion is allowed.

5. **`ProcessRecursiveQueryAsync()`** (line 4519) — Checks allowed/blocked zones, then calls `RecursiveResolveAsync()`. This method manages ECS (EDNS Client Subnet), cache lookups, request coalescing via `ConcurrentDictionary` of in-flight queries, serve-stale logic (RFC 8767), and prefetch triggers.

6. **`PostProcessQueryAsync()`** (line 2653) — Runs all `IDnsPostProcessor` apps on the final response. Logs the query via `IDnsQueryLogger` apps. Records stats.

## Key Patterns

**Plugin-based extensibility with interface multiplexing.** A single DNS App assembly can implement multiple interfaces (`IDnsRequestController`, `IDnsAuthoritativeRequestHandler`, `IDnsPostProcessor`, etc.) and the `DnsApplicationManager` discovers and sorts them by preference. This is a clean pattern — apps are composable and the core pipeline doesn't need to know about specific apps.

**Custom byte-tree radix structure for domain lookups.** The `DomainTree<T>` base class (in `Trees/DomainTree.cs`) converts domain names into reversed-label byte keys (TLD first), enabling efficient longest-prefix matching. This is how the server maps `mail.example.com` to the correct zone in O(labels) time. Each label character maps through a 41-byte key map for case-insensitive, DNS-valid character lookups.

**Request coalescing for recursive resolution.** The `RecursiveResolveAsync()` method uses a `ConcurrentDictionary<string, Task<RecursiveResolveResponse>>` keyed on `(question name, question type, ECS subnet)` to ensure that concurrent requests for the same query share a single in-flight resolution task rather than triggering redundant upstream lookups.

**Zone manager hierarchy.** Five zone managers partition the domain namespace: `AuthZoneManager` (authoritative zones), `AllowedZoneManager` (allow-list), `BlockedZoneManager` (block-list), `BlockListZoneManager` (external block list URLs), and `CacheZoneManager` (recursive cache). Each uses the same tree structure but serves a different purpose in the resolution pipeline.

**Monolithic core class.** `DnsServer.cs` at 8,046 lines is the single largest file and handles everything from socket binding to recursive resolution to cache management. The web service (`DnsWebService.cs`) is another 2,925-line monolith. This is a deliberate architectural choice — everything DNS-related lives in one place.

## Non-Obvious Details

> [!note] Two separate `ResolverDnsCache` instances
> The server creates two cache instances: `_dnsCache` (normal) and `_dnsCacheSkipDnsApps` (bypasses DNS App authoritative handlers). The second one prevents infinite loops when a DNS App itself needs to resolve internally (e.g., the `InternalDnsServer` wrapper given to apps uses the skip-cache).

> [!warning] Binary config format
> Configuration is stored in a custom binary format (starts with magic bytes `"DC"`, version byte, then serialized fields via `BinaryReader`). This makes it non-human-readable and harder to debug or version-control compared to JSON/YAML. Zone files use a similar binary format.

> [!note] APP and FWD are proprietary record types
> The server defines `DnsResourceRecordType.APP` and `DnsResourceRecordType.FWD` as internal record types. APP records delegate query handling to a DNS App's `IDnsAppRecordRequestHandler`. FWD records define conditional forwarders within a zone's authority section. These are not standard DNS types — they're routing instructions embedded in the zone tree.

> [!tip] Serve-stale with RFC 8767 compliance
> The cache implements serve-stale with a 200ms-before-client-timeout wait window (max 1,800 seconds). If a fresh resolution is in progress, stale cache entries are served while the background task completes — exactly per RFC 8767.

> [!question] QPM rate limiting with "slip"
> The rate limiter uses a configurable "slip" percentage (`_qpmLimitUdpTruncationPercentage = 50%`) — when a client exceeds queries-per-minute limits over UDP, only a percentage of responses are truncated (TC bit set) while the rest are dropped silently. This is a defensive technique to avoid amplifying attacks against spoofed sources.

## Assessment

**Strengths:**
- Comprehensive protocol support (DoH with HTTP/1.1, H2, H3; DoT; DoQ; PROXY protocol) in a single binary
- The plugin architecture is well-designed: 27 built-in apps demonstrate the system's flexibility for split-horizon DNS, geo-routing, advanced blocking, and external log exports
- Performance-conscious: custom task schedulers, request coalescing, serve-stale, prefetch, UDP socket pooling, and concurrent reader tasks scaled to processor count
- Strong RFC compliance across DNSSEC (RSA/ECDSA/EdDSA, NSEC/NSEC3), zone transfers (AXFR/IXFR with TLS/QUIC), TSIG, EDNS Client Subnet, catalog zones, and QNAME minimization

**Concerns:**
- The 8,046-line `DnsServer.cs` is a god class. It handles socket management, the entire request pipeline, recursive resolution, cache logic, blocking, rate limiting, and configuration. This makes the codebase difficult to navigate and test in isolation
- Binary config and zone file formats are opaque — no tooling can inspect them outside the server itself
- The `TechnitiumLibrary` dependency is loaded via DLL reference from a sibling directory (`../../TechnitiumLibrary/bin/`) rather than a NuGet package, which complicates the build setup
- Minimal test surface — the repository has no visible test project

**Recommendations:**
- For operators: Technitium is one of the most feature-complete self-hosted DNS servers available. The built-in apps eliminate the need for external tooling for most common use cases (ad blocking, geo-routing, split-horizon)
- For contributors: the monolithic core class is the biggest barrier to entry. Understanding the request pipeline (section above) is the key to navigating the codebase
- For anyone evaluating alternatives: compare with [[analyzing-traefik]] for HTTP-layer routing, or [[analyzing-step-ca]] for PKI/certificate automation that pairs well with DNS-over-TLS setup

## Related

- [[analyzing-step-ca]] — Certificate authority for automating TLS certs (useful with DoT/DoH/DoQ)
- [[analyzing-traefik]] — Reverse proxy with DNS challenge support
- [[analyzing-dockflare]] — Cloudflare DNS management tool
