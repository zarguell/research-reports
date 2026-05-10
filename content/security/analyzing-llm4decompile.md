---
title: "Analyzing LLM4Decompile"
date: 2026-05-10
type: codebase-analysis
status: complete
source: https://github.com/albertan017/LLM4Decompile
tags: [reverse-engineering, decompilation, llm, binary-analysis, security]
---

## Overview

LLM4Decompile is a pioneering open-source research project that applies large language models to the problem of binary decompilation — translating compiled machine code back into human-readable C source code. Published as an arXiv paper (2403.05286) by Hanzhuo Tan, Qi Luo, Jing Li, and Yuqun Zhang, the project represents one of the first systematic attempts to treat decompilation as a sequence-to-sequence translation task solvable by fine-tuned LLMs. The repository contains model inference code, evaluation pipelines, benchmark datasets (HumanEval-Decompile, Decompile-Bench), Ghidra integration scripts, and training configurations for the newer SK²Decompile two-phase approach. The project has evolved through multiple iterations — from direct binary-to-C decompilation (V1.5 End) to Ghidra pseudo-code refinement (V2 Ref) to a skeleton-to-skin pipeline (SK²Decompile) — with model sizes ranging from 1.3B to 22B parameters.

## Key Findings

### Architecture and Approach

LLM4Decompile frames decompilation as a supervised fine-tuning task on causal language models. The input is either raw disassembled assembly code (from `objdump`) or pseudo-code produced by Ghidra, and the target output is clean, compilable C source code. The models are built on top of existing decoder-only LLM backbones — DeepSeek-Coder for V1.5, Yi-Coder for the 9B V2 variant — and fine-tuned on billions of binary-source token pairs. The prompt format is deliberately minimal: `# This is the assembly code:\n<ASM>\n# What is the source code?\n`, followed by the model's generated C function. This simplicity keeps inference straightforward and avoids complex prompt engineering.

### Model Variants and Evolution

The project has released several model families:

- **V1 (End)**: Initial models that directly decompile assembly into C. Trained on ~4B tokens, limited to 1,024 token context.
- **V1.5 (End)**: Scaled training to 15B tokens with 4,096 max token context. The 6.7B variant achieves 45.4% re-executability, a 100% improvement over V1.
- **V2 (Ref)**: Shifts to a refinement paradigm — Ghidra decompiles the binary into pseudo-code first, then the LLM refines it into clean C. Trained on 2B tokens. The 9B model reaches 64.9% re-executability, and the 22B variant achieves 63.6%.
- **V1.6 (DCBench)**: Trained on the newer Decompile-Bench dataset (2M pairs from 100M raw pairs), adding C++ support. The 1.3B model achieves 20.89% on HumanEval-Decompile.
- **SK²Decompile**: A two-phase approach released in late 2025. Phase 1 (Skeleton) transforms binary or pseudo-code into a normalized intermediate representation with obfuscated identifiers. Phase 2 (Skin) generates human-readable source with meaningful variable and function names. Training uses LLaMA-Factory with DeepSpeed ZeRO-2, cosine learning rate scheduling, and supervised fine-tuning.

### Training Data and Benchmarks

The project introduced several important datasets:

- **HumanEval-Decompile**: 164 C functions × 4 optimization levels (O0–O3), adapted from OpenAI's HumanEval benchmark. Each sample includes the original C function, test assertions, and preprocessed assembly prompts.
- **Decompile-Bench**: A massive dataset of 2 million curated binary-source pairs, distilled from 100 million raw pairs compiled from permissively licensed GitHub projects. Uses a Compile-Trace-Filter pipeline to ensure quality.
- **ExeBench**: 2,621 functions from real-world projects with user-defined functions, structures, and macros.

Training data preprocessing is notably thorough. The `format.py` script applies clang-format normalization, removes comments via regex, strips empty lines, and filters functions by line count (3–300 lines). This produces consistent training samples.

### Evaluation Methodology

The primary metric is **re-executability**: whether the decompiled C code compiles with GCC, links against the original test harness, and passes all test assertions at runtime. This is a strong functional correctness metric — it goes beyond syntactic similarity to verify semantic equivalence. The evaluation pipeline (`run_evaluation_llm4decompile_vllm.py`) uses vLLM for efficient batch inference, multiprocessing for parallel compilation/testing, and configurable repeat runs for stability. Each test case goes through a two-stage check: first compilation with `gcc -S`, then full compilation and execution with a 10-second timeout.

A secondary **edit similarity** metric based on Levenshtein distance measures the minimum edits needed to transform the decompiled output into the reference source. The Decompile-Bench evaluation also supports IDA Pro and Ghidra outputs as additional baselines, providing comprehensive cross-tool comparison.

### Code Quality

The codebase is functional but clearly research-oriented. Strengths include well-structured evaluation scripts with proper multiprocessing, comprehensive vLLM/TGI inference support, and a clean Docker setup with Ghidra integration. Weaknesses include significant code duplication — the `evaluate_func` function is copied verbatim across three evaluation files, the demo and README contain largely duplicated preprocessing code, and the `requirements.txt` has duplicate entries. Error handling uses bare `except` clauses that silently swallow exceptions. The Ghidra integration script (`decompile.py`) is written in Python 2 for Ghidra's Jython environment, which is a constraint of the platform rather than a design choice. There are no unit tests, CI/CD configuration, or automated quality checks.

## Assessment

**Strengths:**

- **Pioneering work**: LLM4Decompile is the first open-source LLM dedicated to decompilation, establishing the feasibility of the approach and releasing reproducible models, datasets, and evaluation code.
- **Strong evaluation methodology**: Re-executability is a rigorous, meaningful metric that measures actual functional correctness rather than surface-level code similarity.
- **Practical ecosystem**: Docker support, Google Colab notebooks, Hugging Face model releases, and multiple inference backends (vLLM, TGI, direct transformers) make the project accessible.
- **Iterative improvement**: The project has evolved from direct decompilation to Ghidra-based refinement to the SK² two-phase pipeline, showing thoughtful architectural progression.
- **Massive dataset curation**: The Decompile-Bench pipeline — compiling 450GB of binaries from GitHub, tracing function-level mappings, and filtering down to 2M high-quality pairs — is a significant contribution.

**Concerns:**

- **Architecture limitations**: Currently supports only Linux x86_64 ELF binaries compiled with GCC. No ARM, MIPS, Windows PE, or macOS Mach-O support.
- **Scalability**: The prompt-based approach requires fitting entire function assembly within the context window (4,096 tokens for V1.5), limiting applicability to large functions.
- **Code quality**: Significant duplication across evaluation scripts, bare exception handling, no tests, and no CI pipeline.
- **Dependency on Ghidra**: The V2 Ref approach adds a heavy external dependency. Ghidra's headless analyzer requires Java 17 and adds significant latency to the pipeline.
- **Re-executability ceiling**: Even the best model (9B V2) achieves ~65% re-executability, meaning one-third of decompiled functions fail to produce correct output. Higher optimization levels (O2/O3) show degraded performance.

**Recommendations:**

- Expand architecture support to ARM64 and RISC-V, critical for embedded and IoT security analysis.
- Consolidate duplicated evaluation code into shared utility modules.
- Add structured logging and error categorization to the evaluation pipeline (compile errors vs. runtime failures vs. assertion failures).
- Investigate retrieval-augmented approaches to handle functions larger than the context window.
- Add automated test suites and CI for the evaluation and preprocessing code.

## Related

- [[analyzing-ghidra-mcp]]
- [[analyzing-nuclei]]
- [[analyzing-misp]]
- [[analyzing-opencti]]
- [[analyzing-velociraptor]]
- [[analyzing-bloodhound]]
- [[analyzing-mimikatz]]
