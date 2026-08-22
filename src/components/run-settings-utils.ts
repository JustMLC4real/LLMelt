import type { AIModel, ChatgptVersion, ModelRunConfig, ProviderType, UiLanguage } from '../providers/types';
import {
  chatgptPresetFor,
  codexRunConfig,
  modelDisplayName,
  selectableModels,
} from './model-utils';

export type RunSettingsModelChoice = {
  key: string;
  label: string;
  modelId: string;
  provider: ProviderType;
  runConfig?: ModelRunConfig;
};

const COMMAND_FIELDS: Array<keyof ModelRunConfig> = [
  'commandPresetId',
  'commandGoal',
  'commandInstruction',
  'nativeProviderCommand',
];

/**
 * De compacte run-kiezer blijft binnen hetzelfde provideroppervlak. Een wissel
 * binnen Claude CLI mag bijvoorbeeld niet ongemerkt naar Claude API springen.
 */
export function runSettingsModelChoices(
  models: AIModel[],
  activeModel: AIModel | undefined,
  activeRunConfig: ModelRunConfig | undefined,
  chatgptVersions: ChatgptVersion[],
  language: UiLanguage,
): RunSettingsModelChoice[] {
  if (!activeModel) return [];
  if (isChatgptWebModel(activeModel)) {
    return chatgptVersionChoices(models, activeModel, activeRunConfig, chatgptVersions);
  }

  const surface = modelSurfaceKey(activeModel);
  return selectableModels(models)
    .filter((model) => model.provider === activeModel.provider && modelSurfaceKey(model) === surface)
    .sort(compareCatalogModels)
    .map((model) => ({
      key: model.id,
      // Model en inspanning zijn in Geavanceerd twee losse controls. Door de
      // catalogusdefault hier niet in de modelnaam te plakken ontstaan geen
      // regels als "5.6 Sol · Gemiddeld" in de modelkeuze.
      label: modelDisplayName(model, language),
      modelId: model.id,
      provider: model.provider,
      runConfig: compatibleRunConfig(model, activeRunConfig, model.id === activeModel.id),
    }));
}

export function activeRunSettingsChoiceKey(
  activeModel: AIModel | undefined,
  activeRunConfig: ModelRunConfig | undefined,
): string {
  if (!activeModel) return '';
  if (isChatgptWebModel(activeModel)) {
    return activeRunConfig?.chatgptVersionId || activeModel.id;
  }
  return activeModel.id;
}

function chatgptVersionChoices(
  models: AIModel[],
  activeModel: AIModel,
  activeRunConfig: ModelRunConfig | undefined,
  versions: ChatgptVersion[],
): RunSettingsModelChoice[] {
  const enabled = versions.filter((version) => version.enabled);
  const currentHit = chatgptPresetFor(enabled, activeModel.id, activeRunConfig?.chatgptThinkingEffort);
  const configuredVersion = enabled.find((version) => version.id === activeRunConfig?.chatgptVersionId);
  const configuredPreset = configuredVersion?.presets.find((preset) => (
    `chatgpt:${preset.modelSlug}` === activeModel.id
    && (preset.thinkingEffort || undefined) === (activeRunConfig?.chatgptThinkingEffort || undefined)
  ));
  const preferredTitle = configuredPreset?.title || currentHit?.preset.title;
  const commandConfig = preservedCommandConfig(activeRunConfig);

  return enabled.flatMap((version) => {
    const preset = version.presets.find((candidate) => candidate.available && candidate.title === preferredTitle)
      || version.presets.find((candidate) => candidate.available)
      || version.presets[0];
    const modelId = preset ? `chatgpt:${preset.modelSlug}` : version.slugs[0] ? `chatgpt:${version.slugs[0]}` : '';
    const model = models.find((candidate) => candidate.provider === 'openai' && candidate.id === modelId);
    if (!modelId || !model) return [];

    const runConfig: ModelRunConfig = {
      ...(model.runConfig || {}),
      ...commandConfig,
      chatgptVersionId: version.id,
    };
    if (preset?.thinkingEffort) runConfig.chatgptThinkingEffort = preset.thinkingEffort;
    else delete runConfig.chatgptThinkingEffort;

    return [{
      key: version.id,
      label: version.title,
      modelId,
      provider: 'openai' as const,
      runConfig,
    }];
  });
}

function compatibleRunConfig(model: AIModel, current?: ModelRunConfig, isActiveModel = false): ModelRunConfig | undefined {
  const next: ModelRunConfig = {
    ...(model.runConfig || {}),
    ...preservedCommandConfig(current),
  };

  if (model.provider === 'codex' && !isActiveModel && model.supportedReasoningEfforts?.includes('high')) {
    // Nieuwe Codex-modelkeuzes starten op de door de gebruiker gewenste live
    // High-stand. De waarde wordt alleen gebruikt als de CLI hem publiceert.
    next.reasoningEffort = 'high';
  } else if (current?.reasoningEffort && model.supportedReasoningEfforts?.includes(current.reasoningEffort)) {
    next.reasoningEffort = current.reasoningEffort;
  }
  if (current?.serviceTier && model.supportedServiceTiers?.includes(current.serviceTier)) {
    next.serviceTier = current.serviceTier;
  }

  const configured = model.provider === 'codex' ? codexRunConfig(model, next) : next;
  return configured && Object.keys(configured).length ? configured : undefined;
}

function preservedCommandConfig(current?: ModelRunConfig): ModelRunConfig {
  const preserved: ModelRunConfig = {};
  for (const key of COMMAND_FIELDS) {
    const value = current?.[key];
    if (value !== undefined) Object.assign(preserved, { [key]: value });
  }
  return preserved;
}

function isChatgptWebModel(model: AIModel) {
  return model.provider === 'openai' && model.id.startsWith('chatgpt:');
}

function modelSurfaceKey(model: AIModel) {
  if (isChatgptWebModel(model)) return 'chatgpt-web';
  if (model.provider === 'openai') return model.providerSurface || 'openai-api';
  if (model.provider === 'anthropic') {
    return model.id.startsWith('claude-cli:') ? 'claude-cli' : model.providerSurface || 'claude-api';
  }
  return model.providerSurface || model.executionMode || model.provider;
}

function compareCatalogModels(a: AIModel, b: AIModel) {
  return (a.catalogPriority ?? Number.MAX_SAFE_INTEGER) - (b.catalogPriority ?? Number.MAX_SAFE_INTEGER)
    || a.name.localeCompare(b.name, undefined, { numeric: true });
}
