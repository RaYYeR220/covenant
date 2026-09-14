import { useMemo, useState } from "react";
import { formatEther, formatUnits, parseEther, parseUnits } from "viem";
import { AddrLink, Certificate, ErrorNote, ExtLink, Loading } from "../components/bits";
import { TxSteps } from "../components/WalletBits";
import { ADDR, ccTx, client, pool } from "../lib/chain";
import { useTxSteps, useWallet, wctcAbi } from "../lib/wallet";
import { useAsync, useBlockTimes, usePoolEvents } from "../lib/hooks";
import { amt, bps, dateTime, short } from "../lib/format";

const parseShares = (s: string, dec: number) => {
  try {
    return /^\d*\.?\d+$/.test(s.trim()) ? parseUnits(s.trim(), dec) : undefined;
  } catch {
    return undefined;
  }
};

const read = <T,>(functionName: string, args: unknown[] = []) => client.readContract({ ...pool, functionName, args }) as Promise<T>;

async function loadPool() {
  const [totalAssets, outstanding, idle, util, maxUtil, supply, decimals, symbol] = await Promise.all([
    read<bigint>("totalAssets"),
    read<bigint>("outstandingPrincipal"),
    read<bigint>("idleAssets"),
    read<bigint>("utilizationBps"),
    read<bigint>("maxUtilizationBps"),
    read<bigint>("totalSupply"),
    read<number>("decimals"),
    read<string>("symbol")
  ]);
  const sharePrice = await read<bigint>("convertToAssets", [10n ** BigInt(decimals)]);
  return { totalAssets, outstanding, idle, util, maxUtil, supply, decimals, symbol, sharePrice };
}

const TITLES: Record<string, string> = {
  Deposit: "Deposit",
  Withdraw: "Withdrawal",
  Lent: "Lent to a line",
  RepaymentBooked: "Repayment booked",
  WrittenOff: "Written off"
};

function PoolActions({ onDone }: { onDone: () => void }) {
  const w = useWallet();
  const me = w.account;
  const mine = useAsync(
    async () => {
      if (!me) return undefined;
      const [shares, maxW, wctcBal, native, dec] = await Promise.all([
        read<bigint>("balanceOf", [me]),
        read<bigint>("maxWithdraw", [me]),
        client.readContract({ address: ADDR.wctc, abi: wctcAbi, functionName: "balanceOf", args: [me] }) as Promise<bigint>,
        client.getBalance({ address: me }),
        read<number>("decimals")
      ]);
      const value = await read<bigint>("convertToAssets", [shares]);
      return { shares, maxW, wctcBal, native, value, dec };
    },
    [me],
    15_000
  );
  const [depAmt, setDepAmt] = useState("1");
  const [wdShares, setWdShares] = useState("");
  const tx = useTxSteps();
  if (!w.available) return <p className="fine">Read-only view. Install a browser wallet to deposit or withdraw.</p>;
  if (!me)
    return (
      <p className="fine">
        <button type="button" className="btn-quiet" onClick={() => void w.connect()}>
          Connect wallet
        </button>{" "}
        to deposit tCTC or withdraw your shares.
      </p>
    );
  const parse = (s: string) => {
    try {
      return /^\d*\.?\d+$/.test(s.trim()) ? parseEther(s.trim()) : undefined;
    } catch {
      return undefined;
    }
  };
  const dep = parse(depAmt);
  const wd = parseShares(wdShares, mine.data?.dec ?? 18);
  const d = mine.data;
  const after = async (ok: boolean) => {
    mine.reload();
    if (ok) onDone();
  };
  const deposit = async () => {
    if (!dep) return;
    await after(
      await tx.run([
        { label: `Wrap ${formatEther(dep)} tCTC`, call: async () => ({ address: ADDR.wctc, abi: wctcAbi, functionName: "deposit", value: dep }) },
        { label: "Approve the pool", call: async () => ({ address: ADDR.wctc, abi: wctcAbi, functionName: "approve", args: [pool.address, dep] }) },
        { label: "Deposit into the pool", call: async () => ({ ...pool, functionName: "deposit", args: [dep, me] }) }
      ])
    );
  };
  const withdraw = async () => {
    if (!wd) return;
    let assets = 0n;
    await after(
      await tx.run([
        {
          label: "Redeem shares",
          call: async () => {
            assets = await read<bigint>("previewRedeem", [wd]);
            return { ...pool, functionName: "redeem", args: [wd, me, me] };
          }
        },
        {
          label: "Unwrap to tCTC",
          call: async () => {
            const bal = (await client.readContract({ address: ADDR.wctc, abi: wctcAbi, functionName: "balanceOf", args: [me] })) as bigint;
            const amount = assets < bal ? assets : bal;
            return amount > 0n ? { address: ADDR.wctc, abi: wctcAbi, functionName: "withdraw", args: [amount] } : null;
          }
        }
      ])
    );
  };
  return (
    <div className="wallet-actions">
      <dl className="line-figs">
        <div>
          <dt>Your shares</dt>
          <dd>{d ? amt(d.shares, d.dec, true) : "…"}</dd>
        </div>
        <div>
          <dt>Worth</dt>
          <dd>{d ? `${amt(d.value, 18, true)} tCTC` : "…"}</dd>
        </div>
        <div>
          <dt>Max withdraw</dt>
          <dd>{d ? `${amt(d.maxW, 18, true)} tCTC` : "…"}</dd>
        </div>
        <div>
          <dt>Wallet balance</dt>
          <dd>{d ? `${amt(d.native, 18, true)} tCTC` : "…"}</dd>
        </div>
      </dl>
      <div className="field-row">
        <label className="field narrow">
          <span>Deposit, tCTC</span>
          <input className="mono" value={depAmt} onChange={(e) => setDepAmt(e.target.value)} inputMode="decimal" aria-invalid={!dep} />
        </label>
        <button type="button" className="btn-primary" disabled={!dep || tx.busy} onClick={() => void deposit()}>
          Deposit
        </button>
        <label className="field narrow">
          <span>Withdraw, shares</span>
          <input className="mono" value={wdShares} onChange={(e) => setWdShares(e.target.value)} inputMode="decimal" placeholder={d ? formatUnits(d.shares, d.dec) : ""} />
        </label>
        <button type="button" className="btn-primary" disabled={!wd || tx.busy} onClick={() => void withdraw()}>
          Withdraw
        </button>
      </div>
      <TxSteps steps={tx.steps} />
    </div>
  );
}

function PoolEvents() {
  const { events, error, loading, retry } = usePoolEvents();
  const list = useMemo(() => events.filter((e) => TITLES[e.eventName]).slice(-20).reverse(), [events]);
  const times = useBlockTimes(useMemo(() => [...new Set(list.map((e) => e.blockNumber))], [list]));
  if (error && events.length === 0) return <ErrorNote error={error} onRetry={retry} what="pool events" />;
  if (loading && events.length === 0) return <Loading what="pool events" />;
  if (list.length === 0) return <p className="empty">No deposits or loans yet.</p>;
  return (
    <div className="table-wrap">
      <table className="ledger-table">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Entry</th>
            <th scope="col" className="num">
              Amount, wCTC
            </th>
            <th scope="col">Party</th>
            <th scope="col">Transaction</th>
          </tr>
        </thead>
        <tbody>
          {list.map((e) => {
            const a = e.args;
            let value: bigint | undefined;
            let party: string | undefined;
            if (e.eventName === "Deposit") {
              value = a.assets as bigint;
              party = a.owner as string;
            } else if (e.eventName === "Withdraw") {
              value = a.assets as bigint;
              party = a.owner as string;
            } else if (e.eventName === "Lent") {
              value = a.amount as bigint;
              party = a.to as string;
            } else if (e.eventName === "RepaymentBooked") value = (a.principal as bigint) + (a.interest as bigint);
            else if (e.eventName === "WrittenOff") value = a.principalLoss as bigint;
            const ts = times.get(e.blockNumber);
            return (
              <tr key={`${e.txHash}-${e.logIndex}`}>
                <td>{ts ? dateTime(ts) : `Block ${e.blockNumber}`}</td>
                <td>{TITLES[e.eventName]}</td>
                <td className="num">{value !== undefined ? amt(value, 18, true) : ""}</td>
                <td>{party ? <AddrLink addr={party} /> : <span className="hint">Pool</span>}</td>
                <td>
                  <ExtLink href={ccTx(e.txHash)} title={e.txHash}>
                    <span className="mono">{short(e.txHash, 8, 6)}</span>
                  </ExtLink>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PoolPage() {
  const { data, error, reload } = useAsync(loadPool, [], 15_000);
  return (
    <section className="page">
      <header className="page-head">
        <h1 className="page-title">The lending pool</h1>
        <p className="page-lede">
          An ERC-4626 vault of wrapped tCTC. Lenders fund every line; defaulted bonds flow back here.
        </p>
      </header>
      {error && !data ? <ErrorNote error={error} onRetry={reload} what="pool figures" /> : null}
      {!data && !error ? <Loading what="pool figures" /> : null}
      {data && (
        <Certificate>
          <div className="pool-figs">
            <div className="fig">
              <span className="sc">Total assets</span>
              <strong>{amt(data.totalAssets)}</strong>
              <em>wCTC</em>
            </div>
            <div className="fig">
              <span className="sc">Lent out</span>
              <strong>{amt(data.outstanding)}</strong>
              <em>wCTC</em>
            </div>
            <div className="fig">
              <span className="sc">Idle</span>
              <strong>{amt(data.idle)}</strong>
              <em>wCTC</em>
            </div>
            <div className="fig">
              <span className="sc">Share price</span>
              <strong>{amt(data.sharePrice, 18, true)}</strong>
              <em>wCTC per {data.symbol}</em>
            </div>
          </div>
          <figure className="util">
            <div className="util-track" role="img" aria-label={`Utilization ${bps(data.util)} of a ${bps(data.maxUtil)} cap`}>
              <div className="util-fill" style={{ width: `${Number(data.util) / 100}%` }} />
              <div className="util-cap" style={{ left: `${Number(data.maxUtil) / 100}%` }}>
                <span>Cap {bps(data.maxUtil)}</span>
              </div>
            </div>
            <figcaption>
              Utilization <strong>{bps(data.util)}</strong>. New draws are refused once lending would pass the {bps(data.maxUtil)} cap.
            </figcaption>
          </figure>
          <p className="fine">
            Vault <AddrLink addr={pool.address} full />. {amt(data.supply, data.decimals)} {data.symbol} shares outstanding.
          </p>
          <h2 className="block-title">Your position</h2>
          <PoolActions onDone={reload} />
          <h2 className="block-title">Recent entries</h2>
          <PoolEvents />
        </Certificate>
      )}
    </section>
  );
}
