import type { FallbackConfig, FallbackReason, ProviderType } from '../src/providers/types';

/**
 * Oude versies schakelden providerfallback standaard in zonder dat de gebruiker
 * dit expliciet bevestigde. Behandel zo'n legacyconfig veilig als uitgeschakeld.
 */
export function normalizeFallbackSwitchState(
  config: Pick<FallbackConfig, 'autoSwitchEnabled' | 'autoSwitchConfirmed'>,
) {
  const confirmed = config.autoSwitchConfirmed === true;
  return {
    autoSwitchEnabled: confirmed && config.autoSwitchEnabled === true,
    autoSwitchConfirmed: confirmed,
  };
}

/**
 * Een ontbrekende of niet-ingelogde CLI is voor een fallbackketen herstelbaar:
 * het huidige model kan niet draaien, maar een volgende provider mogelijk wel.
 */
export function credentialPreflightFallbackReason(provider: ProviderType): FallbackReason {
  if (provider === 'ollama') return 'network';
  return provider === 'openai'
    || provider === 'anthropic'
    || provider === 'google'
    || provider === 'remote'
    || provider === 'codex'
    || provider === 'antigravity'
    ? 'auth_failed'
    : 'provider_error';
}
