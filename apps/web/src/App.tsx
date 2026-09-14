import { ADDR, ccAddress } from "./lib/chain";
import { useHashRoute, useManagerEvents } from "./lib/hooks";
import { Landing } from "./pages/Landing";
import { Ledger } from "./pages/Ledger";
import { PoolPage } from "./pages/Pool";
import { Verify } from "./pages/Verify";
import { Watch } from "./pages/Watch";
import { short } from "./lib/format";
import { Nav } from "./components/Nav";

function ChainStatus() {
  const { head, error, updatedAt } = useManagerEvents();
  if (error) return <span className="chain-status bad">RPC unreachable, retrying</span>;
  if (!head) return <span className="chain-status">Connecting to Creditcoin testnet</span>;
  return (
    <span className="chain-status ok" title={updatedAt ? new Date(updatedAt).toLocaleTimeString() : undefined}>
      Creditcoin testnet, block {head.toString()}
    </span>
  );
}

function Footer() {
  const rows: [string, string][] = [
    ["Covenant manager", ADDR.manager],
    ["Lending pool", ADDR.pool],
    ["Credit record", ADDR.record],
    ["Wrapped tCTC", ADDR.wctc]
  ];
  return (
    <footer className="site-footer">
      <div className="footer-grid">
        {rows.map(([k, v]) => (
          <p key={k}>
            <span className="sc">{k}</span>
            <a className="mono" href={ccAddress(v)} target="_blank" rel="noreferrer" title={v}>
              {short(v, 8, 6)}
            </a>
          </p>
        ))}
      </div>
      <p className="fine">
        Chain 102031. Every figure on these pages is read from the contracts above at view time; nothing is cached server-side.
      </p>
    </footer>
  );
}

export function App() {
  const route = useHashRoute();
  const page = route[0] ?? "";

  if (page === "") {
    return (
      <>
        <Landing />
        <Footer />
      </>
    );
  }

  let body;
  switch (page) {
    case "ledger":
      body = <Ledger lineId={route[1]} />;
      break;
    case "pool":
      body = <PoolPage />;
      break;
    case "verify":
      body = <Verify />;
      break;
    case "watch":
      body = <Watch />;
      break;
    default:
      body = (
        <section className="page">
          <h1 className="page-title">No such page</h1>
          <p>
            Return to the <a href="#/ledger">ledger</a>.
          </p>
        </section>
      );
  }

  return (
    <div className="app">
      <header className="masthead">
        <a className="wordmark" href="#/">
          <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true">
            <circle cx="32" cy="32" r="30" fill="#7A2331" />
            <circle cx="32" cy="32" r="26" fill="none" stroke="#F2ECD9" strokeWidth="1.2" />
            <g fill="none" stroke="#F2ECD9" strokeWidth="1">
              <ellipse cx="32" cy="32" rx="16" ry="6" />
              <ellipse cx="32" cy="32" rx="16" ry="6" transform="rotate(60 32 32)" />
              <ellipse cx="32" cy="32" rx="16" ry="6" transform="rotate(120 32 32)" />
            </g>
          </svg>
          <span>Covenant</span>
        </a>
        <Nav current={page} />
        <ChainStatus />
      </header>
      <main id="main">{body}</main>
      <Footer />
    </div>
  );
}
