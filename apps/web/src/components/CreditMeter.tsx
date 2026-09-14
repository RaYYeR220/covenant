import { amt, KIND_NAME, mult } from "../lib/format";

export interface MeterTerm {
  kind: number;
  retired: boolean;
}

interface Props {
  bond: bigint;
  limit: bigint;
  debt: bigint;
  terms: MeterTerm[];
  historyRepays: number;
  weights: [bigint, bigint, bigint];
  historyBoost: bigint;
  maxLeverageBps: bigint;
}

interface Seg {
  key: string;
  label: string;
  bps: number;
  cls: string;
}

/**
 * Engraved leverage rule measured in multiples of the bond: bond (1x), each live
 * covenant's weight, the repayment-history boost, the hard cap and current debt.
 */
export function CreditMeter({ bond, limit, debt, terms, historyRepays, weights, historyBoost, maxLeverageBps }: Props) {
  const segs: Seg[] = [{ key: "bond", label: "Bond", bps: 10000, cls: "seg-bond" }];
  terms.forEach((t, i) => {
    if (!t.retired) segs.push({ key: `t${i}`, label: KIND_NAME[t.kind] ?? `Kind ${t.kind}`, bps: Number(weights[t.kind] ?? 0n), cls: `seg-k${t.kind}` });
  });
  if (historyRepays > 0) {
    segs.push({ key: "hist", label: `${historyRepays} proven repay${historyRepays === 1 ? "" : "s"}`, bps: historyRepays * Number(historyBoost), cls: "seg-hist" });
  }
  const earned = segs.reduce((s, x) => s + x.bps, 0);
  const cap = Number(maxLeverageBps);
  const debtBps = bond > 0n ? Number((debt * 10000n) / bond) : 0;
  const limitBps = bond > 0n ? Number((limit * 10000n) / bond) : 0;
  const scale = Math.max(earned, cap, debtBps, 10000) * 1.04;
  const pct = (b: number) => `${(b / scale) * 100}%`;
  let acc = 0;

  const ticks = [];
  for (let x = 0; x <= scale; x += 5000) ticks.push(x);

  return (
    <figure className="meter" aria-label={`Credit limit ${amt(limit)} wCTC against a bond of ${amt(bond)} wCTC`}>
      <div className="meter-track">
        {segs.map((s) => {
          const left = acc;
          acc += s.bps;
          const over = Math.max(0, acc - Math.max(left, cap));
          return (
            <div key={s.key} className={`meter-seg ${s.cls}`} style={{ left: pct(left), width: pct(s.bps) }} title={`${s.label}: +${mult(s.bps)}`}>
              {over > 0 && <span className="seg-over" style={{ width: `${(Math.min(over, s.bps) / s.bps) * 100}%` }} />}
            </div>
          );
        })}
        <div className="meter-mark mark-cap" style={{ left: pct(cap) }}>
          <span>Cap {mult(cap)}</span>
        </div>
        <div className="meter-mark mark-debt" style={{ left: pct(debtBps) }}>
          <span>Debt {amt(debt)}</span>
        </div>
      </div>
      <div className="meter-axis" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} style={{ left: pct(t) }}>
            {mult(t)}
          </span>
        ))}
      </div>
      <figcaption className="meter-legend">
        {segs.map((s) => (
          <span key={s.key} className="lg">
            <i className={`sw ${s.cls}`} />
            {s.label} <b>+{mult(s.bps)}</b>
            {s.key === "bond" && <em> ({amt(bond)} wCTC)</em>}
          </span>
        ))}
        {earned > cap && (
          <span className="lg">
            <i className="sw sw-over" />
            Beyond the cap, not lendable
          </span>
        )}
      </figcaption>
      <div className="meter-sum">
        <p>
          <span className="sc">Earned</span> {mult(earned)}
        </p>
        <p>
          <span className="sc">Limit</span> {amt(limit)} wCTC <em>({mult(limitBps)})</em>
        </p>
        <p>
          <span className="sc">Headroom</span> {limit > debt ? amt(limit - debt) : "0"} wCTC
        </p>
      </div>
    </figure>
  );
}
