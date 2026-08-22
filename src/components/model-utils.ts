import { PROVIDER_INFO, type AIModel, type ChatgptIntelligencePreset, type ChatgptVersion, type CredentialStatus, type ModelRunConfig, type ProviderType, type ReasoningEffort, type ServiceTier, type UiLanguage } from '../providers/types';
import { localizedText } from '../i18n/language';
import { limitGroupForModel } from './ui';

// Leesbare naam voor een Codex-servicetier. "standard"/"fast" volgen de woorden
// uit de Codex-GUI; overige providerwaarden blijven herkenbaar intact.
export function serviceTierLabel(tier: string, language: UiLanguage = 'nl'): string {
  const t = (tier || '').toLowerCase();
  if (t === 'standard' || t === 'default' || t === '') return localizedText(language, 'Standaard', 'Standard');
  if (t === 'fast' || t === 'priority') return localizedText(language, 'Snel', 'Fast');
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

// Houd de wire-waarde los van het zichtbare label. De live Codex-catalogus kan zowel max als ultra
// aanbieden; dat zijn in de officiële kiezer twee verschillende regels.
export function reasoningEffortLabel(effort: string, language: UiLanguage = 'nl'): string {
  const labels: Record<string, [string, string]> = {
    low: ['Licht', 'Low'],
    medium: ['Gemiddeld', 'Medium'],
    high: ['Hoog', 'High'],
    xhigh: ['Zeer Hoog', 'Very High'],
    max: ['Max', 'Max'],
    ultra: ['Ultra', 'Ultra'],
  };
  const label = labels[effort.toLowerCase()];
  return label ? localizedText(language, label[0], label[1]) : effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * Geeft uitsluitend inspanningsniveaus terug die het actuele model zelf heeft
 * gepubliceerd. Een lege lijst betekent bewust dat de app geen instelbare
 * inspanning mag tonen of naar de provider mag sturen.
 */
export function reasoningEffortsForModel(model?: AIModel): ReasoningEffort[] {
  return Array.from(new Set(model?.supportedReasoningEfforts || []));
}

export function reasoningEffortForModel(
  model: AIModel | undefined,
  requested?: ReasoningEffort | '',
): ReasoningEffort | undefined {
  const efforts = reasoningEffortsForModel(model);
  if (requested && efforts.includes(requested)) return requested;
  if (model?.defaultReasoningEffort && efforts.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  // Een live lijst zegt alleen welke waarden geldig zijn, niet welke waarde de
  // provider standaard kiest. Zonder expliciete catalogusdefault laten we het
  // argument daarom weg en behoudt de CLI zijn eigen providerdefault.
  return undefined;
}

/** Bouwt een runconfig zonder een oude/verzonnen effort door te laten lekken. */
export function runConfigWithAdvertisedEffort(
  model: AIModel | undefined,
  current?: ModelRunConfig,
  requested?: ReasoningEffort | '',
): ModelRunConfig | undefined {
  const next = { ...(model?.runConfig || {}), ...(current || {}) };
  delete next.reasoningEffort;
  const effort = reasoningEffortForModel(model, requested);
  if (effort) next.reasoningEffort = effort;
  return Object.keys(next).length ? next : undefined;
}

export function providerLabel(provider: ProviderType) {
  if (provider === 'openai') return 'ChatGPT / OpenAI API';
  return PROVIDER_INFO[provider]?.name || provider;
}

export function codexModelLabel(value: string) {
  return value
    .replace(/^GPT-/i, '')
    .replace(/^(\d+(?:\.\d+)+)-/, '$1 ')
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export function parseCodexModel(model?: AIModel, language: UiLanguage = 'nl'): { version: string; variant: string } {
  const label = modelDisplayName(model, language);
  const match = label.match(/^(\d+(?:\.\d+)+)(?:\s+(.+))?$/);
  return {
    version: match?.[1] || label,
    variant: match?.[2] || localizedText(language, 'Standaard', 'Standard'),
  };
}

export function modelDisplayName(model?: AIModel): string;
export function modelDisplayName(model: AIModel | undefined, language: UiLanguage): string;
export function modelDisplayName(model?: AIModel, language: UiLanguage = 'nl') {
  if (!model) return localizedText(language, 'Geen model', 'No model');
  if (model.provider === 'codex') {
    return codexModelLabel(model.name.replace(/\s*\(CLI\)$/i, ''));
  }
  return model.name;
}

export function surfaceLabel(model: AIModel, language: UiLanguage = 'nl') {
  const explicitLabel = model.surfaceLabel?.trim();
  if (explicitLabel) {
    const knownLabels: Record<string, [string, string]> = {
      'chatgpt subscription': ['ChatGPT-abonnement', 'ChatGPT Subscription'],
      'ollama local': ['Ollama lokaal', 'Ollama local'],
      local: ['Lokaal', 'Local'],
    };
    const known = knownLabels[explicitLabel.toLowerCase()];
    return known ? localizedText(language, known[0], known[1]) : explicitLabel;
  }
  if (model.provider === 'openai' && model.id.startsWith('chatgpt:')) {
    return localizedText(language, 'ChatGPT-abonnement', 'ChatGPT Subscription');
  }
  if (model.provider === 'openai') return 'OpenAI API';
  if (model.provider === 'codex') return 'Codex CLI';
  if (model.provider === 'anthropic') return model.id.startsWith('claude-cli:') ? 'Claude CLI' : 'Claude API';
  if (model.provider === 'google') return 'Gemini API';
  if (model.provider === 'ollama') return localizedText(language, 'Lokaal', 'Local');
  return providerLabel(model.provider);
}

function choiceParts(...parts: Array<string | undefined | null | false>) {
  return parts.map((part) => String(part || '').trim()).filter(Boolean).join(' · ');
}

/** Eén actuele, provider-neutrale samenvatting voor compacte modelkeuzes. */
export function modelChoiceLabel(
  model: AIModel,
  chatgptVersions: ChatgptVersion[] = [],
  language: UiLanguage = 'nl',
) {
  if (model.provider === 'openai' && model.id.startsWith('chatgpt:')) {
    return choiceParts(
      surfaceLabel(model, language),
      chatgptPresetLabel(chatgptVersions, model.id, model.runConfig?.chatgptThinkingEffort) || modelDisplayName(model, language),
    );
  }
  if (model.provider === 'codex') {
    const parsed = parseCodexModel(model, language);
    const config = codexRunConfig(model, model.runConfig) || {};
    return choiceParts(
      surfaceLabel(model, language),
      parsed.version,
      parsed.variant,
      config.reasoningEffort && reasoningEffortLabel(config.reasoningEffort, language),
      config.serviceTier && serviceTierLabel(config.serviceTier, language),
    );
  }
  if (model.provider === 'anthropic' && model.id.startsWith('claude-cli:')) {
    const parsed = parseClaudeCliModel(model, language);
    const effort = model.runConfig?.reasoningEffort || model.defaultReasoningEffort;
    return choiceParts(surfaceLabel(model, language), parsed.family, parsed.version, effort && reasoningEffortLabel(effort, language));
  }
  if (model.provider === 'antigravity') {
    const parsed = parseAntigravityModel(model, language);
    return choiceParts(surfaceLabel(model, language), parsed.provider, parsed.model, parsed.mode);
  }
  if (model.provider === 'google') {
    const parsed = parseGoogleModelChoice(model, language);
    return choiceParts(surfaceLabel(model, language), parsed.family, parsed.version, parsed.variant);
  }
  return choiceParts(surfaceLabel(model, language), modelDisplayName(model, language));
}

/** In een al per provider gegroepeerde lijst hoeft de providernaam niet op iedere regel terug te komen. */
export function compactModelChoiceLabel(
  model: AIModel,
  chatgptVersions: ChatgptVersion[] = [],
  language: UiLanguage = 'nl',
) {
  const fullLabel = modelChoiceLabel(model, chatgptVersions, language);
  const prefix = `${surfaceLabel(model, language)} · `;
  return fullLabel.startsWith(prefix) ? fullLabel.slice(prefix.length) : fullLabel;
}

export function selectableModels(models: AIModel[]) {
  return models.filter((model) => typeof model?.id === 'string'
    && model.id.trim().length > 0
    && typeof model.name === 'string'
    && model.name.trim().length > 0
    && model.canChat !== false
    && model.executionMode !== 'connector');
}

/**
 * Herstelt een opgeslagen keuze uitsluitend uit de actuele catalogus van
 * dezelfde provider. Zo kan een verdwenen model nooit alsnog naar de CLI
 * worden gestuurd, zonder stilletjes naar een andere aanbieder te wisselen.
 */
export function replacementForUnavailableModel(
  models: AIModel[],
  provider?: ProviderType | null,
  modelId?: string | null,
) {
  if (!provider || !modelId) return undefined;
  const available = selectableModels(models).filter((model) => model.provider === provider);
  if (available.some((model) => model.id === modelId)) return undefined;
  const ordered = provider === 'codex' ? codexModels(available) : available;
  return ordered.find((model) => model.isRecommended) || ordered[0];
}

/** Splitst Google-modelnamen live op voor dezelfde Familie/Versie/Variant-UI als
 * de andere providers. Er staat bewust geen vaste lijst met modelnamen in. */
export function parseGoogleModelChoice(model?: AIModel, language: UiLanguage = 'nl') {
  if (!model) return { family: '', version: '', variant: '' };
  const rawId = model.id.replace(/^models\//, '');
  const idParts = rawId.split('-').filter(Boolean);
  const familyRaw = idParts[0] || 'google';
  const versionIndex = idParts.findIndex((part, index) => index > 0 && /^\d+(?:\.\d+)?[a-z]?$/i.test(part));
  const versionRaw = versionIndex >= 0 ? idParts[versionIndex] : 'overig';
  const family = titleCaseModelPart(familyRaw);
  const version = versionRaw.toLowerCase() === 'overig'
    ? localizedText(language, 'Overig', 'Other')
    : versionRaw;

  const display = modelDisplayName(model, language);
  const prefix = versionRaw.toLowerCase() === 'overig' ? family : `${family} ${version}`;
  const displayVariant = display.toLowerCase().startsWith(prefix.toLowerCase())
    ? display.slice(prefix.length).trim()
    : '';
  const fallbackParts = versionIndex >= 0 ? idParts.slice(versionIndex + 1) : idParts.slice(1);
  const variant = displayVariant
    || fallbackParts.map(titleCaseModelPart).join(' ')
    || localizedText(language, 'Standaard', 'Standard');
  return { family, version, variant };
}

function titleCaseModelPart(value: string) {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.length <= 4 && /\d/.test(part) ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

/**
 * Centrale renderer-regel voor de modelkiezer: een oud modelobject of alleen
 * een gevonden executable is nooit bewijs dat de gebruiker ermee kan chatten.
 */
export function connectedModels(
  models: AIModel[],
  authStatus: Record<ProviderType, CredentialStatus>,
  chatgptSessionActive?: boolean,
) {
  return selectableModels(models).filter((model) => {
    if (model.provider === 'openai' && model.id.startsWith('chatgpt:')) {
      return chatgptSessionActive === true;
    }
    const status = authStatus[model.provider];
    return status?.authenticated === true && status.canChat !== false;
  });
}

export function codexModels(models: AIModel[]) {
  return selectableModels(models)
    .filter((model) => model.provider === 'codex')
    .sort((a, b) => (a.catalogPriority ?? Number.MAX_SAFE_INTEGER) - (b.catalogPriority ?? Number.MAX_SAFE_INTEGER)
      || modelDisplayName(a).localeCompare(modelDisplayName(b), undefined, { numeric: true }));
}

// Exact de live catalogusvolgorde; geen samenvoeging van max en ultra.
export function codexEffortsForModel(model?: AIModel): ReasoningEffort[] {
  return reasoningEffortsForModel(model);
}

export function codexEffortForModel(model: AIModel | undefined, requested?: ReasoningEffort): ReasoningEffort | undefined {
  return reasoningEffortForModel(model, requested);
}

export function isChatgptPickerModel(model: AIModel) {
  return model.provider === 'openai'
    && model.id.startsWith('chatgpt:')
    && model.providerSurface === 'subscription-web'
    && model.canChat !== false;
}

export function chatgptModels(models: AIModel[]) {
  // Live, honest list: every ChatGPT browser model exactly as the scraper returns
  // it — no name-guessing, no invented modes. New models (e.g. 5.6) show up by themselves.
  return selectableModels(models)
    .filter(isChatgptPickerModel)
    .sort((a, b) => modelDisplayName(a).localeCompare(modelDisplayName(b)));
}

// Live thinking-effort options for a specific model, straight from the API.
// Empty array = no configurable effort for this model.
export function chatgptEffortsForModel(
  model?: AIModel,
  versions: ChatgptVersion[] = [],
): { value: string; label: string }[] {
  if (!model || !model.chatgptConfigurableEffort) return [];
  return (model.chatgptThinkingEfforts || []).map((effort) => ({
    value: effort.value,
    // Gebruik dezelfde live intelligence_presets als de hoofdselector. De
    // thinking-effort blijft uitsluitend de wire-waarde naar ChatGPT.
    label: chatgptPresetFor(versions, model.id, effort.value)?.preset.title || effort.label,
  }));
}

export type ChatgptRunLevel = {
  key: string;
  label: string;
  modelId: string;
  thinkingEffort?: string;
  available: boolean;
  versionId: string;
};

/**
 * Geef voor Run-instellingen exact dezelfde rij en presets terug als de
 * hoofdselector. Een preset kan naar een ander model wijzen; daarom bevat elk
 * resultaat zowel de zichtbare titel als het echte model-id.
 */
export function chatgptRunLevels(
  versions: ChatgptVersion[],
  modelId: string,
  thinkingEffort?: string,
  preferredVersionId?: string,
): ChatgptRunLevel[] {
  const enabled = versions.filter((version) => version.enabled);
  const slug = modelId.replace(/^chatgpt:/, '');
  const version = enabled.find((candidate) => candidate.id === preferredVersionId)
    || enabled.find((candidate) => candidate.presets.some((preset) => (
      preset.modelSlug === slug
      && (preset.thinkingEffort || undefined) === (thinkingEffort || undefined)
    )))
    || enabled.find((candidate) => candidate.slugs.includes(slug))
    || enabled.find((candidate) => candidate.presets.some((preset) => preset.modelSlug === slug));

  return (version?.presets || []).map((preset) => {
    const presetModelId = `chatgpt:${preset.modelSlug}`;
    return {
      key: chatgptLevelKey(presetModelId, preset.thinkingEffort),
      label: preset.subtitle ? `${preset.title} · ${preset.subtitle}` : preset.title,
      modelId: presetModelId,
      thinkingEffort: preset.thinkingEffort,
      available: preset.available,
      versionId: version!.id,
    };
  });
}

/**
 * ChatGPT levert z'n modelkiezer zelf aan in `versions[]`. Een "niveau" (Direct,
 * Gemiddeld, Hoog, Pro) is geen model maar een combinatie van een bestaande slug
 * plus een thinking_effort. Deze sleutel identificeert die combinatie uniek.
 */
export function chatgptLevelKey(modelId: string, effort?: string): string {
  return effort ? `${modelId}|${effort}` : modelId;
}

/**
 * Zoekt bij een slug (+ effort) het bijbehorende niveau in ChatGPT's eigen kiezer.
 * Eén slug kan bij twee niveaus horen: Gemiddeld en Hoog draaien allebei op
 * `gpt-5-6-thinking`, alleen de thinking_effort verschilt.
 */
export function chatgptPresetFor(
  versions: ChatgptVersion[],
  modelId: string,
  effort?: string,
): { version: ChatgptVersion; preset: ChatgptIntelligencePreset } | null {
  const slug = modelId.replace(/^chatgpt:/, '');
  const matches: { version: ChatgptVersion; preset: ChatgptIntelligencePreset }[] = [];
  for (const version of versions) {
    for (const preset of version.presets) {
      if (preset.modelSlug === slug) matches.push({ version, preset });
    }
  }

  const sameEffort = matches.filter(
    (match) => (match.preset.thinkingEffort || undefined) === (effort || undefined),
  );
  const pool = sameEffort.length ? sameEffort : matches;
  // Een preset mét subtitle leent het model van een ándere versie: "Direct" op
  // GPT-5.6 Sol draait op gpt-5-5-instant en heeft subtitle "5.5". Kies daarom de
  // versie waar die slug thuishoort, anders zou er "GPT-5.6 Sol · Direct" staan
  // terwijl GPT-5.5 antwoordde.
  return pool.find((match) => !match.preset.subtitle) || pool[0] || null;
}

/**
 * Is de ChatGPT-websessie bruikbaar? De modellenlijst wordt bewaard als
 * laatst-bekend-goed en blijft dus gevuld nadat je uitlogt — die mag hier dus geen
 * bewijs zijn. Alleen zolang de sessiecheck nog niet binnen is (`undefined`) vallen
 * we optimistisch terug op de gecachte modellen, zodat de kaart niet rood knippert.
 */
export function chatgptWebSessionUsable(sessionActive: boolean | undefined, cachedModelCount: number): boolean {
  if (typeof sessionActive === 'boolean') return sessionActive;
  return cachedModelCount > 0;
}

/** "chatgpt:gpt-5-6-thinking" + effort "extended" -> "GPT-5.6 Sol · Hoog". */
export function chatgptPresetLabel(versions: ChatgptVersion[], modelId: string, effort?: string): string | null {
  const hit = chatgptPresetFor(versions, modelId, effort);
  if (hit) return `${hit.version.title} · ${hit.preset.title}`;

  const slug = modelId.replace(/^chatgpt:/, '');
  const bare = versions.find((version) => !version.presets.length && version.slugs.includes(slug));
  return bare ? bare.title : null;
}


export function claudeCliModels(models: AIModel[]) {
  return selectableModels(models)
    .filter((model) => model.provider === 'anthropic' && model.id.startsWith('claude-cli:'))
    .sort((a, b) => (a.catalogPriority ?? Number.MAX_SAFE_INTEGER) - (b.catalogPriority ?? Number.MAX_SAFE_INTEGER)
      || modelDisplayName(a).localeCompare(modelDisplayName(b), undefined, { numeric: true }));
}

export function parseClaudeCliModel(model?: AIModel, language: UiLanguage = 'nl'): { family: string; version: string } {
  if (!model) return { family: '', version: '' };
  const name = (model.name || model.id)
    .replace(/^claude-cli:/i, '')
    .replace(/^Claude\s+/i, '')
    .replace(/\s*\(CLI\)\s*$/i, '')
    .trim();
  const match = name.match(/^([A-Za-z]+)(?:\s+(.+))?$/);
  if (!match) return { family: name || 'Claude', version: '' };
  return { family: capitalize(match[1]), version: match[2]?.trim() || '' };
}

export function claudeCliFamilies(models: AIModel[], language: UiLanguage = 'nl') {
  return Array.from(new Set(claudeCliModels(models).map((model) => parseClaudeCliModel(model, language).family))).filter(Boolean);
}

export function claudeCliVersionsFor(models: AIModel[], family: string, language: UiLanguage = 'nl') {
  return Array.from(new Set(claudeCliModels(models)
    .filter((model) => parseClaudeCliModel(model, language).family === family)
    .map((model) => parseClaudeCliModel(model, language).version)))
    .sort((a, b) => compareVersionLike(b, a));
}

export function claudeCliModelFor(models: AIModel[], family: string, version: string, language: UiLanguage = 'nl') {
  return claudeCliModels(models).find((model) => {
    const parsed = parseClaudeCliModel(model, language);
    return parsed.family === family && parsed.version === version;
  });
}

export function antigravityModels(models: AIModel[]) {
  return selectableModels(models)
    .filter((model) => model.provider === 'antigravity')
    .sort((a, b) => modelDisplayName(a).localeCompare(modelDisplayName(b), undefined, { numeric: true }));
}

export function parseAntigravityModel(model?: AIModel, language: UiLanguage = 'nl'): { provider: string; model: string; mode: string } {
  if (!model) return { provider: '', model: '', mode: '' };
  const raw = (model.name || model.id).trim();
  const modeMatch = raw.match(/\s*\(([^)]+)\)\s*$/);
  const mode = antigravityModeLabel(modeMatch?.[1]?.trim() || 'standard', language);
  const base = raw.replace(/\s*\([^)]+\)\s*$/, '').trim();

  // Recente `agy models`-versies geven stabiele slugs terug, bijvoorbeeld
  // `Gemini-3.6-flash-medium` en `Claude-opus-4-6-thinking`. Oudere versies
  // gebruikten labels met spaties en een stand tussen haakjes. Ondersteun beide
  // vormen zonder de live catalogus tot een vaste modellenlijst te beperken.
  const slugMatch = base.match(/^(GPT-OSS|Gemini|Claude)[-_](.+)$/i);
  if (slugMatch) {
    const provider = normalizeProviderFamily(slugMatch[1]);
    const parts = slugMatch[2].split(/[-_]+/).filter(Boolean);
    const hasTrailingMode = antigravitySlugHasMode(provider, parts);
    const modelParts = hasTrailingMode ? parts.slice(0, -1) : parts;
    return {
      provider,
      model: humanizeAntigravitySlug(modelParts),
      mode: hasTrailingMode
        ? antigravityModeLabel(humanizeAntigravitySlug(parts.slice(-1)), language)
        : antigravityModeLabel('standard', language),
    };
  }

  const providerMatch = base.match(/^(Gemini|Claude|GPT-OSS)\s+(.+)$/i);
  if (providerMatch) {
    return {
      provider: normalizeProviderFamily(providerMatch[1]),
      model: providerMatch[2].trim(),
      mode,
    };
  }
  const [first, ...rest] = base.split(/\s+/);
  return {
    provider: normalizeProviderFamily(first || localizedText(language, 'Overig', 'Other')),
    model: rest.join(' ') || base || raw,
    mode,
  };
}

function antigravitySlugHasMode(provider: string, parts: string[]) {
  if (parts.length < 2) return false;
  const last = parts[parts.length - 1];
  if (/^\d+(?:\.\d+)?[a-z]*$/i.test(last)) return false;
  if (provider === 'Gemini') return parts.length >= 3 && /^\d+(?:\.\d+)?$/i.test(parts[0]);
  if (provider === 'Claude') return parts.slice(0, -1).some((part) => /^\d+(?:\.\d+)?$/.test(part));
  if (provider === 'GPT-OSS') return parts.slice(0, -1).some((part) => /\d/.test(part));
  return false;
}

function humanizeAntigravitySlug(parts: string[]) {
  const words: string[] = [];
  for (const part of parts) {
    if (/^\d+$/.test(part) && /^\d+(?:\.\d+)*$/.test(words[words.length - 1] || '')) {
      words[words.length - 1] = `${words[words.length - 1]}.${part}`;
    } else if (/^\d+(?:\.\d+)?[a-z]+$/i.test(part)) {
      words.push(part.toUpperCase());
    } else if (/^\d+(?:\.\d+)?$/.test(part)) {
      words.push(part);
    } else {
      words.push(capitalize(part));
    }
  }
  return words.join(' ');
}

export function antigravityProviders(models: AIModel[], language: UiLanguage = 'nl') {
  return orderBy(Array.from(new Set(antigravityModels(models).map((model) => parseAntigravityModel(model, language).provider))), [
    'Gemini',
    'Claude',
    'GPT-OSS',
  ]);
}

export function antigravityModelNamesFor(models: AIModel[], provider: string, language: UiLanguage = 'nl') {
  return Array.from(new Set(antigravityModels(models)
    .filter((model) => parseAntigravityModel(model, language).provider === provider)
    .map((model) => parseAntigravityModel(model, language).model)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function antigravityModesFor(models: AIModel[], provider: string, modelName: string, language: UiLanguage = 'nl') {
  return orderBy(Array.from(new Set(antigravityModels(models)
    .filter((model) => {
      const parsed = parseAntigravityModel(model, language);
      return parsed.provider === provider && parsed.model === modelName;
    })
    .map((model) => parseAntigravityModel(model, language).mode))), [
    antigravityModeLabel('standard', language),
    'Low',
    'Medium',
    'High',
    'Thinking',
  ]);
}

export function antigravityModelFor(models: AIModel[], provider: string, modelName: string, mode: string, language: UiLanguage = 'nl') {
  return antigravityModels(models).find((model) => {
    const parsed = parseAntigravityModel(model, language);
    return parsed.provider === provider && parsed.model === modelName && parsed.mode === mode;
  });
}

export function serviceTiersForModel(model?: AIModel): ServiceTier[] {
  return Array.from(new Set(model?.supportedServiceTiers || []));
}

function orderBy(values: string[], preferredOrder: readonly string[]) {
  return values
    .filter(Boolean)
    .sort((a, b) => {
      const ai = preferredOrder.indexOf(a);
      const bi = preferredOrder.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return a.localeCompare(b);
    });
}

function compareVersionLike(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function capitalize(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() : value;
}

function normalizeProviderFamily(value: string) {
  const lower = value.toLowerCase();
  if (lower === 'gpt-oss') return 'GPT-OSS';
  if (lower === 'gemini') return 'Gemini';
  if (lower === 'claude') return 'Claude';
  return capitalize(value);
}

export function defaultCodexModel(models: AIModel[], activeModelId?: string) {
  const codex = codexModels(models);
  return codex.find((model) => model.id === activeModelId) || codex.find((model) => model.isRecommended) || codex[0];
}

export function codexRunConfig(model: AIModel | undefined, current?: ModelRunConfig): ModelRunConfig | undefined {
  if (!model) return current;
  const next: ModelRunConfig = {
    ...(model.runConfig || {}),
    ...(current || {}),
    baseModelId: model.id,
  };
  delete next.reasoningEffort;
  delete next.serviceTier;
  const effort = current?.reasoningEffort && codexEffortsForModel(model).includes(current.reasoningEffort)
    ? current.reasoningEffort
    : undefined;
  if (effort) next.reasoningEffort = effort;
  const tiers = serviceTiersForModel(model);
  const tier = current?.serviceTier && tiers.includes(current.serviceTier)
    ? current.serviceTier
    : undefined;
  if (tier) next.serviceTier = tier;
  return next;
}

function antigravityModeLabel(value: string, language: UiLanguage) {
  return value.trim().toLowerCase() === 'standard'
    ? localizedText(language, 'Standaard', 'Standard')
    : value;
}

export function configuredModelRef(model: AIModel, runConfig?: ModelRunConfig) {
  return {
    provider: model.provider,
    modelId: model.id,
    runConfig: model.provider === 'codex' ? codexRunConfig(model, runConfig) : model.runConfig,
  };
}

export function dedupeAccountScopedModels(models: AIModel[]) {
  const result: AIModel[] = [];
  const seen = new Set<string>();
  for (const model of selectableModels(models)) {
    const group = limitGroupForModel(model);
    if ((model.limitScope === 'account' || model.provider === 'codex') && seen.has(group)) continue;
    seen.add(group);
    result.push(model);
  }
  return result;
}
