import { useMemo } from "react";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { AddrLink, Certificate, ErrorNote, ExtLink, Loading, TxLink } from "../components/bits";
import { CreditMeter } from "../components/CreditMeter";
import { Seal } from "../components/Seal";
import { ccTx, client, manager, managerAbi, record, sourceChain } from "../lib/chain";
import { useAsync, useBlockTimes, useManagerEvents, useNow, type ChainEvent } from "../lib/hooks";
import { amt, bps, dateTime, duration, KIND_NAME, short, STATUS, tokenAmount, tokenLabel, ZERO } from "../lib/format";
import { resolveSourceTx, type MerkleProof } from "../lib/sourceProof";

interface Line {
  borrower: Address;
  linkedWallet: Address;
  bond: bigint;
  principal: bigint;
  interestAccrued: bigint;
  lastAccrual: number;
  historyRepays: number;
  status: number;
  breachedAt: number;
  graceEnds: number;
  breachedTerm: number;
  breachHeight: bigint;
  breachAmount: bigint;
  memoHash: Hex;
}

interface Term {
  kind: number;
  chainKey: bigint;
  target: Address;
  threshold: bigint;
  retired: boolean;
}

interface CreditRecordData {
  kept: number;
  breaches: number;
  cures: number;
  defaults: number;
  provenRepays: number;
  lastUpdate: number;
}

const read = <T,>(functionName: string, args: unknown[] = []) => client.readContract({ ...manager, functionName, args }) as Promise<T>;

function statusVariant(s: number) {
  return (["none", "active", "breached", "defaulted", "closed"] as const)[s] ?? "none";
}

async function loadLines() {
  const next = await read<bigint>("nextLineId");
  const ids: bigint[] = [];
  for (let i = next - 1n; i >= 1n; i--) ids.push(i);
  const rows = await Promise.all(
    ids.map(async (id) => {
      const [line, limit, debt] = await Promise.all([read<Line>("lineOf", [id]), read<bigint>("limitOf", [id]), read<bigint>("debtOf", [id])]);
      return { id, line, limit, debt };
    })
  );
  return rows;
}

function LineStubs({ selected }: { selected: string }) {
  const { data, error, loading, reload } = useAsync(loadLines, [], 15_000);
  if (error && !data) return <ErrorNote error={error} onRetry={reload} what="the list of credit lines" />;
  if (!data) return <Loading what="credit lines" />;
  if (data.length === 0)
    return (
      <p className="empty">
        No credit lines have been opened yet. Lines appear here as soon as <span className="mono">openLine</span> lands on chain.
      </p>
    );
  return (
    <div className="stubs" role="list" aria-busy={loading}>
      {data.map(({ id, line, limit, debt }) => (
        <a
          role="listitem"
          key={id.toString()}
          href={`#/ledger/${id}`}
          className={`stub stub-${statusVariant(line.status)}`}
          aria-current={selected === id.toString() ? "true" : undefined}
        >
          <span className="stub-no">No. {id.toString()}</span>
          <span className="stub-status">{STATUS[line.status]}</span>
          <span className="stub-who mono">{short(line.borrower)}</span>
          <span className="stub-fig">
            {amt(debt)} <em>of</em> {amt(limit)} wCTC
          </span>
        </a>
      ))}
    </div>
  );
}

const EVENT_TITLES: Record<string, string> = {
  LineOpened: "Line opened",
  TermAttached: "Covenant attached",
  SourceActivated: "Source chain activated",
  RepayProven: "Aave repayment proven",
  HistoryUpdated: "Limit raised by history",
  Drawn: "Drawn",
  Repaid: "Repaid",
  CovenantBreached: "Breach proven",
  GraceStarted: "Grace period started",
  LineCured: "Cured",
  LineDefaulted: "Default settled",
  LineClosed: "Line closed"
};

/** A source-chain height, plus (when resolvable) the exact Sepolia tx hash for that proof item. */
interface SourceRef {
  height: bigint;
  hash?: string;
}

/**
 * Pulls source-chain heights and merkle proofs out of the Creditcoin calldata of proof-carrying
 * transactions, then resolves each proof's exact Sepolia tx hash from the same merkle proof
 * siblings the manager contract itself uses (via the calculateTxIndex precompile + Sepolia's
 * eth_getTransactionByBlockNumberAndIndex). Falls back to height-only (block link) on any failure.
 */
async function sourceRefs(hashes: Hex[]): Promise<Record<string, SourceRef[]>> {
  const out: Record<string, SourceRef[]> = {};
  await Promise.all(
    hashes.map(async (h) => {
      try {
        const tx = await client.getTransaction({ hash: h });
        const d = decodeFunctionData({ abi: managerAbi, data: tx.input });
        const a = d.args as readonly unknown[];
        let items: { height: bigint; proof: MerkleProof }[] = [];
        if (d.functionName === "proveHistory") {
          const heights = a[2] as bigint[];
          const proofs = a[4] as MerkleProof[];
          items = heights.map((height, i) => ({ height, proof: proofs[i] }));
        } else if (d.functionName === "proveRepay") {
          items = [{ height: a[2] as bigint, proof: a[4] as MerkleProof }];
        } else if (d.functionName === "reportBreach") {
          items = [{ height: a[2] as bigint, proof: a[4] as MerkleProof }];
        } else if (d.functionName === "cureByProof") {
          items = [{ height: a[1] as bigint, proof: a[3] as MerkleProof }];
        }
        out[h] = await Promise.all(
          items.map(async ({ height, proof }) => ({ height, hash: await resolveSourceTx(height, proof) }))
        );
      } catch {
        /* heights/hashes are an optional enrichment; the Creditcoin tx link is always shown */
      }
    })
  );
  return out;
}

function Timeline({ lineId, terms }: { lineId: bigint; terms: Term[] }) {
  const { events, error, loading, retry } = useManagerEvents();
  const mine = useMemo(
    () => events.filter((e) => e.args.lineId === lineId && EVENT_TITLES[e.eventName] && e.eventName !== "TermAttached"),
    [events, lineId]
  );
  const blocks = useMemo(() => [...new Set(mine.map((e) => e.blockNumber))], [mine]);
  const times = useBlockTimes(blocks);
  const proofTxs = useMemo(
    () => [...new Set(mine.filter((e) => ["RepayProven", "CovenantBreached", "LineCured"].includes(e.eventName)).map((e) => e.txHash))],
    [mine]
  );
  const { data: refs } = useAsync(() => sourceRefs(proofTxs), [proofTxs.join(",")]);
  const debtCapTarget = terms.find((t) => t.kind === 1)?.target;

  if (error && events.length === 0) return <ErrorNote error={error} onRetry={retry} what="line events" />;
  if (loading && events.length === 0) return <Loading what="line events" />;
  if (mine.length === 0) return <p className="empty">No events recorded for this line yet.</p>;

  const repayIdx: Record<string, number> = {};
  const ordered = [...mine].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)));

  const rows = ordered.map((e: ChainEvent) => {
    const a = e.args;
    let detail: React.ReactNode = null;
    let source: React.ReactNode = null;
    const srcLink = (chainKey: bigint | number, ref: SourceRef | undefined) => {
      const sc = sourceChain(chainKey);
      if (ref === undefined || !sc.explorer) return null;
      if (ref.hash) {
        return (
          <ExtLink href={`${sc.explorer}/tx/${ref.hash}`} title={ref.hash}>
            {sc.name} tx <span className="mono">{short(ref.hash, 6, 4)}</span>
          </ExtLink>
        );
      }
      return (
        <ExtLink href={`${sc.explorer}/block/${ref.height}`}>
          {sc.name} block {ref.height.toLocaleString("en-US")}
        </ExtLink>
      );
    };
    switch (e.eventName) {
      case "LineOpened":
        detail = (
          <>
            Bond {amt(a.bond as bigint)} wCTC by <AddrLink addr={a.borrower as string} />
          </>
        );
        break;
      case "SourceActivated":
        detail = (
          <>
            {sourceChain(a.chainKey as bigint).name}, watched from block {(a.activeFromHeight as bigint).toLocaleString("en-US")}
          </>
        );
        break;
      case "RepayProven": {
        const k = (repayIdx[e.txHash] = (repayIdx[e.txHash] ?? -1) + 1);
        detail = <>Amount {tokenAmount(debtCapTarget ?? ZERO, a.amount as bigint)}</>;
        source = srcLink(a.chainKey as bigint, refs?.[e.txHash]?.[k]);
        break;
      }
      case "HistoryUpdated":
        detail = (
          <>
            {(a.historyRepays as bigint).toString()} proven repays, limit now {amt(a.limit as bigint)} wCTC
          </>
        );
        break;
      case "Drawn":
        detail = (
          <>
            {amt(a.amount as bigint)} wCTC, principal {amt(a.principal as bigint)}
          </>
        );
        break;
      case "Repaid":
        detail = (
          <>
            {amt((a.principalPaid as bigint) + (a.interestPaid as bigint), 18, true)} wCTC by <AddrLink addr={a.payer as string} />
          </>
        );
        break;
      case "CovenantBreached": {
        const t = terms[Number(a.termIndex)];
        detail = (
          <>
            {t ? KIND_NAME[t.kind] : `Term ${a.termIndex}`} broken. Reporter <AddrLink addr={a.reporter as string} /> paid{" "}
            {amt(a.bounty as bigint)} wCTC
          </>
        );
        source = t ? srcLink(t.chainKey, refs?.[e.txHash]?.[0]) : null;
        break;
      }
      case "GraceStarted":
        detail = <>Cure or settle after {dateTime(Number(a.graceEnds))}</>;
        break;
      case "LineCured":
        detail = <>{a.byProof ? "Repayment proven on the source chain" : "Cured by repayment"}</>;
        if (a.byProof) {
          const t = terms[Number(a.termIndex)];
          source = t ? srcLink(t.chainKey, refs?.[e.txHash]?.[0]) : null;
        }
        break;
      case "LineDefaulted":
        detail = (
          <>
            {amt(a.recovered as bigint)} wCTC recovered for lenders, loss {amt(a.principalLoss as bigint)}. Keeper{" "}
            <AddrLink addr={a.keeper as string} />
          </>
        );
        break;
      case "LineClosed":
        detail = <>Bond returned: {amt(a.bondReturned as bigint)} wCTC</>;
        break;
    }
    const ts = times.get(e.blockNumber);
    return (
      <li key={`${e.txHash}-${e.logIndex}`} className={`tl-row tl-${e.eventName}`}>
        <span className="tl-dot" aria-hidden="true" />
        <div className="tl-when">
          <span>{ts ? dateTime(ts) : `Block ${e.blockNumber}`}</span>
        </div>
        <div className="tl-what">
          <h4>{EVENT_TITLES[e.eventName]}</h4>
          <p>{detail}</p>
        </div>
        <div className="tl-links">
          <ExtLink href={ccTx(e.txHash)} title={e.txHash}>
            Creditcoin <span className="mono">{short(e.txHash, 6, 4)}</span>
          </ExtLink>
          {source}
        </div>
      </li>
    );
  });

  return <ol className="timeline">{rows.reverse()}</ol>;
}

function StatusSeal({ line }: { line: Line }) {
  const now = useNow();
  const v = statusVariant(line.status);
  if (line.status === 2) {
    const left = line.graceEnds - now;
    return (
      <div className="seal-wrap">
        <Seal word="BREACHED" ring="COVENANT BROKEN • GRACE PERIOD • " variant="breached" size={168} sub={left > 0 ? `${duration(left)} to cure` : "grace elapsed"} />
        <p className="seal-note" aria-live="polite">
          {left > 0 ? <>Borrower can cure until {dateTime(line.graceEnds)}</> : <>Grace elapsed. Anyone may settle the default.</>}
        </p>
      </div>
    );
  }
  const word = { active: "ACTIVE", defaulted: "DEFAULTED", closed: "CLOSED", none: "UNISSUED", breached: "BREACHED" }[v];
  const ring = {
    active: "IN GOOD STANDING • COVENANT LINE • ",
    defaulted: "BOND SETTLED TO LENDERS • ",
    closed: "REPAID IN FULL • BOND RETURNED • ",
    none: "NO SUCH INSTRUMENT • ",
    breached: ""
  }[v];
  return (
    <div className="seal-wrap">
      <Seal word={word} ring={ring.repeat(v === "none" ? 2 : 1)} variant={v} size={168} />
    </div>
  );
}

function LineDetail({ id }: { id: bigint }) {
  const { data, error, reload } = useAsync(
    async () => {
      const [line, terms, limit, debt, wCd, wDc, wNp, boost, maxLev, bounty, grace, apr] = await Promise.all([
        read<Line>("lineOf", [id]),
        read<Term[]>("termsOf", [id]),
        read<bigint>("limitOf", [id]),
        read<bigint>("debtOf", [id]),
        read<bigint>("WEIGHT_CROSS_DEFAULT"),
        read<bigint>("WEIGHT_DEBT_CAP"),
        read<bigint>("WEIGHT_NEGATIVE_PLEDGE"),
        read<bigint>("HISTORY_BOOST_PER_REPAY"),
        read<bigint>("maxLeverageBps"),
        read<bigint>("bountyBps"),
        read<bigint>("gracePeriod"),
        read<bigint>("aprBps")
      ]);
      const rec = line.linkedWallet !== ZERO
        ? ((await client.readContract({ ...record, functionName: "recordOf", args: [line.linkedWallet] })) as CreditRecordData)
        : undefined;
      return { line, terms, limit, debt, weights: [wCd, wDc, wNp] as [bigint, bigint, bigint], boost, maxLev, bounty, grace, apr, rec };
    },
    [id],
    12_000
  );

  if (error && !data) return <ErrorNote error={error} onRetry={reload} what={`line ${id}`} />;
  if (!data) return <Loading what={`line ${id}`} />;
  const { line, terms, limit, debt, rec } = data;
  if (line.status === 0)
    return (
      <p className="empty">
        Line {id.toString()} does not exist. Pick a line from the ledger above.
      </p>
    );
  const linkedChain = terms[0] ? sourceChain(terms[0].chainKey) : sourceChain(1);

  return (
    <Certificate className="line-cert">
      <div className="line-head">
        <div>
          <p className="instrument-no">Credit line</p>
          <h1 className="line-title">Instrument No. {id.toString()}</h1>
          <dl className="line-parties">
            <div>
              <dt>Borrower</dt>
              <dd>
                <AddrLink addr={line.borrower} full />
              </dd>
            </div>
            <div>
              <dt>Ethereum wallet under covenant</dt>
              <dd>
                <AddrLink addr={line.linkedWallet} href={`${linkedChain.explorer}/address/${line.linkedWallet}`} full />
                <span className="hint"> on {linkedChain.name}</span>
              </dd>
            </div>
            <div>
              <dt>Terms of issue</dt>
              <dd>
                {bps(data.apr)} APR, {bps(data.bounty)} of bond to the reporter, {duration(Number(data.grace))} grace
              </dd>
            </div>
          </dl>
        </div>
        <StatusSeal line={line} />
      </div>

      {error ? <ErrorNote error={error} onRetry={reload} what="fresh line data (showing the last good read)" /> : null}

      <section className="block">
        <h2 className="block-title">Credit limit</h2>
        {line.bond === 0n ? (
          <p className="empty">
            {line.status === 3
              ? "The bond has been settled to lenders. This line extends no further credit; the default stays on the wallet's credit record."
              : "No bond is held, so this line extends no credit."}
          </p>
        ) : (
        <CreditMeter
          bond={line.bond}
          limit={limit}
          debt={debt}
          terms={terms}
          historyRepays={line.historyRepays}
          weights={data.weights}
          historyBoost={data.boost}
          maxLeverageBps={data.maxLev}
        />
        )}
      </section>

      <div className="two-col">
        <section className="block">
          <h2 className="block-title">Covenants</h2>
          <div className="table-wrap">
            <table className="terms">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Covenant</th>
                  <th scope="col">Chain</th>
                  <th scope="col">Target</th>
                  <th scope="col">Threshold</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {terms.map((t, i) => {
                  const sc = sourceChain(t.chainKey);
                  const breached = line.status === 2 && line.breachedTerm === i;
                  return (
                    <tr key={i} className={breached ? "row-breached" : t.retired ? "row-retired" : ""}>
                      <td>{i}</td>
                      <td>{KIND_NAME[t.kind] ?? t.kind}</td>
                      <td>{sc.name}</td>
                      <td>
                        {t.target === ZERO ? (
                          <span className="hint">Any Aave V3 position</span>
                        ) : (
                          <span title={tokenLabel(t.target)}>
                            <AddrLink addr={t.target} href={sc.explorer ? `${sc.explorer}/address/${t.target}` : undefined} />
                          </span>
                        )}
                      </td>
                      <td>{t.kind === 0 ? <span className="hint">Any liquidation</span> : tokenAmount(t.target, t.threshold)}</td>
                      <td>{breached ? "Breached" : t.retired ? "Retired" : "In force"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="fine">
            Cross-default never lets the wallet be liquidated on Aave V3. Debt cap bounds Aave borrowing of the target asset. Negative pledge
            bounds outflows of the target token.
          </p>
        </section>

        <section className="block">
          <h2 className="block-title">Credit record</h2>
          {rec ? (
            <>
              <dl className="record">
                <div>
                  <dt>Proven repays</dt>
                  <dd>{rec.provenRepays}</dd>
                </div>
                <div>
                  <dt>Lines kept</dt>
                  <dd>{rec.kept}</dd>
                </div>
                <div>
                  <dt>Breaches</dt>
                  <dd>{rec.breaches}</dd>
                </div>
                <div>
                  <dt>Cures</dt>
                  <dd>{rec.cures}</dd>
                </div>
                <div>
                  <dt>Defaults</dt>
                  <dd>{rec.defaults}</dd>
                </div>
              </dl>
              <p className="fine">
                Portable record for <span className="mono">{short(line.linkedWallet)}</span>
                {rec.lastUpdate ? <>, last written {dateTime(rec.lastUpdate)}</> : null}. Any protocol can read it.
              </p>
            </>
          ) : (
            <p className="empty">No wallet linked.</p>
          )}
          <dl className="line-figs">
            <div>
              <dt>Bond held</dt>
              <dd>{amt(line.bond)} wCTC</dd>
            </div>
            <div>
              <dt>Principal</dt>
              <dd>{amt(line.principal)} wCTC</dd>
            </div>
            <div>
              <dt>Debt with interest</dt>
              <dd>{amt(debt, 18, true)} wCTC</dd>
            </div>
            {line.status === 2 && (
              <div>
                <dt>Breach amount</dt>
                <dd>
                  {(() => {
                    const t = terms[line.breachedTerm];
                    const shown = tokenAmount(t?.target ?? ZERO, line.breachAmount);
                    return t && t.kind !== 0 ? (
                      <>
                        {shown} over a {tokenAmount(t.target, t.threshold)} cap
                      </>
                    ) : (
                      shown
                    );
                  })()}
                </dd>
              </div>
            )}
          </dl>
        </section>
      </div>

      <section className="block">
        <h2 className="block-title">History</h2>
        <Timeline lineId={id} terms={terms} />
      </section>
    </Certificate>
  );
}

export function Ledger({ lineId }: { lineId?: string }) {
  const { data } = useAsync(() => read<bigint>("nextLineId"), [], 15_000);
  const selected = lineId && /^\d+$/.test(lineId) ? lineId : data && data > 1n ? (data - 1n).toString() : undefined;
  return (
    <section className="page">
      <header className="page-head">
        <h1 className="page-title">The ledger</h1>
        <p className="page-lede">Every credit line on Creditcoin testnet, read straight from the manager contract. No wallet needed.</p>
      </header>
      <LineStubs selected={selected ?? ""} />
      {selected ? <LineDetail id={BigInt(selected)} key={selected} /> : null}
      {selected && <TxFootnote />}
    </section>
  );
}

function TxFootnote() {
  return (
    <p className="fine center">
      Figures refresh every few seconds. New breaches, cures and defaults appear without reloading. <TxLink hash={manager.address} href={`https://creditcoin-testnet.blockscout.com/address/${manager.address}`} label="Manager contract on Blockscout" />
    </p>
  );
}
