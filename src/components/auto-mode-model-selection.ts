import type {
  AIModel,
  ChatgptIntelligencePreset,
  ChatgptVersion,
  ModelRef,
  ModelRunConfig,
  ReasoningEffort,
  ServiceTier,
} from '../providers/types';
import { configuredModelRef, surfaceLabel } from './model-utils';

export interface AutoModeChatgptChoice {
  version: ChatgptVersion;
  model: AIModel;
  preset?: ChatgptIntelligencePreset;
}

export function autoModeSurfaces(models: AIModel[]) {
  return [...new Set(models.map(surfaceLabel))];
}

export function autoModeModelsForSurface(models: AIModel[], surface: string) {
  return models.filter((model) => surfaceLabel(model) === surface);
}

export function autoModeModelKey(model: AIModel) {
  return `${model.provider}:${model.id}`;
}

export function autoModeModelByKey(models: AIModel[], key: string) {
  return models.find((model) => autoModeModelKey(model) === key);
}

function liveChatgptModel(models: AIModel[], slug: string) {
  return models.find((model) => model.provider === 'openai' && model.id === `chatgpt:${slug}`);
}

/** Alleen werkelijk klikbare niveaus: live model én door ChatGPT beschikbaar. */
export function availableAutoModeChatgptPresets(version: ChatgptVersion, models: AIModel[]) {
  return version.presets.filter((preset) =>
    preset.available
    // Een subtitle betekent volgens ChatGPT dat dit niveau feitelijk een andere
    // versie gebruikt (bijv. "Direct · 5.5" onder GPT-5.6). Auto Mode toont alleen
    // native, werkelijk selecteerbare combinaties om zo'n schijnkeuze te voorkomen.
    && !preset.subtitle
    && !!liveChatgptModel(models, preset.modelSlug));
}

/** Verberg versies waarvoor de live catalogus geen enkele geldige keuze heeft. */
export function availableAutoModeChatgptVersions(versions: ChatgptVersion[], models: AIModel[]) {
  return versions.filter((version) => {
    if (!version.enabled) return false;
    if (version.presets.length) return availableAutoModeChatgptPresets(version, models).length > 0;
    return version.slugs.some((slug) => !!liveChatgptModel(models, slug));
  });
}

export function autoModeChatgptChoiceForVersion(
  version: ChatgptVersion,
  models: AIModel[],
  preferredPresetTitle?: string,
): AutoModeChatgptChoice | null {
  const presets = availableAutoModeChatgptPresets(version, models);
  const preset = presets.find((candidate) => candidate.title === preferredPresetTitle) || presets[0];
  if (preset) {
    const model = liveChatgptModel(models, preset.modelSlug);
    return model ? { version, model, preset } : null;
  }
  if (version.presets.length) return null;
  const slug = version.slugs.find((candidate) => !!liveChatgptModel(models, candidate));
  const model = slug ? liveChatgptModel(models, slug) : undefined;
  return model ? { version, model } : null;
}

/**
 * Herleidt een opgeslagen ModelRef naar een geldige versie+niveau-combinatie.
 * Een uitgeschakeld niveau mag dus nooit als ogenschijnlijk geselecteerde optie
 * in Auto Mode blijven staan.
 */
export function autoModeChatgptChoiceForRef(
  versions: ChatgptVersion[],
  models: AIModel[],
  ref?: ModelRef | null,
): AutoModeChatgptChoice | null {
  const visibleVersions = availableAutoModeChatgptVersions(versions, models);
  if (!visibleVersions.length) return null;
  const slug = ref?.modelId.replace(/^chatgpt:/, '');
  const effort = ref?.runConfig?.chatgptThinkingEffort || undefined;
  if (slug) {
    const matches = visibleVersions.flatMap((version) =>
      availableAutoModeChatgptPresets(version, models)
        .filter((preset) => preset.modelSlug === slug
          && (preset.thinkingEffort || undefined) === effort)
        .map((preset) => ({ version, preset })));
    const match = matches.find((candidate) => !candidate.preset.subtitle) || matches[0];
    const model = match ? liveChatgptModel(models, match.preset.modelSlug) : undefined;
    if (match && model) return { ...match, model };

    const bare = visibleVersions.find((version) =>
      !version.presets.length && version.slugs.includes(slug));
    const bareModel = bare ? liveChatgptModel(models, slug) : undefined;
    if (bare && bareModel) return { version: bare, model: bareModel };
  }
  return autoModeChatgptChoiceForVersion(visibleVersions[0], models);
}

export function autoModeChatgptRefForChoice(choice: AutoModeChatgptChoice, current?: ModelRef | null): ModelRef {
  const ref = autoModeModelRef(choice.model, current);
  const runConfig = { ...(ref.runConfig || {}) };
  if (choice.preset?.thinkingEffort) runConfig.chatgptThinkingEffort = choice.preset.thinkingEffort;
  else delete runConfig.chatgptThinkingEffort;
  return {
    ...ref,
    runConfig: Object.keys(runConfig).length ? runConfig : undefined,
  };
}

export function normalizeAutoModeChatgptRef(
  versions: ChatgptVersion[],
  models: AIModel[],
  ref?: ModelRef | null,
): ModelRef | null {
  const choice = autoModeChatgptChoiceForRef(versions, models, ref);
  return choice ? autoModeChatgptRefForChoice(choice, ref) : null;
}

export function autoModeModelRef(model: AIModel, current?: ModelRef | null): ModelRef {
  const configured = configuredModelRef(model, current?.runConfig);
  const defaults = model.runConfig || {};
  const previous = current?.provider === model.provider && current.modelId === model.id
    ? current.runConfig || {}
    : {};
  const runConfig: ModelRunConfig = { ...defaults };

  const efforts = model.supportedReasoningEfforts || [];
  const requestedEffort = previous.reasoningEffort || defaults.reasoningEffort || model.defaultReasoningEffort;
  if (requestedEffort && efforts.includes(requestedEffort)) runConfig.reasoningEffort = requestedEffort;
  else if (model.defaultReasoningEffort && efforts.includes(model.defaultReasoningEffort)) {
    runConfig.reasoningEffort = model.defaultReasoningEffort;
  } else {
    delete runConfig.reasoningEffort;
  }

  const tiers = model.supportedServiceTiers || [];
  const requestedTier = previous.serviceTier || defaults.serviceTier;
  if (requestedTier && tiers.includes(requestedTier)) runConfig.serviceTier = requestedTier;
  else delete runConfig.serviceTier;

  const chatgptEfforts = model.chatgptThinkingEfforts || [];
  const requestedChatgptEffort = previous.chatgptThinkingEffort || defaults.chatgptThinkingEffort;
  if (requestedChatgptEffort && chatgptEfforts.some((effort) => effort.value === requestedChatgptEffort)) {
    runConfig.chatgptThinkingEffort = requestedChatgptEffort;
  } else {
    delete runConfig.chatgptThinkingEffort;
  }

  return {
    ...configured,
    runConfig: Object.keys(runConfig).length ? runConfig : undefined,
  };
}

export function withAutoModeReasoningEffort(ref: ModelRef, value: string): ModelRef {
  return {
    ...ref,
    runConfig: {
      ...(ref.runConfig || {}),
      reasoningEffort: value as ReasoningEffort,
    },
  };
}

export function withAutoModeServiceTier(ref: ModelRef, value: string): ModelRef {
  return {
    ...ref,
    runConfig: {
      ...(ref.runConfig || {}),
      serviceTier: value as ServiceTier,
    },
  };
}

export function withAutoModeChatgptEffort(ref: ModelRef, value: string): ModelRef {
  return {
    ...ref,
    runConfig: {
      ...(ref.runConfig || {}),
      chatgptThinkingEffort: value,
    },
  };
}
