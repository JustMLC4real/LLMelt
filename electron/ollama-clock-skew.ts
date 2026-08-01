type FetchLike = typeof fetch;

const OLLAMA_CLOCK_REFERENCE_URL = 'https://ollama.com/';
const MINIMUM_RELEVANT_CLOCK_SKEW_MS = 5 * 60_000;

export function describeWindowsClockSkew(
  serverDateHeader: string | null,
  localNowMs = Date.now(),
) {
  if (!serverDateHeader) return null;
  const serverTimeMs = Date.parse(serverDateHeader);
  if (!Number.isFinite(serverTimeMs) || !Number.isFinite(localNowMs)) return null;

  // Positief betekent: de server is verder dan deze pc, dus de pc loopt achter.
  const skewMs = serverTimeMs - localNowMs;
  if (Math.abs(skewMs) < MINIMUM_RELEVANT_CLOCK_SKEW_MS) return null;

  const direction = skewMs > 0 ? 'achter' : 'voor';
  const duration = formatApproximateDuration(Math.abs(skewMs));
  return `De Windows-klok loopt ongeveer ${duration} ${direction}. `
    + 'Open Instellingen > Tijd en taal > Datum en tijd, zet '
    + '"Tijd automatisch instellen" aan en kies "Nu synchroniseren". '
    + 'Start Ollama daarna opnieuw en probeer opnieuw.';
}

export async function diagnoseOllamaClockSkew(
  fetchImpl: FetchLike = fetch,
  localNowMs = Date.now(),
) {
  try {
    const response = await fetchImpl(OLLAMA_CLOCK_REFERENCE_URL, {
      method: 'HEAD',
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    return describeWindowsClockSkew(response.headers.get('date'), localNowMs);
  } catch {
    // De oorspronkelijke Ollama-fout blijft leidend als deze diagnose niet lukt.
    return null;
  }
}

function formatApproximateDuration(milliseconds: number) {
  const days = milliseconds / (24 * 60 * 60_000);
  if (days >= 1.5) {
    const rounded = Math.max(2, Math.round(days));
    return `${rounded} dagen`;
  }

  const hours = milliseconds / (60 * 60_000);
  if (hours >= 1.5) {
    const rounded = Math.max(2, Math.round(hours));
    return `${rounded} uur`;
  }

  const minutes = Math.max(5, Math.round(milliseconds / 60_000));
  return `${minutes} minuten`;
}
