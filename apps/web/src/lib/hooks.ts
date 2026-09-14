import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { decodeEventLog, type Abi, type Address, type Hex, type Log } from "viem";
import { ADDR, client, DEPLOY_BLOCK, LOG_CHUNK, managerAbi, poolAbi } from "./chain";

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/** Runs an async loader, optionally re-polling. Errors are kept visible; stale data is kept while refreshing. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[], pollMs?: number): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loaderRef
      .current()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(undefined);
      })
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(() => setTick((t) => t + 1), pollMs);
    return () => clearInterval(id);
  }, [pollMs]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export interface ChainEvent {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
  address: Address;
}

interface LogStoreState {
  events: ChainEvent[];
  error: unknown;
  loading: boolean;
  head: bigint | undefined;
  updatedAt: number | undefined;
}

/** Incrementally syncs every log of one contract from the deploy block, in chunks, polling for new blocks. */
function createLogStore(address: Address, abi: Abi, pollMs: number) {
  let state: LogStoreState = { events: [], error: undefined, loading: true, head: undefined, updatedAt: undefined };
  let cursor = DEPLOY_BLOCK;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<LogStoreState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };

  const decode = (log: Log): ChainEvent | undefined => {
    try {
      const d = decodeEventLog({ abi, data: log.data, topics: log.topics });
      return {
        eventName: String(d.eventName),
        args: (d.args ?? {}) as Record<string, unknown>,
        blockNumber: log.blockNumber ?? 0n,
        txHash: log.transactionHash as Hex,
        logIndex: log.logIndex ?? 0,
        address: log.address
      };
    } catch {
      return undefined;
    }
  };

  const sync = async () => {
    if (running) return;
    running = true;
    try {
      const head = await client.getBlockNumber();
      const fresh: ChainEvent[] = [];
      let from = cursor;
      while (from <= head) {
        const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
        const logs = await client.getLogs({ address, fromBlock: from, toBlock: to });
        for (const l of logs) {
          const e = decode(l);
          if (e) fresh.push(e);
        }
        from = to + 1n;
      }
      cursor = head + 1n;
      set({
        events: fresh.length ? [...state.events, ...fresh] : state.events,
        error: undefined,
        loading: false,
        head,
        updatedAt: Date.now()
      });
    } catch (e) {
      set({ error: e, loading: false });
    } finally {
      running = false;
      timer = setTimeout(sync, state.error ? pollMs * 2 : pollMs);
    }
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!started) {
        started = true;
        void sync();
      }
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    retry() {
      if (timer) clearTimeout(timer);
      set({ loading: true });
      void sync();
    }
  };
}

const managerLogs = createLogStore(ADDR.manager, managerAbi, 12_000);
const poolLogs = createLogStore(ADDR.pool, poolAbi, 15_000);

export function useManagerEvents() {
  const s = useSyncExternalStore(managerLogs.subscribe, managerLogs.getSnapshot);
  return { ...s, retry: managerLogs.retry };
}

export function usePoolEvents() {
  const s = useSyncExternalStore(poolLogs.subscribe, poolLogs.getSnapshot);
  return { ...s, retry: poolLogs.retry };
}

const blockTimes = new Map<bigint, Promise<number>>();
export function blockTime(n: bigint): Promise<number> {
  let p = blockTimes.get(n);
  if (!p) {
    p = client.getBlock({ blockNumber: n }).then((b) => Number(b.timestamp));
    p.catch(() => blockTimes.delete(n));
    blockTimes.set(n, p);
  }
  return p;
}

/** Resolves timestamps for the given blocks; missing entries simply stay undefined. */
export function useBlockTimes(blocks: bigint[]): Map<bigint, number> {
  const [times, setTimes] = useState<Map<bigint, number>>(new Map());
  const key = blocks.map(String).join(",");
  useEffect(() => {
    let alive = true;
    Promise.allSettled(blocks.map(async (b) => [b, await blockTime(b)] as const)).then((rs) => {
      if (!alive) return;
      const m = new Map<bigint, number>();
      rs.forEach((r) => r.status === "fulfilled" && m.set(r.value[0], r.value[1]));
      setTimes(m);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return times;
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useHashRoute(): string[] {
  const read = () => (window.location.hash.replace(/^#\/?/, "") || "").split("/").filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => {
      setParts(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}
