import type { ChatgptVersion } from '../src/providers/types';

export function chatGptChoiceValidationError(
  versions: ChatgptVersion[],
  liveSlugs: Set<string>,
  modelSlug: string,
  thinkingEffort?: string,
) {
  const slug = String(modelSlug || '').replace(/^chatgpt:/, '');
  if (!slug) return 'Kies eerst een ChatGPT-model uit de live catalogus.';
  if (!liveSlugs.has(slug)) {
    return `ChatGPT-model ${slug} staat niet in de huidige live webcatalogus. `
      + 'Vernieuw de modellen of log opnieuw in; er wordt niet stil naar Instant teruggevallen.';
  }

  const presets = versions
    .flatMap((version) => version.presets)
    .filter((preset) => preset.modelSlug === slug);
  if (!presets.length) {
    return thinkingEffort
      ? `ChatGPT-model ${slug} biedt het gekozen intelligentieniveau niet meer aan.`
      : null;
  }
  const selected = thinkingEffort
    ? presets.find((preset) => preset.thinkingEffort === thinkingEffort)
    : presets[0];
  if (!selected) {
    return `ChatGPT-model ${slug} biedt intelligentieniveau ${thinkingEffort} niet meer aan.`;
  }
  if (!selected.available) {
    return `ChatGPT-intelligentieniveau ${selected.title} is niet beschikbaar voor dit account.`;
  }
  return null;
}
