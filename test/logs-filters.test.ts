import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_LOG_FILTERS,
  activeFilterCount,
  clearLogFilters,
  filtersToParams,
  getLogFilters,
  logModelLine,
  setLogFilters,
  subscribeLogFilters,
} from '../src/dashboard/lib/logs-filters';

describe('filtersToParams', () => {
  it('with no filters is just the page size', () => {
    expect(filtersToParams(EMPTY_LOG_FILTERS)).toBe('limit=50');
  });

  it('adds each non-empty filter and omits empty strings', () => {
    const q = filtersToParams({ provider_id: '3', gateway_key_id: '', status: 'failover', model: 'claude' });
    expect(q).toBe('limit=50&provider_id=3&status=failover&model=claude');
  });

  it('passes the status values ok, failover and error through verbatim', () => {
    for (const status of ['ok', 'failover', 'error']) {
      expect(filtersToParams({ ...EMPTY_LOG_FILTERS, status })).toBe(`limit=50&status=${status}`);
    }
  });

  it('adds the before cursor only when given', () => {
    expect(filtersToParams(EMPTY_LOG_FILTERS, 120)).toBe('limit=50&before=120');
    expect(filtersToParams(EMPTY_LOG_FILTERS, undefined)).toBe('limit=50');
  });

  it('encodes the model text', () => {
    expect(filtersToParams({ ...EMPTY_LOG_FILTERS, model: 'a b&c' })).toBe('limit=50&model=a+b%26c');
  });
});

describe('activeFilterCount', () => {
  it('counts only the non-empty filters', () => {
    expect(activeFilterCount(EMPTY_LOG_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_LOG_FILTERS, status: 'ok' })).toBe(1);
    expect(activeFilterCount({ provider_id: '1', gateway_key_id: '2', status: 'error', model: '' })).toBe(3);
    expect(activeFilterCount({ provider_id: '1', gateway_key_id: '2', status: 'error', model: 'x' })).toBe(4);
  });
});

describe('filter store', () => {
  it('setLogFilters then getLogFilters returns the new filters and notifies', () => {
    const seen = vi.fn();
    const off = subscribeLogFilters(seen);
    setLogFilters({ provider_id: '7', gateway_key_id: '', status: 'ok', model: 'gpt' });
    expect(getLogFilters().provider_id).toBe('7');
    expect(getLogFilters().model).toBe('gpt');
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    clearLogFilters();
  });

  it('clearLogFilters resets all four and notifies', () => {
    setLogFilters({ provider_id: '7', gateway_key_id: '2', status: 'ok', model: 'gpt' });
    const seen = vi.fn();
    const off = subscribeLogFilters(seen);
    clearLogFilters();
    expect(activeFilterCount(getLogFilters())).toBe(0);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it('an unsubscribed listener is not called again', () => {
    const seen = vi.fn();
    const off = subscribeLogFilters(seen);
    off();
    setLogFilters({ ...EMPTY_LOG_FILTERS, status: 'error' });
    expect(seen).not.toHaveBeenCalled();
    clearLogFilters();
  });
});

describe('logModelLine', () => {
  it('returns the model, adds the upstream model only when it differs', () => {
    expect(logModelLine({ model: 'claude-x', upstream_model: 'claude-x', path: '/v1/messages' })).toBe('claude-x');
    expect(logModelLine({ model: 'claude-x', upstream_model: null, path: '/v1/messages' })).toBe('claude-x');
    expect(logModelLine({ model: 'claude-x', upstream_model: 'glm-4', path: '/v1/messages' })).toBe('claude-x → glm-4');
  });

  it('falls back to the path when the model is empty', () => {
    expect(logModelLine({ model: null, upstream_model: null, path: '/v1/messages' })).toBe('/v1/messages');
    expect(logModelLine({ model: '', upstream_model: 'glm-4', path: '/v1/chat/completions' })).toBe('/v1/chat/completions');
  });
});
