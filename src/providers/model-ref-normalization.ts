import type { ModelRunConfig, ProviderType } from './types';

/**
 * Oude Codex-selecties konden een UI-modus als `model#thinking` bewaren.
 * De suffix was nooit een live capabilitycontract. Strip hem daarom zonder
 * zelf een effort te raden; de actuele catalogus/provider kiest de default.
 */
export function normalizeLegacyModelId(
  provider: ProviderType,
  modelId: string,
): { modelId: string; runConfig?: ModelRunConfig } {
  if (provider !== 'codex') return { modelId };
  const [baseModelId] = modelId.split('#');
  return {
    modelId: baseModelId,
    runConfig: { baseModelId },
  };
}
