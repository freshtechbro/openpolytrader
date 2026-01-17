/**
 * TradingStateManager - Runtime trading state control
 * Events: 'trading:mode_changed', 'trading:enabled_changed'
 */

import { EventEmitter } from 'events';

export type TradingMode = 'off' | 'shadow' | 'paper' | 'live';

export interface TradingState {
  enabled: boolean;
  mode: TradingMode;
  changedAt: Date;
  changedBy: 'env' | 'api';
}

export interface TradingModeChangeEvent {
  previousMode: TradingMode;
  newMode: TradingMode;
  changedAt: Date;
  changedBy: 'env' | 'api';
}

export interface TradingEnabledChangeEvent {
  previousEnabled: boolean;
  newEnabled: boolean;
  changedAt: Date;
  changedBy: 'env' | 'api';
}

export class TradingStateManager extends EventEmitter {
  private _enabled: boolean;
  private _mode: TradingMode;
  private _changedAt: Date;
  private _changedBy: 'env' | 'api';

  constructor(initialEnabled: boolean, initialMode: TradingMode) {
    super();
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

    this.emit('trading:mode_changed', event);
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

    this.emit('trading:enabled_changed', event);
    return true;
  }

  onModeChange(callback: (event: TradingModeChangeEvent) => void): void {
    this.on('trading:mode_changed', callback);
  }

  onEnabledChange(callback: (event: TradingEnabledChangeEvent) => void): void {
    this.on('trading:enabled_changed', callback);
  }
}
