import { describe, expect, it } from 'vitest';
import { BOTTOM_VIEW_IDS, MORE_VIEW_IDS, VIEW_IDS, isMoreActive } from '../src/dashboard/lib/routes';

describe('bottom bar slots (VIEW-09)', () => {
  it('BOTTOM_VIEW_IDS plus MORE_VIEW_IDS contains every view id exactly once', () => {
    const all = [...BOTTOM_VIEW_IDS, ...MORE_VIEW_IDS];
    expect(all).toHaveLength(VIEW_IDS.length);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...VIEW_IDS].sort());
  });

  it('the bar has exactly four destination slots, so More makes five', () => {
    expect(BOTTOM_VIEW_IDS).toHaveLength(4);
  });

  it('isMoreActive is true for Gateway Keys and Rules & Settings only', () => {
    expect(isMoreActive('gateway-keys')).toBe(true);
    expect(isMoreActive('settings')).toBe(true);
    for (const id of ['overview', 'providers', 'routes', 'logs'] as const) expect(isMoreActive(id)).toBe(false);
  });
});
