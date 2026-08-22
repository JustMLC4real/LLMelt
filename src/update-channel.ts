/**
 * LLMelt publiceert zowel stabiele releases als prereleases. Een build hoort bij
 * het kanaal waarop hij is uitgebracht — dat staat als `updateChannel` in
 * package.json — en zoekt daar standaard ook zijn updates. De gebruiker mag dat
 * per installatie overrulen; die keuze weegt zwaarder dan het buildkanaal.
 */
export type UpdateChannel = 'stable' | 'prerelease';

export const UPDATE_CHANNELS: UpdateChannel[] = ['stable', 'prerelease'];

/** Het kanaal dat hoort bij een build zonder expliciet `updateChannel`-veld. */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable';

export function normalizeUpdateChannel(value: unknown): UpdateChannel | undefined {
  const channel = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (UPDATE_CHANNELS as string[]).includes(channel) ? channel as UpdateChannel : undefined;
}

/**
 * Het kanaal waarop deze build is uitgebracht. Een onbekende of ontbrekende
 * waarde telt als stabiel: liever geen prereleases aanbieden aan iemand die er
 * niet om gevraagd heeft.
 */
export function buildUpdateChannel(packageChannel: unknown): UpdateChannel {
  return normalizeUpdateChannel(packageChannel) || DEFAULT_UPDATE_CHANNEL;
}

/** De opgeslagen keuze van de gebruiker gaat voor op het kanaal van de build. */
export function resolveUpdateChannel(storedChannel: unknown, packageChannel: unknown): UpdateChannel {
  return normalizeUpdateChannel(storedChannel) || buildUpdateChannel(packageChannel);
}

/**
 * Vertaalt het kanaal naar electron-updater's `allowPrerelease`. Met een stabiel
 * versienummer én `allowPrerelease` kiest de GitHub-provider de nieuwste release
 * uit de feed, prerelease of niet; zonder die vlag kijkt hij alleen naar
 * `/releases/latest`, waar GitHub prereleases weglaat.
 */
export function allowsPrerelease(channel: UpdateChannel): boolean {
  return channel === 'prerelease';
}

/**
 * Herkent de melding die GitHub's provider geeft wanneer er op het gekozen
 * kanaal geen enkele release staat. Op het stabiele kanaal vraagt de updater
 * `/releases/latest` op; bestaan er alleen prereleases, dan antwoordt GitHub met
 * de HTML-releasepagina en struikelt de parser daarover. Dat is geen storing
 * maar een leeg kanaal, en hoort de gebruiker niet als stacktrace te bereiken.
 */
export function isEmptyChannelError(message: unknown): boolean {
  const text = typeof message === 'string' ? message : '';
  return /Unable to find latest version on GitHub/i.test(text)
    || /No published versions on GitHub/i.test(text)
    || /please ensure a production release exists/i.test(text);
}

/** Of de gebruiker met deze keuze afwijkt van het kanaal waarop hij draait. */
export function isChannelOverridden(storedChannel: unknown, packageChannel: unknown): boolean {
  const stored = normalizeUpdateChannel(storedChannel);
  return !!stored && stored !== buildUpdateChannel(packageChannel);
}
