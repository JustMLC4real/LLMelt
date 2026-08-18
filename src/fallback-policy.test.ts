import { describe, expect, it } from 'vitest';
import { credentialPreflightFallbackReason, normalizeFallbackSwitchState } from '../electron/fallback-policy';

describe('fallbackbeleid', () => {
  it('schakelt een oude impliciet ingeschakelde keten veilig uit', () => {
    expect(normalizeFallbackSwitchState({ autoSwitchEnabled: true })).toEqual({
      autoSwitchEnabled: false,
      autoSwitchConfirmed: false,
    });
  });

  it('respecteert een expliciet door de gebruiker ingeschakelde keten', () => {
    expect(normalizeFallbackSwitchState({ autoSwitchEnabled: true, autoSwitchConfirmed: true })).toEqual({
      autoSwitchEnabled: true,
      autoSwitchConfirmed: true,
    });
  });

  it('houdt een expliciet uitgeschakelde keten uit', () => {
    expect(normalizeFallbackSwitchState({ autoSwitchEnabled: false, autoSwitchConfirmed: true })).toEqual({
      autoSwitchEnabled: false,
      autoSwitchConfirmed: true,
    });
  });

  it('kan ontbrekende of niet-ingelogde CLI-providers overslaan', () => {
    expect(credentialPreflightFallbackReason('codex')).toBe('auth_failed');
    expect(credentialPreflightFallbackReason('antigravity')).toBe('auth_failed');
    expect(credentialPreflightFallbackReason('ollama')).toBe('network');
  });
});
