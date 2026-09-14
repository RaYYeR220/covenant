import type { Address, Hex } from "viem";
import { client } from "./chain";

/** The native query verifier precompile, also used on-chain by CovenantManager._consumeProof. */
const BLOCK_PROVER = "0x0000000000000000000000000000000000000FD2" as Address;
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

const blockProverAbi = [
  {
    type: "function",
    name: "calculateTxIndex",
    stateMutability: "view",
    inputs: [
      {
        name: "merkleProof",
        type: "tuple",
        components: [
          { name: "root", type: "bytes32" },
          {
            name: "siblings",
            type: "tuple[]",
            components: [
              { name: "hash", type: "bytes32" },
              { name: "isLeft", type: "bool" }
            ]
          }
        ]
      }
    ],
    outputs: [{ name: "", type: "uint64" }]
  }
] as const;

export interface MerkleProof {
  root: Hex;
  siblings: { hash: Hex; isLeft: boolean }[];
}

/** In-memory cache of resolved Sepolia tx hashes for the session; never stores a wrong guess. */
const resolved = new Map<string, string | null>();

async function fetchSepoliaTx(height: bigint, index: bigint): Promise<string | null> {
  const res = await fetch(SEPOLIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionByBlockNumberAndIndex",
      params: [`0x${height.toString(16)}`, `0x${index.toString(16)}`]
    })
  });
  if (!res.ok) throw new Error(`Sepolia RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: { hash?: string }; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? "Sepolia RPC error");
  return json.result?.hash ?? null;
}

/**
 * Resolves the exact Sepolia transaction hash for a Creditcoin-attested proof: the same
 * tx index the CovenantManager precompile (calculateTxIndex) derives from the merkle proof
 * siblings, looked up in the Sepolia block by eth_getTransactionByBlockNumberAndIndex.
 * Cached in memory for the session. Returns undefined (never a wrong hash) on any failure,
 * so callers can fall back to a plain block link.
 */
export async function resolveSourceTx(height: bigint, proof: MerkleProof): Promise<string | undefined> {
  const key = `${height}:${proof.root}:${proof.siblings.map((s) => `${s.hash}${s.isLeft ? "1" : "0"}`).join("")}`;
  if (resolved.has(key)) return resolved.get(key) ?? undefined;
  try {
    const index = (await client.readContract({
      address: BLOCK_PROVER,
      abi: blockProverAbi,
      functionName: "calculateTxIndex",
      args: [proof]
    })) as bigint;
    const hash = await fetchSepoliaTx(height, index);
    resolved.set(key, hash);
    return hash ?? undefined;
  } catch {
    resolved.set(key, null);
    return undefined;
  }
}
