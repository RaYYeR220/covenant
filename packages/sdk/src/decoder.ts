import { decodeAbiParameters, type Address, type Hex } from "viem";

/**
 * TypeScript mirror of the Solidity `EvmV1Decoder` library used by Attestcoin ASCs.
 *
 * Encoding: `abi.encode(uint8 txType, bytes[] chunks)` where:
 *  - chunks[0] carries the common tx fields shared by all types.
 *  - chunks[last] carries the receipt fields (status, gasUsed, logs, logsBloom).
 *    The receipt chunk is at index 2 for tx types 0-2, and index 3 for types 3-4
 *    (those types carry an extra blob/auth-list chunk at index 2).
 */

export interface DecodedLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

export interface DecodedReceipt {
  status: number;
  gasUsed: bigint;
  logs: DecodedLog[];
}

export interface DecodedCommon {
  nonce: bigint;
  gasLimit: bigint;
  from: Address;
  to: Address | null;
  value: bigint;
  data: Hex;
}

const TOP_LEVEL_PARAMS = [{ type: "uint8" }, { type: "bytes[]" }] as const;

const COMMON_TX_PARAMS = [
  { type: "uint64" }, // nonce
  { type: "uint64" }, // gasLimit
  { type: "address" }, // from
  { type: "bool" }, // toIsNull
  { type: "address" }, // to
  { type: "uint256" }, // value
  { type: "bytes" } // data
] as const;

const RECEIPT_PARAMS = [
  { type: "uint8" }, // receiptStatus
  { type: "uint64" }, // receiptGasUsed
  {
    type: "tuple[]",
    components: [
      { name: "address_", type: "address" },
      { name: "topics", type: "bytes32[]" },
      { name: "data", type: "bytes" }
    ]
  }, // receiptLogs
  { type: "bytes" } // receiptLogsBloom
] as const;

function assertNonEmpty(txBytes: Hex): void {
  if (!txBytes || txBytes === "0x" || txBytes.length <= 2) {
    throw new Error("EvmV1Decoder: empty txBytes");
  }
}

function splitTopLevel(txBytes: Hex): { txType: number; chunks: Hex[] } {
  assertNonEmpty(txBytes);
  const [txType, chunks] = decodeAbiParameters(TOP_LEVEL_PARAMS, txBytes) as [
    number,
    Hex[]
  ];
  if (txType > 4) {
    throw new Error(`EvmV1Decoder: invalid tx type ${txType}`);
  }
  return { txType, chunks };
}

/** Index of the receipt chunk for a given tx type: 2 for types 0-2, 3 for types 3-4. */
function receiptChunkIndex(txType: number): number {
  return txType <= 2 ? 2 : 3;
}

/** Decodes only the common tx fields (chunk 0): from, to, value, nonce, etc. */
export function decodeCommon(txBytes: Hex): DecodedCommon {
  const { chunks } = splitTopLevel(txBytes);
  const [nonce, gasLimit, from, toIsNull, to, value, data] = decodeAbiParameters(
    COMMON_TX_PARAMS,
    chunks[0]
  ) as [bigint, bigint, Address, boolean, Address, bigint, Hex];
  return {
    nonce,
    gasLimit,
    from,
    to: toIsNull ? null : to,
    value,
    data
  };
}

/** Decodes only the receipt fields (status + logs) from the last chunk. */
export function decodeReceipt(txBytes: Hex): DecodedReceipt {
  const { txType, chunks } = splitTopLevel(txBytes);
  const idx = receiptChunkIndex(txType);
  const receiptChunk = chunks[idx];
  if (!receiptChunk) {
    throw new Error(`EvmV1Decoder: missing receipt chunk at index ${idx}`);
  }
  const [status, gasUsed, logs, _logsBloom] = decodeAbiParameters(
    RECEIPT_PARAMS,
    receiptChunk
  ) as [number, bigint, { address_: Address; topics: Hex[]; data: Hex }[], Hex];

  return {
    status,
    gasUsed,
    logs: logs.map((l) => ({ address: l.address_, topics: l.topics, data: l.data }))
  };
}
