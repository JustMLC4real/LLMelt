import { describe, expect, it } from 'vitest';
import { codexCliServiceTier, codexSafePreflightArgs, codexServiceTiersFromCatalog } from './codex-utils';

describe('codexServiceTiersFromCatalog', () => {
  it('offers standard plus only CLI-accepted speed tiers', () => {
    expect(codexServiceTiersFromCatalog({
      service_tiers: ['default', 'priority'],
      additional_speed_tiers: ['fast', 'flex', 'priority', 'default'],
    })).toEqual(['standard', 'fast', 'flex']);
  });

  it('does not leak catalog-only tiers into CLI config', () => {
    expect(codexCliServiceTier('standard')).toBeUndefined();
    expect(codexCliServiceTier('default')).toBeUndefined();
    expect(codexCliServiceTier('priority')).toBeUndefined();
    expect(codexCliServiceTier('fast')).toBe('fast');
    expect(codexCliServiceTier('flex')).toBe('flex');
  });

  it('gebruikt voor preflight geen versiegebonden ignore-user-config-vlag', () => {
    expect(codexSafePreflightArgs('login', 'status')).toEqual([
      '-c',
      'service_tier="fast"',
      'login',
      'status',
    ]);
    expect(codexSafePreflightArgs('login', 'status')).not.toContain('--ignore-user-config');
  });
});
