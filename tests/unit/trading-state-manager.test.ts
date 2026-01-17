import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradingStateManager } from '../../src/core/TradingStateManager.js';

describe('TradingStateManager', () => {
  let manager: TradingStateManager;

  beforeEach(() => {
    manager = new TradingStateManager(true, 'shadow');
  });

  describe('initial state', () => {
    it('initializes with provided values', () => {
      expect(manager.enabled).toBe(true);
      expect(manager.mode).toBe('shadow');
      expect(manager.state.changedBy).toBe('env');
    });

    it('initializes disabled manager', () => {
      const disabled = new TradingStateManager(false, 'off');
      expect(disabled.enabled).toBe(false);
      expect(disabled.mode).toBe('off');
    });
  });

  describe('mode helpers', () => {
    it('isLiveTrading returns true only when enabled and live', () => {
      expect(manager.isLiveTrading()).toBe(false);
      
      manager.setMode('live');
      expect(manager.isLiveTrading()).toBe(true);
      
      manager.setEnabled(false);
      expect(manager.isLiveTrading()).toBe(false);
    });

    it('shouldExecuteTrades returns true for live or paper mode when enabled', () => {
      expect(manager.shouldExecuteTrades()).toBe(false);
      
      manager.setMode('paper');
      expect(manager.shouldExecuteTrades()).toBe(true);
      
      manager.setMode('live');
      expect(manager.shouldExecuteTrades()).toBe(true);
      
      manager.setEnabled(false);
      expect(manager.shouldExecuteTrades()).toBe(false);
    });

    it('isShadowMode returns true only for shadow mode', () => {
      expect(manager.isShadowMode()).toBe(true);
      
      manager.setMode('live');
      expect(manager.isShadowMode()).toBe(false);
      
      manager.setMode('shadow');
      expect(manager.isShadowMode()).toBe(true);
    });
  });

  describe('setMode', () => {
    it('changes mode and emits event', () => {
      const listener = vi.fn();
      manager.onModeChange(listener);

      const changed = manager.setMode('live');
      
      expect(changed).toBe(true);
      expect(manager.mode).toBe('live');
      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        previousMode: 'shadow',
        newMode: 'live',
        changedBy: 'api'
      }));
    });

    it('returns false when mode unchanged', () => {
      const listener = vi.fn();
      manager.onModeChange(listener);

      const changed = manager.setMode('shadow');
      
      expect(changed).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    });

    it('respects changedBy parameter', () => {
      const listener = vi.fn();
      manager.onModeChange(listener);

      manager.setMode('paper', 'env');
      
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        changedBy: 'env'
      }));
    });
  });

  describe('setEnabled', () => {
    it('changes enabled state and emits event', () => {
      const listener = vi.fn();
      manager.onEnabledChange(listener);

      const changed = manager.setEnabled(false);
      
      expect(changed).toBe(true);
      expect(manager.enabled).toBe(false);
      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        previousEnabled: true,
        newEnabled: false,
        changedBy: 'api'
      }));
    });

    it('returns false when enabled unchanged', () => {
      const listener = vi.fn();
      manager.onEnabledChange(listener);

      const changed = manager.setEnabled(true);
      
      expect(changed).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    });

    it('respects changedBy parameter', () => {
      const listener = vi.fn();
      manager.onEnabledChange(listener);

      manager.setEnabled(false, 'env');
      
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        changedBy: 'env'
      }));
    });
  });

  describe('state snapshot', () => {
    it('returns complete state object', () => {
      const state = manager.state;
      
      expect(state).toEqual({
        enabled: true,
        mode: 'shadow',
        changedAt: expect.any(Date),
        changedBy: 'env'
      });
    });

    it('updates changedAt on mode change', () => {
      const before = manager.state.changedAt;
      
      manager.setMode('live');
      
      const after = manager.state.changedAt;
      expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });
});
