const RISK_PILLARS = [
  {
    title: 'Explicit kill controls',
    description: 'Trading mode and enable flags are always visible in ops surfaces.'
  },
  {
    title: 'Single-shot execution',
    description: 'No blind retries without fresh market state validation.'
  },
  {
    title: 'Circuit and quarantine',
    description: 'Incident thresholds isolate unstable markets before they cascade.'
  },
  {
    title: 'Live telemetry',
    description: 'SLO, incident, and decision streams are continuously inspectable.'
  }
] as const;

export function RiskPillars() {
  return (
    <section className="section section--landing">
      <div className="section__header">
        <h2>Risk-first operating model</h2>
        <p>The system is optimized to reject bad opportunities faster than it can trade them.</p>
      </div>
      <div className="landing-pillars">
        {RISK_PILLARS.map((pillar) => (
          <article key={pillar.title} className="landing-pillars__item">
            <h3>{pillar.title}</h3>
            <p>{pillar.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
