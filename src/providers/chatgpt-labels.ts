/** Providerlabels zijn presentatietekst, geen wire-waarden. ChatGPT kan dezelfde
 * niveaus Nederlands of Engels teruggeven; onbekende toekomstige labels blijven
 * intact, zodat de live catalogus leidend blijft. */
export function chatgptIntelligenceLabel(value: unknown): string {
  const original = String(value || '').trim();
  const normalized = original.toLowerCase().replace(/[\s_-]+/g, ' ');
  const labels: Record<string, string> = {
    instant: 'Direct',
    direct: 'Direct',
    medium: 'Gemiddeld',
    gemiddeld: 'Gemiddeld',
    high: 'Hoog',
    hoog: 'Hoog',
    'extra high': 'Zeer Hoog',
    'very high': 'Zeer Hoog',
    xhigh: 'Zeer Hoog',
    'zeer hoog': 'Zeer Hoog',
    pro: 'Pro',
  };
  return labels[normalized] || original;
}
