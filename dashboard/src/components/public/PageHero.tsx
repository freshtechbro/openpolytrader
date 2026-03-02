interface PageHeroProps {
  eyebrow: string;
  title: string;
  lead: string;
}

export function PageHero({ eyebrow, title, lead }: PageHeroProps) {
  return (
    <section className="page-hero">
      <p className="hero__eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="hero__lead">{lead}</p>
    </section>
  );
}
