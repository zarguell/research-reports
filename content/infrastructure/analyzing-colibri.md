---
title: "Analyzing Colibrì — 744B MoE Inference on Consumer Hardware"
date: 2026-07-15
type: codebase-analysis
status: complete
source: https://github.com/JustVugg/colibri
tags: [c, inference, moe, llm, glm, streaming, gpu]
---

# Analyzing Colibrì

> **Source:** [JustVugg/colibri](https://github.com/JustVugg/colibri) @ [`3fd47b7`](https://github.com/JustVugg/colibri/commit/3fd47b7bbd0a8c92fa9344589032d6edc33e40e2)

## Overview

Colibrì is a single-file C inference engine for **GLM-5.2**, a 744-billion-parameter Mixture-of-Experts model. Its central thesis: an MoE model activates only ~40B parameters per token, so a consumer machine with ~25 GB of RAM can run it by keeping the dense layers resident and streaming the routed experts from disk on demand. The engine is pure C with zero runtime dependencies, implements the full GLM-5.2 architecture (MLA attention, sigmoid router, shared expert, MTP speculative decoding), and validates token-exact against a PyTorch transformer oracle. Optional CUDA and Metal backends provide GPU acceleration for the expert tier.

The project is a one-person effort, written and tested on a 12-core WSL2 laptop with 25 GB RAM and a DRAM-less NVMe. Community benchmarks show 0.05-2.06 tok/s depending on hardware, with the fastest single-request result at 6.84 tok/s on six RTX 5090s with full expert residency.

## Key Findings

### How It Works

The insight is a memory-hierarchy bet: a 744B MoE model activates ~40B params per token, of which only ~11B change between tokens (the routed experts). The dense layers (attention, embeddings, shared expert, LM head — ~17B params) sit resident in RAM at int4 (~9.9 GB). The 21,504 routed experts live on disk (~370 GB total at int4) and stream on demand through a per-layer LRU cache with an optional pinned hot-store and the OS page cache as free L2.

Each token triggers 75 MoE layers × 8 routed experts = ~600 expert reads. At ~19 MB per expert, that's ~11 GB of disk reads per cold token. MTP speculation (the model's own multi-token-prediction head, kept at int8) drafts 2-3 tokens per forward, roughly halving effective disk cost once the cache warms. The learning cache records routing patterns (`.coli_usage`) and auto-pins the hottest experts across sessions — the engine gets faster with use.

### Architecture

The codebase is intentionally flat:

```
c/
├── glm.c              ~5,200-line single-file engine (all of inference)
├── st.h               Sharded safetensors reader (pread-based, no mmap)
├── tok.h              Byte-level BPE tokenizer (cl100k-style, 320k merges)
├── tier.h             Expert hot-store swap logic (LFU, LFRU replacement)
├── grammar.h          GBNF grammar-forced speculative drafts
├── decode_batch.h     Batched decode submission parsing
├── backend_cuda.*     Optional CUDA backend (kernel correctness-first)
├── backend_metal.*    Optional Apple Silicon Metal backend
├── backend_loader.c   Runtime DLL loader for Windows CUDA tier
├── compat.h           Platform shim (macOS/Win32 POSIX emulation)
├── iobench.c          Standalone disk I/O benchmark
├── olmoe.c            OLMoE variant engine (same architecture, smaller)
├── json.h             Minimal JSON parser
├── coli               Python CLI entry point
├── openai_server.py   OpenAI-compatible HTTP gateway
├── resource_plan.py   Disk/RAM/VRAM resource planner
├── doctor.py          Pre-flight readiness diagnostics
└── tools/             Offline converters, benchmarks, test fixtures
```

The runtime dependencies are: **gcc + OpenMP + pthreads**. That's it. Python is only used by the one-time FP8→int4 converter, the CLI wrapper, and the HTTP server — the engine itself reads no Python at runtime.

### The Spine

The entry point is the `coli` Python CLI, which translates flags to environment variables and launches the `glm` C binary. The C engine's main loop:

1. **Load** — `st.h` opens all 144 safetensor shards via `pread()`, builds a hash map of ~120K tensor names, loads resident dense tensors into RAM, and initializes the expert cache auto-sized to `MemAvailable`.
2. **Tokenize** — `tok.h` encodes the input prompt (byte-level BPE with Unicode-property regex pre-tokenization, cl100k-style).
3. **Prefill** — Processes the prompt in one forward pass. Batch-union MoE: each unique expert read once and applied to every position routing to it. Compressed MLA KV-cache stored (576 floats/token vs 32,768 for dense).
4. **Decode loop** — For each output token:
   - Router computes top-8 experts from hidden state (sigmoid + noaux_tc)
   - Streaming: `PIPE` workers issue async `pread()` for missing experts on disk
   - Expert multiply: gate+up projection in one OpenMP dispatch, then down projection
   - MTP speculation (if enabled): draft head bids 2-3 candidate tokens, verified in one batched forward
   - Sampling: temperature + nucleus top-p (default 0.7/0.90, tuned for int4)
   - Output token emitted, KV appended
5. **Persist** — MLA KV-cache appended to `.coli_kv` after every turn (crash-safe, ~182 KB/token).

### Key Patterns

**Zero-dependency C as architectural decision.** No BLAS, no cuBLAS dependency on the CPU path, no Python runtime. The engine implements its own quantized matmul kernels (AVX2 `maddubs` for int8, packed int4/int2 with per-row scales, dequant-on-use). This keeps the binary static and dependency-free at the cost of hand-tuned SIMD kernels.

**Tiered expert placement.** The engine treats VRAM, RAM, and disk as a single managed hierarchy with three tiers:
- **VRAM (hot):** Pinned experts on GPU, zero-copy Metal on Apple Silicon
- **RAM (warm):** LRU cache + dedicated hot-store from learned usage history
- **Disk (cold):** Immutable recovery source, not a normal decode target

The `tier.h` LFU/LFRU replacement policy trades off between access frequency and recency, with 25% hysteresis to prevent thrashing.

**Validation-first development.** Every PR is reviewed against a token-exact oracle: teacher-forcing 32/32 positions and greedy 20/20 must reproduce the PyTorch reference exactly. The same oracle validates all backends (CPU, CUDA, Metal) for byte-identical output.

**Honest measurement culture.** The README opens with "This is not fast" — 0.05-0.1 tok/s on the dev box — and the community benchmark table is meticulously maintained with per-machine config, disk speed, expert hit rate, and bottleneck analysis. Performance claims are distinguished from estimates, and corrections are published transparently (the 9800X3D row notes a retracted earlier claim).

### Non-Obvious Details

**MTP speculations changes the output stream — even verified ones.** The engine's quantized integer kernels are shape-dependent, so batched forward (S>1) rounds differently from single-token. Since int4 GLM sits close enough to argmax ties, this kernel-family difference can flip a token. The emitted token is still the argmax of a valid forward — continuation stays correct — but it isn't byte-identical to non-speculative greedy. This affects MTP, CUDA expert tier, and batched prefill equally. For byte-exact reproducibility: `DRAFT=0 IDOT=0 COLI_CUDA=0`.

**Grammar-forced speculative drafts.** The `grammar.h` component implements a GBNF parser (llama.cpp-style) evaluated at the byte level. On constrained-output workloads (JSON, function calling, structured extraction), wherever the grammar admits exactly one legal byte (braces, quotes, key names), that forced span is tokenized and injected as pre-accepted drafts with ~1.0 acceptance — no draft head, no lookup table. This composes with MTP speculation, which fills the free-text gaps between forced spans. Critically, the grammar never constrains sampling: wrong grammars produce rejected drafts, never wrong output.

**Router-lookahead prefetch (PILOT).** The next layer's expert routing is 71.6% predictable from the current layer's post-attention state. `PILOT=1` issues next-layer expert readahead from a dedicated I/O thread while the current layer computes. On the dev box it's neutral (disk already 80% saturated); on balanced machines it should overlap real I/O with compute.

**Windows CUDA tier via runtime DLL.** On Windows, the CUDA backend is built as a standalone `coli_cuda.dll` (nvcc + MSVC, not MinGW) and loaded at runtime via `LoadLibrary`/`GetProcAddress`. If absent, the CPU path works unchanged. The DLL exports 11 `extern "C"` symbols with opaque `ColiCudaTensor*` structs safe across the ABI boundary.

**Crash-safe KV persistence.** The compressed MLA KV-cache appends to `.coli_kv` after every turn. On restart, it resumes with zero re-prefill — validated byte-identical to an uninterrupted session. The format is simple enough that corruption from a mid-write crash loses at most one turn.

## Assessment

### Strengths

- **Architectural honesty.** The project doesn't pretend a 744B model runs fast on consumer hardware — it documents exactly how slow, on exactly which bottleneck, and gives you knobs (PIN, MTP, PIPE, DIRECT, repin) to turn up as your hardware allows.
- **Portability without compromise.** Linux, macOS, Windows native (MinGW-w64), x86-64, ARM, POWER — the same engine runs on all of them. Platform differences stay in `compat.h`; `glm.c` is unchanged.
- **Quality instrumentation.** The token-exact oracle, the `iobench` disk benchmark, the `coli bench` quality harness, the `coli plan` resource planner, and the `coli doctor` readiness check form a complete measurement stack. No guessing.
- **Zero-dependency C runtime.** No pip install, no Docker, no CUDA toolkit on the CPU path. `gcc -O3 -fopenmp glm.c -o glm -lm` is the full build for the engine.
- **Transparent community.** The benchmark table, the honest 62.5% quality datapoint (with confounds clearly explained), and the publicly corrected measurement errors set a standard for open-source ML projects.

### Concerns

- **Quantization quality is unresolved.** The measured 62.5% on HellaSwag/ARC/MMLU (vs 85-95% expected for fp16 GLM-5.2) is confounded by 0-shot log-likelihood badly suiting a reasoning model. The decisive fp16-vs-int4 A/B on OLMoE hasn't been run. Until it is, the int4 quality ceiling is unknown — 62.5% could be entirely a scoring artifact, or it could confirm grouped-scale quantization is needed.
- **Single-person bus factor.** This is a remarkably sophisticated engine built by one person. Documentation, test coverage, and CI are excellent for a solo project, but long-term maintenance depends on community adoption.
- **Int4 MTP head = 0% acceptance footgun.** The most common user complaint ("why is MTP stuck at 0%?") is caused by downloading the wrong model mirror, because the original int4 mirror ships int4 MTP heads that produce 0% draft acceptance. This is documented but continues to confuse users. The engine could detect this at startup.

### Recommendation

**Use colibrì when** you need to run a 744B frontier-class model on consumer hardware with no cloud GPUs, you have a local NVMe and ≥25 GB RAM, and you accept single-digit tok/s as the cost of local sovereignty. The learning cache makes it faster the more you use it, and the tiered placement gives clear upgrade paths (more RAM → bigger expert cache → higher hit rate).

**Don't use colibrì when** you need production throughput (>10 tok/s), you're on a network filesystem (ext4/NVMe required), or you want byte-exact reproducibility across runs (kernel-family rounding differences mean greedy outputs can diverge per run).

## Related

- [[analyzing-litellm]] — LLM gateway/routing infrastructure (complementary layer for multi-model deployments)
- [[analyzing-zer0vuln]] — Self-hosted AI security stack (different scale of local AI deployment)
- [[deep-dive-building-on-pi]] — Patterns for building on top of inference runtimes (generalizable architecture lessons)
