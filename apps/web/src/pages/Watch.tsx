import { useMemo } from "react";
import { AddrLink, Certificate, ErrorNote, ExtLink, Loading } from "../components/bits";
import { ccTx } from "../lib/chain";
import { useBlockTimes, useManagerEvents } from "../lib/hooks";
import { amt, dateTime, short } from "../lib/format";

const COMMANDS: { cmd: string; what: string }[] = [
  { cmd: "export COVENANT_PRIVATE_KEY=0x…   # Creditcoin testnet key holding a little tCTC for gas", what: "Set the reporter key" },
  { cmd: "node packages/cli/src/cli.mjs status <lineId>", what: "Read a line and its covenants" },
  {
    cmd: "node packages/cli/src/cli.mjs predicate cross-default 3 0xde092a220313cede58750434b66d46b5ff494cbb 0xec0b8f78036c679ed61d1a3ec1a6d4f733c4a306bfc0b6253cf4e02752883b07",
    what: "Dry-run a covenant against a real mainnet liquidation"
  },
  { cmd: "node packages/cli/src/cli.mjs breach <lineId> <termIndex> <sourceTxHash>", what: "Report a breach and collect the bounty" },
  { cmd: "node packages/cli/src/cli.mjs cure <lineId> <sourceTxHash>", what: "Borrower cures with a proven repayment" },
  { cmd: "node packages/cli/src/cli.mjs default <lineId>", what: "Settle a default once grace has elapsed" }
];

const FEED = ["CovenantBreached", "GraceStarted", "LineCured", "LineDefaulted"];

function Feed() {
  const { events, error, loading, retry, head } = useManagerEvents();
  const list = useMemo(() => events.filter((e) => FEED.includes(e.eventName)).reverse(), [events]);
  const times = useBlockTimes(useMemo(() => [...new Set(list.map((e) => e.blockNumber))], [list]));
  if (error && events.length === 0) return <ErrorNote error={error} onRetry={retry} what="breach events" />;
  if (loading && events.length === 0) return <Loading what="breach events" />;
  return (
    <>
      <p className="fine" aria-live="polite">
        Listening to the manager contract{head ? `, synced to block ${head}` : ""}. {error ? "The last poll failed and will retry." : ""}
      </p>
      {list.length === 0 ? (
        <p className="empty">No breaches reported yet. The first watcher to prove one takes the bounty.</p>
      ) : (
        <ol className="feed">
          {list.map((e) => {
            const a = e.args;
            const ts = times.get(e.blockNumber);
            let text: React.ReactNode;
            if (e.eventName === "CovenantBreached")
              text = (
                <>
                  <b>Breach proven</b> on <a href={`#/ledger/${a.lineId}`}>line {String(a.lineId)}</a>, term {String(a.termIndex)}. Reporter{" "}
                  <AddrLink addr={a.reporter as string} /> paid {amt(a.bounty as bigint)} wCTC.
                </>
              );
            else if (e.eventName === "GraceStarted")
              text = (
                <>
                  <b>Line {String(a.lineId)} frozen</b> until {dateTime(Number(a.graceEnds))}.
                </>
              );
            else if (e.eventName === "LineCured")
              text = (
                <>
                  <b>Line {String(a.lineId)} cured</b> {a.byProof ? "with a proven repayment" : "by repayment"}.
                </>
              );
            else
              text = (
                <>
                  <b>Line {String(a.lineId)} defaulted.</b> {amt(a.recovered as bigint)} wCTC recovered for lenders.
                </>
              );
            return (
              <li key={`${e.txHash}-${e.logIndex}`} className={`feed-row feed-${e.eventName}`}>
                <span className="feed-when">{ts ? dateTime(ts) : `Block ${e.blockNumber}`}</span>
                <span className="feed-text">{text}</span>
                <ExtLink href={ccTx(e.txHash)} title={e.txHash}>
                  <span className="mono">{short(e.txHash, 8, 6)}</span>
                </ExtLink>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

export function Watch() {
  return (
    <section className="page">
      <header className="page-head">
        <h1 className="page-title">Watch the covenants</h1>
        <p className="page-lede">
          A breach is worth 10% of the borrower's bond to whoever proves it first. Watching needs no permission: follow the linked wallets on
          Ethereum, fetch a proof, submit it.
        </p>
      </header>
      <div className="two-col watch-cols">
        <Certificate tight>
          <h2 className="block-title">Run a watcher</h2>
          <p>
            From the repository root, with Node 20 or later and <span className="mono">pnpm install</span> done:
          </p>
          <ol className="commands">
            {COMMANDS.map((c) => (
              <li key={c.cmd}>
                <p>{c.what}</p>
                <pre>
                  <code>{c.cmd}</code>
                </pre>
              </li>
            ))}
          </ol>
          <p className="fine">
            The CLI fetches the inclusion proof from the{" "}
            <ExtLink href="https://proof-gen-api.cc3-testnet.creditcoin.network">Attestcoin proof service</ExtLink>, finds the offending log
            in the receipt and submits it to the manager.
          </p>
        </Certificate>
        <Certificate tight>
          <h2 className="block-title">Breach feed</h2>
          <Feed />
        </Certificate>
      </div>
    </section>
  );
}
