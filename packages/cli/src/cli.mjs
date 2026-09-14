#!/usr/bin/env node
// Covenant command line: open lines, prove history, report breaches, cure, settle defaults.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  parseEther
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ProofClient,
  decodeReceipt,
  toContractBatchProofArgs,
  toContractProofArgs
} from "@covenant/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const deployment = JSON.parse(readFileSync(resolve(root, "contracts/deployments/creditcoin-testnet.json"), "utf8"));
const abi = (name) => JSON.parse(readFileSync(resolve(root, `contracts/abi/${name}.json`), "utf8"));

const creditcoin = defineChain({
  id: 102031,
  name: "Creditcoin Testnet",
  nativeCurrency: { name: "tCTC", symbol: "tCTC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.CREDITCOIN_RPC_URL ?? "https://rpc.cc3-testnet.creditcoin.network"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://creditcoin-testnet.blockscout.com" } }
});
const EXPLORER = "https://creditcoin-testnet.blockscout.com";
const GAS_PRICE = 500_000_000n; // Creditcoin testnet accepts legacy txs at 0.5 gwei

const MANAGER = { address: deployment.CovenantManager, abi: abi("CovenantManager") };
const WCTC = { address: deployment.WCTC, abi: abi("WCTC") };
const POOL = { address: deployment.CovenantPool, abi: abi("CovenantPool") };
const RECORD = { address: deployment.CreditRecord, abi: abi("CreditRecord") };

const STATUS = ["None", "Active", "Breached", "Defaulted", "Closed"];
const KIND = { "cross-default": 0, "debt-cap": 1, "negative-pledge": 2 };
const KIND_NAME = ["CROSS_DEFAULT", "DEBT_CAP", "NEGATIVE_PLEDGE"];

const pub = createPublicClient({ chain: creditcoin, transport: http() });
const proofs = new ProofClient();

function wallet() {
  const pk = process.env.COVENANT_PRIVATE_KEY;
  if (!pk) throw new Error("set COVENANT_PRIVATE_KEY");
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  return createWalletClient({ account, chain: creditcoin, transport: http() });
}

async function send(client, contract, functionName, args = [], opts = {}) {
  const request = {
    ...contract,
    functionName,
    args,
    account: client.account,
    chain: creditcoin,
    type: "legacy",
    gasPrice: GAS_PRICE,
    ...opts
  };
  if (!opts.gas) {
    try {
      const { request: simulated } = await pub.simulateContract(request);
      request.gas = ((simulated.gas ?? (await pub.estimateContractGas(request))) * 13n) / 10n;
    } catch (err) {
      if (!process.env.COVENANT_FORCE_SEND) throw err;
      request.gas = 3_000_000n;
      console.log(`simulation reverted (${err.shortMessage ?? err.message}); sending anyway with gas ${request.gas}`);
    }
  }
  const hash = await client.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`${functionName} ${receipt.status} ${EXPLORER}/tx/${hash}`);
  return receipt;
}

function sourceRpc(chainKey) {
  return chainKey === 3 ? "https://ethereum-rpc.publicnode.com" : "https://ethereum-sepolia-rpc.publicnode.com";
}

async function sourceBlock(chainKey, txHash) {
  const res = await fetch(sourceRpc(chainKey), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] })
  });
  const { result } = await res.json();
  if (!result) throw new Error(`tx ${txHash} not found on chainKey ${chainKey}`);
  return Number(result.blockNumber);
}

async function proofFor(chainKey, txHash) {
  const block = await sourceBlock(chainKey, txHash);
  await proofs.waitUntilAttested(chainKey, block, {
    pollMs: 15000,
    onTick: (h) => console.log(`waiting for attestation: attested ${h} / needed ${block}`)
  });
  return proofs.proofByTx(chainKey, txHash);
}

/** Finds the tx-local log index whose preview (decode-only) predicate passes. */
async function findLogIndex(term, linkedWallet, encodedTx) {
  const logs = decodeReceipt(encodedTx).logs;
  for (let i = 0; i < logs.length; i++) {
    const [ok] = await pub.readContract({
      ...MANAGER,
      functionName: "previewPredicate",
      args: [term.kind, term.chainKey, term.target, term.threshold, linkedWallet, encodedTx, BigInt(i)]
    });
    if (ok) return i;
  }
  return -1;
}

function findRepayLogIndex(encodedTx, pool, walletAddr) {
  const REPAY = "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051";
  const logs = decodeReceipt(encodedTx).logs;
  return logs.findIndex(
    (l) =>
      l.address.toLowerCase() === pool.toLowerCase() &&
      l.topics[0]?.toLowerCase() === REPAY &&
      `0x${l.topics[2].slice(26)}`.toLowerCase() === walletAddr.toLowerCase()
  );
}

function findCureLogIndex(term, encodedTx, walletAddr, pool) {
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  if (term.kind === 1) return findRepayLogIndex(encodedTx, pool, walletAddr);
  const logs = decodeReceipt(encodedTx).logs;
  return logs.findIndex(
    (l) =>
      l.address.toLowerCase() === term.target.toLowerCase() &&
      l.topics[0]?.toLowerCase() === TRANSFER &&
      `0x${l.topics[2].slice(26)}`.toLowerCase() === walletAddr.toLowerCase()
  );
}

const commands = {
  async status([lineId]) {
    const line = await pub.readContract({ ...MANAGER, functionName: "lineOf", args: [BigInt(lineId)] });
    const terms = await pub.readContract({ ...MANAGER, functionName: "termsOf", args: [BigInt(lineId)] });
    const limit = await pub.readContract({ ...MANAGER, functionName: "limitOf", args: [BigInt(lineId)] });
    const debt = await pub.readContract({ ...MANAGER, functionName: "debtOf", args: [BigInt(lineId)] });
    const record = await pub.readContract({ ...RECORD, functionName: "recordOf", args: [line.linkedWallet] });
    console.log({
      lineId,
      status: STATUS[line.status],
      borrower: line.borrower,
      linkedWallet: line.linkedWallet,
      bond: formatEther(line.bond),
      limit: formatEther(limit),
      debt: formatEther(debt),
      historyRepays: line.historyRepays,
      graceEnds: line.graceEnds ? new Date(line.graceEnds * 1000).toISOString() : null,
      terms: terms.map((t, i) => `${i}: ${KIND_NAME[t.kind]} chainKey=${t.chainKey} target=${t.target} threshold=${t.threshold}${t.retired ? " (retired)" : ""}`),
      record
    });
  },

  async pool() {
    const totalAssets = await pub.readContract({ ...POOL, functionName: "totalAssets" });
    const outstanding = await pub.readContract({ ...POOL, functionName: "outstandingPrincipal" });
    console.log({ totalAssets: formatEther(totalAssets), outstanding: formatEther(outstanding) });
  },

  /** open <bondCTC> <chainKey> <debtCapReserve> <debtCapThreshold> <pledgeToken> <pledgeThreshold> */
  async open([bond, chainKey, debtReserve, debtThreshold, pledgeToken, pledgeThreshold]) {
    const client = wallet();
    const me = client.account.address;
    const ck = Number(chainKey);
    const amount = parseEther(bond);
    await send(client, WCTC, "deposit", [], { value: amount });
    await send(client, WCTC, "approve", [MANAGER.address, amount]);
    const nonce = await pub.readContract({ ...MANAGER, functionName: "nonces", args: [me] }).catch(() => 0n);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const signature = await client.signTypedData({
      domain: { name: "Covenant", version: "1", chainId: 102031, verifyingContract: MANAGER.address },
      types: {
        LinkWallet: [
          { name: "borrower", type: "address" },
          { name: "wallet", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      },
      primaryType: "LinkWallet",
      message: { borrower: me, wallet: me, nonce, deadline }
    });
    const zero = "0x0000000000000000000000000000000000000000";
    const terms = [
      { kind: 0, chainKey: BigInt(ck), target: zero, threshold: 0n, retired: false },
      { kind: 1, chainKey: BigInt(ck), target: getAddress(debtReserve), threshold: BigInt(debtThreshold), retired: false },
      { kind: 2, chainKey: BigInt(ck), target: getAddress(pledgeToken), threshold: BigInt(pledgeThreshold), retired: false }
    ];
    const memoHash = process.env.COVENANT_MEMO_HASH ?? `0x${"0".repeat(64)}`;
    const receipt = await send(client, MANAGER, "openLine", [terms, amount, me, deadline, signature, memoHash]);
    const next = await pub.readContract({ ...MANAGER, functionName: "nextLineId" });
    console.log(`opened line ${next - 1n} at Creditcoin block ${receipt.blockNumber}`);
  },

  /** history <lineId> <chainKey> <txHash...> */
  async history([lineId, chainKey, ...txHashes]) {
    const client = wallet();
    const ck = Number(chainKey);
    const line = await pub.readContract({ ...MANAGER, functionName: "lineOf", args: [BigInt(lineId)] });
    const pool = await pub.readContract({ ...MANAGER, functionName: "aavePool", args: [BigInt(ck)] });
    const batch = await proofs.batchProof(ck, txHashes);
    const args = toContractBatchProofArgs(batch, txHashes);
    const logIndexes = args.encodedTxs.map((tx) => BigInt(findRepayLogIndex(tx, pool, line.linkedWallet)));
    if (logIndexes.some((i) => i < 0n)) throw new Error("a tx has no Repay by the linked wallet");
    await send(client, MANAGER, "proveHistory", [
      BigInt(lineId),
      BigInt(ck),
      args.heights,
      args.encodedTxs,
      args.merkleProofs,
      args.sharedContinuity,
      logIndexes
    ]);
  },

  async draw([lineId, amount]) {
    await send(wallet(), MANAGER, "draw", [BigInt(lineId), parseEther(amount)]);
  },

  async repay([lineId, amount]) {
    const client = wallet();
    await send(client, WCTC, "approve", [MANAGER.address, parseEther(amount)]);
    await send(client, MANAGER, "repay", [BigInt(lineId), parseEther(amount)]);
  },

  /** breach <lineId> <termIndex> <sourceTxHash> */
  async breach([lineId, termIndex, txHash]) {
    const client = wallet();
    const line = await pub.readContract({ ...MANAGER, functionName: "lineOf", args: [BigInt(lineId)] });
    const term = (await pub.readContract({ ...MANAGER, functionName: "termsOf", args: [BigInt(lineId)] }))[Number(termIndex)];
    const p = toContractProofArgs(await proofFor(Number(term.chainKey), txHash));
    const logIndex = await findLogIndex(term, line.linkedWallet, p.encodedTx);
    if (logIndex < 0) throw new Error("no log in this tx breaches the covenant");
    const [ok, amount, reason] = await pub.readContract({
      ...MANAGER,
      functionName: "previewBreach",
      args: [BigInt(lineId), Number(termIndex), p.height, p.encodedTx, p.merkleProof, p.continuityProof, BigInt(logIndex)]
    });
    console.log(`preview: breach=${ok} amount=${amount} ${reason}`);
    await send(client, MANAGER, "reportBreach", [
      BigInt(lineId),
      Number(termIndex),
      p.height,
      p.encodedTx,
      p.merkleProof,
      p.continuityProof,
      BigInt(logIndex)
    ]);
  },

  /** cure <lineId> <sourceTxHash> */
  async cure([lineId, txHash]) {
    const client = wallet();
    const line = await pub.readContract({ ...MANAGER, functionName: "lineOf", args: [BigInt(lineId)] });
    const term = (await pub.readContract({ ...MANAGER, functionName: "termsOf", args: [BigInt(lineId)] }))[line.breachedTerm];
    const pool = await pub.readContract({ ...MANAGER, functionName: "aavePool", args: [term.chainKey] });
    const p = toContractProofArgs(await proofFor(Number(term.chainKey), txHash));
    const logIndex = findCureLogIndex(term, p.encodedTx, line.linkedWallet, pool);
    if (logIndex < 0) throw new Error("no curing log found in this tx");
    await send(client, MANAGER, "cureByProof", [
      BigInt(lineId),
      p.height,
      p.encodedTx,
      p.merkleProof,
      p.continuityProof,
      BigInt(logIndex)
    ]);
  },

  async default([lineId]) {
    await send(wallet(), MANAGER, "settleDefault", [BigInt(lineId)]);
  },

  /** predicate <kind> <chainKey> <wallet> <txHash> [target] [threshold]  — decode-only check on real data */
  async predicate([kind, chainKey, walletAddr, txHash, target, threshold]) {
    const k = KIND[kind] ?? Number(kind);
    const p = await proofs.proofByTx(Number(chainKey), txHash);
    const logs = decodeReceipt(p.txBytes).logs;
    for (let i = 0; i < logs.length; i++) {
      const [ok, amount, reason] = await pub.readContract({
        ...MANAGER,
        functionName: "previewPredicate",
        args: [k, BigInt(chainKey), target ?? "0x0000000000000000000000000000000000000000", BigInt(threshold ?? 0), walletAddr, p.txBytes, BigInt(i)]
      });
      if (ok) {
        console.log(`log ${i}: ${KIND_NAME[k]} breach for ${walletAddr}, amount ${amount}`);
        return;
      }
      if (i === logs.length - 1) console.log(`no breaching log (last reason: ${reason})`);
    }
  }
};

const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) {
  console.log(`usage: covenant <${Object.keys(commands).join("|")}> ...`);
  process.exit(1);
}
commands[cmd](rest).catch((err) => {
  console.error(err.shortMessage ?? err.message);
  process.exit(1);
});
