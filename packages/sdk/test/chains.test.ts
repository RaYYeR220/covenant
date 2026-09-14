import { describe, expect, it } from "vitest";
import {
  creditcoinTestnet,
  sepolia,
  ethereumMainnet,
  ATTESTCOIN_CHAIN_KEYS,
  AAVE_POOL_ADDRESS,
  PLEDGE_TOKENS,
  explorerAddressUrl,
  explorerTxUrl
} from "../src/chains";

describe("chain definitions", () => {
  it("defines Creditcoin testnet with the correct chainId and RPC", () => {
    expect(creditcoinTestnet.id).toBe(102031);
    expect(creditcoinTestnet.rpcUrls.default.http[0]).toBe(
      "https://rpc.cc3-testnet.creditcoin.network"
    );
    expect(creditcoinTestnet.blockExplorers?.default.url).toBe(
      "https://creditcoin-testnet.blockscout.com"
    );
  });

  it("defines Sepolia with the correct RPC and explorer", () => {
    expect(sepolia.id).toBe(11155111);
    expect(sepolia.rpcUrls.default.http[0]).toBe(
      "https://ethereum-sepolia-rpc.publicnode.com"
    );
    expect(sepolia.blockExplorers?.default.url).toBe("https://sepolia.etherscan.io");
  });

  it("defines Ethereum mainnet with the correct RPC and explorer", () => {
    expect(ethereumMainnet.id).toBe(1);
    expect(ethereumMainnet.rpcUrls.default.http[0]).toBe(
      "https://ethereum-rpc.publicnode.com"
    );
    expect(ethereumMainnet.blockExplorers?.default.url).toBe("https://etherscan.io");
  });
});

describe("Attestcoin chainKey registry", () => {
  it("maps sepolia to chainKey 1 and mainnet to chainKey 3", () => {
    expect(ATTESTCOIN_CHAIN_KEYS.sepolia).toBe(1);
    expect(ATTESTCOIN_CHAIN_KEYS.mainnet).toBe(3);
  });

  it("resolves the Aave V3 Pool address per chainKey", () => {
    expect(AAVE_POOL_ADDRESS[1]).toBe("0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951");
    expect(AAVE_POOL_ADDRESS[3]).toBe("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2");
  });

  it("resolves the allowed pledge tokens per chainKey", () => {
    expect(PLEDGE_TOKENS[1]).toContain("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
    expect(PLEDGE_TOKENS[1]).toContain("0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8");
    expect(PLEDGE_TOKENS[3]).toContain("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  });
});

describe("explorer link helpers", () => {
  it("builds an address explorer URL on Creditcoin testnet", () => {
    expect(explorerAddressUrl(creditcoinTestnet, "0xabc")).toBe(
      "https://creditcoin-testnet.blockscout.com/address/0xabc"
    );
  });

  it("builds a tx explorer URL on Sepolia", () => {
    expect(explorerTxUrl(sepolia, "0xdef")).toBe("https://sepolia.etherscan.io/tx/0xdef");
  });
});
