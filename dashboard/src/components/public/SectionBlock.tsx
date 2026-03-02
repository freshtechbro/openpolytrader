import type { ReactNode } from 'react';

interface SectionBlockProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function SectionBlock({ title, description, children }: SectionBlockProps) {
  return (
    <section className="section-block">
      <header className="section-block__header">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </header>
      <div className="section-block__body">{children}</div>
    </section>
  );
}
