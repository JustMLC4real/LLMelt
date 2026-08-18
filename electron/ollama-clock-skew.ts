import type { UiLanguage } from '../src/providers/types';
import { localizedText } from '../src/i18n/language';

type FetchLike = typeof fetch;

const OLLAMA_CLOCK_REFERENCE_URL = 'https://ollama.com/';
const MINIMUM_RELEVANT_CLOCK_SKEW_MS = 5 * 60_000;

export function describeWindowsClockSkew(
  serverDateHeader: string | null,
  localNowMs = Date.now(),
  language: UiLanguage = 'nl',
) {
  if (!serverDateHeader) return null;
  const serverTimeMs = Date.parse(serverDateHeader);
  if (!Number.isFinite(serverTimeMs) || !Number.isFinite(localNowMs)) return null;

  // Positief betekent: de server is verder dan deze pc, dus de pc loopt achter.
  const skewMs = serverTimeMs - localNowMs;
  if (Math.abs(skewMs) < MINIMUM_RELEVANT_CLOCK_SKEW_MS) return null;

  const duration = formatApproximateDuration(Math.abs(skewMs), language);
  return localizedText(
    language,
    `De Windows-klok loopt ongeveer ${duration} ${skewMs > 0 ? 'achter' : 'voor'}. Open Instellingen > Tijd en taal > Datum en tijd, zet "Tijd automatisch instellen" aan en kies "Nu synchroniseren". Start Ollama daarna opnieuw en probeer opnieuw.`,
    `The Windows clock is about ${duration} ${skewMs > 0 ? 'behind' : 'ahead'}. Open Settings > Time & language > Date & time, enable “Set time automatically”, then choose “Sync now”. Restart Ollama and try again.`,
  );
}

export async function diagnoseOllamaClockSkew(
  fetchImpl: FetchLike = fetch,
  localNowMs = Date.now(),
  language: UiLanguage = 'nl',
) {
  try {
    const response = await fetchImpl(OLLAMA_CLOCK_REFERENCE_URL, {
      method: 'HEAD',
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    return describeWindowsClockSkew(response.headers.get('date'), localNowMs, language);
  } catch {
    // De oorspronkelijke Ollama-fout blijft leidend als deze diagnose niet lukt.
    return null;
  }
}

function formatApproximateDuration(milliseconds: number, language: UiLanguage) {
  const days = milliseconds / (24 * 60 * 60_000);
  if (days >= 1.5) {
    const rounded = Math.max(2, Math.round(days));
    return localizedText(language, `${rounded} dagen`, `${rounded} days`);
  }

  const hours = milliseconds / (60 * 60_000);
  if (hours >= 1.5) {
    const rounded = Math.max(2, Math.round(hours));
    return localizedText(language, `${rounded} uur`, `${rounded} hours`);
  }

  const minutes = Math.max(5, Math.round(milliseconds / 60_000));
  return localizedText(language, `${minutes} minuten`, `${minutes} minutes`);
}
