import { Section } from '../components/Section';
import { RiskConfigSettingsSection } from './risk-gates/RiskConfigSettingsSection';
import { RiskInfraSection } from './risk-gates/RiskInfraSection';
import { RiskProfilePanel, TradingModePanel } from './risk-gates/RiskProfilePanels';
import { riskProfileLabel } from './risk-gates/shared';
import { useRiskGatesController } from './risk-gates/useRiskGatesController';

export function RiskGates() {
  const controller = useRiskGatesController();

  return (
    <>
      <Section title="Risk Gates" subtitle="Phase 1 settings, trading mode, and gate controls.">
        <RiskProfilePanel section={controller.profileSection} />
        <TradingModePanel section={controller.tradingSection} />
      </Section>

      <RiskInfraSection section={controller.infraSection} />

      <RiskConfigSettingsSection section={controller.settingsSection} />
    </>
  );
}
