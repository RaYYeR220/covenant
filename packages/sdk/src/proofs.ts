import type { Hex } from "viem";

export const DEFAULT_PROOF_API_BASE_URL = "https://proof-gen-api.cc3-testnet.creditcoin.network";

/** Base class for every typed error the proof client can throw. Never swallowed — callers always see a real failure. */
export class ProofClientError extends Error {}

/** The proof service does not know about the requested chainKey/txHash (HTTP 404). */
export class ProofNotFoundError extends ProofClientError {
  constructor(message: string) {
    super(message);
    this.name = "ProofNotFoundError";
  }
}

/** The proof service responded with a non-2xx, non-404 status after retries were exhausted. */
export class ProofClientHttpError extends ProofClientError {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "ProofClientHttpError";
  }
}

/** The proof service is unreachable (network failure) after retries were exhausted. */
export class ProofClientNetworkError extends ProofClientError {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ProofClientNetworkError";
  }
}

export interface MerkleSibling {
  hash: Hex;
  isLeft: boolean;
}

export interface MerkleProof {
  root: Hex;
  siblings: MerkleSibling[];
}

export interface ContinuityProof {
  lowerEndpointDigest: Hex;
  roots: Hex[];
}

/** Response shape of GET /api/v1/proof-by-tx/{chainKey}/{txHash}. */
export interface ProofResult {
  chainKey: number;
  headerNumber: number;
  txIndex: number;
  txHash: Hex;
  txBytes: Hex;
  continuityProof: ContinuityProof;
  merkleProof: MerkleProof;
  cached: boolean;
  generatedAt: string;
}

interface BatchMerkleEntry {
  txHash: Hex;
  txBytes: Hex;
  merkleProof: MerkleProof;
}

/** Response shape of POST /api/v1/proof-batch-by-tx/{chainKey}. */
export interface BatchProofResult {
  chainKey: number;
  fromHeader: number;
  toHeader: number;
  continuityProof: ContinuityProof;
  merkleProofs: Record<string, Record<string, BatchMerkleEntry>>;
  cached: boolean;
  generatedAt: string;
}

export interface RetryOptions {
  /** Number of attempts (not counting the first) before giving up. Default 3. */
  retries?: number;
  /** Base delay for exponential backoff, in ms. Default 250. */
  baseDelayMs?: number;
}

export interface ProofClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retry?: RetryOptions;
}

export interface WaitUntilAttestedOptions {
  pollMs?: number;
  timeoutMs?: number;
  onTick?: (attestedHeight: number) => void;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * HTTP client for the Attestcoin proof generation API. Retries transient
 * failures with exponential backoff; every non-success outcome is surfaced
 * as a typed error rather than a fabricated/default value.
 */
export class ProofClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly baseDelayMs: number;

  constructor(options: ProofClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_PROOF_API_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.retries = options.retry?.retries ?? DEFAULT_RETRIES;
    this.baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (res.status === 404) {
          throw new ProofNotFoundError(`not found: ${path}`);
        }
        if (!res.ok) {
          if (isRetryableStatus(res.status) && attempt < this.retries) {
            lastError = new ProofClientHttpError(`HTTP ${res.status} for ${path}`, res.status);
            await sleep(this.baseDelayMs * 2 ** attempt);
            continue;
          }
          throw new ProofClientHttpError(`HTTP ${res.status} for ${path}`, res.status);
        }
        return res;
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof ProofNotFoundError || err instanceof ProofClientHttpError) {
          throw err;
        }
        lastError = err;
        if (attempt < this.retries) {
          await sleep(this.baseDelayMs * 2 ** attempt);
          continue;
        }
        throw new ProofClientNetworkError(`network error for ${path}: ${String(err)}`, err);
      }
    }
    // Unreachable: the loop above always returns or throws.
    throw lastError instanceof Error ? lastError : new ProofClientError(String(lastError));
  }

  /** GET /api/v1/attested-height/{chainKey} */
  async attestedHeight(chainKey: number): Promise<number> {
    const res = await this.request(`/api/v1/attested-height/${chainKey}`, { method: "GET" });
    const body = (await res.json()) as { attestedHeight: number };
    return body.attestedHeight;
  }

  /** GET /api/v1/proof-by-tx/{chainKey}/{txHash} */
  async proofByTx(chainKey: number, txHash: string): Promise<ProofResult> {
    const res = await this.request(`/api/v1/proof-by-tx/${chainKey}/${txHash}`, { method: "GET" });
    return (await res.json()) as ProofResult;
  }

  /** POST /api/v1/proof-batch-by-tx/{chainKey} with a JSON array of tx hashes. */
  async batchProof(chainKey: number, txHashes: string[]): Promise<BatchProofResult> {
    const res = await this.request(`/api/v1/proof-batch-by-tx/${chainKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(txHashes)
    });
    return (await res.json()) as BatchProofResult;
  }

  /** Polls attestedHeight until it reaches blockNumber, or throws on timeout. */
  async waitUntilAttested(
    chainKey: number,
    blockNumber: number,
    options: WaitUntilAttestedOptions = {}
  ): Promise<void> {
    const pollMs = options.pollMs ?? 5000;
    const timeoutMs = options.timeoutMs ?? 900000;
    const start = Date.now();

    while (true) {
      const height = await this.attestedHeight(chainKey);
      options.onTick?.(height);
      if (height >= blockNumber) return;
      if (Date.now() - start > timeoutMs) {
        throw new ProofClientError(
          `timeout waiting for chainKey ${chainKey} to attest block ${blockNumber} (last seen: ${height})`
        );
      }
      await sleep(pollMs);
    }
  }
}

export interface ContractProofArgs {
  chainKey: number;
  height: bigint;
  encodedTx: Hex;
  merkleProof: MerkleProof;
  continuityProof: ContinuityProof;
}

/** Converts a single `ProofResult` into the args shape expected by the on-chain verifier. */
export function toContractProofArgs(proof: ProofResult): ContractProofArgs {
  return {
    chainKey: proof.chainKey,
    height: BigInt(proof.headerNumber),
    encodedTx: proof.txBytes,
    merkleProof: proof.merkleProof,
    continuityProof: proof.continuityProof
  };
}

export interface ContractBatchProofArgs {
  chainKey: number;
  heights: bigint[];
  encodedTxs: Hex[];
  merkleProofs: MerkleProof[];
  sharedContinuity: ContinuityProof;
}

/**
 * Converts a `BatchProofResult` into the args shape expected by the batch
 * verifier, ordered by `orderedTxHashes` (the caller's own tx order).
 * Throws if any requested tx hash is missing from the batch response.
 */
export function toContractBatchProofArgs(
  batch: BatchProofResult,
  orderedTxHashes: string[]
): ContractBatchProofArgs {
  const byTxHash = new Map<string, { header: number; entry: BatchMerkleEntry }>();
  for (const [headerStr, byIndex] of Object.entries(batch.merkleProofs)) {
    const header = Number(headerStr);
    for (const entry of Object.values(byIndex)) {
      byTxHash.set(entry.txHash.toLowerCase(), { header, entry });
    }
  }

  const heights: bigint[] = [];
  const encodedTxs: Hex[] = [];
  const merkleProofs: MerkleProof[] = [];

  for (const txHash of orderedTxHashes) {
    const found = byTxHash.get(txHash.toLowerCase());
    if (!found) {
      throw new ProofClientError(`tx hash ${txHash} not present in batch proof response`);
    }
    heights.push(BigInt(found.header));
    encodedTxs.push(found.entry.txBytes);
    merkleProofs.push(found.entry.merkleProof);
  }

  return {
    chainKey: batch.chainKey,
    heights,
    encodedTxs,
    merkleProofs,
    sharedContinuity: batch.continuityProof
  };
}
