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
        'dashboard/**',
        'src/main.ts',
        'src/boot/runtime.ts',
        'src/boot/fwOracle.ts',
        'src/boot/runtimeCatalog.ts',
        'src/boot/runtimeLifecycle.ts',
        'src/api/contracts.ts',
        'src/**/index.ts',
        'src/config/schemaTypes.ts',
        'src/config/venues.ts',
        'src/config/rpc.ts',
        'src/services/PolymarketClob.ts',
        'src/services/PolymarketRealtime.ts',
        'src/services/PolygonRpc.ts',
        'src/services/MarketCatalog.ts',
        'src/services/websearch/WebSearchClient.ts',
        'src/services/llm/types.ts',
        'src/core/EventStore.ts',
        'src/agents/dependency/DependencyResolver.ts',
        'src/agents/dependency/DependencyRelationCatalog.ts',
        'src/tools/dependencyRelationCatalog.ts',
        'src/agents/execution/ExecutionAgent.ts',
        'src/agents/market-data/**',
        'src/agents/projection/**',
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
        lines: 97.01,
        functions: 97.01,
        statements: 97.01,
        branches: 97.01
      }
    }
  }
});
