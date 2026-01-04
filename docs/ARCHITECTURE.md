# Architecture Document - Polymarket Arbitrage Bot

> **Status**: Draft. The canonical research + constraints (especially the execution/partial-fill caveat and strict market gating) are in `docs/RESEARCH_REPORT.md`. This file should be treated as an implementation sketch, not a profitability guarantee.


## Overview

High-frequency arbitrage bot for Polymarket CLOB on Polygon POS, designed for $1000 starting capital with continuous compounding.

### Success Criteria (CONDITIONAL)
- Detect candidate complete-set opportunities (YES+NO pricing inefficiency) within 50ms from a websocket update
- Execute **only when two-leg completion is extremely likely** (strict market/condition gating; reject delayed matching)
- Demonstrate positive realized PnL **after** slippage/execution failures and infra costs (measured in shadow mode first)
- Run 24/7 with high uptime and auto-recover from crashes without corrupting state

### System Constraints
- **Capital**: $1000 starting, deploy up to 80% per opportunity
- **Latency**: Polygon block time 2s >> RPC latency, optimize at application layer
- **Rate Limits**: CLOB API 3,500 req/10s burst, 9,000 req/10s overall
- **Cost**: $39/month infrastructure (3.9% of monthly capital)
- **Language**: TypeScript/Node.js (ecosystem > raw speed)
- **Storage**: SQLite (event sourcing, state persistence)

---

## Architecture Principles

1. **Latency Hierarchy**: Polygon block time (2s) >> network latency (50-100ms) >> application latency (1-10ms)
2. **Separation of Concerns**: Market data via CLOB WebSocket, execution via CLOB API, settlement via Polygon RPC
3. **Event-Driven**: All agents communicate via typed event bus
4. **State Persistence**: Every decision and state change logged to SQLite
5. **Idempotency**: All operations idempotent, replay-safe on crash recovery
6. **Graceful Degradation**: Provider fallback, circuit breakers, rate limiting

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        External Services                        │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Polymarket   │  │   Alchemy     │  │ QuickNode    │      │
│  │ CLOB WebSocket│  │  Polygon RPC │  │  (fallback)  │      │
│  │              │  │              │  │              │      │
│  │ - Market data│  │ - Settlement │  │ - Backup RPC │      │
│  │ - Orderbook  │  │ - Contracts  │  │ - Failover   │      │
│  │ - Trades     │  │ - Events     │  │              │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
└─────────┼──────────────────┼──────────────────┼───────────────┘
          │                  │                  │
          │ WSS              │ HTTPS/WebSocket  │ HTTPS/WebSocket
          │                  │                  │
┌─────────┼──────────────────┼──────────────────┼───────────────┐
│         │     ┌────────────▼──────────────────▼──────┐           │
│         │     │         Core Layer                     │           │
│         │     ├────────────────────────────────────────┤           │
│         │     │  • MessageBus (Typed Event Emitter)  │           │
│         │     │  • EventStore (SQLite Event Sourcing) │           │
│         │     │  • StateRebuilder (Crash Recovery)    │           │
│         │     │  • CircuitBreaker (Protection)        │           │
│         │     └────────────────────────────────────────┘           │
│         │                  │                                  │
│         │                  ▼                                  │
│         │     ┌────────────────────────────────────────┐         │
│         │     │     Agent Layer (7 Agents)             │         │
│         │     ├────────────────────────────────────────┤         │
│         │     │ 1. MarketDataAgent                    │         │
│         │     │2. ScannerAgent                        │         │
│         │     │3. RiskAgent                          │         │
│         │     │4. ExecutionAgent                     │         │
│         │     │5. PortfolioAgent                     │         │
│         │     │6. OpsAgent                           │         │
│         │     │7. LearningAgent                      │         │
│         │     └────────────────────────────────────────┘         │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐                                               │
│  │   Supervisor  │ ───────────────► Python (RL Training)          │
│  │   + Orch.    │                                               │
│  └──────────────┘                                               │
└──────────────────────────────────────────────────────────────────┘
```

---

## Component Details

### 1. Infrastructure Layer

#### 1.1 Market Data: Polymarket CLOB WebSocket

**Purpose**: Real-time market data streaming, orderbook updates, trade events

**Channels**:
- `market`: Orderbook changes, price updates, new markets
- `user`: Order status updates, trade confirmations

**Events**:
```typescript
interface MarketEvent {
  type: 'book' | 'price_change' | 'last_trade_price' | 'best_bid_ask' | 'new_market' | 'market_resolved';
  marketId: string;
  timestamp: number;
  data: BookData | PriceChange | TradePrice | BidAsk | NewMarket | MarketResolved;
}

interface BookData {
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
}

interface PriceChange {
  price: number;
  bestBid: number;
  bestAsk: number;
  tradeHashes: string[];
}

interface LastTradePrice {
  price: number;
}
```

**Implementation**:
```typescript
// src/services/PolymarketRealtime.ts
export class PolymarketRealtime {
  private ws: WebSocket;
  private subscriptions: Set<string> = new Set();

  async connect(auth: AuthConfig): Promise<void> {
    this.ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
    this.ws.onopen = () => this.authenticate(auth);
    this.ws.onmessage = (msg) => this.handleMessage(msg);
  }

  subscribeToMarket(assetId: string): void {
    this.ws.send(JSON.stringify({
      auth: this.auth,
      type: 'market',
      assets_ids: [assetId]
    }));
    this.subscriptions.add(assetId);
  }

  private handleMessage(msg: MessageEvent): void {
    const event = JSON.parse(msg.data) as MarketEvent;
    MessageBus.emit('market:updated', event);
  }
}
```

#### 1.2 RPC Provider: Alchemy Polygon

**Purpose**: On-chain settlement, contract interactions, event monitoring

**Configuration**:
```typescript
// src/config/rpc.ts
export interface RpcConfig {
  primary: {
    url: string;
    apiKey: string;
    rps: number;  // Rate limit per second
  };
  fallback: {
    url: string;
    rps: number;
  };
}

export const RPC_CONFIG: RpcConfig = {
  primary: {
    url: 'https://polygon-mainnet.g.alchemy.com/v2',
    apiKey: process.env.ALCHEMY_API_KEY,
    rps: 125  // Alchemy Growth plan
  },
  fallback: {
    url: 'https://polygon-mainnet.g.alchemy.com/v2/demo',
    rps: 10  // Free tier fallback
  }
};
```

**Implementation**:
```typescript
// src/services/PolygonRpc.ts
export class PolygonRpc {
  private provider: ethers.Provider;
  private fallbackProvider: ethers.Provider;
  private circuitBreaker: CircuitBreaker;

  async getContract(address: string, abi: any[]): Promise<ethers.Contract> {
    try {
      return new ethers.Contract(address, abi, this.provider);
    } catch (error) {
      this.circuitBreaker.recordFailure();
      return new ethers.Contract(address, abi, this.fallbackProvider);
    }
  }

  async waitForTransaction(txHash: string): Promise<ethers.ContractTransactionReceipt> {
    return await this.provider.waitForTransaction(txHash, 1, 60000);  // 1 confirm, 60s timeout
  }
}
```

**Upgrade Path**:
- **Phase 1** ($1000): Alchemy Growth ($39/mo, 125 RPS)
- **Phase 2** ($2000+): Chainstack Pro ($199/mo, 600 RPS) + Ankr PAYG
- **Phase 3** ($5000+): Private node ($470+/mo) + Flashbots bundles

### 2. Core Layer

#### 2.1 MessageBus

**Purpose**: Type-safe event communication between agents

```typescript
// src/core/MessageBus.ts
type EventMap = {
  'market:updated': MarketEvent;
  'opportunity:detected': ArbitrageOpportunity;
  'risk:approved': ApprovedTrade;
  'order:placed': OrderPlaced;
  'order:filled': OrderFilled;
  'order:failed': OrderFailed;
  'circuit:tripped': CircuitBreakerEvent;
};

export class MessageBus {
  private static emitter = new TypedEmitter<EventMap>();

  static on<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void {
    this.emitter.on(event, handler);
  }

  static emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    this.emitter.emit(event, data);
  }
}
```

#### 2.2 EventStore

**Purpose**: Immutable event log for crash recovery and audit trail

```typescript
// src/core/EventStore.ts
export interface StoredEvent {
  id: string;
  timestamp: number;
  type: string;
  data: any;
  metadata: { agent: string; correlationId?: string };
}

export class EventStore {
  private db: sqlite3.Database;

  async append(event: StoredEvent): Promise<void> {
    await this.db.run(
      'INSERT INTO events (id, timestamp, type, data, metadata) VALUES (?, ?, ?, ?, ?)',
      [event.id, event.timestamp, event.type, JSON.stringify(event.data), JSON.stringify(event.metadata)]
    );
  }

  async getEvents(since: number): Promise<StoredEvent[]> {
    const rows = await this.db.all('SELECT * FROM events WHERE timestamp > ? ORDER BY timestamp ASC', [since]);
    return rows.map(row => ({ ...row, data: JSON.parse(row.data), metadata: JSON.parse(row.metadata) }));
  }
}
```

#### 2.3 CircuitBreaker

**Purpose**: Prevent cascade failures, protect from rate limits

```typescript
// src/core/CircuitBreaker.ts
export interface CircuitBreakerConfig {
  failureThreshold: number;      // 5 failures
  timeout: number;               // 60s cooldown
  halfOpenRequests: number;       // Test with 3 requests
}

export class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures = 0;
  private lastFailureTime = 0;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime < this.config.timeout) {
        throw new Error('Circuit breaker is open');
      }
      this.state = 'half-open';
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state === 'half-open') {
      this.state = 'closed';
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
      MessageBus.emit('circuit:tripped', { service: this.serviceName });
    }
  }
}
```

### 3. Agent Layer

#### 3.1 MarketDataAgent

**Purpose**: Connect to CLOB WebSocket, normalize orderbook data

```typescript
// src/agents/market-data/MarketDataAgent.ts
export class MarketDataAgent {
  private realtime: PolymarketRealtime;
  private orderbook: Map<string, OrderBook> = new Map();

  async start(): Promise<void> {
    await this.realtime.connect({ key, secret, passphrase });
    this.realtime.on('message', this.handleMessage.bind(this));
    
    // Subscribe to all active markets
    const markets = await this.getActiveMarkets();
    for (const market of markets) {
      this.realtime.subscribeToMarket(market.id);
    }
  }

  private handleMessage(msg: any): void {
    if (msg.type === 'book') {
      this.updateOrderbook(msg);
      MessageBus.emit('market:updated', msg);
    }
  }

  getOrderbook(marketId: string): OrderBook | undefined {
    return this.orderbook.get(marketId);
  }
}
```

#### 3.2 ScannerAgent

**Purpose**: Detect arbitrage opportunities (YES/NO sum < $1.00)

```typescript
// src/agents/scanner/ScannerAgent.ts
export class ScannerAgent {
  async scanMarket(market: BinaryMarket): Promise<ArbitrageOpportunity | null> {
    const yesMarket = this.findOutcomeMarket(market, 'YES');
    const noMarket = this.findOutcomeMarket(market, 'NO');
    
    if (!yesMarket || !noMarket) return null;

    const yesPrice = yesMarket.bestAsk;
    const noPrice = noMarket.bestAsk;
    const sum = yesPrice + noPrice;

    if (sum >= 1.00) return null;  // No arbitrage

    const edge = 1.00 - sum;  // e.g., 0.97 sum = 3% edge
    const profit = this.calculateProfit(edge);

    if (profit < MIN_PROFIT_THRESHOLD) return null;

    return {
      type: 'binary_yes_no',
      marketId: market.id,
      yesMarketId: yesMarket.id,
      noMarketId: noMarket.id,
      yesPrice,
      noPrice,
      sum,
      edge,
      maxProfit: profit,
      timestamp: Date.now()
    };
  }
}
```

#### 3.3 RiskAgent

**Purpose**: Capital management, position limits, circuit breakers

```typescript
// src/agents/risk/RiskAgent.ts
export interface RiskConfig {
  maxPositionPercent: number;        // 80% of capital
  maxMarketExposurePercent: number;  // 50% per market
  dailyDrawdownLimit: number;        // 10%
  minProfitPerTrade: number;         // $5
}

export class RiskAgent {
  async evaluateOpportunity(op: ArbitrageOpportunity): Promise<RiskDecision> {
    const availableCapital = this.portfolio.getAvailableCapital();
    const totalCapital = this.portfolio.getTotalCapital();
    const maxPositionNotional = availableCapital * this.config.maxPositionPercent;
    const maxMarketExposure = totalCapital * this.config.maxMarketExposurePercent;
    const costPerSet = op.yesPrice + op.noPrice;
    const depthLimitedNotional = op.maxSizeByDepth * costPerSet;
    const positionNotional = Math.min(maxPositionNotional, depthLimitedNotional);
    
    // Check capital constraints
    if (op.maxProfit < this.config.minProfitPerTrade) {
      return { approved: false, reason: 'Below minimum profit threshold' };
    }

    // Check market exposure
    const marketExposure = this.portfolio.getMarketExposure(op.marketId);
    if (marketExposure + positionNotional > maxMarketExposure) {
      return { approved: false, reason: 'Max market exposure exceeded' };
    }

    // Check daily drawdown
    const dailyPnL = this.portfolio.getDailyPnL();
    if (dailyPnL < -this.config.dailyDrawdownLimit) {
      return { approved: false, reason: 'Daily drawdown limit hit' };
    }

    const positionSize = positionNotional / costPerSet;
    
    return {
      approved: true,
      positionSize,
      positionNotional,
      reason: 'Opportunity within risk parameters'
    };
  }
}
```

#### 3.4 ExecutionAgent

**Purpose**: Place paired FOK orders, handle partial fills, idempotency

```typescript
// src/agents/execution/ExecutionAgent.ts
export class ExecutionAgent {
  private clobClient: ClobClient;

  async executeArbitrage(op: ArbitrageOpportunity, size: number): Promise<ExecutionResult> {
    const idempotencyKey = this.generateIdempotencyKey(op);
    
    // Place paired FOK orders simultaneously
    const [yesOrder, noOrder] = await Promise.all([
      this.placeOrder(op.yesMarketId, 'buy', size, yesPrice, 'fok', idempotencyKey),
      this.placeOrder(op.noMarketId, 'buy', size, noPrice, 'fok', idempotencyKey)
    ]);

    // Monitor for fills
    const result = await this.monitorOrders([yesOrder, noOrder]);

    if (result.status === 'filled') {
      // Settle on-chain via Polygon RPC
      await this.settleOrders([yesOrder, noOrder]);
    }

    return result;
  }

  private generateIdempotencyKey(op: ArbitrageOpportunity): string {
    return createHash('sha256')
      .update(`${op.marketId}-${op.yesMarketId}-${op.noMarketId}-${Date.now()}`)
      .digest('hex');
  }
}
```

#### 3.5 PortfolioAgent

**Purpose**: Track positions, PnL, reconcile with CLOB

```typescript
// src/agents/portfolio/PortfolioAgent.ts
export class PortfolioAgent {
  private positions: Map<string, Position> = new Map();
  private dailyPnL = 0;

  async syncWithCLOB(): Promise<void> {
    const clobOrders = await this.clobClient.getOrders();
    
    for (const clobOrder of clobOrders) {
      const position = this.positions.get(clobOrder.id);
      
      if (!position) {
        // New order found
        this.positions.set(clobOrder.id, {
          id: clobOrder.id,
          marketId: clobOrder.marketId,
          side: clobOrder.side,
          size: clobOrder.size,
          price: clobOrder.price,
          status: clobOrder.status,
          filledSize: clobOrder.filledSize
        });
      } else {
        // Update existing
        position.status = clobOrder.status;
        position.filledSize = clobOrder.filledSize;
        
        if (clobOrder.status === 'filled') {
          this.dailyPnL += this.calculatePnL(position);
        }
      }
    }
  }

  getAvailableCapital(): number {
    const deployed = Array.from(this.positions.values())
      .filter(p => p.status === 'filled' || p.status === 'pending')
      .reduce((sum, p) => sum + p.size * p.price, 0);
    return TOTAL_CAPITAL - deployed;
  }
}
```

#### 3.6 OpsAgent

**Purpose**: Health checks, reconnection, rate limiting, alerts

```typescript
// src/agents/ops/OpsAgent.ts
export class OpsAgent {
  private healthCheckInterval: NodeJS.Timeout;

  async start(): Promise<void> {
    this.healthCheckInterval = setInterval(() => this.runHealthChecks(), 30000);  // Every 30s
  }

  private async runHealthChecks(): Promise<void> {
    const checks = await Promise.allSettled([
      this.checkWebSocketConnection(),
      this.checkRpcConnection(),
      this.checkRateLimits(),
      this.checkCircuitBreakers()
    ]);

    for (const [i, check] of checks.entries()) {
      if (check.status === 'rejected') {
        MessageBus.emit('ops:alert', {
          severity: 'critical',
          check: ['WebSocket', 'RPC', 'RateLimit', 'CircuitBreaker'][i],
          error: check.reason
        });
      }
    }
  }
}
```

#### 3.7 LearningAgent

**Purpose**: Log decisions for RL training, policy inference

```typescript
// src/agents/learning/LearningAgent.ts
export class LearningAgent {
  private onnxSession: ort.InferenceSession;
  private featureBuffer: FeatureVector[] = [];

  async loadModel(modelPath: string): Promise<void> {
    this.onnxSession = await ort.InferenceSession.create(modelPath);
  }

  async evaluateOpportunity(op: ArbitrageOpportunity): Promise<PolicyOutput> {
    const features = FeatureBuilder.build(op);
    const tensor = new ort.Tensor('float32', features);
    
    const results = await this.onnxSession.run({ input: tensor });
    const output = results.output.data as Float32Array;

    return {
      shouldExecute: output[0] > 0.5,
      confidence: output[0],
      positionSizeMultiplier: output[1]
    };
  }

  logDecision(decision: Decision): void {
    EventStore.append({
      id: generateId(),
      timestamp: Date.now(),
      type: 'learning:decision',
      data: decision,
      metadata: { agent: 'LearningAgent' }
    });
  }
}
```

### 4. Supervisor

```typescript
// src/core/Supervisor.ts
export class Supervisor {
  private agents: Map<string, Agent> = new Map();

  async start(): Promise<void> {
    // Initialize all agents
    this.agents.set('marketData', new MarketDataAgent());
    this.agents.set('scanner', new ScannerAgent());
    this.agents.set('risk', new RiskAgent());
    this.agents.set('execution', new ExecutionAgent());
    this.agents.set('portfolio', new PortfolioAgent());
    this.agents.set('ops', new OpsAgent());
    this.agents.set('learning', new LearningAgent());

    // Start all agents
    for (const agent of this.agents.values()) {
      await agent.start();
    }

    // Set up event handlers
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    MessageBus.on('market:updated', async (event: MarketEvent) => {
      const scanner = this.agents.get('scanner') as ScannerAgent;
      const opportunity = await scanner.scanMarket(event.marketId);
      
      if (opportunity) {
        MessageBus.emit('opportunity:detected', opportunity);
      }
    });

    MessageBus.on('opportunity:detected', async (op: ArbitrageOpportunity) => {
      const risk = this.agents.get('risk') as RiskAgent;
      const decision = await risk.evaluateOpportunity(op);
      
      if (decision.approved) {
        MessageBus.emit('risk:approved', { opportunity: op, ...decision });
      }
    });

    MessageBus.on('risk:approved', async (approved: ApprovedTrade) => {
      const execution = this.agents.get('execution') as ExecutionAgent;
      const result = await execution.executeArbitrage(approved.opportunity, approved.positionSize);
      
      MessageBus.emit(result.status === 'filled' ? 'order:filled' : 'order:failed', result);
    });
  }
}
```

---

## Data Flow

### Arbitrage Execution Flow

```
1. Market Update (WebSocket)
   └─> MarketDataAgent receives 'book' event
       └─> Updates local orderbook cache

2. Scan for Arbitrage
   └─> ScannerAgent scans market
       └─> Calculates YES + NO prices
       └─> Checks if sum < $1.00
       └─> Emits 'opportunity:detected'

3. Risk Evaluation
   └─> RiskAgent checks capital, exposure, limits
       └─> Emits 'risk:approved' (if within parameters)

4. Execute Orders
   └─> ExecutionAgent places paired FOK orders via CLOB API
       └─> Monitors for fills
       └─> On fill: settles on-chain via Polygon RPC

5. Portfolio Update
   └─> PortfolioAgent updates positions
       └─> Tracks PnL
       └─> Compounds profits

6. Learning
   └─> LearningAgent logs decision + outcome
       └─> Updates feature buffer for RL training
```

### Crash Recovery Flow

```
1. Application crashes

2. Supervisor restarts
   └─> Reads last checkpoint from SQLite
   └─> Loads events from EventStore since last checkpoint
   └─> Rebuilds state: orderbooks, positions, portfolio

3. Resume operation
   └─> MarketDataAgent reconnects to WebSocket
   └─> OpsAgent verifies all connections
   └─> Bot resumes without missing opportunities
```

---

## Execution Hardening (Risk-Free Policy)

### Pre-trade gates
- **Orderbook freshness**: last update age < threshold; resync if hash/sequence drift detected.
- **Top-of-book stability**: require best ask unchanged for N updates or T ms.
- **Depth headroom**: trade size <= 25% of depth across top 3 levels; use sweep cost, not just top-of-book.
- **Delay signals**: hard-reject `status=delayed` / `ORDER_DELAYED`.
- **Market allowlist**: only trade markets with strong fill telemetry; quarantine after any incident.
- **Funds + allowance**: verify USDC.e balance and allowance before both legs.

### Order placement choreography
- **Batch place** both FOK legs when supported to minimize timing skew.
- **Single-shot policy**: do not retry a failed leg without a fresh book check.
- **Shared correlation ID**: idempotency keyed to opportunity signature (market ids + prices + size + time bucket).

### Incident response (one-leg exposure)
- **Bounded completion attempt**: retry missing leg with a strict price cap.
- **Immediate unwind**: if completion fails, flatten using FAK with max-loss cap.
- **Quarantine + downsize**: flag market as unsafe and reduce sizing globally.

---

## Phase 2 Cross-Venue Readiness (design now)

### Venue abstraction (Phase 1 scaffolding)
- Create a `VenueAdapter` interface: `getOrderbook`, `placeOrder`, `cancelOrder`, `getPositions`, `getFees`, `getMarketMeta`.
- Normalize contracts via a `ContractMapper` (rulebook/event metadata + explicit allowlist).
- Track **fee models** per venue (Polymarket 0, Kalshi taker/maker fees) inside EV checks.
- Pre-fund balances per venue; transfers are **not** on the critical path.
- Add per-venue health and circuit breakers (rate-limit, trading pause, websocket lag).

See `docs/PHASE2_CROSS_VENUE.md` for constraints and the risk model.

---

## Latency Budget

| Component | Target | Notes |
|-----------|--------|-------|
| WebSocket message receipt | 10-30ms | Network latency to Polymarket |
| Orderbook update | 1-5ms | In-memory data structure |
| Arbitrage scan | 1-3ms | Simple arithmetic |
| Risk check | 1-2ms | Local state queries |
| Order placement | 10-30ms | CLOB API call |
| Order matching | 0ms (off-chain) | CLOB matching engine |
| Settlement submission | 50-100ms | Polygon RPC call |
| Block inclusion | 2000ms | Polygon block time |
| **Total** | ~2100ms | Block time dominates |

**Optimization Focus**: Application layer (1-10ms) is negligible vs block time (2000ms). Focus on:
- Fast WebSocket connection
- Efficient orderbook data structures
- Low-latency CLOB API calls
- Reliable RPC provider (uptime > raw speed)

---

## Capital Management Rules

### Position Sizing
```
max_position = available_capital * 0.80  // Deploy 80% per opportunity
reserve_capital = available_capital * 0.20  // 20% for gas + buffer
```

### Exposure Limits
```
max_market_exposure = total_capital * 0.50  // Max 50% per market
daily_drawdown_limit = total_capital * 0.10  // Halt if -10% daily
```

### Profit Compounding
```
new_capital = old_capital + realized_profit
reinvest_every = 'trade'  // Immediate reinvestment
```

### Trade Filters
```
min_profit_per_trade = $5
min_edge = 1%  // sum < $0.99
max_edge = 5%  // sum > $0.95 (avoid illiquid markets)
```

---

## Deployment

### Environment Variables
```bash
# Alchemy
ALCHEMY_API_KEY=xxx

# Polymarket
POLYMARKET_API_KEY=xxx
POLYMARKET_API_SECRET=xxx
POLYMARKET_PASSPHRASE=xxx

# Configuration
TOTAL_CAPITAL=1000
MAX_POSITION_PERCENT=0.80
DAILY_DRAWDOWN_LIMIT=0.10

# Monitoring
SENTRY_DSN=xxx  # Error tracking
SLACK_WEBHOOK=xxx  # Alerts
```

### Health Checks
```bash
# /health endpoint
GET /health
Response: {
  status: 'healthy' | 'degraded',
  uptime: 123456,
  agents: {
    marketData: 'running',
    scanner: 'running',
    risk: 'running',
    execution: 'running',
    portfolio: 'running',
    ops: 'running',
    learning: 'running'
  },
  connections: {
    websocket: 'connected',
    rpc: 'connected'
  }
}
```

---

## Monitoring & Alerts

### Metrics to Track
- Orders placed per minute
- Profit per trade
- Daily PnL
- Arbitrage opportunities detected vs executed
- RPC latency (p50, p95, p99)
- WebSocket message latency
- Circuit breaker trips
- Rate limit hits

### Alert Thresholds
- WebSocket disconnected for > 30s
- RPC latency p95 > 500ms
- Daily drawdown > 5% (warning), 10% (critical)
- Circuit breaker tripped
- No opportunities detected for > 10 minutes

---

## Security Considerations

### API Keys
- Store in environment variables, not code
- Rotate keys monthly
- Use read-only keys where possible

### Idempotency
- All operations idempotent via SHA256 keys
- Prevent duplicate orders on retry

### Rate Limiting
- Respect CLOB API limits (3,500 req/10s burst)
- Implement client-side throttling
- Use circuit breakers to prevent cascading failures

### MEV Protection
- Phase 1: Not needed (CLOB off-chain matching)
- Phase 2: Private RPC for DEX arbitrage
- Phase 3: Flashbots bundles for high-value trades

---

## Performance Optimization

### In-Memory Caching
- Orderbook data in memory (Map<string, OrderBook>)
- Position tracking in memory, persisted to SQLite
- Feature vectors in ring buffer for RL

### Batching
- Batch contract calls via Multicall
- Batch event writes to SQLite (every 100 events or 5 seconds)

### Connection Pooling
- Reuse WebSocket connections (auto-reconnect)
- HTTP/2 for RPC connections

### Data Structures
- Efficient orderbook implementation (red-black tree or heap)
- Typed arrays for feature vectors
- Binary protocol for WebSocket (MessagePack instead of JSON)

---

## Testing Strategy

### Unit Tests
- Each agent in isolation
- Risk calculation logic
- Arbitrage detection
- Position sizing

### Integration Tests
- End-to-end flow from market update to execution
- WebSocket reconnection
- RPC fallback
- Circuit breaker behavior

### Load Tests
- 1000 market updates per second
- 100 concurrent arbitrage opportunities
- 24-hour continuous operation

### Backtests
- Historical CLOB data replay
- Validate profitability on past data
- Tune risk parameters

---

## Documentation

### Code Documentation
- JSDoc for all public methods
- Type annotations for all functions
- Architecture diagrams for major components

### Operational Documentation
- Deployment guide
- Monitoring setup
- Troubleshooting common issues
- Upgrade procedures

### Business Documentation
- Strategy explanation
- Performance metrics
- Risk management
- Capital growth projections

---

## Future Enhancements

### Phase 2 ($2000+ Capital)
- Cross-platform arbitrage (Polymarket vs Kalshi)
- DEX arbitrage (Uniswap on Polygon)
- Private RPC for MEV protection
- Enhanced RL model with more features
 - See `docs/PHASE2_CROSS_VENUE.md` for venue constraints and design notes

### Phase 3 ($5000+ Capital)
- Multi-strategy bot (arbitrage + market making)
- Custom Polygon node for ultra-low latency
- Flashbots bundle submission
- Advanced risk management (dynamic position sizing)
