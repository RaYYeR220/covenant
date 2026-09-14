import { formatUnits } from "viem";
import { KNOWN_TOKENS } from "./chain";

export const STATUS = ["None", "Active", "Breached", "Defaulted", "Closed"] as const;
export const KIND_NAME = ["Cross-default", "Debt cap", "Negative pledge"] as const;
export const KIND_CODE = ["CROSS_DEFAULT", "DEBT_CAP", "NEGATIVE_PLEDGE"] as const;

export function short(hex: string, head = 6, tail = 4): string {
  if (!hex) return "";
  return hex.length <= head + tail + 2 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const nf4 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/** Formats a wei-denominated amount (18 decimals) for display. */
export function amt(value: bigint, decimals = 18, precise = false): string {
  const n = Number(formatUnits(value, decimals));
  return (precise ? nf4 : nf).format(n);
}

export function bps(value: bigint | number): string {
  return `${nf.format(Number(value) / 100)}%`;
}

export function mult(valueBps: bigint | number): string {
  const n = Number(valueBps) / 10000;
  return `${n.toFixed(n % 1 === 0 ? 0 : 2)}x`;
}

export function tokenAmount(token: string, raw: bigint): string {
  const t = KNOWN_TOKENS[token.toLowerCase()];
  if (!t) return `${raw.toString()} base units`;
  return `${nf.format(Number(formatUnits(raw, t.decimals)))} ${t.symbol}`;
}

export function tokenLabel(token: string): string | undefined {
  return KNOWN_TOKENS[token.toLowerCase()]?.note;
}

export function dateTime(ts: number | bigint): string {
  const d = new Date(Number(ts) * 1000);
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x: number) => x.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function errorText(err: unknown): string {
  if (!err) return "Unknown error";
  const e = err as { shortMessage?: string; message?: string };
  return e.shortMessage ?? e.message ?? String(err);
}

export const ZERO = "0x0000000000000000000000000000000000000000";
