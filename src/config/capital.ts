type CapitalSource = 'rpc_usdc' | 'static';

interface CapitalConfig {
  source: CapitalSource;
  refreshIntervalMs: number;
  fallbackDollars: number;
}

export const DEFAULT_CAPITAL_CONFIG: CapitalConfig = {
  source: 'rpc_usdc',
  refreshIntervalMs: 60000,
  fallbackDollars: 0
};
