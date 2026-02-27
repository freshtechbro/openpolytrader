const TRUST_ITEMS = [
  { label: 'Agent Pipeline', value: '8 specialized agents' },
  { label: 'Risk Discipline', value: 'Near-zero by design' },
  { label: 'State Model', value: 'Event-sourced ledger' },
  { label: 'Quality Bar', value: '>97% coverage target' }
] as const;

export function TrustStrip() {
  return (
    <section className="trust-strip" aria-label="Trust signals">
      {TRUST_ITEMS.map((item) => (
        <article key={item.label} className="trust-strip__item">
          <p className="trust-strip__label">{item.label}</p>
          <p className="trust-strip__value">{item.value}</p>
        </article>
      ))}
    </section>
  );
}
