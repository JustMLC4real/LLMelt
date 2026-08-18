import type { ChatgptVersion, UiLanguage } from '../src/providers/types';
import { localizedText } from '../src/i18n/language';

export function chatGptChoiceValidationError(
  versions: ChatgptVersion[],
  liveSlugs: Set<string>,
  modelSlug: string,
  thinkingEffort?: string,
  language: UiLanguage = 'nl',
) {
  const slug = String(modelSlug || '').replace(/^chatgpt:/, '');
  if (!slug) return localizedText(language, 'Kies eerst een ChatGPT-model uit de live catalogus.', 'Choose a ChatGPT model from the live catalog first.');
  if (!liveSlugs.has(slug)) {
    return localizedText(
      language,
      `ChatGPT-model ${slug} staat niet in de huidige live webcatalogus. Vernieuw de modellen of log opnieuw in; er wordt niet stil naar Instant teruggevallen.`,
      `ChatGPT model ${slug} is not in the current live web catalog. Refresh the models or sign in again; the app will not silently fall back to Instant.`,
    );
  }

  const presets = versions
    .flatMap((version) => version.presets)
    .filter((preset) => preset.modelSlug === slug);
  if (!presets.length) {
    return thinkingEffort
      ? localizedText(language, `ChatGPT-model ${slug} biedt het gekozen intelligentieniveau niet meer aan.`, `ChatGPT model ${slug} no longer offers the selected intelligence level.`)
      : null;
  }
  const selected = thinkingEffort
    ? presets.find((preset) => preset.thinkingEffort === thinkingEffort)
    : presets[0];
  if (!selected) {
    return localizedText(language, `ChatGPT-model ${slug} biedt intelligentieniveau ${thinkingEffort} niet meer aan.`, `ChatGPT model ${slug} no longer offers intelligence level ${thinkingEffort}.`);
  }
  if (!selected.available) {
    return localizedText(language, `ChatGPT-intelligentieniveau ${selected.title} is niet beschikbaar voor dit account.`, `ChatGPT intelligence level ${selected.title} is not available for this account.`);
  }
  return null;
}
