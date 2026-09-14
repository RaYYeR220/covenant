import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ProofClient,
  ProofNotFoundError,
  ProofClientHttpError,
  toContractProofArgs,
  toContractBatchProofArgs
} from "../src/proofs";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string) {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8"));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("ProofClient.attestedHeight", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs /api/v1/attested-height/{chainKey} and returns the height", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ attestedHeight: 11700000 }));
    const client = new ProofClient({ baseUrl: "https://proof.example" });

    const height = await client.attestedHeight(1);

    expect(height).toBe(11700000);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://proof.example/api/v1/attested-height/1",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("retries on a transient server error and then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 503))
      .mockResolvedValueOnce(jsonResponse({ attestedHeight: 42 }));
    const client = new ProofClient({ baseUrl: "https://proof.example", retry: { retries: 2, baseDelayMs: 1 } });

    const height = await client.attestedHeight(1);

    expect(height).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a typed HTTP error after exhausting retries, never fabricating a height", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "down" }, 500));
    const client = new ProofClient({ baseUrl: "https://proof.example", retry: { retries: 2, baseDelayMs: 1 } });

    await expect(client.attestedHeight(1)).rejects.toBeInstanceOf(ProofClientHttpError);
  });
});

describe("ProofClient.proofByTx", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs /api/v1/proof-by-tx/{chainKey}/{txHash} and returns the parsed proof", async () => {
    const fixture = loadFixture("sepolia-repay-1.proof.json");
    fetchMock.mockResolvedValueOnce(jsonResponse(fixture));
    const client = new ProofClient({ baseUrl: "https://proof.example" });

    const proof = await client.proofByTx(1, fixture.txHash);

    expect(proof.txHash).toBe(fixture.txHash);
    expect(proof.txBytes).toBe(fixture.txBytes);
    expect(proof.merkleProof.root).toBe(fixture.merkleProof.root);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://proof.example/api/v1/proof-by-tx/1/${fixture.txHash}`,
      expect.objectContaining({ method: "GET" })
    );
  });

  it("throws ProofNotFoundError on a 404 rather than returning fabricated data", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404));
    const client = new ProofClient({ baseUrl: "https://proof.example" });

    await expect(client.proofByTx(1, "0xdeadbeef")).rejects.toBeInstanceOf(ProofNotFoundError);
  });
});

describe("ProofClient.batchProof", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the tx hash array to /api/v1/proof-batch-by-tx/{chainKey}", async () => {
    const fixture = loadFixture("sepolia-repays.batch.json");
    fetchMock.mockResolvedValueOnce(jsonResponse(fixture));
    const client = new ProofClient({ baseUrl: "https://proof.example" });
    const txHashes = ["0x8fdcc5a3fbbe14d982e01df01a2d38d34e2581db8a1307e2b3d69f633e85380b"];

    const batch = await client.batchProof(1, txHashes);

    expect(batch.chainKey).toBe(1);
    expect(batch.fromHeader).toBe(fixture.fromHeader);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://proof.example/api/v1/proof-batch-by-tx/1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(txHashes)
      })
    );
  });
});

describe("ProofClient.waitUntilAttested", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("polls attestedHeight until the target block is attested", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ attestedHeight: 100 }))
      .mockResolvedValueOnce(jsonResponse({ attestedHeight: 105 }))
      .mockResolvedValueOnce(jsonResponse({ attestedHeight: 110 }));
    const client = new ProofClient({ baseUrl: "https://proof.example" });
    const ticks: number[] = [];

    await client.waitUntilAttested(1, 108, { pollMs: 1, timeoutMs: 5000, onTick: (h) => ticks.push(h) });

    expect(ticks).toEqual([100, 105, 110]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws on timeout instead of resolving silently", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ attestedHeight: 1 })));
    const client = new ProofClient({ baseUrl: "https://proof.example" });

    await expect(
      client.waitUntilAttested(1, 999999, { pollMs: 1, timeoutMs: 20 })
    ).rejects.toThrow(/timeout/i);
  });
});

describe("toContractProofArgs", () => {
  it("converts a single proof result into contract-call args", () => {
    const fixture = loadFixture("sepolia-repay-1.proof.json");
    const args = toContractProofArgs(fixture);

    expect(args.chainKey).toBe(1);
    expect(args.height).toBe(BigInt(fixture.headerNumber));
    expect(args.encodedTx).toBe(fixture.txBytes);
    expect(args.merkleProof.root).toBe(fixture.merkleProof.root);
    expect(args.merkleProof.siblings).toHaveLength(fixture.merkleProof.siblings.length);
    expect(args.merkleProof.siblings[0]).toEqual(fixture.merkleProof.siblings[0]);
    expect(args.continuityProof.lowerEndpointDigest).toBe(
      fixture.continuityProof.lowerEndpointDigest
    );
    expect(args.continuityProof.roots).toEqual(fixture.continuityProof.roots);
  });
});

describe("toContractBatchProofArgs", () => {
  it("orders heights/encodedTxs/merkleProofs by the caller's requested tx order", () => {
    const fixture = loadFixture("sepolia-repays.batch.json");
    // batch fixture headers: 11698052 (repay#1), 11698053 (#2), 11698054 (#3), 11698055 (#4)
    const orderedTxHashes = [
      "0x0f883dec3f4988225c96c309dde1fcd04c41e447de0479404ac0990e5cf63c46", // repay #4
      "0x8fdcc5a3fbbe14d982e01df01a2d38d34e2581db8a1307e2b3d69f633e85380b" // repay #1
    ];

    const args = toContractBatchProofArgs(fixture, orderedTxHashes);

    expect(args.chainKey).toBe(1);
    expect(args.heights).toEqual([11698055n, 11698052n]);
    expect(args.encodedTxs).toHaveLength(2);
    expect(args.merkleProofs).toHaveLength(2);
    expect(args.sharedContinuity.lowerEndpointDigest).toBe(
      fixture.continuityProof.lowerEndpointDigest
    );
  });

  it("throws if a requested tx hash is not present in the batch response", () => {
    const fixture = loadFixture("sepolia-repays.batch.json");
    expect(() => toContractBatchProofArgs(fixture, ["0xnotpresent"])).toThrow();
  });
});
