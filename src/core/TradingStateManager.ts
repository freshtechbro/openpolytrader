/**
 * TradingStateManager - Runtime trading state control
 * Events: 'trading:mode_changed', 'trading:enabled_changed'
 */

type TradingMode = 'off' | 'shadow' | 'paper' | 'live';

export interface TradingState {
  enabled: boolean;
  mode: TradingMode;
  changedAt: Date;
  changedBy: 'env' | 'api';
}

interface TradingModeChangeEvent {
  previousMode: TradingMode;
  newMode: TradingMode;
  changedAt: Date;
  changedBy: 'env' | 'api';
}

interface TradingEnabledChangeEvent {
  previousEnabled: boolean;
  newEnabled: boolean;
  changedAt: Date;
  changedBy: 'env' | 'api';
}

export class TradingStateManager {
  private _enabled: boolean;
  private _mode: TradingMode;
  private _changedAt: Date;
  private _changedBy: 'env' | 'api';
  private readonly modeChangeListeners = new Set<(event: TradingModeChangeEvent) => void>();
  private readonly enabledChangeListeners = new Set<(event: TradingEnabledChangeEvent) => void>();

  constructor(initialEnabled: boolean, initialMode: TradingMode) {
    this._enabled = initialEnabled;
    this._mode = initialMode;
    this._changedAt = new Date();
    this._changedBy = 'env';
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get mode(): TradingMode {
    return this._mode;
  }

  get state(): TradingState {
    return {
      enabled: this._enabled,
      mode: this._mode,
      changedAt: this._changedAt,
      changedBy: this._changedBy,
    };
  }

  isLiveTrading(): boolean {
    return this._enabled && this._mode === 'live';
  }

  shouldExecuteTrades(): boolean {
    return this._enabled && (this._mode === 'live' || this._mode === 'paper');
  }

  isShadowMode(): boolean {
    return this._mode === 'shadow';
  }

  setMode(newMode: TradingMode, changedBy: 'env' | 'api' = 'api'): boolean {
    if (this._mode === newMode) {
      return false;
    }

    const previousMode = this._mode;
    this._mode = newMode;
    this._changedAt = new Date();
    this._changedBy = changedBy;

    const event: TradingModeChangeEvent = {
      previousMode,
      newMode,
      changedAt: this._changedAt,
      changedBy,
    };

    for (const listener of this.modeChangeListeners) {
      listener(event);
    }
    return true;
  }

  setEnabled(newEnabled: boolean, changedBy: 'env' | 'api' = 'api'): boolean {
    if (this._enabled === newEnabled) {
      return false;
    }

    const previousEnabled = this._enabled;
    this._enabled = newEnabled;
    this._changedAt = new Date();
    this._changedBy = changedBy;

    const event: TradingEnabledChangeEvent = {
      previousEnabled,
      newEnabled,
      changedAt: this._changedAt,
      changedBy,
    };

    for (const listener of this.enabledChangeListeners) {
      listener(event);
    }
    return true;
  }

  onModeChange(callback: (event: TradingModeChangeEvent) => void): void {
    this.modeChangeListeners.add(callback);
  }

  onEnabledChange(callback: (event: TradingEnabledChangeEvent) => void): void {
    this.enabledChangeListeners.add(callback);
  }
}
