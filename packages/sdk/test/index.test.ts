import { describe, expect, it } from "vitest";
import * as sdk from "../src/index";

describe("public API surface", () => {
  it("exports chain definitions and the Attestcoin chainKey registry", () => {
    expect(sdk.creditcoinTestnet.id).toBe(102031);
    expect(sdk.sepolia).toBeDefined();
    expect(sdk.ethereumMainnet).toBeDefined();
    expect(sdk.ATTESTCOIN_CHAIN_KEYS.sepolia).toBe(1);
    expect(sdk.AAVE_POOL_ADDRESS[1]).toBeDefined();
    expect(sdk.PLEDGE_TOKENS[1]).toBeDefined();
  });

  it("exports the decoder", () => {
    expect(typeof sdk.decodeReceipt).toBe("function");
    expect(typeof sdk.decodeCommon).toBe("function");
  });

  it("exports the proof client and converters", () => {
    expect(typeof sdk.ProofClient).toBe("function");
    expect(typeof sdk.toContractProofArgs).toBe("function");
    expect(typeof sdk.toContractBatchProofArgs).toBe("function");
  });

  it("exports covenant kinds and predicate mirrors", () => {
    expect(sdk.CovenantKind.CROSS_DEFAULT).toBe(0);
    expect(sdk.CovenantKind.DEBT_CAP).toBe(1);
    expect(sdk.CovenantKind.NEGATIVE_PLEDGE).toBe(2);
    expect(typeof sdk.computeLimit).toBe("function");
    expect(typeof sdk.matchBreach).toBe("function");
    expect(typeof sdk.matchRepay).toBe("function");
    expect(typeof sdk.matchCure).toBe("function");
  });

  it("exports the wallet scanner", () => {
    expect(typeof sdk.scanWallet).toBe("function");
    expect(typeof sdk.resolveTxLocalLogIndex).toBe("function");
  });

  it("exports the risk memo generator", () => {
    expect(typeof sdk.generateRiskMemo).toBe("function");
    expect(typeof sdk.clampProposedTerms).toBe("function");
    expect(typeof sdk.computeMemoHash).toBe("function");
  });
});
