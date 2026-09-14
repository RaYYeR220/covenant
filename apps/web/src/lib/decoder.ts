import { decodeAbiParameters, type Address, type Hex } from "viem";

/**
 * Browser mirror of the Solidity EvmV1Decoder used by Attestcoin:
 * abi.encode(uint8 txType, bytes[] chunks). chunks[0] holds the common tx fields,
 * the receipt chunk sits at index 2 (types 0-2) or 3 (types 3-4).
 */

export interface DecodedLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

export interface DecodedTx {
  txType: number;
  from: Address;
  to: Address | null;
  value: bigint;
  status: number;
  gasUsed: bigint;
  logs: DecodedLog[];
}

const TOP = [{ type: "uint8" }, { type: "bytes[]" }] as const;
const COMMON = [
  { type: "uint64" },
  { type: "uint64" },
  { type: "address" },
  { type: "bool" },
  { type: "address" },
  { type: "uint256" },
  { type: "bytes" }
] as const;
const RECEIPT = [
  { type: "uint8" },
  { type: "uint64" },
  {
    type: "tuple[]",
    components: [
      { name: "address_", type: "address" },
      { name: "topics", type: "bytes32[]" },
      { name: "data", type: "bytes" }
    ]
  },
  { type: "bytes" }
] as const;

export function decodeAttestedTx(txBytes: Hex): DecodedTx {
  if (!txBytes || txBytes.length <= 2) throw new Error("Empty txBytes in proof");
  const [txType, chunks] = decodeAbiParameters(TOP, txBytes);
  if (txType > 4) throw new Error(`Unknown tx type ${txType}`);
  const [, , from, toIsNull, to, value] = decodeAbiParameters(COMMON, chunks[0]);
  const receiptChunk = chunks[txType <= 2 ? 2 : 3];
  if (!receiptChunk) throw new Error("Proof is missing its receipt chunk");
  const [status, gasUsed, logs] = decodeAbiParameters(RECEIPT, receiptChunk);
  return {
    txType,
    from,
    to: toIsNull ? null : to,
    value,
    status,
    gasUsed,
    logs: logs.map((l) => ({ address: l.address_, topics: [...l.topics], data: l.data }))
  };
}

export const TOPIC_NAMES: Record<string, string> = {
  "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286": "Aave LiquidationCall",
  "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0": "Aave Borrow",
  "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051": "Aave Repay",
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef": "ERC-20 Transfer",
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925": "ERC-20 Approval",
  "0x804c9b842b2748a22bb64b345453a3de7ca54a6ca45ce00d415894979e22897a": "Aave ReserveDataUpdated",
  "0x44c58d81365b66dd4b1a7f36c25aa97b8c71c361ee4937adc1a00000227db5dd": "Aave ReserveUsedAsCollateralDisabled",
  "0x00058a56ea94653cdf4f152d227ace22d4c00ad99e2a43f58cb7d9e3feb295f2": "Aave ReserveUsedAsCollateralEnabled",
  "0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196": "aToken Mint",
  "0x4beccb90f994c31aced7a23b5611020728a23d8ec5cddd1a3e9d97b96fda8666": "aToken BalanceTransfer",
  "0x4cf25bc1d991c17529c25213d3cc0cda295eeaad5f13f361969b12ea48015f90": "aToken / debt Burn",
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67": "Uniswap V3 Swap",
  "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65": "WETH Withdrawal",
  "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c": "WETH Deposit"
};

export const LIQUIDATION_TOPIC0 = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";
