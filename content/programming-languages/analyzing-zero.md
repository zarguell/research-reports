---
title: "Analyzing Zero — Vercel Labs' Agent-First Language"
date: 2026-05-20
type: codebase-analysis
status: complete
source: https://github.com/vercel-labs/zerolang
tags: [programming-languages, compilers, vercel, agents, systems-programming]
---

# Analyzing Zero — Vercel Labs' Agent-First Language

> **Source:** [vercel-labs/zerolang](https://github.com/vercel-labs/zerolang) @ [`8980182`](https://github.com/vercel-labs/zerolang/commit/8980182dd0026be6ca43e7652f2bd333b3c7a087)

## How It Works

Zero is a pre-1.0 experimental programming language and toolchain from Vercel Labs designed from first principles for AI agents as primary users. The compiler is a ~1.3MB monolithic C11 program that takes `.0` source files and produces native binaries directly — no LLVM, no runtime, no VM. It embeds its own runtime sources, skill data, and agent-facing documentation into the compiled binary so the toolchain is fully self-contained and inspectable.

The language itself occupies a unique niche: it's a statically-typed, systems-level language with C-like explicitness but Rust-inspired ownership semantics, a Zig-like compile-time evaluation model, and a custom error system based on named error sets (`raises { InvalidInput }`). But the real innovation isn't in any single language feature — it's that **everything** is structured for machine consumption. Every compiler command outputs JSON. Diagnostics have stable codes (`TYP001`, `OWN002`, `BOR001`). The compiler ships with "skill data" embedded in the binary that an agent can query to learn the language on the fly. The `zero fix --plan --json` command produces structured repair plans an agent can execute without parsing natural language.

> [!note]
> Zero is at version 0.1.3, built with `pnpm@11`, Node >=22, and Turborepo. The compiler target list includes linux-musl-x64, darwin-arm64, linux-musl-arm64, and Windows x86-64 via COFF.

## Architecture

The repo is organized as a pnpm workspace with Turborepo:

```
native/zero-c/        ← The compiler (C11, ~16 source files)
  src/main.c          ← CLI dispatch + code generation + emission (461KB)
  src/checker.c       ← Type checker + ownership analysis (437KB)
  src/ir.c            ← Intermediate representation (161KB)
  src/parser.c        ← Parser (42KB)
  src/lexer.c         ← Lexer (7KB)
  src/target.c        ← Target triple handling (20KB)
  src/emit_elf64.c    ← ELF64 code emission
  src/emit_elf_aarch64.c
  src/emit_macho64.c  ← Mach-O emission
  src/emit_coff.c     ← COFF emission
  src/fs.c            ← Filesystem operations
docs/                 ← Next.js documentation site
scripts/              ← TypeScript build/test/release tooling
skill-data/           ← Agent-facing markdown knowledge files (baked into binary)
skills/               ← Compiler skill bundle
examples/             ← ~70 runnable `.0` example programs
conformance/          ← 516 conformance test fixtures
evals/                ← Agent capability evaluations
extensions/vscode/    ← VS Code extension
```

**Data flow through the compiler (single-pass):**

```
Source (.0) → Lexer → Parser → Type Checker (ownership provenance) → IR builder → Code generator → Binary emission
```

There is no intermediate representation dump phase — the compiler constructs a MIR (mid-level IR) that tracks ownership provenance (which values are borrowed, where, and whether they escape), then emits code directly. The checker and code generator are tightly coupled in `main.c`, with `checker.c` handling the type-checking pass and ownership analysis.

## The Spine

### CLI Entry Points

The `zero` binary accepts 19 commands, parsed via `strcmp` chains in `main.c`:

| Command | Purpose | Structured Output |
|---------|---------|-------------------|
| `check` | Type check | `--json` diagnostics |
| `build` | Compile to binary | `--json` build stats |
| `run` | Compile + execute | stdout/stderr |
| `fmt` | Format source | `--check` mode |
| `graph` | Dependency graph | `--json` |
| `size` | Binary size breakdown | `--json` |
| `doctor` | Self-diagnostics | `--json` |
| `explain` | Explain a diagnostic code | text |
| `fix` | Auto-fix with plan | `--plan --json` |
| `ship` | Produce release artifacts | `--json` |
| `skills` | Query embedded agent knowledge | `--json`, `--full` |
| `mem` | Memory analysis | `--json` |
| `time` | Compilation timing | `--json` |
| `tokens` | Tokenization | `--json` |
| `parse` | Parse tree | `--json` |
| `doc` | Documentation | `--json` |
| `abi` | ABI check/dump | `--json` |
| `dev` | Dev mode with trace | `--json` |
| `clean` | Clean artifacts | text |

The `bin/zero` shell script is a thin wrapper that execs the compiled binary at `.zero/bin/zero`, ensuring the local build is used during development.

### Language Lifecycle

A minimal Zero program:

```zero
pub fun main(world: World) -> Void raises {
    check world.out.write("hello from zero\n")
}
```

1. `pub fun` exports the function. Private functions use `fun`.
2. `World` is a capability token — you can only access files, networking, or I/O if the function signature includes it.
3. `raises` marks the function as fallible. A bare `raises` means open error set; `raises { ErrName }` restricts it.
4. `check` invokes a fallible call and propagates any error.
5. Output goes through `world.out.write` — no implicit stdout.

## Key Patterns

### 1. Agent-First by Design, Not Retrofit

This is the defining pattern of the entire project. Every design decision is filtered through "can an agent consume this programmatically?":

- **Diagnostic codes**: `TYP001`, `BOR001` — stable, documented, explainable via `zero explain TYP001`
- **JSON output**: Every substantive command has `--json` mode
- **Skill system**: `zero skills get zero --full` returns the complete language specification as structured markdown, embedded in the binary
- **Fix plans**: `zero fix --plan --json` returns an array of repair actions with file paths, line ranges, and old/new text
- **Self-contained**: The compiler embeds its own documentation and skill data — no internet access needed for agent learning

### 2. Capability-Based Security

Rather than ambient authority, Zero uses explicit capability tokens:

```zero
// No IO possible without World
pub fun main(world: World) -> Void raises { ... }

// Explicit capability types: Fs, Net, Clock, Rand, Alloc, Proc
let fs: Fs = world.get_fs()
let net = std.net.host()
```

The compiler tracks which capabilities a program uses (`capability_summary_set`) and can reject builds that request capabilities unavailable on the target platform. For example, `std.fs` on a `linux-musl-x64` target works; the same code targeting WASM would fail with `TAR002`.

### 3. Ownership Without a Borrow Checker

Zero has ownership semantics (Span/MutSpan, ref/mutref, owned<T>) but implements them through **provenance tracking** in the type checker rather than a dedicated borrow checker pass. The `ProvenanceEntry` and `FunctionProvenanceSummary` types in `checker.c` track:

- Where each value originates (`origin`)
- Whether it's mutably borrowed (`mutable_borrow`)
- Storage effects — which function calls permanently move or overwrite values
- Return value provenance — whether a returned reference outlives its source

This is notably simpler than Rust's NLL borrow checker while still preventing use-after-free and aliasing violations.

### 4. Monolithic Compiler Architecture

Unlike modern compilers that use LLVM or Cranelift as a backend, Zero's entire pipeline is hand-implemented in C11:

```c
// Single-pass: parsing, checking, IR, and emission all happen in sequence
// in the same process with shared arena allocation
static int cmd_check(...) { ... }
static int cmd_build(...) { /* check + codegen + emit */ }
```

The `main.c` file alone is 461KB and contains the CLI dispatcher, diagnostic system, code generation, emission logic, and the runtime/standard library implementation. This is unusual for a modern compiler — most split across dozens of files — but it makes the compiler easy to audit and statically link.

## Non-Obvious Details

### The "Embedded Skill System"

The compiler bakes agent-facing knowledge files into its own binary at compile time:

```
Makefile: skill-data/*.md → scripts/embed-skill-data.mts → src/embedded_skills.inc → compiled into zero binary
```

This means `zero skills get zero --full` works without network access and returns the same knowledge regardless of which compiler version is installed. The skill bundle (`zero-language.md`, `zero-diagnostics.md`, `zero-builds.md`, `zero-agent.md`, `zero-packages.md`) is the official "language spec" — but written for agents, not humans.

### The Embedded Runtime

The compiler includes `embedded_runtime_sources.inc` — a generated C array containing the standard library source code compiled directly into the binary. This is how `std.mem`, `std.http`, `std.fs`, etc., are available without a separate standard library distribution. The compiler can compile runtime code at build time without external dependencies.

### Static Dispatch, Not Traits

Zero's interface system uses static dispatch only:

```zero
interface Readable<T> {
    fun read(self: ref<T>) -> i32
}

fun readValue<T: Readable<T>>(value: ref<T>) -> i32 {
    return T.read(value)  // static dispatch: monomorphized at compile time
}
```

There are no vtables, no dynamic dispatch, no trait objects. This keeps binaries small and predictable — matching the "agent-first" goal of deterministic outputs.

### The "Check" Requirement

Every call to a fallible function must be prefixed with `check`. The compiler enforces this at the type level: a function returning `-> T raises { E }` cannot be called without `check` (which would silently discard the error). This is similar to Rust's `?` operator but syntactically required rather than opt-in, making error propagation paths visually obvious in code.

### Diagnostic Codes as UX

The diagnostic numbering scheme reveals the compiler's mental model:

| Prefix | Category |
|--------|----------|
| `ERR` | General errors (1001-1003) |
| `APP` | Application-level (2001) |
| `BLD` | Build configuration (2002-2003) |
| `NAM` | Name resolution (3002-3004) |
| `TYP` | Type errors (3005-3027) |
| `BOR` | Borrow checking (3029-3030) |
| `ABI` | ABI compatibility (3031) |
| `IFC` | Interface satisfaction (3038-3042) |
| `OWN` | Ownership violations (3013-3014) |
| `MEM` | Memory safety (3015) |
| `CGEN` | Code generation (4004) |
| `TAR` | Target platform (6001-6002) |
| `IMP` | Import resolution (7001-7003) |

## Assessment

**Strengths:**

- **Coherent vision.** Zero doesn't compromise on its agent-first premise. Every tool outputs structured JSON, every diagnostic has an explain command, and the skill system is genuinely novel for a language toolchain. This is not "we added JSON output to a human compiler" — it's designed from scratch for a non-human user.
- **Technical execution.** Writing a native-compiling systems language in C11 that supports generics, interfaces, ownership tracking, and cross-compilation to 4+ targets is impressive for a 0.1.x project. The codegen directly emitting ELF/Mach-O/COFF without LLVM is a strong signal of compiler maturity.
- **Self-contained toolchain.** No JVM, no LLVM, no runtime, no VM. The compiler + standard library + documentation is a single binary. This is ideal for agent environments where you can't install language runtimes.
- **Test coverage.** 516 conformance fixtures, command-contract snapshot testing, evals, smoke tests, and a sandboxed test runner. The testing approach is thorough for an experimental project.

**Concerns:**

- **Monolithic compiler.** The 461KB `main.c` is difficult to reason about and will become a maintenance liability as the language grows. Splitting codegen from CLI dispatch and emission backends would improve contributor velocity.
- **No LLVM backend.** Writing bespoke codegen for every target is heroic but unsustainable long-term. The project currently supports x86-64 (ELF/Mach-O/COFF) and aarch64 (ELF/Mach-O). Adding RISCV, WASM, or GPU targets would require writing new emission backends from scratch.
- **Pre-1.0 instability.** The project explicitly warns that breaking changes are expected and welcomed. The AGENTS.md says "do not preserve legacy behavior by default." This is fine for an experiment but limits adoption beyond agent sandboxes.
- **Error messages are terse.** The `print_diag` function produces compact `file:line:col CODE: message` output. For an agent-first tool this is fine (agents parse JSON), but human developers using the CLI without `--json` will find diagnostics laconic compared to Rust or Elm.
- **Binding-heavy standard library.** APIs like `std.http.fetch` require pre-allocated buffers, explicit timeouts, and manual result inspection. This is idiomatic for a systems language but verbose compared to what agents are used to (Python's `requests`, JavaScript's `fetch`).

**Recommendations:**

- Zero's skill system is the most interesting idea here — embedding structured language documentation into the compiler binary for agent self-query. This pattern could apply to any language toolchain (a `python skills get` that returns Python stdlib docs as structured markdown, for instance).
- For production use, watch for: (1) the compiler breaking up `main.c` into separable modules, (2) WASM target support, and (3) stabilization of the standard library APIs.
- At its current stage, Zero is best used as an inspiration for agent-first tooling design rather than a production language. The ideas about structured diagnostics, embedded skill data, and capability-based security are the real contributions.
