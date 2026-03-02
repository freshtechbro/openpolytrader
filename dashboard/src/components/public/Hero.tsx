import { Link } from 'react-router-dom';

interface HeroAction {
  to: string;
  label: string;
  variant?: 'primary' | 'ghost';
}

interface HeroProps {
  eyebrow: string;
  title: string;
  lead: string;
  actions: HeroAction[];
}

export function Hero({ eyebrow, title, lead, actions }: HeroProps) {
  return (
    <section className="landing-hero">
      <div className="landing-hero__content">
        <p className="hero__eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="hero__lead">{lead}</p>
        <div className="landing-hero__actions">
          {actions.map((action) => (
            <Link
              key={action.to}
              to={action.to}
              className={action.variant === 'ghost' ? 'button-link button-link--ghost' : 'button-link'}
            >
              {action.label}
            </Link>
          ))}
        </div>
      </div>
      <aside className="landing-hero__panel">
        <p className="label">Execution loop</p>
        <ol className="landing-hero__steps">
          <li>Signal scores market state in real time.</li>
          <li>Risk gate checks edge, depth, and freshness.</li>
          <li>Execution submits single-shot, guarded orders.</li>
          <li>Portfolio reconciles fills and drift.</li>
        </ol>
      </aside>
    </section>
  );
}
