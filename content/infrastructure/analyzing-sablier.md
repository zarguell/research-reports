---
title: "Analyzing Sablier"
date: 2026-05-06
type: codebase-analysis
status: complete
source: https://github.com/sablierhq/sablier
tags: [solidity, ethereum, defi, token-streaming, smart-contracts, foundry]
---

# Analyzing Sablier

> **Source:** [sablierhq/sablier](https://github.com/sablierhq/sablier) @ [`6b3e69b`](https://github.com/sablierhq/sablier/commit/6b3e69ba34e58331a0ff348112e93919d184a6bb)
>
> **Companion Repository:** [sablier-labs/evm-monorepo](https://github.com/sablier-labs/evm-monorepo) @ [`8b6823c`](https://github.com/sablier-labs/evm-monorepo/commit/8b6823c019ff7556ac9ad24cbb5ac62821854d2f) — The active V2+ development repository.

## Overview

Sablier is the first production-grade protocol for **continuous, real-time token streaming** on EVM-compatible blockchains. The name "sablier" means "hourglass" in French — an intentional metaphor for money that flows through time rather than sitting idle in a wallet. The project has evolved through multiple major versions:

| Version | Codebase | Status |
|---------|----------|--------|
| V1 (Legacy) | `sablierhq/sablier` | **Analyzed here** — superseded, read-only |
| V2 (Lockup) | `sablier-labs/evm-monorepo` | Active — fixed-term vesting and vesting airdrops |
| V2 (Flow) | `sablier-labs/evm-monorepo` | Active — open-ended payroll-style streaming |
| V2 (Merkle Airdrops) | `sablier-labs/evm-monorepo` | Active — on-chain token airdrops |
| V2 (Bob) | `sablier-labs/evm-monorepo` | Active — price-gated token vaults |

The legacy repository is a **Lerna/Yarn monorepo** with three packages using Solidity 0.5.17, Truffle, and OpenZeppelin 2.3.0. The active development happens in the `sablier-labs/evm-monorepo` Foundry-based monorepo, which is analyzed as a companion to understand the full arc of the protocol.

> [!note]
> This report analyzes `sablierhq/sablier` (Legacy V1) as the target repository, with the `sablier-labs/evm-monorepo` used to provide architectural context for the V2+ design decisions and how the protocol evolved.

---

## How It Works (Legacy V1)

At its core, Sablier V1 implements a **time-delimited escrow** contract. The mechanism is straightforward:

1. A **sender** deposits a fixed number of ERC-20 tokens into the `Sablier` contract for a fixed duration.
2. The contract computes a `ratePerSecond = deposit / duration` — a linear vesting curve.
3. Tokens **accrue to the recipient** automatically over time; the recipient must call `withdrawFromStream()` to extract them.
4. At any point before depletion, either party can call `cancelStream()` to split the remaining balance pro rata.

The entire model fits in a single Solidity contract with five state variables and three public functions. This minimalism is the design's greatest strength and its greatest limitation.

---

## Architecture

### Legacy V1 Monorepo Structure

```
sablierhq/sablier/
├── packages/
│   ├── protocol/              ← Core streaming contract
│   │   ├── contracts/
│   │   │   ├── Sablier.sol   ← Main contract (293 lines)
│   │   │   ├── Types.sol     ← Stream struct definition
│   │   │   └── interfaces/
│   │   │       └── ISablier.sol
│   │   ├── migrations/        ← Truffle migration scripts
│   │   ├── test/             ← Mocha + Truffle tests
│   │   ├── scripts/
│   │   └── truffle-config.js  ← Network configs (mainnet, goerli, etc.)
│   ├── shared-contracts/      ← Reusable contracts across packages
│   │   ├── compound/
│   │   │   └── CarefulMath.sol  ← Safe math (pre-Solidity 0.8)
│   │   └── mocks/
│   │       └── ERC20Mock.sol
│   └── dev-utils/             ← Shared test utilities
├── lerna.json                ← Monorepo config (Lerna 3.x)
├── package.json
└── yarn.lock
```

### V2/V3 Architecture (sablier-labs/evm-monorepo)

```
sablier-labs/evm-monorepo/
├── lockup/        ← Fixed-term vesting (LL, LD, LT, LPG models)
│   └── src/
│       ├── SablierLockup.sol           ← Main singleton (ERC721, inherits all models)
│       ├── SablierBatchLockup.sol      ← Batch stream creation
│       ├── abstracts/                   ← Model-specific logic (Linear, Dynamic, Tranched, etc.)
│       ├── libraries/                   ← LockupMath.sol, LockupHelpers.sol
│       ├── interfaces/                   ← ISablierLockup*.sol
│       └── types/                       ← Lockup.sol, LockupLinear.sol, LockupDynamic.sol, etc.
├── flow/          ← Open-ended debt streaming
│   └── src/
│       ├── SablierFlow.sol              ← Debt-tracking singleton
│       ├── types/DataTypes.sol          ← Flow.Stream with snapshotDebtScaled
│       └── libraries/FlowHelpers.sol    ← Decimal scaling helpers
├── airdrops/      ← Merkle-based token distribution
├── bob/           ← Price-gated vault protocol (Chainlink oracle integration)
└── utils/         ← Shared infrastructure
    └── src/
        ├── SablierComptroller.sol      ← Protocol fee collection (UUPS upgradeable)
        ├── Comptrollerable.sol          ← Base for all protocol contracts
        ├── Batch.sol                    ← Shared batch creation logic
        ├── Adminable.sol / RoleAdminable.sol
        └── libraries/SafeOracle.sol     ← Chainlink price feed wrapper
```

---

## The Spine: How a Stream Flows Through the System

### Legacy V1 Stream Lifecycle

```
createStream(sender, recipient, deposit, token, startTime, stopTime)
  ├── Validate inputs (non-zero, non-self, non-zero-address, time order)
  ├── Compute: duration = stopTime - startTime
  ├── Require: deposit >= duration (no fractional tokens)
  ├── Require: deposit % duration == 0 (no remainder)
  ├── Compute: ratePerSecond = deposit / duration  (integer division)
  ├── Store: Types.Stream { deposit, ratePerSecond, remainingBalance=deposit,
  │                          startTime, stopTime, recipient, sender, tokenAddress, isEntity=true }
  ├── Increment: nextStreamId++
  ├── Transfer tokens: IERC20(token).safeTransferFrom(sender, this, deposit)
  └── Emit: CreateStream(streamId, sender, recipient, deposit, token, startTime, stopTime)
```

**Partial withdrawal** is the heart of Sablier's value proposition. When the recipient calls `withdrawFromStream(streamId, amount)`:

```
withdrawFromStream(streamId, amount)
  ├── Require: amount > 0
  ├── Compute: balance = balanceOf(streamId, recipient)
  │   └── delta = min(block.timestamp - startTime, stopTime - startTime, or 0 if not started)
  │   └── recipientBalance = delta * ratePerSecond - totalPreviousWithdrawals
  ├── Require: balance >= amount
  ├── Update: remainingBalance -= amount
  ├── If remainingBalance == 0: delete streams[streamId]  (gas refund)
  ├── Transfer: IERC20(token).safeTransfer(recipient, amount)
  └── Emit: WithdrawFromStream(streamId, recipient, amount)
```

**Cancellation** distributes the remaining tokens pro rata:

```
cancelStream(streamId)
  ├── senderBalance = balanceOf(streamId, sender)
  ├── recipientBalance = balanceOf(streamId, recipient)
  ├── delete streams[streamId]
  ├── Transfer recipient: recipientBalance tokens
  ├── Transfer sender: senderBalance tokens
  └── Emit: CancelStream(streamId, sender, recipient, senderBalance, recipientBalance)
```

> [!tip]
> The pro rata cancellation means the **recipient always keeps what has already vested**. The sender recovers only the unvested remainder. This is a critical economic invariant that makes Sablier safe for recipients.

### V2 Lockup: Four Distribution Models

The V2 `SablierLockup` contract consolidates four streaming models into a single ERC721 singleton:

**1. Lockup Linear (LL)** — Linear streaming with optional cliff and unlock amounts:
- `UnlockAmounts.start` — tokens unlocked immediately at start time
- `UnlockAmounts.cliff` — tokens unlocked at cliff time  
- Remaining amount — streamed linearly from start to end time
- `granularity` parameter — minimum withdrawal interval (prevents griefing via dust withdrawals)

**2. Lockup Dynamic (LD)** — Multi-segment streaming with custom exponents:
- Each `Segment` has: `amount`, `exponent` (UD2x18 fixed-point), `timestamp`
- Formula: `f(x) = x^exp * csa + Σ(previous_esas)` where `x = elapsed/duration`
- Enables step functions, acceleration/deceleration curves, and cliff-only vesting
- `LockupHelpers.calculateSegmentTimestamps()` converts durations to absolute timestamps

**3. Lockup Tranched (LT)** — Time-bucketed vesting:
- Each `Tranche` has: `amount`, `timestamp`
- Tokens unlock in discrete time buckets — simpler than LD for standard cliff+vest schedules
- Used heavily for employee grants: e.g., 25% at TGE, 75% over 12 months

**4. Lockup Price-Gated (LPG)** — Vesting that unlocks when a Chainlink price feed reaches a target:
- `UnlockParams` store the target price and expiry
- `SablerBob` contract (separate vault protocol) handles the actual price oracle integration
- Used for token-gated distributions tied to protocol milestones

### V2 Flow: Debt Tracking Model

Unlike Lockup's fixed deposit model, **Flow tracks debt continuously**:

```
Flow.Stream {
  balance: uint128          // Tokens deposited minus withdrawn
  ratePerSecond: UD21x18   // Fixed-point, 1e18 = 1 token/sec
  sender: address
  snapshotTime: uint40      // Last time debt was checkpointed
  snapshotDebtScaled: uint256  // Accumulated debt at snapshotTime (18-decimal scaled)
  token: IERC20
  tokenDecimals: uint8
  isVoided: bool
  isTransferable: bool
  isStream: bool
}
```

Debt calculation uses a **snapshot pattern**:

```
totalDebt = snapshotDebtScaled + ratePerSecond * (block.timestamp - snapshotTime)
coveredDebt = min(totalDebt, balance)
uncoveredDebt = max(0, totalDebt - balance)
```

Flow supports: pause/restart (resets snapshot), void (irreversible, forfeits uncovered debt), and refund (sender recovers excess balance).

---

## Key Patterns

### 1. Singleton Stream Management

V1 uses a simple `mapping(uint256 => Types.Stream) private streams`. V2 escalates this to a singleton ERC721 where each stream NFT represents a live stream. The NFT ownership confers withdrawal rights — transferring the NFT transfers the right to withdraw vested tokens. This is a clean, composable abstraction.

### 2. CarefulMath for Safe Integer Arithmetic

Legacy V1 uses a custom `CarefulMath` library (inspired by Compound Finance) that returns `(MathError, uint256)` tuples instead of reverting on overflow. Every arithmetic operation is checked explicitly:

```solidity
(MathError err, uint256 result) = mulUInt(delta, stream.ratePerSecond);
require(err == MathError.NO_ERROR, "recipient balance calculation error");
```

V2 abandoned this pattern entirely, moving to Solidity 0.8.29's built-in overflow checking, `SafeCast`, and `PRBMath` for fixed-point math. The `UD21x18` and `UD2x18` types from `@prb/math` handle decimal arithmetic.

### 3. Comptroller Pattern for Protocol Fees

The `SablierComptroller` (UUPS upgradeable) manages:
- **Protocol fees** — minimum fees in USD, converted to wei using Chainlink oracles
- **Role-based access** — `FEE_MANAGEMENT_ROLE`, `ASSET_ROLE`, `ORACLE_ROLE`
- **Custom per-user fees** — enterprise customers can negotiate discounted fees

This is the most significant architectural addition in V2 — the protocol now takes a cut.

### 4. Tight Variable Packing in Structs

Both V1 and V2 use aggressive struct packing to minimize storage costs:

```solidity
// V2 Lockup.Stream — 3 storage slots for 7 fields
struct Stream {
    Lockup.Amounts amounts;  // deposited(uint128) + withdrawn(uint128) + refunded(uint128) = 3 slots, but packed pair
    Lockup.Timestamps timestamps;  // start(uint40) + end(uint40) = 1 slot
    address sender;          // 1 slot
    Lockup.Model model;      // enum uint8 = 1 slot
    bool isCancelable;      // 1 slot (padded)
    bool isDepleted;        // 1 slot (padded)
    IERC20 token;            // 1 slot (address)
}
```

### 5. NFT Descriptor Pattern

`LockupNFTDescriptor` and `FlowNFTDescriptor` generate on-chain SVG/URI metadata for stream NFTs. This avoids off-chain IPFS dependencies and ensures NFT metadata is always accessible.

### 6. NoDelegateCall Protection

The V2 contracts use a `NoDelegateCall` base contract to prevent reentrancy via delegatecall, complementing the `ReentrancyGuard` pattern.

### 7. Batch Creation Pattern

`SablierBatchLockup` handles atomic multi-stream creation — the sender approves a single aggregate amount, and the contract distributes it across many recipients in one transaction. This is critical for airdrop and payroll use cases.

### 8. Hook Pattern

V2 introduces `_allowedToHook` — external contracts (vaults, staking pools) can register to receive callbacks when streams are canceled or withdrawn. This enables composable DeFi integrations.

---

## Non-Obvious Details

### Integer Division Rounding in V1

In `createStream()`, the requirement `deposit % duration == 0` is critical. Because `ratePerSecond = deposit / duration` uses integer division, without this check, rounding errors would accumulate over the stream's lifetime. In V2, `LockupMath` handles decimal-aware calculations using `PRBMath` to eliminate this constraint.

### The `remainingBalance == 0` Auto-Deletion

```solidity
if (streams[streamId].remainingBalance == 0) delete streams[streamId];
```

This is a gas optimization: deleting a storage slot refunds 15,000-24,000 gas. For fully withdrawn streams, this refunds the caller some of the gas spent on the withdrawal transaction.

### V1's `CarefulMath` Is Not SafeMath

`CarefulMath` returns error codes rather than reverting. Every caller must explicitly check the error code and revert manually. This is more verbose but allows callers to handle overflows differently — for example, the `balanceOf` function uses `subUInt` and expects underflow to be impossible given the caller's preconditions, hence the `assert()` instead of `require()`.

### Flow's Snapshot Debt Prevents Drift

The snapshot pattern in Flow is subtle: `snapshotDebtScaled` is denominated in 18-decimal fixed-point regardless of the token's decimals. The `FlowHelpers.descaleAmount()` and `scaleAmount()` functions bridge this gap. Without this, floating-point rounding would cause the debt to slowly diverge from the actual token amounts.

### LockupDynamic Exponents Enable Non-Linear Curves

The `UD2x18` exponent in `LockupDynamic.Segment` is a powerful abstraction. An exponent of `1.0` (UD2x18 representation) produces linear streaming. An exponent of `2.0` produces accelerating quadratic vesting. This is how Sablier supports "unlock 10% at TGE, then 90% cliff" patterns by setting the first segment amount to 10% of the total with a cliff timestamp, without needing a dedicated cliff model.

### The Comptroller Is the Only Upgradeable Contract

The `SablierComptroller` uses UUPS proxy pattern. All stream contracts (`SablierLockup`, `SablierFlow`) are completely immutable — once deployed, their logic cannot change. Only the fee and role configuration is upgradeable through the Comptroller. This is a strong security property: protocol fee changes cannot affect stream invariants.

### Chain Support Was Front-Loaded

V1's Truffle config includes deprecated networks (Ropsten, Rinkeby, Kovan) as well as the active ones (mainnet, Arbitrum, Avalanche, Optimism). The presence of these legacy networks indicates the breadth of V1's multi-chain deployment. V2 continues this with extensive deployment tables across Ethereum, Polygon, Arbitrum, Optimism, Base, and more.

---

## Supported Chains and Tokens

| Chain | V1 Support | V2 (Lockup v4.0) | V2 (Flow v3.0) |
|-------|-----------|-------------------|----------------|
| Ethereum | ✅ | ✅ | ✅ |
| Polygon | ✅ | ✅ | ✅ |
| Arbitrum | ✅ | ✅ | ✅ |
| Optimism | ✅ | ✅ | ✅ |
| Base | — | ✅ | ✅ |
| Avalanche | ✅ | ✅ | ✅ |
| BSC | ✅ | ✅ | — |
| zkSync | — | ✅ | ✅ |
| Scroll | — | ✅ | ✅ |
| Linea | — | ✅ | ✅ |

**Tokens:** All standard ERC-20 tokens are supported in both V1 and V2. There is no protocol-level token — streams are denominated in whatever ERC-20 the sender chooses. V2's `LockupMath` handles any token decimals via the `Lockup.Amounts` struct's `uint128` denomination (tokens with >18 decimals would overflow, but no standard ERC-20 has >18 decimals).

> [!question]
> ERC-4626 (tokenized vault standard) support is not present in the analyzed contracts. The Bob protocol's vault shares (ERC-20) are a related but distinct abstraction. Integrating with 4626 vaults as streaming recipients could be a future extension point.

---

## Fee Model

### Legacy V1: No Protocol Fees

V1 charges zero protocol fees. The only cost to users is **gas** — blockchain transaction fees. This made V1 attractive for experimentation but unsustainable as a business.

### V2+: Minimum Fee via Comptroller

V2 introduces a minimum protocol fee denominated in USD, converted to wei using a Chainlink oracle:

```solidity
// SablierComptroller — protocol fee structure
mapping(Protocol => ProtocolFees) private _protocolFees;
struct ProtocolFees {
    uint256 minFeeUSD;
    mapping(address => uint256) customFeesUSD;  // per-user overrides
}
```

The fee applies per stream created. Enterprise customers can negotiate custom fees via the `customFeesUSD` mapping. The Comptroller is UUPS-upgradeable, allowing Sablier Labs to modify fee parameters without redeploying stream contracts.

---

## Comparison with Payment Infrastructure

| Dimension | Sablier | Stripe | Circle | Traditional Wire |
|-----------|---------|--------|--------|------------------|
| Settlement timing | Continuous (per-second) | Batch (T+2 typical) | Near-instant | 1-5 business days |
| Cancellation | Pro-rata refund | Full refund (disputes) | Full refund | Irreversible |
| Partial withdrawal | ✅ Native | ❌ | ❌ | ❌ |
| Programmability | Smart contract logic | Webhooks + API | API | None |
| Counterparty risk | Zero (on-chain escrow) | Stripe holds funds | Circle holds funds | Bank solvency risk |
| Global access | Permissionless | KYC required | KYC required | Bank account required |
| Intermediaries | None | Stripe + card networks | Circle + banks | Correspondent banks |
| Fee model | Gas + protocol fee | 2.9% + $0.30 | 0% + $0.01 | $10-50 flat |
| FX support | Via bridge tokens | ✅ Native | ✅ Native | ✅ Native |

Sablier's core innovation is turning **discrete finance** (lump-sum payments) into **continuous finance** (per-second streaming). The implications are significant: salaries can be streamed continuously rather than paid bi-weekly; vesting schedules can enforce time-alignment without cliff distortions; grants can be stopped mid-vest if a recipient leaves.

---

## Notable Libraries and Tooling

| Library | Version | Purpose |
|---------|---------|---------|
| **OpenZeppelin** | V1: 2.3.0 / V2: 5.x | ERC20, ERC721, ReentrancyGuard, SafeERC20, UUPS |
| **PRBMath** | V2: latest | UD21x18, UD2x18, SD59x18 fixed-point math |
| **Foundry** | V2 | Compilation, testing (via `forge`), fuzzing, console.log |
| **Truffle** | V1: 5.5.x | Compilation, migration, testing |
| **Chainlink** | V2 | Price oracle feeds (Comptroller USD→wei conversion, Bob LPG) |
| **Lerna** | V1: 3.13.x | Monorepo package management |
| **Bun** | V2 | Package manager and runtime |
| **Just** | V2 | Command runner (replaces npm scripts) |
| **Bulloak** | V2 | Branching Tree Technique (BTT) test generation |
| **Bignumber.js** | V1: 8.1.1 | JavaScript big integer arithmetic (Truffle tests) |
| **Ganache** | V1: 6.5.1 | Local EVM for testing |
| **Solidity** | V1: 0.5.17 / V2: 0.8.29 | Language version reflects maturity trajectory |

---

## Assessment

### Strengths

**Minimal, auditable core.** The legacy V1 contract is 293 lines. A security researcher can read the entire implementation in one sitting. This is a deliberate design choice that prioritizes verifiability over feature count. The V2 architecture extends this with a well-separated library structure — `LockupMath` is the only computational engine, and it is used exclusively by the lockup contracts.

**Clean economic invariants.** The cancellation math is provably correct: `recipientBalance + senderBalance == remainingBalance` always holds. There is no protocol-level rounding that could advantage either party. This is essential for a protocol managing employee payroll and investor vesting.

**Immutable stream contracts with upgradeable governance.** The singleton pattern in V2 means new stream features (new distribution models) don't require migrating existing streams. The Comptroller is the only upgradeable component, and its scope is intentionally narrow (fees and roles only).

**Multi-chain by design, not afterthought.** Both V1 and V2 have comprehensive multi-chain deployment tables. The protocol is chain-agnostic by architecture — it only needs ERC-20 support.

**Extensive test coverage.** The BTT (Branching Tree Technique) testing methodology used in V2 ensures path-complete coverage. Tests are specified as `.tree` files and generated with `bulloak`, making coverage measurable and reproducible.

### Concerns

**V1's integer division constraint is user-hostile.** The requirement that `deposit % duration == 0` means streams must have integer `ratePerSecond`. For long-duration streams with small amounts, this creates awkward token quantities. V2's `PRBMath` fixed-point arithmetic eliminates this constraint but at the cost of added complexity.

**No native gas cost sponsorship.** Unlike some modern streaming protocols, Sablier doesn't support meta-transactions or gasless withdrawals out of the box. Recipients must hold ETH/MAV to pay gas for withdrawals — a friction point for small streams. The `_allowedToHook` pattern could theoretically support gasless withdrawals via a relayer, but it's not implemented.

**No ERC-777 or ERC-677 token hooks.** V1 uses only `safeTransferFrom` (ERC-20). Tokens with transfer fees (some ERC-20 variants) would cause accounting discrepancies because the contract receives fewer tokens than `deposit` specifies. V2's `_handleTransfer` pattern may handle this differently, but it warrants verification.

**Comptroller upgrade key is a single point of trust.** The `DEFAULT_ADMIN_ROLE` on the Comptroller can change fee parameters and even upgrade the Comptroller itself via UUPS. If this key is compromised, fee parameters could be changed adversarially. The role structure (`FEE_MANAGEMENT_ROLE` separate from admin) provides some separation, but the ultimate upgrade key is still a centralized control point.

**No emergency pause mechanism for stream contracts.** Once a stream is created, it runs to completion (or cancellation). There's no circuit breaker if a critical bug is found in `LockupMath` or `FlowHelpers`. The immutability cuts both ways — it protects against admin abuse but also against response to discovered vulnerabilities.

### Recommendations

1. **Consider ERC-7702 or account abstraction integration** to enable gasless withdrawals for recipients — this is the single largest UX friction point for small-value streams.
2. **Formal verification of LockupMath** — the LD streaming formula (`f(x) = x^exp * csa + Σ(esas)`) is complex enough that mechanical verification would add significant confidence, especially as exponents diverge from `1.0`.
3. **Monitor Comptroller role distribution** — if the upgrade key is held by a multisig, ensure the multisig's threshold and members follow best practices for high-value contracts.
4. **Add token transfer fee detection** — a guard that reverts if `IERC20(token).balanceOf(address(this)) < expectedAmount` after `safeTransferFrom` would prevent accounting errors with fee-on-transfer tokens.

---

## Related

[[analyzing-fluent-bit]]
[[analyzing-kanidm]]
[[analyzing-lightpanda-browser]]
