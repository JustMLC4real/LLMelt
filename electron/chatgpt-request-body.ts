/**
 * Houd de keuze uit LLMelt leidend in de request die de echte ChatGPT-webapp
 * zelf opbouwt. Alle browserheaders, cookies en beveiligingsvelden blijven van
 * de website; alleen de live gevalideerde model- en effortkeuze wordt gezet.
 *
 * Geen imports toevoegen: de scraper injecteert de bron van deze functie in de
 * geïsoleerde webpagina en de unit-test gebruikt exact dezelfde code.
 */
export function patchChatGptConversationBody(
  body: unknown,
  modelSlug: unknown,
  thinkingEffort?: unknown,
) {
  if (typeof body !== 'string' || typeof modelSlug !== 'string' || !modelSlug.trim()) return body;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
    parsed.model = modelSlug;
    if (typeof thinkingEffort === 'string' && thinkingEffort) {
      parsed.thinking_effort = thinkingEffort;
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}
