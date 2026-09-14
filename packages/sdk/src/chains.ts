import { defineChain, type Address, type Chain } from "viem";
import { sepolia as viemSepolia, mainnet as viemMainnet } from "viem/chains";

/** Creditcoin CC3 testnet — the execution chain Covenant contracts live on. */
export const creditcoinTestnet: Chain = defineChain({
  id: 102031,
  name: "Creditcoin Testnet",
  nativeCurrency: { name: "tCTC", symbol: "tCTC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.cc3-testnet.creditcoin.network"] }
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://creditcoin-testnet.blockscout.com"
    }
  }
});

/** Ethereum Sepolia — Attestcoin source chain, chainKey 1. */
export const sepolia: Chain = defineChain({
  ...viemSepolia,
  rpcUrls: {
    default: { http: ["https://ethereum-sepolia-rpc.publicnode.com"] }
  },
  blockExplorers: {
    default: {
      name: "Etherscan",
      url: "https://sepolia.etherscan.io"
    }
  }
});

/** Ethereum mainnet — Attestcoin source chain, chainKey 3. */
export const ethereumMainnet: Chain = defineChain({
  ...viemMainnet,
  rpcUrls: {
    default: { http: ["https://ethereum-rpc.publicnode.com"] }
  },
  blockExplorers: {
    default: {
      name: "Etherscan",
      url: "https://etherscan.io"
    }
  }
});

/** Attestcoin chainKey identifiers for the source chains Covenant reads from. */
export const ATTESTCOIN_CHAIN_KEYS = {
  sepolia: 1,
  mainnet: 3
} as const;

export type AttestcoinChainKey =
  (typeof ATTESTCOIN_CHAIN_KEYS)[keyof typeof ATTESTCOIN_CHAIN_KEYS];

/** Aave V3 Pool address on each source chain, keyed by Attestcoin chainKey. */
export const AAVE_POOL_ADDRESS: Record<AttestcoinChainKey, Address> = {
  [ATTESTCOIN_CHAIN_KEYS.sepolia]: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
  [ATTESTCOIN_CHAIN_KEYS.mainnet]: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
};

/** Pledge tokens allowlisted for NEGATIVE_PLEDGE covenants, keyed by Attestcoin chainKey. */
export const PLEDGE_TOKENS: Record<AttestcoinChainKey, Address[]> = {
  [ATTESTCOIN_CHAIN_KEYS.sepolia]: [
    "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Circle USDC (Sepolia)
    "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8" // Aave test USDC (Sepolia)
  ],
  [ATTESTCOIN_CHAIN_KEYS.mainnet]: [
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" // USDC (mainnet)
  ]
};

/** Builds an explorer URL for viewing an address on `chain`. */
export function explorerAddressUrl(chain: Chain, address: string): string {
  const base = chain.blockExplorers?.default.url;
  if (!base) throw new Error(`chain ${chain.name} has no configured block explorer`);
  return `${base}/address/${address}`;
}

/** Builds an explorer URL for viewing a transaction on `chain`. */
export function explorerTxUrl(chain: Chain, txHash: string): string {
  const base = chain.blockExplorers?.default.url;
  if (!base) throw new Error(`chain ${chain.name} has no configured block explorer`);
  return `${base}/tx/${txHash}`;
}
