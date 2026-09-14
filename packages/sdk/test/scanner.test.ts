import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encodeAbiParameters, pad, type Address, type Hex } from "viem";
import { decodeReceipt } from "../src/decoder";
import { scanWallet, resolveTxLocalLogIndex, type LogsClient } from "../src/scanner";
import { AAVE_POOL_ADDRESS, PLEDGE_TOKENS } from "../src/chains";

function addressTopic(address: Address): Hex {
  return pad(address, { size: 32 });
}

function uintTopic(value: bigint): Hex {
  return pad(`0x${value.toString(16)}`, { size: 32 });
}

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadReceiptLogs(name: string) {
  const proof = JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8"));
  return { txBytes: proof.txBytes as Hex, logs: decodeReceipt(proof.txBytes).logs };
}

const CHAIN_KEY = 1;
const WALLET: Address = "0x2E2b283100135De40177e8124bc5591CF69EE163";
const AAVE_POOL = AAVE_POOL_ADDRESS[CHAIN_KEY];

describe("resolveTxLocalLogIndex", () => {
  it("finds the tx-local index of a log by matching address+topics+data", () => {
    const { txBytes, logs } = loadReceiptLogs("mainnet-aave-liquidation.proof.json");
    const target = logs[16];

    const index = resolveTxLocalLogIndex(txBytes, {
      address: target.address,
      topics: target.topics,
      data: target.data
    });

    expect(index).toBe(16);
  });

  it("throws when no log in the receipt matches the candidate", () => {
    const { txBytes } = loadReceiptLogs("mainnet-aave-liquidation.proof.json");

    expect(() =>
      resolveTxLocalLogIndex(txBytes, {
        address: "0x0000000000000000000000000000000000dEaD",
        topics: ["0x0000000000000000000000000000000000000000000000000000000000000000"] as Hex[],
        data: "0x" as Hex
      })
    ).toThrow();
  });
});

describe("scanWallet", () => {
  it("collects Aave LiquidationCall/Borrow/Repay and pledge Transfer candidates", async () => {
    const someAddress: Address = "0x53Cd0b05934FA0C7Dc9bC2341c86f26ed5cef540";
    const liquidationLog = {
      address: AAVE_POOL,
      topics: [
        "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286",
        addressTopic(someAddress),
        addressTopic(someAddress),
        addressTopic(WALLET)
      ] as Hex[],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "bool" }],
        [1n, 2n, someAddress, false]
      ),
      blockNumber: 100n,
      transactionHash: "0xaaa1" as Hex,
      logIndex: 7
    };
    const borrowLog = {
      address: AAVE_POOL,
      topics: [
        "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0",
        addressTopic(someAddress),
        addressTopic(WALLET),
        uintTopic(0n)
      ] as Hex[],
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint8" }, { type: "uint256" }],
        [WALLET, 50_000_000n, 2, 123n]
      ),
      blockNumber: 200n,
      transactionHash: "0xbbb2" as Hex,
      logIndex: 4
    };
    const repayLog = {
      address: AAVE_POOL,
      topics: [
        "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051",
        addressTopic(someAddress),
        addressTopic(WALLET),
        addressTopic(WALLET)
      ] as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [10_000_000n, false]),
      blockNumber: 300n,
      transactionHash: "0xccc3" as Hex,
      logIndex: 5
    };

    const getLogs = vi.fn(async ({ event }: { event: { name: string } }) => {
      if (event.name === "LiquidationCall") return [liquidationLog];
      if (event.name === "Borrow") return [borrowLog];
      if (event.name === "Repay") return [repayLog];
      return [];
    }) as unknown as LogsClient["getLogs"];

    const client: LogsClient = { getLogs };

    const candidates = await scanWallet(client, CHAIN_KEY, WALLET, 0n, 400n);

    const kinds = candidates.map((c) => c.kind).sort();
    expect(kinds).toEqual(["BORROW", "LIQUIDATION", "REPAY"]);

    const liquidation = candidates.find((c) => c.kind === "LIQUIDATION")!;
    expect(liquidation.txHash).toBe("0xaaa1");
    expect(liquidation.blockLogIndex).toBe(7);
    expect(liquidation.amount).toBe(1n);

    const borrow = candidates.find((c) => c.kind === "BORROW")!;
    expect(borrow.amount).toBe(50_000_000n);

    const repay = candidates.find((c) => c.kind === "REPAY")!;
    expect(repay.amount).toBe(10_000_000n);
  });

  it("chunks the block range into windows of at most 500 blocks", async () => {
    const seenRanges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const getLogs = vi.fn(async ({ event, fromBlock, toBlock }: any) => {
      if (event.name === "LiquidationCall") {
        seenRanges.push({ fromBlock, toBlock });
      }
      return [];
    }) as unknown as LogsClient["getLogs"];
    const client: LogsClient = { getLogs };

    await scanWallet(client, CHAIN_KEY, WALLET, 0n, 1200n);

    expect(seenRanges).toHaveLength(3);
    expect(seenRanges[0]).toEqual({ fromBlock: 0n, toBlock: 499n });
    expect(seenRanges[1]).toEqual({ fromBlock: 500n, toBlock: 999n });
    expect(seenRanges[2]).toEqual({ fromBlock: 1000n, toBlock: 1200n });
  });

  it("retries a chunk after a transient RPC failure instead of dropping it", async () => {
    let calls = 0;
    const getLogs = vi.fn(async ({ event }: { event: { name: string } }) => {
      if (event.name !== "LiquidationCall") return [];
      calls++;
      if (calls === 1) throw new Error("429 rate limited");
      return [];
    }) as unknown as LogsClient["getLogs"];
    const client: LogsClient = { getLogs };

    await scanWallet(client, CHAIN_KEY, WALLET, 0n, 10n, { retry: { retries: 2, baseDelayMs: 1 } });

    expect(calls).toBe(2);
  });

  it("scans every allowlisted pledge token for transfers in and out of the wallet", async () => {
    const seenAddresses: Address[] = [];
    const getLogs = vi.fn(async ({ event, address }: any) => {
      if (event.name === "Transfer") seenAddresses.push(address);
      return [];
    }) as unknown as LogsClient["getLogs"];
    const client: LogsClient = { getLogs };

    await scanWallet(client, CHAIN_KEY, WALLET, 0n, 10n);

    for (const token of PLEDGE_TOKENS[CHAIN_KEY]) {
      const occurrences = seenAddresses.filter((a) => a.toLowerCase() === token.toLowerCase());
      // once for from==wallet, once for to==wallet
      expect(occurrences.length).toBe(2);
    }
  });
});
