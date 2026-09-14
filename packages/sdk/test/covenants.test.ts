import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Address } from "viem";
import { decodeReceipt } from "../src/decoder";
import {
  CovenantKind,
  computeLimit,
  matchBreach,
  matchRepay,
  matchCure
} from "../src/covenants";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadReceiptLogs(name: string) {
  const proof = JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8"));
  return decodeReceipt(proof.txBytes).logs;
}

const MAINNET_CHAIN_KEY = 3;
const SEPOLIA_CHAIN_KEY = 1;
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const SEPOLIA_TEST_USDC: Address = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8";
const BORROWER: Address = "0x2E2b283100135De40177e8124bc5591CF69EE163";
const LIQUIDATED_WALLET: Address = "0xde092a220313cede58750434b66d46b5ff494cbb";

describe("computeLimit", () => {
  it("applies the CROSS_DEFAULT weight with no history", () => {
    const limit = computeLimit(100n, [{ kind: CovenantKind.CROSS_DEFAULT }], 0);
    // (10000 + 10000) / 10000 * 100 = 200
    expect(limit).toBe(200n);
  });

  it("adds a history boost of 2500 bps per proven repay, capped at 10000 bps", () => {
    const limit = computeLimit(100n, [{ kind: CovenantKind.CROSS_DEFAULT }], 5);
    // weight 10000 + historyBoost capped at 10000 => (10000+10000+10000)/10000*100 = 300
    // maxLeverageBps default 40000 -> cap 400, so min(300,400) = 300
    expect(limit).toBe(300n);
  });

  it("ignores retired terms when summing weights", () => {
    const limit = computeLimit(
      100n,
      [
        { kind: CovenantKind.CROSS_DEFAULT, retired: true },
        { kind: CovenantKind.DEBT_CAP }
      ],
      0
    );
    // only DEBT_CAP weight 7500 counts => (10000+7500)/10000*100 = 175
    expect(limit).toBe(175n);
  });

  it("caps the limit at bond * maxLeverageBps", () => {
    const limit = computeLimit(
      100n,
      [
        { kind: CovenantKind.CROSS_DEFAULT },
        { kind: CovenantKind.DEBT_CAP },
        { kind: CovenantKind.NEGATIVE_PLEDGE }
      ],
      10,
      { maxLeverageBps: 40000 }
    );
    // raw = (10000+10000+7500+5000+10000)/10000*100 = 425 > cap 400
    expect(limit).toBe(400n);
  });

  it("caps the limit at perLineCap when it is the tightest bound", () => {
    const limit = computeLimit(100n, [{ kind: CovenantKind.CROSS_DEFAULT }], 0, {
      perLineCap: 150n
    });
    expect(limit).toBe(150n);
  });
});

describe("matchBreach CROSS_DEFAULT against the real mainnet liquidation fixture", () => {
  const logs = loadReceiptLogs("mainnet-aave-liquidation.proof.json");
  const log = logs[16];

  it("flags a breach for the liquidated wallet", () => {
    const result = matchBreach(
      CovenantKind.CROSS_DEFAULT,
      { chainKey: MAINNET_CHAIN_KEY, target: ZERO_ADDRESS, threshold: 0n },
      LIQUIDATED_WALLET,
      log
    );
    expect(result.breach).toBe(true);
    expect(result.amount).toBe(3985851340n);
  });

  it("does not flag a breach for an unrelated wallet", () => {
    const result = matchBreach(
      CovenantKind.CROSS_DEFAULT,
      { chainKey: MAINNET_CHAIN_KEY, target: ZERO_ADDRESS, threshold: 0n },
      BORROWER,
      log
    );
    expect(result.breach).toBe(false);
  });

  it("rejects a spoofed emitter carrying the same topic0", () => {
    const spoofed = { ...log, address: "0x0000000000000000000000000000000000dEaD" as Address };
    const result = matchBreach(
      CovenantKind.CROSS_DEFAULT,
      { chainKey: MAINNET_CHAIN_KEY, target: ZERO_ADDRESS, threshold: 0n },
      LIQUIDATED_WALLET,
      spoofed
    );
    expect(result.breach).toBe(false);
    expect(result.reason).toMatch(/emitter/i);
  });
});

describe("matchBreach DEBT_CAP against the real sepolia borrow fixture (50 USDC, 6 decimals)", () => {
  const logs = loadReceiptLogs("sepolia-borrow.proof.json");
  const log = logs[4];

  it("breaches when the threshold (40 USDC) is exceeded", () => {
    const result = matchBreach(
      CovenantKind.DEBT_CAP,
      { chainKey: SEPOLIA_CHAIN_KEY, target: ZERO_ADDRESS, threshold: 40_000_000n },
      BORROWER,
      log
    );
    expect(result.breach).toBe(true);
    expect(result.amount).toBe(50_000_000n);
  });

  it("does not breach when the threshold (60 USDC) is not exceeded", () => {
    const result = matchBreach(
      CovenantKind.DEBT_CAP,
      { chainKey: SEPOLIA_CHAIN_KEY, target: ZERO_ADDRESS, threshold: 60_000_000n },
      BORROWER,
      log
    );
    expect(result.breach).toBe(false);
  });

  it("respects a reserve-scoped target", () => {
    const result = matchBreach(
      CovenantKind.DEBT_CAP,
      { chainKey: SEPOLIA_CHAIN_KEY, target: "0x0000000000000000000000000000000000dEaD", threshold: 1n },
      BORROWER,
      log
    );
    expect(result.breach).toBe(false);
    expect(result.reason).toMatch(/reserve/i);
  });
});

describe("matchBreach NEGATIVE_PLEDGE against the real sepolia repay-1 fixture (Transfer out of borrower)", () => {
  const logs = loadReceiptLogs("sepolia-repay-1.proof.json");
  const log = logs[3];

  it("breaches when the pledge token transfer out of the wallet exceeds threshold", () => {
    const result = matchBreach(
      CovenantKind.NEGATIVE_PLEDGE,
      { chainKey: SEPOLIA_CHAIN_KEY, target: SEPOLIA_TEST_USDC, threshold: 5_000_000n },
      BORROWER,
      log
    );
    expect(result.breach).toBe(true);
    expect(result.amount).toBe(10_000_000n);
  });

  it("does not breach when under threshold", () => {
    const result = matchBreach(
      CovenantKind.NEGATIVE_PLEDGE,
      { chainKey: SEPOLIA_CHAIN_KEY, target: SEPOLIA_TEST_USDC, threshold: 20_000_000n },
      BORROWER,
      log
    );
    expect(result.breach).toBe(false);
  });
});

describe("matchRepay against the real sepolia repay-1 fixture", () => {
  const logs = loadReceiptLogs("sepolia-repay-1.proof.json");
  const log = logs[5];

  it("matches a proven Aave Repay for the borrower", () => {
    const result = matchRepay(SEPOLIA_CHAIN_KEY, BORROWER, log);
    expect(result.matches).toBe(true);
    expect(result.amount).toBe(10_000_000n);
  });

  it("does not match for a different wallet", () => {
    const result = matchRepay(SEPOLIA_CHAIN_KEY, LIQUIDATED_WALLET, log);
    expect(result.matches).toBe(false);
  });
});

describe("matchCure", () => {
  it("cures a DEBT_CAP breach via a sufficient Aave Repay on the same reserve", () => {
    const logs = loadReceiptLogs("sepolia-repay-1.proof.json");
    const result = matchCure(
      CovenantKind.DEBT_CAP,
      { chainKey: SEPOLIA_CHAIN_KEY, target: SEPOLIA_TEST_USDC, threshold: 0n },
      BORROWER,
      logs[5],
      5_000_000n
    );
    expect(result.matches).toBe(true);
  });

  it("rejects a DEBT_CAP cure that repays less than the breach amount", () => {
    const logs = loadReceiptLogs("sepolia-repay-1.proof.json");
    const result = matchCure(
      CovenantKind.DEBT_CAP,
      { chainKey: SEPOLIA_CHAIN_KEY, target: SEPOLIA_TEST_USDC, threshold: 0n },
      BORROWER,
      logs[5],
      20_000_000n
    );
    expect(result.matches).toBe(false);
  });

  it("cures a NEGATIVE_PLEDGE breach via a sufficient transfer back to the wallet", () => {
    const logs = loadReceiptLogs("sepolia-borrow.proof.json");
    const result = matchCure(
      CovenantKind.NEGATIVE_PLEDGE,
      { chainKey: SEPOLIA_CHAIN_KEY, target: SEPOLIA_TEST_USDC, threshold: 0n },
      BORROWER,
      logs[3],
      40_000_000n
    );
    expect(result.matches).toBe(true);
  });

  it("never allows curing CROSS_DEFAULT by proof", () => {
    const logs = loadReceiptLogs("mainnet-aave-liquidation.proof.json");
    const result = matchCure(
      CovenantKind.CROSS_DEFAULT,
      { chainKey: MAINNET_CHAIN_KEY, target: ZERO_ADDRESS, threshold: 0n },
      LIQUIDATED_WALLET,
      logs[16],
      0n
    );
    expect(result.matches).toBe(false);
    expect(result.reason).toMatch(/not curable/i);
  });
});
