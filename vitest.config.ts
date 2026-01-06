import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/main.ts',
        'src/**/index.ts',
        'src/config/rpc.ts',
        'src/services/PolymarketClob.ts',
        'src/services/PolymarketRealtime.ts',
        'src/services/PolygonRpc.ts',
        'src/services/MarketCatalog.ts',
        'src/agents/market-data/**',
        'src/agents/scanner/**',
        'src/agents/learning/**',
        'src/core/Supervisor.ts',
        'src/venues/**',
        'src/domain/types.ts',
        'src/domain/venue.ts',
        'src/domain/portfolio.ts',
        'src/domain/incident.ts',
        'src/telemetry/events.ts'
      ],
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 95,
        branches: 95
      }
    }
  }
});
