# Real-Time Trading Infrastructure Plan

**Created:** 2026-01-07  
**Goal:** Enable real-time trading control, live data streaming, and instant decision-making from the dashboard.

---

## Executive Summary

This plan addresses five key requirements:
1. **UI Settings Control** - Change trading mode (shadow/live) from dashboard
2. **Persistent Real-Time Connection** - WebSocket stays connected, auto-reconnects
3. **Market Descriptions** - Show human-readable market info, not just IDs
4. **Live Decisions Display** - Stream decisions in real-time via SSE
5. **Microsecond Freshness** - Ensure data is as fresh as possible

---

## Current State Analysis

| Component | Status | Gap |
|-----------|--------|-----|
| WebSocket Connection | ✅ Working | Auto-reconnect, 30s heartbeat, 60s staleness detection |
| SSE Stream | ✅ Working | Pushes metrics events to dashboard |
| Trading Mode | ⚠️ Read-only | Env var only, no runtime change |
| Decisions | ⚠️ On-demand | Fetched once, not streamed live |
| Market Descriptions | ❌ Missing | Only IDs shown, no human-readable info |
| Settings UI | ⚠️ Partial | Policy/risk editable, trading mode read-only |

---

## Task 1 — Runtime Trading Mode Control

### Reasoning
Currently `TRADING_MODE` is an environment variable that requires restart to change. Users need to switch between shadow/live modes instantly from the UI.

### What to do
Add a runtime-mutable trading mode with backend endpoint and UI toggle.

### How
1. **Backend: Add mutable trading state**
   - Create `src/core/TradingStateManager.ts` - singleton managing trading mode
   - Expose `getTradingMode()`, `setTradingMode()`, `onModeChange(callback)`
   - Initialize from env var, allow runtime override

2. **Backend: Add API endpoint**
   - Add `POST /config/trading-mode` to `src/api/server.ts`
   - Body: `{ "mode": "shadow" | "live" | "paper" | "off" }`
   - Validate mode, update TradingStateManager, emit event

3. **Backend: Wire Supervisor to listen for mode changes**
   - Supervisor subscribes to TradingStateManager changes
   - Propagates to ExecutionAgent in real-time

4. **Dashboard: Add trading mode toggle**
   - Add toggle in TopNav or dedicated Settings section
   - Call POST /config/trading-mode on change
   - Show confirmation for live mode (dangerous!)

### Files impacted
- `src/core/TradingStateManager.ts` (new file)
- `src/api/server.ts` (add endpoint)
- `src/core/Supervisor.ts` (subscribe to mode changes)
- `src/agents/execution/ExecutionAgent.ts` (accept mode updates)
- `dashboard/src/App.tsx` (add toggle UI)
- `dashboard/src/components/TopNav.tsx` (if exists, add toggle)

### End goal
User can click a toggle in the dashboard to switch between shadow and live mode without restarting.

### Acceptance criteria
- [ ] POST /config/trading-mode endpoint works
- [ ] Changing mode reflects immediately in ExecutionAgent behavior
- [ ] Dashboard shows current mode and allows change
- [ ] Live mode shows warning confirmation dialog
- [ ] Mode change emitted via SSE for all dashboard instances

---

## Task 2 — Verify Persistent WebSocket Connection

### Reasoning
The WebSocket infrastructure already exists with auto-reconnect. We need to verify it's working optimally and add visibility into connection status.

### What to do
Add connection status visibility to dashboard and verify reconnection logic.

### How
1. **Backend: Emit connection status events**
   - Add `ws:connected`, `ws:disconnected`, `ws:reconnecting` events
   - Include in SSE stream for dashboard visibility

2. **Dashboard: Show connection status indicator**
   - Add green/yellow/red dot in TopNav showing connection health
   - Green: connected, Yellow: reconnecting, Red: disconnected

3. **Verify heartbeat and staleness**
   - Check logs for heartbeat pings every 30s
   - Verify staleness detection triggers reconnect at 60s

### Files impacted
- `src/services/PolymarketRealtime.ts` (emit status events)
- `src/api/server.ts` (include in SSE)
- `dashboard/src/App.tsx` (show status indicator)

### End goal
Dashboard shows live connection status; WebSocket auto-recovers from any disconnection.

### Acceptance criteria
- [ ] Connection status visible in dashboard
- [ ] Disconnection triggers automatic reconnect within 5s
- [ ] Reconnect resubscribes to all markets
- [ ] Staleness detection works (60s threshold)

---

## Task 3 — Market Descriptions in UI

### Reasoning
Markets currently show cryptic condition IDs. Users need human-readable descriptions to understand what they're trading.

### What to do
Fetch and display market question/description alongside token IDs.

### How
1. **Backend: Enhance market catalog with descriptions**
   - Modify `MarketCatalog` to store `question` field from Polymarket API
   - Fetch descriptions when loading catalog

2. **Backend: Include descriptions in /allowlist response**
   - Add `question` field to allowlist endpoint response
   - Format: `{ marketId, conditionId, question, ... }`

3. **Dashboard: Display descriptions**
   - Show question text in Markets page table
   - Add tooltip or expandable row for full description

### Files impacted
- `src/domain/MarketCatalog.ts` (add question field)
- `src/tools/marketCatalogPrestart.ts` (fetch descriptions)
- `src/api/server.ts` (include in response)
- `dashboard/src/pages/Markets.tsx` (display descriptions)

### End goal
Markets page shows "Will X happen?" instead of just "0x1234...".

### Acceptance criteria
- [ ] Market catalog stores question text
- [ ] /allowlist returns question for each market
- [ ] Dashboard displays question in Markets table
- [ ] Long questions truncated with tooltip for full text

---

## Task 4 — Live Decisions Streaming

### Reasoning
Decisions page currently fetches on page load. Users need real-time decision feed for split-second trading awareness.

### What to do
Stream decision events via SSE and update Decisions page in real-time.

### How
1. **Backend: Emit decision events to SSE**
   - Already happening via MetricsStore, verify `decision:made` events flow
   - Ensure LLM decisions include full context

2. **Dashboard: Subscribe to decision events**
   - Add decision event handler in useEventStream
   - Update Decisions page state when new decision arrives
   - Add "live" indicator and auto-scroll to latest

3. **Dashboard: Add decision detail panel**
   - Click decision to see full JSON context
   - Show reasoning, inputs, outputs, timing

### Files impacted
- `src/agents/*/` (verify decision events emitted)
- `dashboard/src/hooks/useEventStream.ts` (add decision handler)
- `dashboard/src/pages/Decisions.tsx` (live updates)

### End goal
Decisions page shows new decisions appearing in real-time as they happen.

### Acceptance criteria
- [ ] Decision events flow through SSE
- [ ] Decisions page updates without refresh
- [ ] New decisions appear at top with highlight animation
- [ ] "Live" indicator shows streaming status
- [ ] Decision detail shows full context

---

## Task 5 — Real-Time Allowlist Display

### Reasoning
The allowlist defines which markets we're actively trading. Users need to see this in real-time.

### What to do
Stream allowlist changes and show live trading activity per market.

### How
1. **Backend: Emit allowlist change events**
   - Add `allowlist:updated` event when markets added/removed/paused
   - Include in SSE stream

2. **Dashboard: Live allowlist updates**
   - Subscribe to allowlist events
   - Show add/remove animations
   - Display last activity timestamp per market

### Files impacted
- `src/domain/MarketAllowlist.ts` (emit events)
- `src/api/server.ts` (include in SSE)
- `dashboard/src/pages/Markets.tsx` (live updates)

### End goal
Markets page reflects allowlist changes instantly without refresh.

### Acceptance criteria
- [ ] Allowlist changes emit events
- [ ] Dashboard updates in real-time
- [ ] Each market shows last activity time
- [ ] Visual indicator for recently active markets

---

## Implementation Sequence

1. **Task 1: Trading Mode Control** - Core functionality
2. **Task 2: Connection Status** - Visibility into health
3. **Task 3: Market Descriptions** - UX improvement
4. **Task 4: Live Decisions** - Real-time awareness
5. **Task 5: Live Allowlist** - Complete real-time picture

---

## File-by-File Implementation Order

| Order | File | Tasks |
|-------|------|-------|
| 1 | `src/core/TradingStateManager.ts` | Task 1 (new file) |
| 2 | `src/api/server.ts` | Tasks 1, 2, 3, 5 |
| 3 | `src/core/Supervisor.ts` | Task 1 |
| 4 | `src/agents/execution/ExecutionAgent.ts` | Task 1 |
| 5 | `src/services/PolymarketRealtime.ts` | Task 2 |
| 6 | `src/domain/MarketCatalog.ts` | Task 3 |
| 7 | `src/domain/MarketAllowlist.ts` | Task 5 |
| 8 | `dashboard/src/App.tsx` | Tasks 1, 2 |
| 9 | `dashboard/src/pages/Markets.tsx` | Tasks 3, 5 |
| 10 | `dashboard/src/pages/Decisions.tsx` | Task 4 |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Accidental live trading | Confirmation dialog with "Type 'LIVE' to confirm" |
| WebSocket disconnection during trade | Graceful degradation, pause trading on disconnect |
| SSE connection drops | Auto-reconnect with exponential backoff |
| Stale data displayed | Timestamp all data, show staleness warnings |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-07 | Initial plan |
