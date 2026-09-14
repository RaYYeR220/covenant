import { useCallback, useState, useSyncExternalStore } from "react";
import { createWalletClient, custom, encodeFunctionData, type Abi, type Address, type EIP1193Provider, type Hex } from "viem";
import wctcAbiJson from "../../../../contracts/abi/WCTC.json";
import { client, CC_EXPLORER, creditcoinTestnet, RPC_URL } from "./chain";
import { errorText } from "./format";

export const wctcAbi = wctcAbiJson as Abi;

/** Creditcoin testnet accepts only legacy transactions at this fixed gas price. */
const GAS_PRICE = 500_000_000n;
const CHAIN_HEX = "0x18e8f";

interface WalletState {
  account: Address | undefined;
  connecting: boolean;
  error: string | undefined;
}

let state: WalletState = { account: undefined, connecting: false, error: undefined };
const listeners = new Set<() => void>();
const set = (patch: Partial<WalletState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

function provider(): EIP1193Provider | undefined {
  return typeof window !== "undefined" ? ((window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? undefined) : undefined;
}

export const hasWallet = () => !!provider();

let watching = false;
function watch() {
  const p = provider();
  if (!p || watching) return;
  watching = true;
  try {
    p.on?.("accountsChanged", (accs: Address[]) => set({ account: accs?.[0] }));
  } catch {
    /* optional */
  }
  // Silent restore of an already-authorised account; never prompts.
  p.request({ method: "eth_accounts" })
    .then((accs) => {
      if (accs?.[0] && !state.account) set({ account: accs[0] as Address });
    })
    .catch(() => undefined);
}

async function ensureChain(p: EIP1193Provider) {
  const current = (await p.request({ method: "eth_chainId" })) as string;
  if (current?.toLowerCase() === CHAIN_HEX) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 4902 && code !== -32603) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: CHAIN_HEX,
          chainName: "Creditcoin Testnet",
          nativeCurrency: { name: "tCTC", symbol: "tCTC", decimals: 18 },
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [CC_EXPLORER]
        }
      ]
    });
  }
}

export async function connectWallet() {
  const p = provider();
  if (!p) return;
  set({ connecting: true, error: undefined });
  try {
    const accs = (await p.request({ method: "eth_requestAccounts" })) as Address[];
    await ensureChain(p);
    set({ account: accs[0], connecting: false });
  } catch (e) {
    set({ connecting: false, error: errorText(e) });
  }
}

export function useWallet() {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      watch();
      return () => listeners.delete(l);
    },
    () => state
  );
  return { ...s, available: hasWallet(), connect: connectWallet };
}

export interface WriteCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: unknown[];
  value?: bigint;
  /** Gas used when estimation fails. */
  fallbackGas?: bigint;
}

/** Sends one legacy tx through the injected wallet and waits for it; throws on revert. */
export async function sendWrite(call: WriteCall, onHash?: (h: Hex) => void): Promise<Hex> {
  const p = provider();
  const account = state.account;
  if (!p || !account) throw new Error("Connect a wallet first.");
  await ensureChain(p);
  const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] });
  let gas: bigint;
  try {
    const est = await client.estimateGas({ account, to: call.address, data, value: call.value });
    gas = (est * 13n) / 10n;
  } catch (e) {
    if (!call.fallbackGas) throw e;
    gas = call.fallbackGas;
  }
  const wallet = createWalletClient({ account, chain: creditcoinTestnet, transport: custom(p) });
  const hash = await wallet.sendTransaction({ account, chain: creditcoinTestnet, to: call.address, data, value: call.value, gas, gasPrice: GAS_PRICE, type: "legacy" });
  onHash?.(hash);
  const rc = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== "success") throw new Error("Transaction reverted on chain.");
  return hash;
}

export interface TxStep {
  label: string;
  status: "waiting" | "pending" | "confirmed" | "error";
  hash?: Hex;
  error?: string;
}

/** Runs a sequence of writes, tracking each step's pending → confirmed state. */
export function useTxSteps() {
  const [steps, setSteps] = useState<TxStep[]>([]);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (plan: { label: string; call: () => Promise<WriteCall | null> }[]) => {
    setBusy(true);
    const cur: TxStep[] = plan.map((s) => ({ label: s.label, status: "waiting" }));
    const push = () => setSteps(cur.map((s) => ({ ...s })));
    push();
    let ok = true;
    for (let i = 0; i < plan.length; i++) {
      cur[i].status = "pending";
      push();
      try {
        const c = await plan[i].call();
        if (c) {
          await sendWrite(c, (h) => {
            cur[i].hash = h;
            push();
          });
        }
        cur[i].status = "confirmed";
        push();
      } catch (e) {
        cur[i].status = "error";
        cur[i].error = errorText(e).split("\n")[0].slice(0, 180);
        push();
        ok = false;
        break;
      }
    }
    setBusy(false);
    return ok;
  }, []);
  return { steps, busy, run, reset: () => setSteps([]) };
}
