import { CircuitBreakerRegistry } from './CircuitBreaker.js';
import type { TradePolicy } from '../config/policy.js';
import type { RiskConfig } from '../config/risk.js';
import type { TradingMode } from '../config/env.js';
import type { MarketPair } from '../domain/market.js';
import { MarketDataAgent } from '../agents/market-data/MarketDataAgent.js';
import { ScannerAgent } from '../agents/scanner/ScannerAgent.js';
import { RiskAgent } from '../agents/risk/RiskAgent.js';
import { ExecutionAgent } from '../agents/execution/ExecutionAgent.js';
import type { AgentLlmConfig, AgentPolicyHashes } from '../services/llm/AgentLlm.js';
import type { LLMAgentId } from '../services/llm/types.js';
import type { SupervisorAssembly, SupervisorConfig, SupervisorDeps } from './Supervisor.js';

export type SupervisorPolicyHashes = AgentPolicyHashes;

export interface SupervisorLLMContext extends AgentLlmConfig<LLMAgentId> {}

interface BuildSupervisorRuntimeConfigInput {
  marketPairs: MarketPair[];
  policy: TradePolicy;
  riskConfig: RiskConfig;
  capital: number;
  tradingEnabled: boolean;
  tradingMode: TradingMode;
  maxConcurrentMarkets: number;
  maxCapitalInFlight: number;
  bookRefresh: {
    intervalMs: number;
    maxStalenessMs: number;
  };
  reconciliation: {
    intervalMs: number;
    afterIncidentDelayMs: number;
    positionSizeTolerance: number;
    positionsUser?: string;
    positionsSizeThreshold: number;
    positionsLimit: number;
    positionsOffset: number;
  };
}

export function buildSupervisorRuntimeConfig(input: BuildSupervisorRuntimeConfigInput): SupervisorConfig {
  return {
    marketPairs: input.marketPairs,
    policy: input.policy,
    riskConfig: input.riskConfig,
    capital: input.capital,
    tradingEnabled: input.tradingEnabled,
    tradingMode: input.tradingMode,
    maxConcurrentMarkets: input.maxConcurrentMarkets,
    maxCapitalInFlight: input.maxCapitalInFlight,
    bookRefresh: input.bookRefresh,
    reconciliation: input.reconciliation
  };
}

export function buildRuntimeSupervisorAssembly(
  config: SupervisorConfig,
  deps: SupervisorDeps
): SupervisorAssembly {
  const marketCircuitBreakers = new CircuitBreakerRegistry(
    {
      failureThreshold: config.riskConfig.marketCircuitFailureThreshold,
      cooldownMs: config.riskConfig.marketCooldownSeconds * 1000,
      halfOpenSuccesses: config.riskConfig.marketCircuitHalfOpenSuccesses
    },
    'market'
  );

  return {
    marketCircuitBreakers,
    marketData: new MarketDataAgent(
      {
        tokenIds: config.marketPairs.flatMap((pair) => [pair.yesTokenId, pair.noTokenId]),
        policy: config.policy,
        metrics: deps.metrics,
        messageBus: deps.messageBus,
        eventStore: deps.eventStore,
        llm: deps.llm
      },
      deps.clob,
      deps.realtime
    ),
    scanner: new ScannerAgent(
      config.policy,
      deps.allowlist,
      {
        tradingMode: config.tradingMode,
        metrics: deps.metrics,
        messageBus: deps.messageBus,
        eventStore: deps.eventStore,
        fwProjectionAgent: deps.fwProjectionAgent,
        llm: deps.llm
      }
    ),
    risk: new RiskAgent(
      config.riskConfig,
      {
        maxOpenInventorySeconds: config.policy.maxOpenInventorySeconds,
        fallbackTickSize: config.policy.fallbackTickSize,
        depthBufferMultiplier: config.policy.depthBufferMultiplier,
        evMaxPerMarketNotional: config.policy.evMaxPerMarketNotional,
        evMaxPortfolioNotional: config.policy.evMaxPortfolioNotional,
        fwMaxPerMarketNotional: config.policy.fwMaxPerMarketNotional,
        fwMaxPortfolioNotional: config.policy.fwMaxPortfolioNotional
      },
      { advisor: deps.riskAdvisor }
    ),
    execution: new ExecutionAgent(
      config.policy,
      deps.clob,
      deps.incidentTracker,
      deps.metrics,
      {
        tradingEnabled: config.tradingEnabled,
        tradingMode: config.tradingMode,
        messageBus: deps.messageBus,
        eventStore: deps.eventStore,
        riskConfig: config.riskConfig,
        portfolio: deps.portfolio,
        userRealtime: deps.userRealtime,
        circuitBreakers: marketCircuitBreakers,
        executionAdvisor: deps.executionAdvisor,
        executionAdvisorMode: deps.llm?.config.agents.ExecutionAgent.mode ?? 'disabled'
      }
    )
  };
}
