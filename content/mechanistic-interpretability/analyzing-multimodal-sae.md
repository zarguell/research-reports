---
title: "Analyzing Multimodal-SAE"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/EvolvingLMMs-Lab/multimodal-sae
tags: [python, mechanistic-interpretability, sparse-autoencoders, multimodal, llm, pytorch]
---

# Analyzing Multimodal-SAE

> **Source:** [EvolvingLMMs-Lab/multimodal-sae](https://github.com/EvolvingLMMs-Lab/multimodal-sae) @ [`60265c3`](https://github.com/EvolvingLMMs-Lab/multimodal-sae/commit/60265c36e4b21d7b70e1951086cc6f04a7bb5659)

## How It Works

Multimodal-SAE extends the Sparse Autoencoder (SAE) technique from language-only models to Large Multimodal Models (LMMs). Where traditional SAE research focused on text transformers, this work applies SAEs to the vision-language feature space of models like LLaVA-NeXT. The core insight is that SAE-learned features in a smaller LMM can be interpreted by a larger LMM — effectively using one model to explain another's internal representations.

The system has three main operations: **training** SAEs on multimodal activations, **caching** feature activations from images, and **interpreting** those features via an automated explanation pipeline. For interpretation, the pipeline crops activated image regions, sends them to a larger LMM (LLaVA-OV-72B), and uses the model's own reasoning to explain what semantic concept each SAE feature detects. Features can then be used to **steer** model behavior by clamping specific neurons to higher activation values.

## Architecture

```
multimodal-sae/
├── sae_auto_interp/           # Main interpretability package
│   ├── agents/                 # LLM clients and explainers
│   │   ├── explainers/         # Image and text explanation strategies
│   │   │   └── image_explainer/  # Vision feature explanation
│   │   └── scorers/            # Evaluation: CLIP-score, segmentation
│   ├── clients/                # API clients: OpenAI, SGLang, OpenRouter
│   ├── features/               # Feature caching, sampling, steering
│   │   ├── cache.py            # Activation buffering with DDP support
│   │   ├── steering.py         # Feature clamping for behavior control
│   │   └── patching/           # Attribution patching for feature discovery
│   ├── launch/                 # CLI entry points
│   │   ├── cache/              # cache_image.py, cache.py
│   │   ├── explain/            # explain_images.py, explain.py
│   │   ├── features/           # steering.py, attribution_patching.py
│   │   └── score/              # clip_score.py, segment.py
│   └── sae/                    # SAE model implementation
│       └── sae.py              # Core SAE: encode, decode, forward
├── train/sae/                  # Training package (separate)
│   └── sae/
│       ├── sae.py              # Training SAE with gradient handling
│       ├── trainer.py          # Training loop
│       └── data.py             # Multimodal data processing
└── tools/                     # Standalone utilities
    └── model_steering.py       # Single-feature steering CLI
```

## The Spine

The core user flow follows this path:

**1. Cache activations.** `cache_image.py` loads LLaVA-NeXT with SAEs attached at target layers (e.g., `model.layers.24`). For each image in the dataset, it runs a forward pass, extracts activations, applies top-k sparsity, and stores nonzero features in `.safetensors` files split across DDP ranks. Filters can restrict which features are cached.

**2. Interpret features.** `explain_images.py` loads cached activations, samples top-activating image patches per feature, and sends them to `ImageExplainer`. The explainer base64-encodes the activation overlays and prompts LLaVA-OV-72B to describe what semantic concept the feature detects. Results are saved as JSON + annotated image crops.

**3. Evaluate interpretations.** `segment.py` uses Grounding-DINO + SAM (Segment Anything) to detect the described concept in the original image, then computes IoU between the detection mask and the feature's activation mask. `clip_score.py` measures semantic alignment via CLIP similarity.

**4. Steer model behavior.** `steering.py` and the CLI tool register forward hooks that clamp specific SAE features to higher values during generation, demonstrating behavioral control through feature manipulation.

## Key Patterns

### DDP-Aware Distributed Caching

Both caching and scoring support `torchrun` multi-GPU execution. The `FeatureCache` and `FeatureImageCache` classes shard datasets by rank, process independently, and use `dist.barrier()` for synchronization. Output safetensors are sharded by feature index (`Rank{rank}_{start}_{end}.safetensors`), then concatenated post-processing via `concate_safetensors()`.

### Two-Stage Interpretation Pipeline

The interpretation uses a two-stage approach: LLaVA-OV-72B generates natural language descriptions, then LLaMA-3.1-Instruct-8B refines them before evaluation. The `ImageExplainer` sends base64-encoded activation overlay images to the LMM with a prompt asking it to describe "what this feature detects." The explainer parses a `[EXPLANATION]:` marker from the response.

### Hook-Based Activation Interception

SAEs are inserted via `register_forward_hook()` on the target module (e.g., a transformer layer). The hook intercepts activations, runs them through `sae.pre_acts()` (ReLU of encoder output), selects top-k, decodes back to the original space, and returns the reconstruction. For steering, the hook clamps specific feature indices to a fixed value (`k`) before decoding, effectively forcing that feature to "fire."

### Feature Sampling Strategies

Multiple sampling modes exist: `top` (highest activations), `quantile` (even activation distribution), and `random`. The `FeatureDataset` class loads safetensors, and `pool_max_activations_windows_image` extracts image patches around activation peaks, then upsamples the sparse activation grid to full image resolution using bilinear interpolation.

## Non-Obvious Details

**Hardcoded LLaVA-HF assumptions.** The codebase has several LLaVA-HF specific assumptions baked in. `prepare_image_examples()` hardcodes `num_image_tokens=576`, `patch_size=24`, and `image_size=336` — values that match LLaVA-NeXT but won't generalize. The README explicitly warns about hardcoded logic for specific models.

**SAE placement and freezing.** The SAE is trained by inserting it into a specific transformer layer while keeping all other components frozen. Only the SAE weights update during training. The README notes that while training code is released in `train/`, a separate repository (`EvolvingLMMs-Lab/sae`) has been created for "easier and more flexible SAE training" — suggesting the embedded training code may be less maintained.

**Attribution patching for feature discovery.** Rather than interpreting all 131K features, attribution patching identifies which features most influence a specific output token. It computes gradients from the target token back through the model, then attributes that loss to specific SAE features. This requires one backward pass per input, so the README recommends small resolution images or quantized models.

**Multi-model explanation pipeline.** The explain_images pipeline loads cached features, but the actual LLM explanation happens via `SRT` (SGLang Runtime) client pointing to `lmms-lab/llava-onevision-qwen2-72b-ov` at `localhost:12345`. This requires a separate SGLang server running — a deployment dependency not obvious from the README.

**Filter-based feature selection.** Instead of processing all features, users create JSON filters like `{"model.layers.24": [0, 1, 2]}` to restrict caching and interpretation to specific features. `create_filters_from_attribution.py` generates these programmatically from attribution patching results.

## Assessment

**Code quality: Good.** Clean module organization with clear separation between training (`train/sae`), interpretation (`sae_auto_interp`), and tools. Type annotations are present but not enforced (no pyright/mypy config). The codebase is a "detached fork" of EleutherAI's `sae-auto-interp` with substantial modifications — documentation acknowledges the divergence.

**Architecture fitness: Solid for research, limited generalization.** The pipeline is well-suited for reproducing the paper's experiments on LLaVA-NeXT. However, the hardcoded assumptions (image token counts, patch sizes, model-specific preprocessing) make it difficult to apply to other multimodal models without significant modification.

**Strengths:**
- Complete end-to-end pipeline: train → cache → interpret → evaluate → steer
- DDP support for multi-GPU processing
- Dual evaluation metrics: IoU (spatial) and CLIP-score (semantic)
- Attribution-based feature discovery reduces interpretability workload
- Pre-trained SAEs available on HuggingFace Hub

**Concerns:**
- Tight coupling to LLaVA-HF preprocessing (image token count, resize logic)
- Requires running a separate SGLang server for explanation
- The `train/` submodule is marked as superseded by a separate repo
- No type checking enforcement
- Large dependency footprint: transformers, sglang, nnsight, grounding-dino, SAM

**Recommendation:** This codebase is the right choice for researchers reproducing the ICCV 2025 paper on LLaVA-NeXT. For applying SAE-based interpretability to other multimodal models, expect significant adaptation work. The separate `EvolvingLMMs-Lab/sae` repository may offer a cleaner, more generalizable training path going forward.
