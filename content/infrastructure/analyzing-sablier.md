---
title: "Analyzing Sablier: Open-Source Payment Streaming Infrastructure"
date: 2026-05-06
type: codebase-analysis
status: complete
source: sablierhq/sablier (legacy), sablier-labs/evm-monorepo, sablier-labs/indexers
tags: [blockchain, solidity, evm, payment-streaming, defi, infrastructure]
---

## Overview

Sablier is an open-source protocol for continuous, real-time payment streaming on the EVM. Instead of lump-sum transfers, Sablier escrows funds in a smart contract that releases tokens incrementally over time — to the second. The protocol powers use cases ranging from payroll (continuous salary), vesting (cliff-less equity), and subscription billing to creator monetization and airdrops.

The project has three distinct layers:

- **Smart contracts** — EVM-based protocol logic (Lockup, Flow, Airdrops, Bob)
- **Indexers** — GraphQL data pipelines that process on-chain events into queryable data
- **Frontend** — Web application consuming indexer APIs

There are two major protocol generations:
- **Legacy (v1)** — `sablierhq/sablier`, Truffle + Solidity 0.5.x, last active 2021
- **Modern (v2+)** — `sablier-labs/evm-monorepo`, Hardhat + Foundry, active

The modern stack is the relevant one for any current analysis.

> [!note]
> Throughout this report, "Sablier" refers to the modern sablier-labs ecosystem unless explicitly prefixed with "legacy v1."

---

## Smart Contracts Architecture

### Repository Structure

The EVM monorepo at `sablier-labs/evm-monorepo` contains several packages under `packages/`:

| Package | Purpose | Solidity Version |
|---------|---------|-----------------|
| `lockup` | Fixed-term vesting streams | >=0.8.22 |
| `flow` | Open-ended continuous streams | >=0.8.22 |
| `airdrops` | Merkle-based token distributions | >=0.8.22 |
| `bob` | Price-target vaults + OTC escrow | >=0.8.22 |
| `utils` | Shared: Comptroller, Batch, role libs | >=0.8.22 |
| `misc` | Benchmarks, examples, tests | various |

Key dependencies:
- **OpenZeppelin** v5.3.0 (ERC721, UUPS proxy, Ownable, ReentrancyGuard)
- **@prb/math** v4.1.0 (UD2x18 fixed-point for dynamic stream exponents)
- **solady** (LockupLinear, Airdrops — gas-optimized lib)
- **solarray** (LockupLinear — inline array creation)
- **@sablier/evm-utils** v2.0.1 (shared low-level helpers)

### Lockup: Fixed-Term Streaming

Lockup handles time-bound streams where funds are escrowed upfront and released linearly over a defined period. There are four variants:

#### LockupLinear (LL)
Linear vesting with optional cliff. Funds unlock in a continuous stream from `startTime + cliffDuration` to `startTime + totalDuration`.

```
createStream → depositAmount escrowed
               startTime
               ├── cliff duration (0 unlock) ──┐
               │                               ├── linear unlock
               └───────────────────────────────┘
               endTime
```

Key struct fields:
```solidity
struct LockupLinear {
    address sender;
    address recipient;
    uint128 depositAmount;
    uint128 withdrawnAmount;
    uint64 startTime;
    uint64 cliffDuration;    // seconds, 0 = no cliff
    uint64 totalDuration;    // cliffDuration + linear unlock period
    bool   cancelable;
    bool   transferred;
}
```

The `granularity` parameter (minimum seconds between unlock ticks) controls rounding resolution — a lower granularity means more precision but more gas.

#### LockupDynamic (LD)
Arbitrary vesting curves using PRB math's UD2x18 fixed-point exponents. Each segment has a timestamp, amount, and exponent. An exponent of `1.0` produces linear release; exponents >1.0 produce accelerating curves (useful for vesting that back-loads rewards).

```solidity
struct Segment {
    uint128 amount;
    UD2x18  exponent;       // e.g., 1.0 = linear, 2.0 = quadratic
    uint64  timestamp;
}
```

#### LockupTranched (LT)
Discrete tranches with no continuous unlock — funds sit locked until each tranche's timestamp arrives, then unlock atomically.

```solidity
struct LockupTranched {
    address sender;
    address recipient;
    uint128 depositAmount;
    uint128 withdrawnAmount;
    uint64  startTime;
    uint64  totalDuration;
    bool    cancelable;
    bool    transferred;
    // tranches: (amount, timestamp) pairs
}
```

#### LockupPriceGated (LPG)
Tokens unlock only when the ERC-20/ETH price (from ChainLink oracle) crosses a target threshold. No partial withdrawals — the full tranche amount must be withdrawn at once. Useful for conditional vesting tied to token price floors.

### Flow: Continuous Streaming

Flow is the open-ended counterpart. Unlike Lockup, there is no fixed deposit. Instead, the sender funds a running balance that depletes continuously at a `ratePerSecond`.

Core struct:
```solidity
struct FlowStream {
    address sender;
    address recipient;
    uint256 depositedAmount;
    uint256 withdrawnAmount;
    uint112 ratePerSecond;
    uint256 availableAmount;   // computed: deposited - withdrawn
    uint256 depletionTime;     // when balance runs out at current rate
    bool    paused;
    uint256 pausedTime;
    uint256 snapshotAmount;     // debt captured at last pause/resume
}
```

The debt model tracks two quantities:
- **snapshotDebt** — debt accumulated at the rate until a pause/void/restart event
- **ongoingDebtScaled** — accumulating debt at current rate since last adjustment

Debt forgiveness: `void(streamId)` marks all remaining debt as forgiven (the sender's obligation is erased). This is semantically different from Lockup's `cancel` (which returns unstreamed funds).

### SablierLockup (Main Entry Point)

The primary contract orchestrates all lockup variants. It inherits:
- `ERC721` — each stream is an NFT (tokenId = streamId)
- `Batch` — batch create/cancel/withdraw for gas efficiency
- `Comptrollerable` — fee validation against SablierComptroller
- All lockup type abstract contracts

Critical methods:
- `createWithDurationsLL/LD/LT/LPG` — create stream by relative duration
- `createWithTimestampsLL/LD/LT/LPG` — create stream by absolute timestamps
- `withdraw(streamId, to, amount)` — partial withdrawal to any address
- `withdrawMax(streamId, to)` — withdraw entire withdrawable amount
- `withdrawMaxAndTransfer(streamId)` — withdraw + transfer NFT to recipient
- `cancel(streamId)` — sender cancels; recipient claims remaining
- `cancelMultiple(streamId[])` — batch cancel
- `withdrawMultiple(streamId[], to[])` — batch withdraw
- `getLockedAmount(streamId)` — atomic unlock calculation
- `getWithdrawableAmount(streamId)` — max withdrawable right now

Stream status lifecycle: `PENDING → STREAMING → SETTLED | CANCELED | DEPLETED`

The NFT design is notable: recipients can transfer the stream NFT to a third party, which reassigns the stream's recipient. The new holder can withdraw on behalf of the original recipient.

### SablierComptroller (Protocol Governance)

The Comptroller is a UUPS-upgradeable contract that:
1. **Validates protocol fees** — every stream creation checks the protocol minimum fee is met
2. **Converts USD fees to native token** — uses ChainLink ETH/USD oracle to price the fee in wei
3. **Manages fee exemptions** — certain addresses (e.g., Bob adapters) can bypass fees
4. **Stores `attestor` address** — for future integration with attestations

```solidity
uint256 public constant override MAX_FEE_USD = 100e8; // $10,000 cap

function calculateMinFeeWei(Protocol protocol) external view returns (uint256) {
    uint256 minFeeUSD = _protocolFees[protocol].minFeeUSD;
    return convertUSDFeeToWei(minFeeUSD, /* ChainLink oracle */);
}
```

Protocols: `Lockup`, `Flow`, `Bob`, `Airdrops` — each has its own minimum fee.

### Batch Operations

The `Batch` contract provides gas-efficient multi-stream creation:
```solidity
function createWithDurationsLLBatch(
    CreateWithDurationsLL[] calldata params
) external returns (uint256[] memory streamIds);
```

Uses `delegatecall` to each lockup variant's implementation, saving deployment gas vs individual transactions.

---

## Supported Chains and Tokens

### Chains
Sablier v2+ is EVM-native, so any EVM-compatible chain works. The protocol has been deployed on (confirmed in `sablier.config.ts`):

- Ethereum Mainnet
- Polygon (137)
- Arbitrum (42161)
- Optimism (10 / 111)
- Base (8453)
- BNB Smart Chain (56)
- Avalanche C-Chain (43114)
- Gnosis Chain (100)

### Tokens
- **ERC-20 only** — Sablier streams any ERC-20 token. There is no native ETH support (users wrap to WETH first).
- **No ERC-4626 integration** — Sablier does not currently use vault tokens. The Bob package explores yield-adapter integrations but is separate.
- The protocol handles tokens with different decimals correctly by normalizing amounts in calculations.
- Minimum stream amounts apply to prevent dust and rounding exploits.

---

## Cancel, Refund, and Unlock Flows

### Lockup Cancel
1. Sender calls `cancel(streamId)` on SablierLockup
2. `_cancel()` computes: `refund = depositAmount - streamedAmount`
3. `canceled = true`, `cancelable = false` on the stream
4. The **recipient must still call `withdraw()`** to claim the refund
5. If recipient doesn't withdraw, funds sit in the contract indefinitely

> [!warning]
> Cancel returns unstreamed funds to the recipient, not the sender. The sender can only recover funds if the stream was cancelable (the default). Non-cancelable streams (set at creation) cannot be canceled.

### Lockup Withdraw (Partial)
1. Recipient calls `withdraw(streamId, to, amount)`
2. Amount can be any value up to `getWithdrawableAmount(streamId)`
3. ERC20 transferred to the `to` address (not necessarily the recipient — send to anyone)
4. `withdrawnAmount` incremented; `intactAmount` decremented
5. NFT owner can withdraw on behalf of recipient

### Flow Cancel (= Void)
1. Sender calls `void(streamId)`
2. All outstanding debt is forgiven — the sender owes nothing further
3. Recipient withdraws whatever balance is currently `availableAmount`
4. Stream cannot be resumed after void

### Flow Pause / Resume
1. `pause(streamId)` — ratePerSecond → 0, `snapshotAmount` captured, `paused = true`
2. `resume(streamId)` — new snapshot taken at current debt, rate restarts
3. Any caller can withdraw available funds during pause

---

## Fee Model

Sablier charges a **protocol minimum fee in USD**, converted to native token at time of stream creation. Key properties:

- Fee is per-protocol (Lockup vs Flow vs Airdrops vs Bob)
- Capped at `$10,000 USD` (MAX_FEE_USD = 100e8 in 8-decimal units)
- Fee is **paid by the sender** — not deducted from the deposit (sender must send deposit + fee)
- **Gas is separate** — users pay EVM gas for transactions on top of protocol fees
- Bob has a fee bypass: if a yield adapter exists for the token, the protocol takes its cut from yield instead of charging upfront

```
Total cost to sender ≈ depositAmount + protocolFeeWei + (gas * gas_price)
```

There is no protocol revenue split with recipients — all streamed funds go to the recipient.

---

## Backend: Indexers and Data Pipeline

The indexers (`sablier-labs/indexers`) are a critical piece of infrastructure. The smart contracts do not expose rich query APIs — all aggregation must be computed from events. The indexers solve this.

### Dual Indexer Architecture

Sablier runs **two parallel indexing targets**:

1. **Envio** (TypeScript, recommended) — `envio/streams/`
2. **The Graph** (AssemblyScript) — `graph/streams/`

Both consume the same event sources and write to the same GraphQL schema.

### GraphQL Schema

Key entities:

**FlowStream:**
- `ratePerSecond`, `availableAmount`, `depositedAmount`, `withdrawnAmount`, `refundedAmount`, `forgivenDebt`
- `depletionTime`, `paused`, `snapshotAmount`, `lastAdjustmentTimestamp`
- `lastAdjustmentAction_id`, `pausedTime`, `pausedAction_id`

**LockupStream:**
- `depositAmount`, `withdrawnAmount`, `refundedAmount`, `intactAmount`
- `canceled`, `depleted`, `canceledTime`, `cliffTime`, `granularity`
- `canceledAction_id`, `renouncedAction_id`

**LockupAction / FlowAction:**
- `category`: Create, Withdraw, Cancel, Renounce, Pause, Resume, Void, Refund
- `addressA`, `addressB`, `amountA`, `amountB` (semantics vary by category)
- `transactionHash`, `timestamp`, `blockNumber`

**Common shared fields** (via `streamDefs` fragment):
- `id`: `{contractAddress}-{chainId}-{tokenId}`
- `chainId`, `contract`, `tokenId`, `hash`, `timestamp`
- `recipient`, `sender`, `asset` (ERC-20 address)
- `assetDecimalsValue`, `assetSymbol`

### Handler Processing Logic

**CreateStream:**
1. Validate contract is not deprecated (skip if on denylist)
2. Create stream entity with initial amounts
3. Create action entity with `Create` category
4. Increment watcher counter

**WithdrawStream (Lockup):**
```typescript
const totalWithdrawnAmount = stream.withdrawnAmount + withdrawAmount;
let intactAmount = 0n;
if (stream.canceledAction_id) {
  intactAmount = BigInt(stream.intactAmount) - BigInt(withdrawAmount);
} else {
  intactAmount = BigInt(stream.depositAmount) - BigInt(totalWithdrawnAmount);
}
const updatedStream = { ...stream, depleted: intactAmount === 0n, intactAmount, withdrawnAmount: totalWithdrawnAmount };
```

**WithdrawStream (Flow):**
```typescript
const updatedStream = {
  ...stream,
  availableAmount: stream.availableAmount - withdrawAmount,
  withdrawnAmount: stream.withdrawnAmount + withdrawAmount,
};
```

**CancelStream:** Sets `canceled = true`, `cancelable = false`, `intactAmount = recipientAmount` (the refund owed to recipient).

**PauseStream (Flow):** Captures `snapshotAmount` at current block, rate → 0, `paused = true`.

### Production Endpoints
- Streams indexer: `https://indexer.hyperindex.xyz/53b7e25/v1/graphql`
- Airdrops indexer: `https://indexer.hyperindex.xyz/508d217/v1/graphql`

### Analytics Layer

The indexers include an `analytics/` service that computes:
- `totalStreamed` — cumulative amount ever streamed per asset
- `totalWithdrawn`, `totalRefunded`, `totalForgiven`
- Stream counts by status (active, completed, canceled)
- Active stream count and total value locked (TVL)

---

## Frontend

The frontend is a separate consumer of the indexer GraphQL APIs. No dedicated frontend repo is part of the open-source monorepos — the official app at `app.sablier.com` consumes the indexers. Key patterns:

- **GraphQL client** — queries the indexer endpoints (Envio/The Graph)
- **Wallet connection** — MetaMask, WalletConnect, Coinbase Wallet via viem
- **Transaction submission** — via viem or ethers.js
- **Real-time UI** — streams update as events are indexed (near real-time via GraphQL subscriptions where supported)

The indexer architecture means the frontend never needs to call `balanceOf` on-chain for historical data — it queries the indexed data instead. This makes the UI fast and cheap.

---

## Comparison to Payment Infrastructure

| Dimension | Sablier | Stripe | Circle |
|-----------|---------|--------|--------|
| **Model** | Real-time streaming | Batch/billing cycles | Instant transfers |
| **On-chain** | Yes — full transparency | No — centralized ledger | Settlement on-chain |
| **Partial withdrawal** | Yes (all variants except LPG) | N/A | N/A |
| **Cancel/refund** | Cancel returns to recipient | Refund to payer | Chargebacks |
| **Fee model** | Protocol fee + gas | 2.9% + $0.30 | 0% + $0.01–0.15 |
| **Token support** | Any ERC-20 | Fiat + crypto | USDC |
| **Programmable** | Smart contracts = infinite use cases | Webhooks + APIs | APIs |
| **Counterparty risk** | Escrowed in contract | Stripe holds | Circle holds |

**Where Sablier wins:**
- Trustless escrow — no intermediary
- Composability — streams are NFTs, can be traded/transferred
- Programmable conditions — cliff, dynamic curves, price gates
- Global, permissionless — anyone can stream to anyone

**Where traditional payments win:**
- Familiar UX and settlement guarantees
- Chargebacks and dispute resolution
- Regulatory compliance built in
- Multi-currency, fraud detection

---

## Notable Libraries and Tools

| Category | Library | Usage in Sablier |
|----------|---------|-----------------|
| Smart contracts | **Foundry** | Development framework, Forge tests, fuzz testing |
| Smart contracts | **Hardhat** | Deployment, task scripts |
| Smart contracts | **Bulloak** | BTT (Branch Testing Tree) coverage for math libs |
| Smart contracts | **@prb/math** | UD2x18 fixed-point for dynamic exponentiation |
| Smart contracts | **solady** | Gas-optimized lib (LockupLinear, Airdrops) |
| EVM interaction | **viem** | Frontend wallet connection and tx submission |
| Testing | **Bun** | JS/TS test runner in lockup package |
| Task runner | **Just** | Build/test/deploy taskfile |
| Indexing | **Envio** | TypeScript indexer (recommended) |
| Indexing | **The Graph** | AssemblyScript indexer (alternate) |
| Oracles | **ChainLink** | ETH/USD price feeds for fee conversion |

---

## Assessment

### Strengths

1. **Well-separated concerns** — lockup, flow, airdrops, and bob are independent packages sharing a utils layer. Adding a new stream type is a matter of implementing the abstract interfaces, not modifying a monolith.

2. **NFT-based stream ownership** — making streams ERC-721 tokens is architecturally elegant. It means transfer, trading, and fractionalization become possible without protocol changes.

3. **Dual indexer approach** — running both Envio and The Graph in parallel gives redundancy. Envio's TypeScript is more accessible for most developers.

4. **Comprehensive math testing** — Bulloak BTT coverage on PRB math usage is a high standard for financial contracts.

5. **UUPS upgradeability** — the Comptroller uses ERC1967 + UUPS, allowing safe proxy upgrades with storage isolation.

### Concerns

1. **No ERC-4626 support** — yield-bearing streams would dramatically expand use cases (stream into a yield vault, recipient earns interest). This is a known gap.

2. **Cancelable streams are default** — while configurable, the default cancelability may surprise recipients who expect irrevocable streams. The NFT-based transfer complicates this further (a transferred stream can still be canceled by sender).

3. **Oracle dependency for fees** — the Comptroller relies on ChainLink ETH/USD. An oracle failure or manipulation could cause fee mispricing. The `SafeOracle` library provides some protection but this is a systemic risk.

4. **Indexers are operationally complex** — self-hosting requires managing Envio/Graph nodes. The official endpoints are run by sablier-labs, creating a centralized dependency for open-source infrastructure.

5. **Gas sensitivity** — streaming creates per-second unlock calculations. While Sablier uses efficient integer math with granularity rounding, high-frequency small withdrawals remain economically impractical due to gas costs.

6. **No front-end in monorepo** — the open-source repo covers contracts and indexers, but the actual app is closed-source. Independent deployers must build their own UI.

### Recommendations

- For payroll/salary use cases: use **LockupLinear** with a 1-month cliff for reasonable UX
- For vesting: use **LockupDynamic** with exponent curves to match your cliff/vesting schedule
- For continuous revenue share: use **Flow** — but educate recipients that the stream can be voided
- For airdrops: use the **MerkleAirdrop** contract — it handles claiming with Merkle proof verification
- For production deployment: deploy your own indexer using Envio; don't rely solely on sablier-labs' hosted endpoints

---

## Related

No related reports currently exist in the vault.
