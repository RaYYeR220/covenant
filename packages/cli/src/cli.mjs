#!/usr/bin/env node
// Covenant command line: open lines, prove history, report breaches, cure, settle defaults.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  parseAbiItem,
  parseEther,
  parseEventLogs
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AAVE_POOL_ADDRESS,
  PLEDGE_TOKENS,
  ProofClient,
  decodeReceipt,
  generateRiskMemo,
  scanWallet,
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

function sourceExplorer(chainKey) {
  return chainKey === 3 ? "https://etherscan.io" : "https://sepolia.etherscan.io";
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

/** Splits argv into positionals and --flags (`--once` → true, `--interval 30` → "30"). */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else flags[key] = argv[++i];
    } else positional.push(a);
  }
  return { positional, flags };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
const errMsg = (err) => (err?.shortMessage ?? err?.message ?? String(err)).split("\n")[0];

const sourceClients = new Map();
function sourceClient(chainKey) {
  if (!sourceClients.has(chainKey)) {
    sourceClients.set(chainKey, createPublicClient({ transport: http(sourceRpc(chainKey), { retryCount: 5, retryDelay: 1000 }) }));
  }
  return sourceClients.get(chainKey);
}

const LIQUIDATION_CALL = parseAbiItem(
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)"
);
const BORROW = parseAbiItem(
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)"
);
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

async function getLogsRetry(client, params, retries = 5) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.getLogs(params);
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/**
 * Breach candidates for a linked wallet in [from, to], chunked ≤500 blocks:
 * LiquidationCall(user=wallet) → CROSS_DEFAULT, Borrow(onBehalfOf=wallet) → DEBT_CAP,
 * Transfer(from=wallet) on pledge targets → NEGATIVE_PLEDGE.
 */
async function scanBreachCandidates(chainKey, pool, walletAddr, pledgeTargets, from, to) {
  const client = sourceClient(chainKey);
  const out = [];
  for (let start = from; start <= to; start += 500n) {
    const end = start + 499n < to ? start + 499n : to;
    const range = { fromBlock: start, toBlock: end };
    if (pool) {
      for (const l of await getLogsRetry(client, { address: pool, event: LIQUIDATION_CALL, args: { user: walletAddr }, ...range }))
        out.push({ kind: 0, txHash: l.transactionHash, block: l.blockNumber });
      for (const l of await getLogsRetry(client, { address: pool, event: BORROW, args: { onBehalfOf: walletAddr }, ...range }))
        out.push({ kind: 1, txHash: l.transactionHash, block: l.blockNumber, reserve: l.args.reserve });
    }
    if (pledgeTargets.length) {
      for (const l of await getLogsRetry(client, { address: pledgeTargets, event: TRANSFER, args: { from: walletAddr }, ...range }))
        out.push({ kind: 2, txHash: l.transactionHash, block: l.blockNumber, token: l.address });
    }
  }
  return out;
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
  async open(argv) {
    const { positional, flags } = parseArgs(argv);
    const [bond, chainKey, debtReserve, debtThreshold, pledgeToken, pledgeThreshold] = positional;
    let memoHash = process.env.COVENANT_MEMO_HASH ?? `0x${"0".repeat(64)}`;
    if (flags.memo) {
      memoHash = JSON.parse(readFileSync(flags.memo, "utf8")).memoHash;
      if (!/^0x[0-9a-fA-F]{64}$/.test(memoHash ?? "")) throw new Error(`${flags.memo} has no valid memoHash`);
      console.log(`memoHash ${memoHash} (from ${flags.memo})`);
    }
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

  /** watch [--once] [--interval 30] [--lines 2,3] — autonomous watcher: scan attested source blocks, report breaches */
  async watch(argv) {
    const { flags } = parseArgs(argv);
    const once = flags.once === true;
    const intervalMs = Number(flags.interval ?? 30) * 1000;
    const lineFilter = typeof flags.lines === "string" ? flags.lines.split(",").map((s) => BigInt(s.trim())) : null;
    const client = wallet();
    console.log(`[${ts()}] watcher ${client.account.address} interval ${intervalMs / 1000}s${lineFilter ? ` lines ${lineFilter.join(",")}` : ""}`);
    const cursors = new Map(); // `${lineId}:${chainKey}` -> next unscanned source height
    const done = new Set(); // `${lineId}:${termIndex}:${txHash}` already decided (reported or skipped)

    const tick = async (n) => {
      const next = await pub.readContract({ ...MANAGER, functionName: "nextLineId" });
      const ids = lineFilter ?? Array.from({ length: Number(next) - 1 }, (_, i) => BigInt(i + 1));
      const active = [];
      for (const id of ids) {
        const line = await pub.readContract({ ...MANAGER, functionName: "lineOf", args: [id] });
        if (line.status === 1) active.push({ id, line });
      }
      const attested = new Map();
      const parts = [];
      let totalCandidates = 0;
      for (const { id, line } of active) {
        const terms = await pub.readContract({ ...MANAGER, functionName: "termsOf", args: [id] });
        const byChain = new Map();
        terms.forEach((t, i) => {
          if (t.retired) return;
          const ck = Number(t.chainKey);
          if (!byChain.has(ck)) byChain.set(ck, []);
          byChain.get(ck).push({ ...t, index: i });
        });
        for (const [ck, chainTerms] of byChain) {
          const key = `${id}:${ck}`;
          try {
            if (!attested.has(ck)) attested.set(ck, BigInt(await proofs.attestedHeight(ck)));
            const to = attested.get(ck);
            const from = cursors.get(key) ?? BigInt(await pub.readContract({ ...MANAGER, functionName: "activeFromHeight", args: [id, BigInt(ck)] }));
            if (from > to) {
              parts.push(`line ${id} ck${ck} up to date @${to}`);
              continue;
            }
            const pool = await pub.readContract({ ...MANAGER, functionName: "sourcePoolOf", args: [id, BigInt(ck)] });
            const zero = "0x0000000000000000000000000000000000000000";
            const pledgeTargets = [...new Set(chainTerms.filter((t) => t.kind === 2 && t.target !== zero).map((t) => getAddress(t.target)))];
            const candidates = await scanBreachCandidates(ck, pool !== zero ? pool : AAVE_POOL_ADDRESS[ck], line.linkedWallet, pledgeTargets, from, to);
            totalCandidates += candidates.length;
            parts.push(`line ${id} ck${ck} window ${from}..${to} candidates ${candidates.length}`);
            let clean = true;
            const proofCache = new Map();
            for (const c of candidates) {
              const matching = chainTerms.filter(
                (t) =>
                  t.kind === c.kind &&
                  (c.kind === 0 ||
                    (c.kind === 1 && (t.target === zero || t.target.toLowerCase() === c.reserve.toLowerCase())) ||
                    (c.kind === 2 && t.target.toLowerCase() === c.token.toLowerCase()))
              );
              for (const term of matching) {
                const doneKey = `${id}:${term.index}:${c.txHash}`;
                if (done.has(doneKey)) continue;
                const label = `line ${id} term ${term.index} ${KIND_NAME[term.kind]} src ${c.txHash} @${c.block}`;
                try {
                  if (!proofCache.has(c.txHash)) proofCache.set(c.txHash, toContractProofArgs(await proofs.proofByTx(ck, c.txHash)));
                  const p = proofCache.get(c.txHash);
                  const logIndex = await findLogIndex(term, line.linkedWallet, p.encodedTx);
                  if (logIndex < 0) {
                    console.log(`  skip ${label}: threshold not exceeded`);
                    done.add(doneKey);
                    continue;
                  }
                  const proofArgs = [id, term.index, p.height, p.encodedTx, p.merkleProof, p.continuityProof, BigInt(logIndex)];
                  const [ok, amount, reason] = await pub.readContract({ ...MANAGER, functionName: "previewBreach", args: proofArgs });
                  if (!ok) {
                    console.log(`  skip ${label}: ${reason || "preview rejected"}`);
                    done.add(doneKey);
                    continue;
                  }
                  console.log(`  BREACH ${label} amount ${amount} log ${logIndex}: reporting`);
                  const receipt = await send(client, MANAGER, "reportBreach", proofArgs);
                  const [ev] = parseEventLogs({ abi: MANAGER.abi, logs: receipt.logs, eventName: "CovenantBreached" });
                  console.log(
                    `  reported ${label}: ${EXPLORER}/tx/${receipt.transactionHash} bounty ${ev ? formatEther(ev.args.bounty) : "?"} source ${sourceExplorer(ck)}/tx/${c.txHash}`
                  );
                  done.add(doneKey);
                  if (receipt.status === "success") break;
                } catch (err) {
                  clean = false;
                  console.log(`  error ${label}: ${errMsg(err)} (retry next tick)`);
                }
              }
              const status = (await pub.readContract({ ...MANAGER, functionName: "lineOf", args: [id] })).status;
              if (status !== 1) {
                console.log(`  line ${id} is now ${STATUS[status]}; stop watching it`);
                break;
              }
            }
            if (clean) cursors.set(key, to + 1n);
          } catch (err) {
            parts.push(`line ${id} ck${ck} error: ${errMsg(err)}`);
          }
        }
      }
      console.log(`[${ts()}] tick ${n}: watching ${active.length} active line(s) [${active.map((a) => a.id).join(",")}] candidates ${totalCandidates} | ${parts.join(" | ") || "nothing to scan"}`);
    };

    for (let n = 1; ; n++) {
      try {
        await tick(n);
      } catch (err) {
        console.log(`[${ts()}] tick ${n} failed: ${errMsg(err)} (retry next tick)`);
      }
      if (once) return;
      await sleep(intervalMs);
    }
  },

  /** memo <wallet> [--chainKey 1] [--from <block>] [--out <file>] [--model <venice model>] — live Venice risk memo over scanned facts */
  async memo(argv) {
    const { positional, flags } = parseArgs(argv);
    if (!positional[0]) throw new Error("usage: memo <wallet> [--chainKey 1] [--from <block>] [--out <file>]");
    const who = getAddress(positional[0]);
    const ck = Number(flags.chainKey ?? 1);
    const src = sourceClient(ck);
    const latest = await src.getBlockNumber();
    const from = flags.from !== undefined ? BigInt(flags.from) : latest > 20000n ? latest - 20000n : 0n;
    console.error(`scanning chainKey ${ck} blocks ${from}..${latest} for ${who}`);
    const cands = await scanWallet(src, ck, who, from, latest, { chunkSize: 500n, retry: { retries: 5, baseDelayMs: 1000 } });

    const sumBy = (list, keyOf) => {
      const out = {};
      for (const c of list) out[keyOf(c)] = ((BigInt(out[keyOf(c)] ?? 0)) + c.amount).toString();
      return out;
    };
    const reserveOf = (c) => getAddress(`0x${c.topics[1].slice(26)}`);
    const repays = cands.filter((c) => c.kind === "REPAY");
    const borrows = cands.filter((c) => c.kind === "BORROW");
    const liquidations = cands.filter((c) => c.kind === "LIQUIDATION");
    const outflows = cands.filter((c) => c.kind === "PLEDGE_TRANSFER_OUT");
    const inflows = cands.filter((c) => c.kind === "PLEDGE_TRANSFER_IN");
    const largest = outflows.reduce((m, c) => (!m || c.amount > m.amount ? c : m), null);
    const tokens = PLEDGE_TOKENS[ck] ?? [];

    const record = await pub.readContract({ ...RECORD, functionName: "recordOf", args: [who] });
    let currentAaveDebt;
    const aavePool = AAVE_POOL_ADDRESS[ck];
    if (aavePool) {
      try {
        const data = await src.readContract({
          address: aavePool,
          abi: [parseAbiItem("function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)")],
          functionName: "getUserAccountData",
          args: [who]
        });
        currentAaveDebt = data[1];
      } catch {}
    }

    const facts = {
      window: { fromBlock: from.toString(), toBlock: latest.toString(), blocks: (latest - from + 1n).toString() },
      aaveRepays: { count: repays.length, totalByReserve: sumBy(repays, reserveOf) },
      aaveBorrows: { count: borrows.length, totalByReserve: sumBy(borrows, reserveOf) },
      aaveLiquidations: { count: liquidations.length },
      pledgeTokenOutflows: {
        count: outflows.length,
        totalByToken: sumBy(outflows, (c) => c.address),
        largestSingle: largest ? { token: largest.address, amount: largest.amount.toString(), txHash: largest.txHash } : null
      },
      aaveDebtUsdBase8: currentAaveDebt?.toString() ?? null,
      creditRecord: Object.fromEntries(Object.entries(record).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]))
    };
    console.error(`facts: ${JSON.stringify(facts)}`);

    const [maxDebt, maxPledge] = await Promise.all([
      pub.readContract({ ...MANAGER, functionName: "maxDebtCapThreshold" }),
      pub.readContract({ ...MANAGER, functionName: "maxPledgeThreshold" })
    ]);
    const ceilings = {
      maxThresholdByKind: { 1: maxDebt, 2: maxPledge },
      allowlistedTargets: { [ck]: [...tokens, ...(aavePool ? [aavePool] : [])] }
    };
    const result = await generateRiskMemo(
      {
        wallet: who,
        chainKey: ck,
        provenRepays: Number(record.provenRepays),
        breaches: Number(record.breaches),
        currentAaveDebt,
        pledgeTokenActivity: tokens.map((t) => ({
          token: t,
          transfersOut: outflows.filter((c) => c.address.toLowerCase() === t.toLowerCase()).length,
          transfersIn: inflows.filter((c) => c.address.toLowerCase() === t.toLowerCase()).length
        })),
        observedActivity: facts
      },
      { apiKey: process.env.VENICE_API_KEY, model: flags.model ?? process.env.VENICE_MODEL, ceilings }
    );
    if (result.status !== "ok") {
      console.log(JSON.stringify({ status: "unavailable", reason: result.reason }));
      process.exit(2);
    }
    const memo = {
      status: "ok",
      wallet: who,
      chainKey: ck,
      facts,
      summary: result.summary,
      riskFlags: result.riskFlags,
      proposedTerms: result.proposedTerms.map((t) => ({ ...t, kindName: KIND_NAME[t.kind], threshold: t.threshold.toString() })),
      ceilings: { maxDebtCapThreshold: maxDebt.toString(), maxPledgeThreshold: maxPledge.toString() },
      memoHash: result.memoHash
    };
    const json = JSON.stringify(memo, null, 2);
    console.log(json);
    console.log(`memoHash ${result.memoHash}`);
    if (flags.out) {
      writeFileSync(flags.out, json);
      console.log(`wrote ${flags.out}`);
    }
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
