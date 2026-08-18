import { describe, expect, it } from 'vitest';
import { hasRecordableUsage, mergeUsageSources, usageSourceFromRows } from './providers/token-usage';

describe('tokenverbruik-bronnen', () => {
  it('registreert geen lege providerplaceholder als werkelijk verbruik', () => {
    expect(hasRecordableUsage({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextWindowSize: 128_000,
      contextUsedPercent: 0,
      source: 'unknown',
    })).toBe(false);
  });

  it('registreert gemeten of geschat verbruik zodra er tokens zijn', () => {
    expect(hasRecordableUsage({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      contextWindowSize: 128_000,
      contextUsedPercent: 0,
      source: 'provider',
    })).toBe(true);
  });

  it('houdt een zuivere bron intact en markeert gemengde aggregaten', () => {
    expect(mergeUsageSources('provider', 'provider')).toBe('provider');
    expect(usageSourceFromRows('provider,estimate')).toBe('mixed');
    expect(usageSourceFromRows(null)).toBe('unknown');
  });
});
