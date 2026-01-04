interface MetricCardProps {
  title: string;
  value: number | string;
}

export function MetricCard({ title, value }: MetricCardProps) {
  const displayValue = typeof value === 'number' ? value.toLocaleString() : value;
  return (
    <div className="metric-card">
      <p className="metric-card__title">{title}</p>
      <p className="metric-card__value">{displayValue}</p>
    </div>
  );
}
