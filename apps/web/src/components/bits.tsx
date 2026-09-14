import type { ReactNode } from "react";
import { ccAddress, ccTx } from "../lib/chain";
import { errorText, short } from "../lib/format";

const CornerSvg = () => (
  <svg viewBox="0 0 34 34" aria-hidden="true">
    <path d="M2 2 Q2 20 20 20 M2 2 Q20 2 20 20" fill="none" stroke="#7A2331" strokeWidth="1" />
    <path d="M2 8 Q8 8 8 2" fill="none" stroke="#7A2331" strokeWidth="0.8" />
    <circle cx="2" cy="2" r="2" fill="#7A2331" />
  </svg>
);

/** Double-ruled certificate frame with engraved corner ornaments. */
export function Certificate({ children, className = "", tight = false }: { children: ReactNode; className?: string; tight?: boolean }) {
  return (
    <div className={`frame ${className}`}>
      <div className="corner tl"><CornerSvg /></div>
      <div className="corner tr"><CornerSvg /></div>
      <div className="corner bl"><CornerSvg /></div>
      <div className="corner br"><CornerSvg /></div>
      <div className={`frame-inner${tight ? " tight" : ""}`}>{children}</div>
    </div>
  );
}

export function ExtLink({ href, children, title }: { href: string; children: ReactNode; title?: string }) {
  return (
    <a className="ext" href={href} target="_blank" rel="noreferrer" title={title}>
      {children}
    </a>
  );
}

export function TxLink({ hash, href, label }: { hash: string; href?: string; label?: string }) {
  return (
    <ExtLink href={href ?? ccTx(hash)} title={hash}>
      <span className="mono">{label ?? short(hash, 8, 6)}</span>
    </ExtLink>
  );
}

export function AddrLink({ addr, href, full = false }: { addr: string; href?: string; full?: boolean }) {
  return (
    <ExtLink href={href ?? ccAddress(addr)} title={addr}>
      <span className="mono">{full ? addr : short(addr, 6, 4)}</span>
    </ExtLink>
  );
}

export function ErrorNote({ error, onRetry, what }: { error: unknown; onRetry?: () => void; what: string }) {
  return (
    <div className="error-note" role="alert">
      <p>
        <strong>Could not read {what} from Creditcoin testnet.</strong> {errorText(error)}
      </p>
      {onRetry && (
        <button type="button" className="btn-quiet" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="loading">Reading {what} from the chain…</p>;
}

export function Rule({ children }: { children?: ReactNode }) {
  return (
    <div className="orn-rule" role="separator">
      <span />
      {children && <em>{children}</em>}
      <span />
    </div>
  );
}
