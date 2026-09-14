import { Certificate, ExtLink } from "../components/bits";
import { Rosette } from "../components/Rosette";
import { Nav } from "../components/Nav";
import { client, manager } from "../lib/chain";
import { useAsync } from "../lib/hooks";
import { mult } from "../lib/format";

const LIQUIDATION_TX = "0xec0b8f78036c679ed61d1a3ec1a6d4f733c4a306bfc0b6253cf4e02752883b07";

function StepPledge() {
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <g fill="none" stroke="#232B1C" strokeWidth="1">
        <path d="M30 22 h52 l8 8 v68 h-60 z" />
        <path d="M82 22 v8 h8" />
        {[40, 48, 56, 64].map((y) => (
          <line key={y} x1="40" y1={y} x2={y === 64 ? 66 : 80} y2={y} strokeWidth="0.7" />
        ))}
        {Array.from({ length: 9 }, (_, i) => (
          <line key={i} x1={34 + i * 6} y1="98" x2={30 + i * 6} y2="104" strokeWidth="0.5" />
        ))}
      </g>
      <circle cx="78" cy="84" r="13" fill="#7A2331" />
      <circle cx="78" cy="84" r="10" fill="none" stroke="#F2ECD9" strokeWidth="0.8" />
      <path d="M72 84 l4 4 l8 -8" fill="none" stroke="#F2ECD9" strokeWidth="1.4" />
    </svg>
  );
}

function StepProve() {
  const nodes = [
    [60, 26],
    [36, 54],
    [84, 54],
    [24, 84],
    [48, 84],
    [72, 84],
    [96, 84]
  ];
  const path = new Set([0, 2, 5]);
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <g stroke="#9C8F63" strokeWidth="0.9">
        <line x1="60" y1="26" x2="36" y2="54" />
        <line x1="60" y1="26" x2="84" y2="54" stroke="#1F5C42" strokeWidth="1.6" />
        <line x1="36" y1="54" x2="24" y2="84" />
        <line x1="36" y1="54" x2="48" y2="84" />
        <line x1="84" y1="54" x2="72" y2="84" stroke="#1F5C42" strokeWidth="1.6" />
        <line x1="84" y1="54" x2="96" y2="84" />
      </g>
      {nodes.map(([x, y], i) => (
        <rect
          key={i}
          x={x - 6}
          y={y - 6}
          width="12"
          height="12"
          fill={path.has(i) ? "#1F5C42" : "#F2ECD9"}
          stroke={path.has(i) ? "#1F5C42" : "#3C4A32"}
          strokeWidth="1"
          transform={`rotate(45 ${x} ${y})`}
        />
      ))}
      <path d="M72 96 v10 M68 102 l4 4 l4 -4" fill="none" stroke="#7A2331" strokeWidth="1.1" />
      <text x="60" y="16" textAnchor="middle" fontFamily="'EB Garamond', serif" fontSize="8.5" fill="#5F6B4A" fontStyle="italic">
        attested root
      </text>
    </svg>
  );
}

function StepFreeze() {
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <g fill="none" stroke="#232B1C" strokeWidth="1">
        <circle cx="46" cy="60" r="28" />
        <circle cx="46" cy="60" r="23" strokeWidth="0.6" strokeDasharray="1.4 1.8" />
        <path d="M38 56 v-6 a8 8 0 0 1 16 0 v6" strokeWidth="1.3" />
        <rect x="34" y="56" width="24" height="17" fill="#232B1C" />
      </g>
      <circle cx="46" cy="64" r="2.2" fill="#F2ECD9" />
      <path d="M76 60 h14" stroke="#7A2331" strokeWidth="1.1" />
      <path d="M86 56 l4 4 l-4 4" fill="none" stroke="#7A2331" strokeWidth="1.1" />
      <circle cx="100" cy="60" r="9" fill="#F2ECD9" stroke="#7A2331" strokeWidth="1.2" />
      <circle cx="100" cy="60" r="6" fill="none" stroke="#7A2331" strokeWidth="0.6" />
      <text x="100" y="63" textAnchor="middle" fontFamily="'Cormorant SC', serif" fontSize="8" fontWeight="700" fill="#7A2331">
        10%
      </text>
    </svg>
  );
}

const STEPS = [
  {
    art: <StepPledge />,
    title: "Pledge covenants",
    body: "The borrower posts a bond in wrapped tCTC and signs terms over their Ethereum wallet: no Aave liquidation, a borrowing cap, no large outflows."
  },
  {
    art: <StepProve />,
    title: "Anyone proves a breach on Ethereum",
    body: "A watcher submits the offending Ethereum transaction with a Merkle inclusion proof and a continuity proof. Creditcoin's native precompile checks both."
  },
  {
    art: <StepFreeze />,
    title: "The line freezes and the reporter is paid",
    body: "Drawing stops at once and the reporter takes 10% of the bond. The borrower can cure by proving a repayment; after the grace period the bond goes to lenders."
  }
];

function LeverageLadder() {
  const { data, error } = useAsync(async () => {
    const read = (functionName: string) => client.readContract({ ...manager, functionName }) as Promise<bigint>;
    const [cd, dc, np, hist, maxHist, maxLev] = await Promise.all([
      read("WEIGHT_CROSS_DEFAULT"),
      read("WEIGHT_DEBT_CAP"),
      read("WEIGHT_NEGATIVE_PLEDGE"),
      read("HISTORY_BOOST_PER_REPAY"),
      read("MAX_HISTORY_REPAYS"),
      read("maxLeverageBps")
    ]);
    return { cd, dc, np, hist, maxHist, maxLev };
  }, []);

  if (error) return null;
  if (!data) return <div className="ladder ladder-pending" aria-busy="true" />;
  const rows = [
    { label: "Bond, posted in wrapped tCTC", value: "1x", strong: true },
    { label: "Cross-default: never liquidated on Aave V3", value: `+${mult(data.cd)}` },
    { label: "Debt cap: never borrow above a set amount", value: `+${mult(data.dc)}` },
    { label: "Negative pledge: never move a token out past a limit", value: `+${mult(data.np)}` },
    { label: `Each proven Aave repayment, up to ${data.maxHist.toString()}`, value: `+${mult(data.hist)}` }
  ];
  return (
    <div className="ladder">
      {rows.map((r) => (
        <div className={`ladder-row${r.strong ? " strong" : ""}`} key={r.label}>
          <span>{r.label}</span>
          <span className="leader" aria-hidden="true" />
          <span className="val">{r.value}</span>
        </div>
      ))}
      <div className="ladder-row cap">
        <span>Hard cap on any line</span>
        <span className="leader" aria-hidden="true" />
        <span className="val">{mult(data.maxLev)}</span>
      </div>
      <p className="fine">Read live from the manager contract.</p>
    </div>
  );
}

export function Landing() {
  return (
    <div className="landing">
      <section className="hero">
        <Certificate className="hero-frame">
          <Nav />
          <Rosette seed={LIQUIDATION_TX} size={212} />
          <p className="instrument-no">Series CC, instrument 102031, issued on Creditcoin testnet</p>
          <h1 className="hero-title">Collateral buys 1x. Covenants buy the rest.</h1>
          <p className="hero-sub">
            A credit report anyone can write to. Borrowers pledge how their Ethereum wallet will behave; anyone who proves otherwise
            freezes the line and is paid for it.
          </p>
          <div className="cta-row">
            <a className="btn-primary" href="#/ledger">
              Open the ledger
            </a>
            <a
              className="btn-secondary"
              href="#/"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById("how")?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              How breaches are proven
            </a>
          </div>
          <div className="legend">
            <span>Cross-default, debt cap, negative pledge</span>
            <span>Proofs checked by a native precompile, no oracle</span>
          </div>
        </Certificate>
      </section>

      <section className="how" id="how" aria-labelledby="how-title">
        <h2 id="how-title" className="section-title">
          How a breach is proven
        </h2>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li className="step" key={s.title}>
              <div className="step-art">
                <span className="step-num">{["i", "ii", "iii"][i]}</span>
                {s.art}
              </div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="how-cta">
          Try it on a real mainnet liquidation: <a href="#/verify">check block 25,967,341 against a covenant</a>, no wallet and no gas.
        </p>
      </section>

      <section className="attest" aria-labelledby="attest-title">
        <div className="attest-copy">
          <h2 id="attest-title" className="section-title left">
            Built on the Attestcoin Protocol
          </h2>
          <p>
            Creditcoin attests Ethereum block headers and exposes a verifier as a precompile. A proof is two parts: a Merkle path showing
            the transaction sits in an attested block, and a continuity proof chaining that block to an attested checkpoint.
          </p>
          <p>
            Covenant decodes the receipt on-chain and matches the log against the pledged terms. There is no price feed, no committee and
            no keeper who can be bribed to look away. If the transaction happened, the contract can see it.
          </p>
          <dl className="spec">
            <div>
              <dt>Verifier</dt>
              <dd>
                BlockProver precompile <span className="mono">0x…0FD2</span>
              </dd>
            </div>
            <div>
              <dt>Headers</dt>
              <dd>
                ChainInfo precompile <span className="mono">0x…0FD3</span>
              </dd>
            </div>
            <div>
              <dt>Sources</dt>
              <dd>Ethereum Sepolia and Ethereum mainnet</dd>
            </div>
            <div>
              <dt>Proof service</dt>
              <dd>
                <ExtLink href="https://proof-gen-api.cc3-testnet.creditcoin.network">proof-gen-api.cc3-testnet</ExtLink>
              </dd>
            </div>
          </dl>
        </div>
        <div className="attest-ladder">
          <h3 className="ladder-title">What a line can borrow, per unit of bond</h3>
          <LeverageLadder />
        </div>
      </section>
    </div>
  );
}
