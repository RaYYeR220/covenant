import { createPublicClient, defineChain, fallback, http, type Abi, type Address } from "viem";
import deployment from "../../../../contracts/deployments/creditcoin-testnet.json";
import managerAbiJson from "../../../../contracts/abi/CovenantManager.json";
import poolAbiJson from "../../../../contracts/abi/CovenantPool.json";
import recordAbiJson from "../../../../contracts/abi/CreditRecord.json";

export const RPC_URL = "https://rpc.cc3-testnet.creditcoin.network";
export const CC_EXPLORER = "https://creditcoin-testnet.blockscout.com";
export const PROOF_API = "https://proof-gen-api.cc3-testnet.creditcoin.network/api/v1";

/** First block of the Covenant deployment on Creditcoin testnet (OwnershipTransferred of the manager). */
export const DEPLOY_BLOCK = 5483700n;
export const LOG_CHUNK = 5000n;

export const creditcoinTestnet = defineChain({
  id: 102031,
  name: "Creditcoin Testnet",
  nativeCurrency: { name: "tCTC", symbol: "tCTC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: CC_EXPLORER } }
});

export const client = createPublicClient({
  chain: creditcoinTestnet,
  transport: fallback([http(RPC_URL, { retryCount: 2, timeout: 30_000 })]),
  batch: { multicall: false }
});

export const ADDR = {
  manager: deployment.CovenantManager as Address,
  pool: deployment.CovenantPool as Address,
  record: deployment.CreditRecord as Address,
  wctc: deployment.WCTC as Address,
  evaluator: deployment.CovenantEvaluator as Address,
  blockProver: "0x0000000000000000000000000000000000000FD2" as Address,
  chainInfo: "0x0000000000000000000000000000000000000FD3" as Address
};

export const managerAbi = managerAbiJson as Abi;
export const poolAbi = poolAbiJson as Abi;
export const recordAbi = recordAbiJson as Abi;

export const manager = { address: ADDR.manager, abi: managerAbi } as const;
export const pool = { address: ADDR.pool, abi: poolAbi } as const;
export const record = { address: ADDR.record, abi: recordAbi } as const;

export interface SourceChain {
  key: number;
  name: string;
  explorer: string;
}

export const SOURCE_CHAINS: Record<number, SourceChain> = {
  1: { key: 1, name: "Ethereum Sepolia", explorer: "https://sepolia.etherscan.io" },
  3: { key: 3, name: "Ethereum mainnet", explorer: "https://etherscan.io" }
};

export function sourceChain(key: number | bigint): SourceChain {
  const k = Number(key);
  return SOURCE_CHAINS[k] ?? { key: k, name: `Chain key ${k}`, explorer: "" };
}

/** Tokens the deployment allows as pledge / debt-cap targets, with their decimals. */
export const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number; note: string }> = {
  "0x94a9d9ac8a22534e3faca9f4e7f2e2cf85d5e4c8": { symbol: "USDC", decimals: 6, note: "Aave faucet USDC, Sepolia" },
  "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": { symbol: "USDC", decimals: 6, note: "Circle USDC, Sepolia" },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6, note: "Circle USDC, mainnet" }
};

export const ccTx = (hash: string) => `${CC_EXPLORER}/tx/${hash}`;
export const ccAddress = (addr: string) => `${CC_EXPLORER}/address/${addr}`;
export const ccBlock = (n: bigint | number) => `${CC_EXPLORER}/block/${n}`;
