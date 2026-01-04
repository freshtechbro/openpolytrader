import { useEffect, useState } from 'react';
import { MetricsTable } from '../components/MetricsTable';
import { Panel } from '../components/Panel';
import { Section } from '../components/Section';

interface PortfolioSnapshot {
  totalCapital: number;
  availableCapital: number;
  dailyPnL: number;
  marketExposure: Record<string, number>;
}

export function Positions() {
  const [portfolio, setPortfolio] = useState<PortfolioSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchPortfolio = async () => {
      try {
        const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
        const token = import.meta.env.VITE_OPS_TOKEN || '';
        const headers: Record<string, string> = {};
        if (token) headers['x-ops-token'] = token;

        const res = await fetch(`${baseUrl}/portfolio`, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setPortfolio(data);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to fetch portfolio');
      } finally {
        setLoading(false);
      }
    };

    fetchPortfolio();
    const interval = setInterval(fetchPortfolio, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <Section title="Positions" subtitle="Loading portfolio data...">
        <Panel title="Portfolio" body={<p>Loading...</p>} />
      </Section>
    );
  }

  if (error) {
    return (
      <Section title="Positions" subtitle="Portfolio snapshot">
        <Panel title="Error" body={<p style={{ color: 'var(--color-error)' }}>{error}</p>} />
      </Section>
    );
  }

  if (!portfolio) {
    return (
      <Section title="Positions" subtitle="Portfolio snapshot">
        <Panel title="Portfolio" body={<p>No portfolio data available</p>} />
      </Section>
    );
  }

  const summaryRows: Array<Array<string | number>> = [
    ['Total Capital', `$${portfolio.totalCapital.toFixed(2)}`],
    ['Available Capital', `$${portfolio.availableCapital.toFixed(2)}`],
    ['Daily PnL', `$${portfolio.dailyPnL.toFixed(2)}`],
  ];

  const exposureRows: Array<Array<string | number>> = Object.entries(portfolio.marketExposure).map(([market, exposure]) => [
    market.length > 16 ? market.slice(0, 16) + '...' : market,
    `$${exposure.toFixed(2)}`,
  ]);

  return (
    <>
      <Section title="Positions" subtitle="Portfolio snapshot">
        <MetricsTable columns={['Metric', 'Value']} rows={summaryRows} />
      </Section>
      {exposureRows.length > 0 && (
        <Section title="Market Exposure" subtitle="Notional by market">
          <MetricsTable columns={['Market', 'Exposure']} rows={exposureRows} />
        </Section>
      )}
    </>
  );
}
