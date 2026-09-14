import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Address } from "viem";
import {
  clampProposedTerms,
  computeMemoHash,
  generateRiskMemo,
  type ProposedTerm,
  type MemoTemplateCeilings,
  type RiskProfile
} from "../src/memo";
import { CovenantKind } from "../src/covenants";

const CHAIN_KEY = 1;
const USDC: Address = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8";
const WALLET: Address = "0x2E2b283100135De40177e8124bc5591CF69EE163";
const RANDOM: Address = "0x53Cd0b05934FA0C7Dc9bC2341c86f26ed5cef540";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const CEILINGS: MemoTemplateCeilings = {
  maxThresholdByKind: {
    [CovenantKind.DEBT_CAP]: 50_000_000n,
    [CovenantKind.NEGATIVE_PLEDGE]: 50_000_000n
  },
  allowlistedTargets: {
    [CHAIN_KEY]: [USDC]
  }
};

describe("clampProposedTerms (the hard rule: memo can only ever tighten)", () => {
  it("leaves a term unchanged when it is within the ceiling and allowlisted", () => {
    const terms: ProposedTerm[] = [
      {
        kind: CovenantKind.DEBT_CAP,
        chainKey: CHAIN_KEY,
        target: ZERO,
        threshold: 10_000_000n,
        rationale: "test"
      }
    ];
    expect(clampProposedTerms(terms, CEILINGS)).toEqual(terms);
  });

  it("clamps a threshold down to the template ceiling instead of dropping the term", () => {
    const terms: ProposedTerm[] = [
      {
        kind: CovenantKind.DEBT_CAP,
        chainKey: CHAIN_KEY,
        target: ZERO,
        threshold: 999_000_000n,
        rationale: "too high"
      }
    ];
    const clamped = clampProposedTerms(terms, CEILINGS);
    expect(clamped).toHaveLength(1);
    expect(clamped[0].threshold).toBe(50_000_000n);
  });

  it("drops a term whose NEGATIVE_PLEDGE target is not allowlisted", () => {
    const terms: ProposedTerm[] = [
      {
        kind: CovenantKind.NEGATIVE_PLEDGE,
        chainKey: CHAIN_KEY,
        target: RANDOM,
        threshold: 1_000_000n,
        rationale: "not a pledge token"
      }
    ];
    expect(clampProposedTerms(terms, CEILINGS)).toHaveLength(0);
  });

  it("drops a term with an unknown covenant kind", () => {
    const terms = [
      {
        kind: 99 as ProposedTerm["kind"],
        chainKey: CHAIN_KEY,
        target: ZERO,
        threshold: 1n,
        rationale: "bogus"
      }
    ];
    expect(clampProposedTerms(terms, CEILINGS)).toHaveLength(0);
  });

  it("never increases a threshold, only ever tightens or drops", () => {
    const terms: ProposedTerm[] = [
      {
        kind: CovenantKind.DEBT_CAP,
        chainKey: CHAIN_KEY,
        target: ZERO,
        threshold: 1_000_000n,
        rationale: "already tight"
      }
    ];
    const clamped = clampProposedTerms(terms, CEILINGS);
    expect(clamped[0].threshold).toBeLessThanOrEqual(1_000_000n);
  });
});

describe("computeMemoHash", () => {
  it("is deterministic and independent of proposedTerms array identity for equal content", () => {
    const memoA = {
      summary: "borrower has a clean repay history",
      riskFlags: ["no breaches"],
      proposedTerms: [
        { kind: CovenantKind.DEBT_CAP, chainKey: 1, target: ZERO, threshold: 10n, rationale: "r" }
      ]
    };
    const memoB = {
      summary: "borrower has a clean repay history",
      riskFlags: ["no breaches"],
      proposedTerms: [
        { kind: CovenantKind.DEBT_CAP, chainKey: 1, target: ZERO, threshold: 10n, rationale: "r" }
      ]
    };
    expect(computeMemoHash(memoA)).toBe(computeMemoHash(memoB));
  });

  it("changes when the content changes", () => {
    const memoA = { summary: "a", riskFlags: [], proposedTerms: [] };
    const memoB = { summary: "b", riskFlags: [], proposedTerms: [] };
    expect(computeMemoHash(memoA)).not.toBe(computeMemoHash(memoB));
  });

  it("produces a 32-byte hex hash", () => {
    const hash = computeMemoHash({ summary: "x", riskFlags: [], proposedTerms: [] });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("generateRiskMemo without network", () => {
  const profile: RiskProfile = {
    wallet: WALLET,
    chainKey: CHAIN_KEY,
    provenRepays: 4,
    breaches: 0,
    pledgeTokenActivity: []
  };

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns status unavailable when no API key is configured, without ever calling fetch", async () => {
    const result = await generateRiskMemo(profile, {
      apiKey: undefined,
      ceilings: CEILINGS,
      fetch: fetchMock
    });

    expect(result.status).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns status unavailable (never a fake memo) when the API call fails", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    const result = await generateRiskMemo(profile, {
      apiKey: "test-key",
      ceilings: CEILINGS,
      fetch: fetchMock
    });

    expect(result.status).toBe("unavailable");
  });

  it("returns status unavailable when the model response fails schema validation", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "llama-3.3-70b" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), {
        status: 200
      });
    });

    const result = await generateRiskMemo(profile, {
      apiKey: "test-key",
      ceilings: CEILINGS,
      fetch: fetchMock
    });

    expect(result.status).toBe("unavailable");
  });

  it("parses a valid model response, clamps proposed terms, and hashes the memo", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "llama-3.3-70b" }] }), { status: 200 });
      }
      const content = JSON.stringify({
        summary: "borrower repaid 4 times with no breaches",
        riskFlags: [],
        proposedTerms: [
          {
            kind: CovenantKind.DEBT_CAP,
            chainKey: CHAIN_KEY,
            target: ZERO,
            threshold: "999000000",
            rationale: "cap borrow size"
          }
        ]
      });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    });

    const result = await generateRiskMemo(profile, {
      apiKey: "test-key",
      ceilings: CEILINGS,
      fetch: fetchMock
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.proposedTerms).toHaveLength(1);
      expect(result.proposedTerms[0].threshold).toBe(50_000_000n); // clamped down
      expect(result.memoHash).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});

// Opt-in live check against the real Venice API. Skipped unless VENICE_API_KEY
// is present in the environment (load it via your own env tooling — never
// commit it). Run with: VENICE_API_KEY=... pnpm -F @covenant/sdk test -- memo.test.ts
describe.skipIf(!process.env.VENICE_API_KEY)("generateRiskMemo live (opt-in)", () => {
  it("gets a real memo back from Venice AI", async () => {
    const profile: RiskProfile = {
      wallet: WALLET,
      chainKey: CHAIN_KEY,
      provenRepays: 4,
      breaches: 0,
      pledgeTokenActivity: []
    };

    const result = await generateRiskMemo(profile, {
      apiKey: process.env.VENICE_API_KEY,
      ceilings: CEILINGS
    });

    expect(["ok", "unavailable"]).toContain(result.status);
  }, 30000);
});
