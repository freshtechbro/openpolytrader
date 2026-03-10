import { Decisions } from '../pages/Decisions';
import { Incidents } from '../pages/Incidents';
import { Markets } from '../pages/Markets';
import {
  Overview,
  type AllowlistEntry,
  type FinalIntent,
  type HealthReport,
  type MetricsSnapshot,
  type OpsIncident,
  type SloAggregates
} from '../pages/Overview';
import { Positions } from '../pages/Positions';
import { RiskGates } from '../pages/RiskGates';
import type { OpsPage } from './opsLayoutUtils';

interface OpsLayoutContentProps {
  allowlist: AllowlistEntry[];
  currentPage: OpsPage;
  expanded: boolean;
  health: HealthReport | null;
  incidents: OpsIncident[];
  intents: FinalIntent[];
  metrics: MetricsSnapshot | null;
  onToggleExpanded: () => void;
  slo: SloAggregates | null;
}

export function OpsLayoutContent(props: OpsLayoutContentProps) {
  if (props.currentPage === 'markets') return <Markets allowlist={props.allowlist} />;
  if (props.currentPage === 'incidents') return <Incidents incidents={props.incidents} />;
  if (props.currentPage === 'positions') return <Positions />;
  if (props.currentPage === 'risk') return <RiskGates />;
  if (props.currentPage === 'decisions') return <Decisions />;
  return (
    <Overview
      health={props.health}
      metrics={props.metrics}
      slo={props.slo}
      intents={props.intents}
      incidents={props.incidents}
      expanded={props.expanded}
      onToggleExpanded={props.onToggleExpanded}
    />
  );
}
