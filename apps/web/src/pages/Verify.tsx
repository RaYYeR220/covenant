import { useEffect, useMemo, useRef, useState } from "react";
import { isAddress, isHex, type Address, type Hex } from "viem";
import { AddrLink, Certificate, ExtLink } from "../components/bits";
import { Rosette } from "../components/Rosette";
import { Seal } from "../components/Seal";
import { client, manager, PROOF_API, sourceChain } from "../lib/chain";
import { decodeAttestedTx, LIQUIDATION_TOPIC0, TOPIC_NAMES, type DecodedTx } from "../lib/decoder";
import { errorText, KIND_CODE, KIND_NAME, short, tokenAmount, ZERO } from "../lib/format";

const DEFAULT_TX = "0xec0b8f78036c679ed61d1a3ec1a6d4f733c4a306bfc0b6253cf4e02752883b07";
const DEFAULT_WALLET = "0xde092a220313cede58750434b66d46b5ff494cbb";

interface Proof {
  chainKey: number;
  headerNumber: number;
  txIndex: number;
  txHash: Hex;
  txBytes: Hex;
  merkleProof: { root: Hex; siblings: { hash: Hex; isLeft: boolean }[] };
  continuityProof: { lowerEndpointDigest: Hex; roots: Hex[] };
  generatedAt: string;
}

type ProofSource = "live" | "cached";

interface Check {
  breach: boolean;
  amount: bigint;
  reason: string;
  wallet: string;
  logIndex: number;
  block: bigint;
}

async function fetchProof(chainKey: number, tx: string): Promise<{ proof: Proof; source: ProofSource; liveError?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(`${PROOF_API}/proof-by-tx/${chainKey}/${tx}`, { signal: ctrl.signal });
    if (res.status === 404) throw new Error("The proof service has no attested block containing this transaction yet.");
    if (!res.ok) throw new Error(`Proof service answered HTTP ${res.status}.`);
    return { proof: (await res.json()) as Proof, source: "live" };
  } catch (e) {
    const msg = ctrl.signal.aborted ? "Proof service timed out after 25 s." : errorText(e);
    if (tx.toLowerCase() === DEFAULT_TX && chainKey === 3) {
      const fixture = (await import("../fixtures/mainnet-aave-liquidation.proof.json")).default as Proof;
      return { proof: fixture, source: "cached", liveError: msg };
    }
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

export function Verify() {
  const [chainKey, setChainKey] = useState(3);
  const [tx, setTx] = useState(DEFAULT_TX);
  const [wallet, setWallet] = useState(DEFAULT_WALLET);
  const [kind, setKind] = useState(0);
  const [target, setTarget] = useState("");
  const [threshold, setThreshold] = useState("0");

  const [proof, setProof] = useState<{ proof: Proof; source: ProofSource; liveError?: string }>();
  const [decoded, setDecoded] = useState<DecodedTx>();
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string>();
  const [logIndex, setLogIndex] = useState<number>();

  const [check, setCheck] = useState<Check>();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string>();
  const [armed, setArmed] = useState(false);
  const reqId = useRef(0);

  const txValid = isHex(tx) && tx.length === 66;
  const walletValid = isAddress(wallet, { strict: false });
  const targetValid = kind === 0 || isAddress(target, { strict: false });
  const thresholdValid = /^\d+$/.test(threshold);

  async function onFetch() {
    setFetching(true);
    setFetchError(undefined);
    setProof(undefined);
    setDecoded(undefined);
    setCheck(undefined);
    setArmed(false);
    try {
      const p = await fetchProof(chainKey, tx.trim());
      const d = decodeAttestedTx(p.proof.txBytes);
      setProof(p);
      setDecoded(d);
      const liq = d.logs.findIndex((l) => l.topics[0]?.toLowerCase() === LIQUIDATION_TOPIC0);
      setLogIndex(liq >= 0 ? liq : 0);
      setTimeout(() => {
        const el = document.querySelector<HTMLElement>(".log-row.on");
        if (el?.parentElement) el.parentElement.scrollTop = el.offsetTop - 120;
      }, 60);
    } catch (e) {
      setFetchError(errorText(e));
    } finally {
      setFetching(false);
    }
  }

  async function runCheck() {
    if (!proof || logIndex === undefined || !walletValid || !targetValid || !thresholdValid) return;
    const id = ++reqId.current;
    setChecking(true);
    setCheckError(undefined);
    try {
      const block = await client.getBlockNumber();
      const [breach, amount, reason] = (await client.readContract({
        ...manager,
        functionName: "previewPredicate",
        args: [kind, BigInt(chainKey), (kind === 0 ? ZERO : target) as Address, BigInt(threshold || "0"), wallet as Address, proof.proof.txBytes, BigInt(logIndex)],
        blockNumber: block
      })) as [boolean, bigint, string];
      if (id !== reqId.current) return;
      setCheck({ breach, amount, reason, wallet, logIndex, block });
      setArmed(true);
    } catch (e) {
      if (id === reqId.current) setCheckError(errorText(e));
    } finally {
      if (id === reqId.current) setChecking(false);
    }
  }

  // After the first check, re-run it whenever the inputs change so edits show their verdict immediately.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(runCheck, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, logIndex, kind, target, threshold]);

  const selectedLog = decoded && logIndex !== undefined ? decoded.logs[logIndex] : undefined;
  const debtAsset = selectedLog && selectedLog.topics[0]?.toLowerCase() === LIQUIDATION_TOPIC0 ? `0x${selectedLog.topics[2].slice(-40)}` : undefined;
  const liquidatedUser = selectedLog && selectedLog.topics[0]?.toLowerCase() === LIQUIDATION_TOPIC0 ? `0x${selectedLog.topics[3].slice(-40)}` : undefined;
  const src = sourceChain(chainKey);
  const stale = check && (check.wallet !== wallet || check.logIndex !== logIndex);

  const verdict = useMemo(() => {
    if (!check) return null;
    if (check.breach)
      return {
        seal: <Seal word="BREACH PROVEN" ring="VERIFIED ON CREDITCOIN • NO ORACLE • " variant="proven" size={176} />,
        title: "Breach proven",
        body: (
          <>
            This log shows <AddrLink addr={check.wallet} href={`${src.explorer}/address/${check.wallet}`} /> broke a {KIND_NAME[kind].toLowerCase()} covenant.
            Amount {debtAsset ? tokenAmount(debtAsset, check.amount) : `${check.amount.toLocaleString("en-US")} base units`}. A line pledging this covenant over
            this wallet would freeze, and the reporter would take the bounty.
          </>
        )
      };
    return {
      seal: <Seal word="NO BREACH" ring="CHECKED ON CREDITCOIN • NO ORACLE • " variant="clear" size={176} />,
      title: `No breach: ${check.reason || "predicate not met"}`,
      body: (
        <>
          The contract read the same proven log for <AddrLink addr={check.wallet} href={`${src.explorer}/address/${check.wallet}`} /> and found nothing to
          report. {check.reason === "wrong wallet" && liquidatedUser ? <>The liquidated account in this log is <span className="mono">{short(liquidatedUser)}</span>.</> : null}
        </>
      )
    };
  }, [check, kind, debtAsset, liquidatedUser, src.explorer]);

  return (
    <section className="page verify">
      <header className="page-head">
        <h1 className="page-title">Check a real Ethereum liquidation against a covenant</h1>
        <p className="page-lede">
          No wallet, no gas. The browser fetches an Attestcoin proof, decodes the receipt, and asks the deployed manager contract whether the log
          breaks a covenant.
        </p>
      </header>

      <div className="verify-grid">
        <Certificate tight className="verify-form">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onFetch();
            }}
          >
            <h2 className="block-title">
              <span className="step-num inline">i</span> The transaction
            </h2>
            <div className="field-row">
              <label className="field narrow">
                <span>Source chain</span>
                <select value={chainKey} onChange={(e) => setChainKey(Number(e.target.value))}>
                  <option value={3}>Ethereum mainnet</option>
                  <option value={1}>Ethereum Sepolia</option>
                </select>
              </label>
              <label className="field grow">
                <span>Transaction hash</span>
                <input className="mono" value={tx} onChange={(e) => setTx(e.target.value.trim())} spellCheck={false} aria-invalid={!txValid} />
              </label>
            </div>
            <div className="form-actions">
              <button className="btn-primary" type="submit" disabled={!txValid || fetching}>
                {fetching ? "Fetching proof…" : "Fetch proof"}
              </button>
              {txValid && src.explorer && (
                <ExtLink href={`${src.explorer}/tx/${tx}`}>View on {src.name === "Ethereum mainnet" ? "Etherscan" : "Sepolia Etherscan"}</ExtLink>
              )}
            </div>
            {fetchError && (
              <p className="error-note" role="alert">
                <strong>No proof.</strong> {fetchError}
              </p>
            )}
          </form>

          {proof && decoded && (
            <div className="proof-block">
              <div className="proof-head">
                <Rosette seed={proof.proof.merkleProof.root} size={96} interactive={false} />
                <dl className="spec compact">
                  <div>
                    <dt>Proof</dt>
                    <dd>
                      {proof.source === "live" ? (
                        <span className="tag tag-live">Live from the proof service</span>
                      ) : (
                        <span className="tag tag-cached" title={proof.liveError}>
                          Cached proof
                        </span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Block</dt>
                    <dd>
                      <ExtLink href={`${src.explorer}/block/${proof.proof.headerNumber}`}>{proof.proof.headerNumber.toLocaleString("en-US")}</ExtLink>, tx {proof.proof.txIndex}
                    </dd>
                  </div>
                  <div>
                    <dt>Merkle root</dt>
                    <dd className="mono">{short(proof.proof.merkleProof.root, 10, 8)}</dd>
                  </div>
                  <div>
                    <dt>Path</dt>
                    <dd>
                      {proof.proof.merkleProof.siblings.length} siblings, {proof.proof.continuityProof.roots.length} continuity roots
                    </dd>
                  </div>
                </dl>
              </div>
              {proof.source === "cached" && <p className="fine">Live fetch failed ({proof.liveError}). Using the proof bundled with the app for this transaction.</p>}

              <h2 className="block-title">
                <span className="step-num inline">ii</span> Receipt logs, decoded in the browser
              </h2>
              <p className="fine">
                {decoded.logs.length} logs, receipt status {decoded.status === 1 ? "success" : "failed"}. Pick the log to test.
              </p>
              <div className="logs" role="radiogroup" aria-label="Receipt logs">
                {decoded.logs.map((l, i) => {
                  const name = TOPIC_NAMES[l.topics[0]?.toLowerCase() ?? ""] ?? "Unlabelled event";
                  return (
                    <label key={i} className={`log-row${logIndex === i ? " on" : ""}${l.topics[0]?.toLowerCase() === LIQUIDATION_TOPIC0 ? " liq" : ""}`}>
                      <input type="radio" name="log" checked={logIndex === i} onChange={() => setLogIndex(i)} />
                      <span className="log-i">{i}</span>
                      <span className="log-name">{name}</span>
                      <span className="log-addr mono">{short(l.address, 6, 4)}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </Certificate>

        <Certificate tight className="verify-check">
          <h2 className="block-title">
            <span className="step-num inline">iii</span> The covenant
          </h2>
          <fieldset disabled={!proof} className="check-fields">
            <label className="field">
              <span>Wallet under covenant</span>
              <input className="mono" value={wallet} onChange={(e) => setWallet(e.target.value.trim())} spellCheck={false} aria-invalid={!walletValid} />
            </label>
            <label className="field">
              <span>Covenant</span>
              <select value={kind} onChange={(e) => setKind(Number(e.target.value))}>
                {KIND_NAME.map((k, i) => (
                  <option key={k} value={i}>
                    {k} ({KIND_CODE[i]})
                  </option>
                ))}
              </select>
            </label>
            {kind !== 0 && (
              <div className="field-row">
                <label className="field grow">
                  <span>{kind === 1 ? "Debt asset" : "Pledged token"}</span>
                  <input className="mono" value={target} onChange={(e) => setTarget(e.target.value.trim())} placeholder="0x…" aria-invalid={!targetValid} />
                </label>
                <label className="field narrow">
                  <span>Threshold, base units</span>
                  <input className="mono" value={threshold} onChange={(e) => setThreshold(e.target.value.trim())} inputMode="numeric" aria-invalid={!thresholdValid} />
                </label>
              </div>
            )}
            <button type="button" className="btn-primary" onClick={() => void runCheck()} disabled={!proof || checking || !walletValid || !targetValid || !thresholdValid}>
              {checking ? "Asking the contract…" : "Check against covenant"}
            </button>
          </fieldset>
          {!proof && <p className="fine">Fetch the proof first.</p>}
          {!walletValid && <p className="fine warn">Enter a full 0x wallet address.</p>}

          <div className={`verdict${check ? (check.breach ? " proven" : " clear") : ""}${stale || checking ? " stale" : ""}`} aria-live="polite">
            {checkError && (
              <p className="error-note" role="alert">
                <strong>The contract call failed.</strong> {checkError}
              </p>
            )}
            {verdict ? (
              <>
                <div className="verdict-seal">{verdict.seal}</div>
                <h3 className="verdict-title">{verdict.title}</h3>
                <p>{verdict.body}</p>
                <p className="fine">
                  <span className="mono">previewPredicate</span> on <AddrLink addr={manager.address} />, Creditcoin block {check!.block.toString()}. Log {check!.logIndex}.
                  Try another wallet: the verdict updates as you type.
                </p>
              </>
            ) : (
              !checkError && <p className="verdict-empty">The verdict from the contract appears here.</p>
            )}
          </div>
        </Certificate>
      </div>
    </section>
  );
}
