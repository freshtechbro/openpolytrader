const PIPELINE_STAGES = [
  {
    title: 'Signal',
    description: 'Aggregates market and optional LLM advisory signals.'
  },
  {
    title: 'Scanner',
    description: 'Builds candidates from live books and market catalog constraints.'
  },
  {
    title: 'Risk',
    description: 'Applies strict gate checks before any execution path opens.'
  },
  {
    title: 'Execution',
    description: 'Submits guarded orders with deterministic timeout behavior.'
  },
  {
    title: 'Portfolio',
    description: 'Reconciles exposure, fills, and runtime drift in near real time.'
  }
] as const;

export function PipelineGrid() {
  return (
    <section className="section section--landing">
      <div className="section__header">
        <h2>Signal Grid pipeline</h2>
        <p>One control surface from signal detection to post-trade reconciliation.</p>
      </div>
      <div className="landing-grid">
        {PIPELINE_STAGES.map((stage) => (
          <article key={stage.title} className="landing-grid__card">
            <h3>{stage.title}</h3>
            <p>{stage.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
