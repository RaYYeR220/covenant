# Proof

Every claim below links to a transaction on a public explorer. Creditcoin testnet transactions are on [Blockscout](https://creditcoin-testnet.blockscout.com); source-chain transactions are on Etherscan.

## Review in five minutes

1. Open the verified [CovenantManager](https://creditcoin-testnet.blockscout.com/address/0xB828ec5068B3b89bdbdacaafc2b494eAAec990F2?tab=contract) source.
2. Look at the [batch history proof](https://creditcoin-testnet.blockscout.com/tx/0x251f8c4205a9c14694a773183fc51a307cde5258c31e8380edda29eec211428c): four Aave repayments on Sepolia verified in one call.
3. Follow the live breach below: a Sepolia borrow above the cap, the watcher's proof on Creditcoin, the cure, the refused replay.
4. Run the mainnet liquidation check from the README. It needs no keys.

## Deployment

All five contracts are verified on Blockscout.

| Contract | Address | Deploy tx |
|---|---|---|
| CovenantEvaluator | [`0x7cecD4d7…9e16C`](https://creditcoin-testnet.blockscout.com/address/0x7cecD4d7e2Aaa4667916B6da41a646Cd9229e16C) | [`0x47123f39…`](https://creditcoin-testnet.blockscout.com/tx/0x47123f39a63dedb8ed6207dcfb572d3adf45c7c2ad244c6d7e709f172fdd7993) |
| WCTC | [`0x1F281ACd…b3dC1`](https://creditcoin-testnet.blockscout.com/address/0x1F281ACd1199a2798c5B9Fa222b18fCa9ebF3dC1) | [`0x5c3cc014…`](https://creditcoin-testnet.blockscout.com/tx/0x5c3cc014ff7e7b7282ddb44ac842707a0435a6aa745fc67da29fe5c79c15abcd) |
| CovenantPool | [`0xB427b1F8…28b8be`](https://creditcoin-testnet.blockscout.com/address/0xB427b1F87966a80D7e50e57B453E7653c228b8be) | [`0x24b7cd9e…`](https://creditcoin-testnet.blockscout.com/tx/0x24b7cd9e96be2128690f1409c56095ed9cc20d587f1f590e70aa32ec42f1c449) |
| CreditRecord | [`0x02977ae7…8aA0`](https://creditcoin-testnet.blockscout.com/address/0x02977ae7C5515EaA562d9353253527226A7f8aA0) | [`0x00a6a95b…`](https://creditcoin-testnet.blockscout.com/tx/0x00a6a95baf297915e8907a2402085d2fd3eb29a70b3a2a9548ad749e2a11b4f7) |
| CovenantManager | [`0xB828ec50…990F2`](https://creditcoin-testnet.blockscout.com/address/0xB828ec5068B3b89bdbdacaafc2b494eAAec990F2) | [`0x6b30869f…`](https://creditcoin-testnet.blockscout.com/tx/0x6b30869fab520d0d3e4bf01daa7f6bf76bcea64cdb82c5f1698ebeeb5d3e110b) |

Wiring: [pool manager](https://creditcoin-testnet.blockscout.com/tx/0xf55164532b8aa82e2094315ac0bf2c81f50065563e38fb069c29fb2eacd43256), [record manager](https://creditcoin-testnet.blockscout.com/tx/0x239f1fbaf9c29330fbd310219a82f8394ed594d237e389bfbd6d1fa2af9fb437), [Aave pool mainnet](https://creditcoin-testnet.blockscout.com/tx/0xc8e8e7e731a08f13bea9ed2d21215ee75fbd6af4c1aebc764c990b43e74efffc), [Aave pool Sepolia](https://creditcoin-testnet.blockscout.com/tx/0xbe1a6a19667bf97a3501bfbf929136ab3c20d0a84e35795298a24e19a5b4b639), [LP deposit of 3,000 tCTC](https://creditcoin-testnet.blockscout.com/tx/0x21d9575921197bde4b062eff2c2505bb18d95a969b8b078ff093bed2cba97efe).

## Actors

| Role | Address |
|---|---|
| Borrower and linked Ethereum wallet | [`0x2E2b2831…EE163`](https://sepolia.etherscan.io/address/0x2E2b283100135De40177e8124bc5591CF69EE163) |
| Watcher | [`0x3b0037F6…466f3`](https://creditcoin-testnet.blockscout.com/address/0x3b0037F6A685951f8312cfaFb6b3048d52A466f3) |
| Liquidity provider | [`0x80a2b667…f6B8`](https://creditcoin-testnet.blockscout.com/address/0x80a2b667dE7e002E65B585AB159565E69158f6B8) |

## Live line 1, step by step

### Real repayment history on Aave V3 Sepolia

| Step | Sepolia tx | Block |
|---|---|---|
| Supply 500 LINK | [`0xb5b1accf…`](https://sepolia.etherscan.io/tx/0xb5b1accf13bda5d54ecb3b3ce6c1d868494b35cbb5956d4433be35756c440bf7) | 11698047 |
| Borrow 50 USDC | [`0x0ae82f47…`](https://sepolia.etherscan.io/tx/0x0ae82f477e5f03b0b8347a272407d081c4deb9a48db8364e2db2f6f070336498) | 11698049 |
| Repay 10 USDC | [`0x8fdcc5a3…`](https://sepolia.etherscan.io/tx/0x8fdcc5a3fbbe14d982e01df01a2d38d34e2581db8a1307e2b3d69f633e85380b) | 11698052 |
| Repay 10 USDC | [`0xcd0f8b17…`](https://sepolia.etherscan.io/tx/0xcd0f8b17a8c53cdd9ce9dee3cc7a398e6bc4c62db9d70abb6f3ebce126fee0e1) | 11698053 |
| Repay 10 USDC | [`0x18f9a9e8…`](https://sepolia.etherscan.io/tx/0x18f9a9e885f26b497794837d30c6a8fb86c367b5d50ca63a19f5bab36e8cfab4) | 11698054 |
| Repay 10 USDC | [`0x0f883dec…`](https://sepolia.etherscan.io/tx/0x0f883dec3f4988225c96c309dde1fcd04c41e447de0479404ac0990e5cf63c46) | 11698055 |

### Credit line on Creditcoin

| Step | Result | Creditcoin tx |
|---|---|---|
| `openLine`: bond 400, three covenants, EIP-712 wallet link | limit 1,300 | [`0x5366007e…`](https://creditcoin-testnet.blockscout.com/tx/0x5366007eaf8c0e568fab7478a169729859dcb133393fe5fae51acaf0dcb9206f) |
| `proveHistory`: four repays, one batch proof | limit 1,600 (4x cap) | [`0x251f8c42…`](https://creditcoin-testnet.blockscout.com/tx/0x251f8c4205a9c14694a773183fc51a307cde5258c31e8380edda29eec211428c) |
| `draw` 1,000 | 40% collateralized | [`0x4a15da1d…`](https://creditcoin-testnet.blockscout.com/tx/0x4a15da1d415a30817615b87a0b5d09dcb1ea6c41089148298d2c7880dea4390f) |

### Breach, cure, refusal, second breach

| Step | Source tx | Creditcoin tx | Result |
|---|---|---|---|
| Borrower borrows 80 USDC on Aave, cap is 60 | [`0x9d7a5532…`](https://sepolia.etherscan.io/tx/0x9d7a553226ae480f2089d63290b9293b0aeb7096fd45e1ad9ab6600e32c9b6f4) | | |
| Watcher proves the `DEBT_CAP` breach | | [`0x8374ddcf…`](https://creditcoin-testnet.blockscout.com/tx/0x8374ddcfa13f595046e468fec8fc651f6343de244c4006dd3737c6feb6ff10cb) | line frozen, watcher paid 40 |
| Borrower repays 80 USDC on Aave | [`0x9b162ad2…`](https://sepolia.etherscan.io/tx/0x9b162ad2f4b57669960196924cceebfe3a0ea8a8ffb6d5812f4f7d7ae4b2cafb) | | |
| Borrower proves the repayment | | [`0xd508846e…`](https://creditcoin-testnet.blockscout.com/tx/0xd508846ed00114503dc0d70fa891b8b4f6d9c2d84400df6c813cd205177c2837) | cured, covenant retired, limit 1,440 |
| Watcher resubmits the same breach proof | | [`0x5a409069…`](https://creditcoin-testnet.blockscout.com/tx/0x5a409069bc8754c90f42f392b173545b44bf5f75331f3289a52b03389cd8e1ea) | **reverted** |
| Borrower moves 150 USDC out, pledge cap is 100 | [`0x72fa120b…`](https://sepolia.etherscan.io/tx/0x72fa120b6d7af9accbf82a1caa75600a64021798146ecc4db98f2be3fd93be2b) | | |
| Watcher proves the `NEGATIVE_PLEDGE` breach | | [`0xd278b636…`](https://creditcoin-testnet.blockscout.com/tx/0xd278b6363f73c5297c257ecf7cd24d5fe4bd68591b73511be1358da152a4305d) | line frozen, watcher paid 36 |
| Grace period ends uncured; watcher settles as keeper | | [`0xad8a32aa…`](https://creditcoin-testnet.blockscout.com/tx/0xad8a32aae69d20ebdab9f389921da9c2aa73e4713a53adbd560c2ff748de2afd) | line defaulted, bond recovered to the pool, loss socialized (pool 3,000 to 2,322.38) |

### Time anchoring

| Step | Creditcoin tx | Result |
|---|---|---|
| Same borrower opens line 2 (bond 200) | [`0x2d821fb0…`](https://creditcoin-testnet.blockscout.com/tx/0x2d821fb0877c2e951f643a77fb195e05336ca7a962437d881ad42ec83571f680) | active, limit 650 |
| Watcher submits the old pledge breach proof against line 2 | [`0xedd6f719…`](https://creditcoin-testnet.blockscout.com/tx/0xedd6f719e6b3a027de8aa838adca9de6a35210d04a31fbdad7a8c8283db594d5) | **reverted**: event is older than the line's activation height |

Line 2 has no history boost: the four repay proofs were consumed by line 1 and replay keys are global.

### Autonomous watcher on line 2

`covenant watch` ran unattended as the watcher key. Every 30 seconds it scanned the linked wallet's Aave and pledge-token events between the line's activation height and the latest attested Sepolia height, checked each candidate with `previewBreach`, and submitted only real breaches.

| Step | Source tx | Creditcoin tx | Result |
|---|---|---|---|
| Borrower borrows 70 USDC on Aave, cap is 60 | [`0x850c300c…`](https://sepolia.etherscan.io/tx/0x850c300cbdf38a98a26943994f6a47f920f433bcef1b7d1b08cc68e6e0ddbd13) | | |
| Watcher finds it after attestation and reports it, no human input | | [`0x0062f75b…`](https://creditcoin-testnet.blockscout.com/tx/0x0062f75b59c75b961aa12a562d9597f92e31d260a34db777c3e74f60b844d32f) | line 2 frozen, watcher paid 20 |

```
[02:44:20] tick 6: watching 1 active line(s) [2] candidates 0 | line 2 ck1 up to date @11700020
reportBreach success https://creditcoin-testnet.blockscout.com/tx/0x0062f75b...
  reported line 2 term 1 DEBT_CAP src 0x850c300c... @11700029 bounty 20
```

### Line 3 opened with a live risk memo

`covenant memo` scanned the LP wallet's recent Sepolia activity and its CreditRecord, asked the Venice API for a memo, and clamped the proposed covenants to the contract's ceilings. The wallet has no proven history, so the memo proposed the tightest terms: a 1 USDC debt cap and a zero-outflow negative pledge. Line 3 was opened with those terms and the memo hash.

| | |
|---|---|
| openLine | [`0x379bb134…`](https://creditcoin-testnet.blockscout.com/tx/0x379bb134e9063eae94eb38c8280e56275f0dcc5e4f60284bbd1ff5658416b83a) |
| Linked wallet | `0x80a2b667dE7e002E65B585AB159565E69158f6B8` |
| Bond / limit | 150 / 487.5 |
| `lineOf(3).memoHash` | `0x67135bee9ab7bf95b9c290a16c6c774d87abc6b91565553e4d942e57e4b97763` |
| Risk flags | `NO_PROVEN_REPAYS`, `NO_ACTIVE_DEBT`, `MINIMAL_PLEDGE_ACTIVITY`, `UNTESTED_CREDITWORTHINESS` |

The memo is advisory. Its thresholds only reached the chain because the borrower chose them, and the contract would have rejected anything above its ceilings. The model's free-text rationale mislabels the reserve symbol in one place; the addresses and thresholds it proposed are correct.

## Real Ethereum mainnet data

The deployed manager's `previewPredicate` evaluates the Aave V3 liquidation [`0xec0b8f78…`](https://etherscan.io/tx/0xec0b8f78036c679ed61d1a3ec1a6d4f733c4a306bfc0b6253cf4e02752883b07) (block 25967341), proof served by the Attestcoin proof API for chain key 3:

```
$ node packages/cli/src/cli.mjs predicate cross-default 3 0xde092a220313cede58750434b66d46b5ff494cbb 0xec0b8f78...
log 16: CROSS_DEFAULT breach for 0xde092a220313cede58750434b66d46b5ff494cbb, amount 3985851340

$ node packages/cli/src/cli.mjs predicate cross-default 3 0x2E2b283100135De40177e8124bc5591CF69EE163 0xec0b8f78...
no breaching log (last reason: wrong emitter)
```

## Tests

```
$ cd contracts && forge test
Ran 11 test suites: 197 tests passed, 0 failed, 0 skipped (197 total tests)
```
