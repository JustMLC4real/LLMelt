import type { FallbackConfig } from '../src/providers/types';

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
