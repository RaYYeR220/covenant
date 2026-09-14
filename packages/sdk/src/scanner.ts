import { decodeAbiParameters, parseAbiItem, type Address, type Hex, type Log } from "viem";
import { AAVE_POOL_ADDRESS, PLEDGE_TOKENS, type AttestcoinChainKey } from "./chains";
import { decodeReceipt } from "./decoder";

const LIQUIDATION_CALL_EVENT = parseAbiItem(
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)"
);
const BORROW_EVENT = parseAbiItem(
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)"
);
const REPAY_EVENT = parseAbiItem(
  "event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)"
);
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

export type ScanCandidateKind =
  | "LIQUIDATION"
  | "BORROW"
  | "REPAY"
  | "PLEDGE_TRANSFER_OUT"
  | "PLEDGE_TRANSFER_IN";

export interface ScanCandidate {
  kind: ScanCandidateKind;
  address: Address;
  txHash: Hex;
  blockNumber: bigint;
  /** Block-global log index, as returned by getLogs. Must be resolved to a tx-local index before proving. */
  blockLogIndex: number;
  amount: bigint;
  topics: Hex[];
  data: Hex;
}

/** The subset of a viem PublicClient this module depends on, kept narrow for testability. */
export interface LogsClient {
  getLogs: (args: {
    address?: Address | Address[];
    event: ReturnType<typeof parseAbiItem>;
    args?: Record<string, unknown>;
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<Log[]>;
}

export interface ScanWalletOptions {
  /** Max blocks per getLogs call. Default 500. */
  chunkSize?: bigint;
  retry?: { retries?: number; baseDelayMs?: number };
}

const DEFAULT_CHUNK_SIZE = 500n;
const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blockRanges(fromBlock: bigint, toBlock: bigint, chunkSize: bigint): Array<[bigint, bigint]> {
  const ranges: Array<[bigint, bigint]> = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + chunkSize - 1n < toBlock ? start + chunkSize - 1n : toBlock;
    ranges.push([start, end]);
    start = end + 1n;
  }
  return ranges;
}

async function getLogsWithRetry(
  client: LogsClient,
  params: Parameters<LogsClient["getLogs"]>[0],
  retries: number,
  baseDelayMs: number
): Promise<Log[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await client.getLogs(params);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function decodeAmount(kind: ScanCandidateKind, data: Hex): bigint {
  switch (kind) {
    case "LIQUIDATION": {
      const [debtToCover] = decodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "bool" }],
        data
      ) as [bigint, bigint, Address, boolean];
      return debtToCover;
    }
    case "BORROW": {
      const [, amount] = decodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint8" }, { type: "uint256" }],
        data
      ) as [Address, bigint, number, bigint];
      return amount;
    }
    case "REPAY": {
      const [amount] = decodeAbiParameters([{ type: "uint256" }, { type: "bool" }], data) as [
        bigint,
        boolean
      ];
      return amount;
    }
    case "PLEDGE_TRANSFER_OUT":
    case "PLEDGE_TRANSFER_IN": {
      const [value] = decodeAbiParameters([{ type: "uint256" }], data) as [bigint];
      return value;
    }
  }
}

function toCandidate(kind: ScanCandidateKind, log: Log): ScanCandidate {
  const topics = (log.topics ?? []) as Hex[];
  const data = log.data as Hex;
  return {
    kind,
    address: log.address as Address,
    txHash: log.transactionHash as Hex,
    blockNumber: log.blockNumber as bigint,
    blockLogIndex: Number(log.logIndex),
    amount: decodeAmount(kind, data),
    topics,
    data
  };
}

/**
 * Scans a source chain for events relevant to a linked wallet's covenants:
 * Aave LiquidationCall (CROSS_DEFAULT), Borrow (DEBT_CAP), Repay (history/cure),
 * and pledge-token Transfers in/out of the wallet (NEGATIVE_PLEDGE + cure).
 * Chunks the block range (default 500 blocks) and retries transient RPC failures.
 */
export async function scanWallet(
  client: LogsClient,
  chainKey: number,
  wallet: Address,
  fromBlock: bigint,
  toBlock: bigint,
  options: ScanWalletOptions = {}
): Promise<ScanCandidate[]> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const retries = options.retry?.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  const aavePool = AAVE_POOL_ADDRESS[chainKey as AttestcoinChainKey];
  const pledgeTokens = PLEDGE_TOKENS[chainKey as AttestcoinChainKey] ?? [];

  const candidates: ScanCandidate[] = [];

  for (const [start, end] of blockRanges(fromBlock, toBlock, chunkSize)) {
    if (aavePool) {
      const liquidationLogs = await getLogsWithRetry(
        client,
        { address: aavePool, event: LIQUIDATION_CALL_EVENT, args: { user: wallet }, fromBlock: start, toBlock: end },
        retries,
        baseDelayMs
      );
      candidates.push(...liquidationLogs.map((l) => toCandidate("LIQUIDATION", l)));

      const borrowLogs = await getLogsWithRetry(
        client,
        { address: aavePool, event: BORROW_EVENT, args: { onBehalfOf: wallet }, fromBlock: start, toBlock: end },
        retries,
        baseDelayMs
      );
      candidates.push(...borrowLogs.map((l) => toCandidate("BORROW", l)));

      const repayLogs = await getLogsWithRetry(
        client,
        { address: aavePool, event: REPAY_EVENT, args: { user: wallet }, fromBlock: start, toBlock: end },
        retries,
        baseDelayMs
      );
      candidates.push(...repayLogs.map((l) => toCandidate("REPAY", l)));
    }

    for (const token of pledgeTokens) {
      const outLogs = await getLogsWithRetry(
        client,
        { address: token, event: TRANSFER_EVENT, args: { from: wallet }, fromBlock: start, toBlock: end },
        retries,
        baseDelayMs
      );
      candidates.push(...outLogs.map((l) => toCandidate("PLEDGE_TRANSFER_OUT", l)));

      const inLogs = await getLogsWithRetry(
        client,
        { address: token, event: TRANSFER_EVENT, args: { to: wallet }, fromBlock: start, toBlock: end },
        retries,
        baseDelayMs
      );
      candidates.push(...inLogs.map((l) => toCandidate("PLEDGE_TRANSFER_IN", l)));
    }
  }

  return candidates;
}

/**
 * Resolves the tx-local log index of a scanned candidate by decoding the
 * proof's receipt and matching address+topics+data. `blockLogIndex` from
 * getLogs is block-global and must not be used directly for proving.
 */
export function resolveTxLocalLogIndex(
  txBytes: Hex,
  candidate: { address: Address; topics: Hex[]; data: Hex }
): number {
  const { logs } = decodeReceipt(txBytes);
  const candidateAddress = candidate.address.toLowerCase();
  const candidateTopics = candidate.topics.map((t) => t.toLowerCase());
  const candidateData = candidate.data.toLowerCase();

  const index = logs.findIndex(
    (log) =>
      log.address.toLowerCase() === candidateAddress &&
      log.data.toLowerCase() === candidateData &&
      log.topics.length === candidateTopics.length &&
      log.topics.every((t, i) => t.toLowerCase() === candidateTopics[i])
  );

  if (index === -1) {
    throw new Error("resolveTxLocalLogIndex: no matching log found in decoded receipt");
  }
  return index;
}
