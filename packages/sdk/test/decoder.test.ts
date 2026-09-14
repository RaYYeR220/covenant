import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decodeReceipt, decodeCommon } from "../src/decoder";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadProof(name: string): { txBytes: `0x${string}`; txHash: string } {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8"));
}

describe("decodeReceipt on real mainnet liquidation fixture", () => {
  const proof = loadProof("mainnet-aave-liquidation.proof.json");
  const receipt = decodeReceipt(proof.txBytes);

  it("decodes receipt status as success", () => {
    expect(receipt.status).toBe(1);
  });

  it("decodes all 68 tx-local logs", () => {
    expect(receipt.logs).toHaveLength(68);
  });

  it("decodes log 16 as the Aave V3 Pool LiquidationCall", () => {
    const log = receipt.logs[16];
    expect(log.address.toLowerCase()).toBe("0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2");
    expect(log.topics[0]).toBe(
      "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286"
    );
    // indexed user is topics[3]
    expect(log.topics[3].toLowerCase()).toBe(
      "0x000000000000000000000000de092a220313cede58750434b66d46b5ff494cbb"
    );
  });

  it("decodes logs 1, 15, 17 as USDC Transfer", () => {
    for (const idx of [1, 15, 17]) {
      const log = receipt.logs[idx];
      expect(log.address.toLowerCase()).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
      expect(log.topics[0]).toBe(
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
      );
    }
  });
});

describe("decodeReceipt against the cast receipt fixture", () => {
  it("matches the number of logs and their addresses/topic0 in order", () => {
    const proof = loadProof("mainnet-aave-liquidation.proof.json");
    const castReceipt = JSON.parse(
      readFileSync(path.join(fixturesDir, "mainnet-aave-liquidation.receipt.json"), "utf8")
    );
    const receipt = decodeReceipt(proof.txBytes);
    expect(receipt.logs).toHaveLength(castReceipt.logs.length);
    for (let i = 0; i < receipt.logs.length; i++) {
      expect(receipt.logs[i].address.toLowerCase()).toBe(castReceipt.logs[i].address.toLowerCase());
      expect(receipt.logs[i].topics[0]?.toLowerCase()).toBe(castReceipt.logs[i].topics[0]?.toLowerCase());
    }
  });
});

describe("decodeReceipt on sepolia repay fixture", () => {
  it("decodes tx-local log index 5 as an Aave Repay by the borrower", () => {
    const proof = loadProof("sepolia-repay-1.proof.json");
    const receipt = decodeReceipt(proof.txBytes);
    const log = receipt.logs[5];
    expect(log.address.toLowerCase()).toBe("0x6ae43d3271ff6888e7fc43fd7321a503ff738951");
    expect(log.topics[0]).toBe(
      "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051"
    );
  });
});

describe("decodeReceipt on sepolia borrow fixture", () => {
  it("decodes tx-local log index 4 as an Aave Borrow", () => {
    const proof = loadProof("sepolia-borrow.proof.json");
    const receipt = decodeReceipt(proof.txBytes);
    const log = receipt.logs[4];
    expect(log.address.toLowerCase()).toBe("0x6ae43d3271ff6888e7fc43fd7321a503ff738951");
    expect(log.topics[0]).toBe(
      "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0"
    );
  });
});

describe("decodeCommon", () => {
  it("decodes the sender of the sepolia repay tx as the borrower wallet", () => {
    const proof = loadProof("sepolia-repay-1.proof.json");
    const common = decodeCommon(proof.txBytes);
    expect(common.from.toLowerCase()).toBe("0x2e2b283100135de40177e8124bc5591cf69ee163");
    expect(common.to?.toLowerCase()).toBe("0x6ae43d3271ff6888e7fc43fd7321a503ff738951");
  });

  it("throws on empty txBytes", () => {
    expect(() => decodeCommon("0x")).toThrow();
    expect(() => decodeReceipt("0x")).toThrow();
  });
});
