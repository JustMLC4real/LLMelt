import type { AIModel, ModelRunConfig, ProviderType } from '../providers/types';

export type ReplacementModelRef = {
  modelId: string;
  provider: ProviderType;
  runConfig?: ModelRunConfig;
};

/**
 * Alleen een verdwenen actieve Ollama-keuze wordt hersteld. Installeren of
 * verwijderen mag een geldige keuze voor een andere provider nooit wijzigen.
 */
export function replacementAfterOllamaCatalogChange(
  active: { modelId: string; provider: ProviderType },
  available: AIModel[],
): ReplacementModelRef | null {
  if (active.provider !== 'ollama') return null;
  if (available.some((model) => model.provider === active.provider && model.id === active.modelId)) {
    return null;
  }
  const fallback = available[0];
  return fallback
    ? { modelId: fallback.id, provider: fallback.provider, runConfig: fallback.runConfig }
    : { modelId: '', provider: 'ollama' };
}
