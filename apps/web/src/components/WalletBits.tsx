import { ccTx } from "../lib/chain";
import { short } from "../lib/format";
import { useWallet, type TxStep } from "../lib/wallet";
import { ExtLink } from "./bits";

export function WalletButton() {
  const w = useWallet();
  if (!w.available) return <span className="chain-status wallet-note">Read-only</span>;
  if (w.account)
    return (
      <span className="wallet-chip mono" title={w.account}>
        {short(w.account, 6, 4)}
      </span>
    );
  return (
    <button type="button" className="btn-quiet wallet-btn" onClick={() => void w.connect()} disabled={w.connecting} title={w.error}>
      {w.connecting ? "Connecting…" : "Connect wallet"}
    </button>
  );
}

const STATUS_TEXT: Record<TxStep["status"], string> = { waiting: "Waiting", pending: "Pending", confirmed: "Confirmed", error: "Failed" };

export function TxSteps({ steps }: { steps: TxStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="tx-steps" aria-live="polite">
      {steps.map((s, i) => (
        <li key={i} className={`tx-step tx-${s.status}`}>
          <span className="tx-label">{s.label}</span>
          <span className="tx-status">{STATUS_TEXT[s.status]}</span>
          {s.hash && (
            <ExtLink href={ccTx(s.hash)} title={s.hash}>
              <span className="mono">{short(s.hash, 8, 6)}</span>
            </ExtLink>
          )}
          {s.error && <span className="tx-error">{s.error}</span>}
        </li>
      ))}
    </ol>
  );
}
