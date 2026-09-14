# How Covenant uses the Attestcoin Protocol

Covenant is an Attestcoin Smart Contract (ASC). Every decision that moves money on Creditcoin is taken on the basis of an Ethereum transaction that the contract has verified itself, in the same transaction, through Creditcoin's native `BlockProver` precompile. There is no oracle operator, no relayer allowlist and no signer whose word the contract trusts.

## Setup

| | |
|---|---|
| Execution chain | Creditcoin CC3 testnet, chainId `102031`, RPC `https://rpc.cc3-testnet.creditcoin.network` |
| BlockProver precompile | `0x0000000000000000000000000000000000000FD2` (`verifyAndEmit`, batch `verifyAndEmit`, `verify`, `calculateTxIndex`) |
| ChainInfo precompile | `0x0000000000000000000000000000000000000FD3` (latest attested height per chain key) |
| Proof API | `https://proof-gen-api.cc3-testnet.creditcoin.network` (`GET /api/v1/proof-by-tx/{chainKey}/{tx}`, `POST /api/v1/proof-batch-by-tx/{chainKey}`, `GET /api/v1/attested-height/{chainKey}`) |
| Source chains | chain key `1` = Ethereum Sepolia, chain key `3` = Ethereum mainnet |
| Decoder | `EvmV1Decoder` from `@gluwa/asc-contracts@0.2.1` |
| Toolchain | Foundry, solc 0.8.30, `via_ir`, `evm_version = shanghai` |

Registered sources (owner-set, visible on-chain through `aavePool(chainKey)` and `pledgeTokenAllowed(chainKey, token)`):

- Aave V3 Pool, Ethereum mainnet `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`
- Aave V3 Pool, Sepolia `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951`
- USDC mainnet `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, Circle USDC Sepolia `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, Aave Sepolia USDC reserve `0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8`

## Four uses of the protocol

### 1. Importing repayment history (batch proofs)

`proveHistory(lineId, chainKey, heights[], encodedTxs[], merkleProofs[], sharedContinuity, logIndexes[])`

The borrower (or anyone) fetches a batch proof for several Aave `Repay` transactions and submits them in one call. The contract decodes every transaction, requires a successful receipt, requires the log to be emitted by the registered Aave pool with `topic0 = Repay` and `user = linkedWallet`, consumes a replay key for each, and then calls the precompile's batch overload once with the shared continuity proof. Each proven repayment adds 0.25x to the credit limit, up to 1x.

Live: four real Aave V3 Sepolia repayments proven in one Creditcoin transaction, [`0x251f8c42…`](https://creditcoin-testnet.blockscout.com/tx/0x251f8c4205a9c14694a773183fc51a307cde5258c31e8380edda29eec211428c).

### 2. Reporting covenant breaches (single proofs, permissionless)

`reportBreach(lineId, termIndex, height, encodedTx, merkleProof, continuityProof, logIndex)`

Anyone can call it. The contract checks, in order:

1. the line is active and the term is not retired;
2. `height >= activeFromHeight[lineId][chainKey]` (see use 4);
3. the replay key `keccak256(chainKey, height, txIndex, logIndex)` is unused;
4. the covenant predicate on the decoded log:
   - `CROSS_DEFAULT`: `LiquidationCall` emitted by the registered Aave pool with `user == linkedWallet`;
   - `DEBT_CAP`: `Borrow` emitted by the registered Aave pool with `onBehalfOf == linkedWallet`, `amount > threshold`, and the reserve equal to the term target when one is set;
   - `NEGATIVE_PLEDGE`: `Transfer` emitted by the allowlisted token with `from == linkedWallet` and `value > threshold`;
5. the receipt status is `1` (the precompile proves inclusion, not success);
6. `verifyAndEmit` on the precompile returns true.

On success the line is frozen, a grace period starts, 10% of the bond is paid to the reporter and the breach is written to `CreditRecord`.

Emitter binding is mandatory: a contract that emits an event with the same signature from any other address is rejected (`PredicateFailed`). This is covered by tests that replay a real mainnet liquidation log from a spoofed address.

### 3. Curing a breach (proof of repayment)

`cureByProof(lineId, height, encodedTx, merkleProof, continuityProof, logIndex)`

Within the grace period, a `DEBT_CAP` breach is cured by proving an Aave `Repay` by the linked wallet of at least the breaching amount, at a later source height. A `NEGATIVE_PLEDGE` breach is cured by proving a `Transfer` of the pledged token back into the wallet. The breached covenant is retired, so its weight stops counting toward the limit. `CROSS_DEFAULT` cannot be cured by proof, only by repaying the Creditcoin debt.

### 4. Anchoring covenants in source-chain time (ChainInfo precompile)

When a line is opened, the manager reads the latest attested height of every source chain used by its covenants from the ChainInfo precompile and stores `activeFromHeight = attested + 1`. An event that happened before the borrower signed the covenants can never be used against the line, and a watcher cannot front-run a line with an old, already-known breach.

### Zero-gas checks

- `previewBreach(...)` runs the full breach pipeline as a view, using the precompile's non-mutating `verify`. Watchers use it before spending gas.
- `previewPredicate(kind, chainKey, target, threshold, wallet, encodedTx, logIndex)` evaluates a covenant against any proven transaction without a line. Against the deployed manager, the real Ethereum mainnet Aave V3 liquidation [`0xec0b8f78…`](https://etherscan.io/tx/0xec0b8f78036c679ed61d1a3ec1a6d4f733c4a306bfc0b6253cf4e02752883b07) (block 25967341, log 16) returns a `CROSS_DEFAULT` breach for `0xde092a220313cede58750434b66d46b5ff494cbb` and `wrong emitter`/no breach for any other wallet.

## Off-chain worker

`packages/sdk` wraps the proof API (single, batch, attestation polling), decodes `txBytes` in TypeScript, mirrors the covenant predicates, and scans a wallet's Aave and token events. `packages/cli` is a watcher and borrower tool built on it:

```bash
node packages/cli/src/cli.mjs predicate cross-default 3 <wallet> <mainnetTxHash>
node packages/cli/src/cli.mjs history <lineId> 1 <repayTx1> <repayTx2> ...
node packages/cli/src/cli.mjs breach <lineId> <termIndex> <sourceTxHash>
node packages/cli/src/cli.mjs cure <lineId> <sourceTxHash>
node packages/cli/src/cli.mjs default <lineId>
node packages/cli/src/cli.mjs watch --interval 30
```

`watch` runs this loop unattended for every active line. The worker finds the tx-local log index by decoding the proven receipt and asking the contract's `previewPredicate`, waits for attestation (about six minutes for a fresh Sepolia block), then submits.

## Transaction encoding notes

- `logIndex` everywhere is the index inside the proven transaction's receipt logs as decoded by `EvmV1Decoder`, not the block-level log index returned by Ethereum RPCs.
- Creditcoin testnet accepts legacy transactions at 0.5 gwei. Frontier headers do not expose `prevrandao`, so contracts are deployed with `forge create` rather than `forge script`.
