const NAV = [
  { href: "#/ledger", key: "ledger", label: "Ledger" },
  { href: "#/pool", key: "pool", label: "Pool" },
  { href: "#/verify", key: "verify", label: "Verify a breach" },
  { href: "#/watch", key: "watch", label: "Watch" }
];

export function Nav({ current }: { current?: string }) {
  return (
    <nav className="nav" aria-label="Primary">
      {NAV.map((n) => (
        <a key={n.key} href={n.href} aria-current={current === n.key ? "page" : undefined}>
          {n.label}
        </a>
      ))}
    </nav>
  );
}
