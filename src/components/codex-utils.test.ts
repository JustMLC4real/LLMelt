import { describe, expect, it } from 'vitest';
import { codexCliServiceTier, codexRecoveredPreflightArgs, codexSafePreflightArgs, codexServiceTiersFromCatalog } from './codex-utils';

describe('codexServiceTiersFromCatalog', () => {
  it('biedt alleen echte extra snelheden uit de live catalogus aan', () => {
    expect(codexServiceTiersFromCatalog({
      service_tiers: ['default', 'priority'],
      additional_speed_tiers: ['fast', 'flex', 'priority', 'default'],
    })).toEqual(['fast', 'flex', 'priority']);
  });

  it('passes only values advertised for that exact model into CLI config', () => {
    const advertised = ['standard', 'eco-v2', 'future'];
    expect(codexCliServiceTier('standard', advertised)).toBeUndefined();
    expect(codexCliServiceTier('fast', advertised)).toBeUndefined();
    expect(codexCliServiceTier('eco-v2', advertised)).toBe('eco-v2');
  });

  it('herstelt een verouderde config met waarden uit de actuele CLI-fout', () => {
    expect(codexSafePreflightArgs('login', 'status')).toEqual(['login', 'status']);
    expect(codexRecoveredPreflightArgs(
      'unknown variant `default`, expected `future-fast` or `eco_v2`',
      'login', 'status',
    )).toEqual(['-c', 'service_tier="future-fast"', 'login', 'status']);
    expect(codexRecoveredPreflightArgs('network error', 'login', 'status')).toBeUndefined();
    expect(codexSafePreflightArgs('login', 'status')).not.toContain('--ignore-user-config');
  });

  it('claimt zonder live speed tiers geen snelheidscontrol', () => {
    expect(codexServiceTiersFromCatalog({ service_tiers: ['default'] })).toEqual([]);
  });
});
