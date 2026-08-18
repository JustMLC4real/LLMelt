import { describe, expect, it } from 'vitest';
import { formatQuotaCountdown, quotaStatusLabelKey, quotaWindowLabelKey, resolveQuotaForModel } from './providers/quota-display';
import type { AIModel, ProviderQuotaSnapshot } from './providers/types';

const labels = { available: 'beschikbaar', day: 'd', hour: 'u', minute: 'm', second: 's' };

describe('quotumweergave', () => {
  it('formatteert een weekreset als dagen en uren in plaats van totale minuten', () => {
    const now = Date.parse('2030-01-01T00:00:00Z');
    expect(formatQuotaCountdown('2030-01-07T23:55:23Z', now, labels)).toBe('6d 23u');
  });

  it('laat een subscription-quota nooit lekken naar OpenAI API-modellen', () => {
    const apiModel = { id: 'gpt-api', provider: 'openai', providerSurface: 'api' } as AIModel;
    const webQuota = {
      id: 'web', provider: 'openai', surface: 'subscription-web', limitGroupKey: 'openai:account',
      state: 'unknown', source: 'unknown', accuracy: 'unavailable', observedAt: new Date().toISOString(), buckets: [],
    } as ProviderQuotaSnapshot;
    expect(resolveQuotaForModel(apiModel, [webQuota], 'openai:gpt-api')).toBeUndefined();
  });

  it('verkiest een actuele runtime-cooldown boven een onbekende accountmeting', () => {
    const model = { id: 'codex:model', provider: 'codex', providerSurface: 'cli' } as AIModel;
    const unknown = {
      id: 'unknown', provider: 'codex', surface: 'cli', limitGroupKey: 'codex:account', state: 'unknown',
      source: 'codex-app-server', accuracy: 'unavailable', observedAt: '2030-01-01T00:00:00Z', buckets: [],
    } as ProviderQuotaSnapshot;
    const cooldown = {
      ...unknown,
      id: 'cooldown',
      state: 'cooldown',
      source: 'runtime-error',
      accuracy: 'live',
      staleAfter: '2030-01-01T00:10:00Z',
      buckets: [{ id: 'runtime', label: 'Runtime', meter: 'provider', state: 'cooldown', resetAt: '2030-01-01T00:10:00Z' }],
    } as ProviderQuotaSnapshot;
    expect(resolveQuotaForModel(model, [unknown, cooldown], 'codex:account', Date.parse('2030-01-01T00:05:00Z'))?.id).toBe('cooldown');
  });

  it('maakt door de app bekende vensterlabels taalneutraal herkenbaar', () => {
    expect(quotaWindowLabelKey({
      id: 'account:primair', label: 'Primair', meter: 'provider', state: 'available', windowSeconds: 5 * 3600,
    })).toBe('primaryWindow');
    expect(quotaWindowLabelKey({
      id: 'seven-day', label: '7 dagen', meter: 'provider', state: 'available', windowSeconds: 7 * 86400,
    })).toBe('sevenDayWindow');
    expect(quotaWindowLabelKey({ id: 'local', label: 'Lokaal', meter: 'provider', state: 'unlimited' }))
      .toBe('localWindow');
  });

  it('toont ontbrekende telemetrie als niet gepubliceerd en niet als providerfout', () => {
    const snapshot = {
      id: 'unknown', provider: 'openai', surface: 'subscription-web', limitGroupKey: 'openai:account',
      state: 'unknown', source: 'unknown', accuracy: 'unavailable', observedAt: new Date().toISOString(),
      note: 'Deze interne notitie mag niet rechtstreeks in de Engelse UI belanden.', buckets: [],
    } as ProviderQuotaSnapshot;
    expect(quotaStatusLabelKey(snapshot)).toBe('limitNotPublished');
  });
});
