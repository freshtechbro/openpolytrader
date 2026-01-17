import type { ReactNode } from 'react';

interface PanelProps {
  title: ReactNode;
  body: ReactNode;
  accent?: 'signal' | 'alert' | 'neutral';
}

export function Panel({ title, body, accent = 'neutral' }: PanelProps) {
  const label = accent === 'signal' ? 'Signal' : accent === 'alert' ? 'Alert' : 'Neutral';
  return (
    <div className={`panel panel--${accent}`}>
      <div className="panel__header">
        <h3>{title}</h3>
        <span className="panel__label">{label}</span>
      </div>
      <div className="panel__body">{body}</div>
    </div>
  );
}
