import type { PortfolioSnapshot, Position } from '../../domain/portfolio.js';

export interface FillUpdate {
  tokenId: string;
  marketId?: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
}

export class PortfolioAgent {
  private positions = new Map<string, Position>();
  private marketExposure: Record<string, number> = {};
  private dailyPnL = 0;

  constructor(private totalCapital: number) {}

  applyFill(fill: FillUpdate): void {
    const position = this.positions.get(fill.tokenId);
    const signedSize = fill.side === 'BUY' ? fill.size : -fill.size;
    const existingSize = position?.size ?? 0;
    const newSize = existingSize + signedSize;

    if (!position) {
      this.positions.set(fill.tokenId, {
        tokenId: fill.tokenId,
        size: signedSize,
        averagePrice: fill.price,
        side: fill.side
      });
    } else {
      const totalNotional = position.averagePrice * existingSize + fill.price * signedSize;
      position.size = newSize;
      position.averagePrice = newSize === 0 ? 0 : totalNotional / newSize;
      position.side = newSize >= 0 ? 'BUY' : 'SELL';
    }

    if (fill.marketId) {
      const exposure = this.marketExposure[fill.marketId] ?? 0;
      const notional = fill.price * fill.size;
      this.marketExposure[fill.marketId] = exposure + notional;
    }
  }

  applyPnL(delta: number): void {
    this.dailyPnL += delta;
  }

  snapshot(): PortfolioSnapshot {
    const deployed = Array.from(this.positions.values()).reduce(
      (sum, position) => sum + Math.abs(position.size) * position.averagePrice,
      0
    );

    return {
      totalCapital: this.totalCapital,
      availableCapital: Math.max(this.totalCapital - deployed, 0),
      dailyPnL: this.dailyPnL,
      marketExposure: { ...this.marketExposure }
    };
  }
}
