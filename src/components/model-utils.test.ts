import { describe, it, expect } from 'vitest';
import type { AIModel, CredentialStatus, ProviderType } from '../providers/types';
import {
  codexEffortForModel,
  codexEffortsForModel,
  codexModels,
  modelDisplayName,
  modelChoiceLabel,
  compactModelChoiceLabel,
  parseCodexModel,
  reasoningEffortLabel,
  serviceTierLabel,
  chatgptEffortsForModel,
  isChatgptPickerModel,
  parseClaudeCliModel,
  claudeCliFamilies,
  claudeCliVersionsFor,
  claudeCliModelFor,
  parseAntigravityModel,
  antigravityProviders,
  antigravityModelNamesFor,
  antigravityModesFor,
  antigravityModelFor,
  chatgptLevelKey,
  chatgptPresetFor,
  chatgptPresetLabel,
  chatgptWebSessionUsable,
  connectedModels,
  parseGoogleModelChoice,
  replacementForUnavailableModel,
} from './model-utils';

// Minimal ChatGPT model factory (only the fields the helpers read).
const cg = (name: string, slug: string, extra: Partial<AIModel> = {}): AIModel =>
  ({
    id: `chatgpt:${slug}`,
    name,
    provider: 'openai',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsVision: true,
    supportsFiles: true,
    supportsStreaming: true,
    canChat: true,
    executionMode: 'chat',
    providerSurface: 'subscription-web',
    ...extra,
  }) as AIModel;

const efforts = [
  { value: 'standard', label: 'Standaard' },
  { value: 'extended', label: 'Langer' },
];

const claudeCli = (name: string, id: string): AIModel =>
  ({
    id: `claude-cli:${id}`,
    name,
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsVision: false,
    supportsFiles: true,
    supportsStreaming: false,
    canChat: true,
    executionMode: 'chat',
  }) as AIModel;

const agy = (name: string): AIModel =>
  ({
    id: name,
    name,
    provider: 'antigravity',
    contextWindow: 400000,
    maxOutputTokens: 64000,
    supportsVision: false,
    supportsFiles: true,
    supportsStreaming: false,
    canChat: true,
    executionMode: 'chat',
  }) as AIModel;

const codex = (name: string, id: string, extra: Partial<AIModel> = {}): AIModel => ({
  id,
  name,
  provider: 'codex',
  contextWindow: 400000,
  maxOutputTokens: 128000,
  supportsVision: false,
  supportsFiles: true,
  supportsStreaming: false,
  canChat: true,
  executionMode: 'agent',
  ...extra,
});

describe('serviceTierLabel', () => {
  it('maps Codex tiers to friendly labels', () => {
    expect(serviceTierLabel('standard')).toBe('Standaard');
    expect(serviceTierLabel('')).toBe('Standaard');
    expect(serviceTierLabel('fast')).toBe('Snel');
    expect(serviceTierLabel('priority')).toBe('Snel');
  });
  it('capitalizes unknown tiers', () => {
    expect(serviceTierLabel('flex')).toBe('Flex');
  });
});

describe('reasoningEffortLabel', () => {
  it('uses friendly labels without changing the provider effort value', () => {
    expect(reasoningEffortLabel('low')).toBe('Licht');
    expect(reasoningEffortLabel('medium')).toBe('Gemiddeld');
    expect(reasoningEffortLabel('high')).toBe('Hoog');
    expect(reasoningEffortLabel('xhigh')).toBe('Zeer Hoog');
    expect(reasoningEffortLabel('max')).toBe('Max');
    expect(reasoningEffortLabel('ultra')).toBe('Ultra');
  });
});

describe('Codex picker parity', () => {
  it('uses the catalog order and official model labels', () => {
    const models = [
      codex('GPT-5.4-Mini', 'gpt-5.4-mini', { catalogPriority: 23 }),
      codex('GPT-5.6-Terra', 'gpt-5.6-terra', { catalogPriority: 2 }),
      codex('GPT-5.5', 'gpt-5.5', { catalogPriority: 7 }),
      codex('GPT-5.6-Sol', 'gpt-5.6-sol', { catalogPriority: 1 }),
      codex('GPT-5.4', 'gpt-5.4', { catalogPriority: 16 }),
      codex('GPT-5.6-Luna', 'gpt-5.6-luna', { catalogPriority: 3 }),
    ];

    expect(codexModels(models).map(modelDisplayName)).toEqual([
      '5.6 Sol', '5.6 Terra', '5.6 Luna', '5.5', '5.4', '5.4 Mini',
    ]);
    expect(parseCodexModel(models[1])).toEqual({ version: '5.6', variant: 'Terra' });
    expect(parseCodexModel(models[2])).toEqual({ version: '5.5', variant: 'Standaard' });
    expect(parseCodexModel(models[0])).toEqual({ version: '5.4', variant: 'Mini' });
  });

  it('toont Max en Ultra afzonderlijk zoals de live CLI-catalogus ze levert', () => {
    const terra = codex('GPT-5.6-Terra', 'gpt-5.6-terra', {
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultReasoningEffort: 'xhigh',
    });
    const luna = codex('GPT-5.6-Luna', 'gpt-5.6-luna', {
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'xhigh',
    });

    expect(codexEffortsForModel(terra)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(codexEffortForModel(terra, 'max')).toBe('max');
    expect(codexEffortsForModel(luna)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(codexEffortForModel(luna, 'ultra')).toBe('xhigh');
  });

  it('vervangt een verdwenen opgeslagen Codex-model door de aanbevolen live keuze', () => {
    const models = [
      codex('GPT-5.6-Terra', 'gpt-5.6-terra', { catalogPriority: 2 }),
      codex('GPT-5.6-Sol', 'gpt-5.6-sol', { catalogPriority: 1, isRecommended: true }),
    ];

    expect(replacementForUnavailableModel(models, 'codex', 'gpt-oud')?.id)
      .toBe('gpt-5.6-sol');
    expect(replacementForUnavailableModel(models, 'codex', 'gpt-5.6-terra'))
      .toBeUndefined();
  });
});

describe('chatgptEffortsForModel', () => {
  it('returns efforts only when the model is configurable', () => {
    const thinking = cg('GPT-5.5 Thinking', 'gpt-5-5-thinking', { chatgptConfigurableEffort: true, chatgptThinkingEfforts: efforts });
    expect(chatgptEffortsForModel(thinking)).toEqual([
      { value: 'standard', label: 'Standaard' },
      { value: 'extended', label: 'Langer' },
    ]);
  });
  it('returns [] for non-configurable models', () => {
    expect(chatgptEffortsForModel(cg('GPT-5.5', 'gpt-5-5'))).toEqual([]);
    expect(chatgptEffortsForModel(undefined)).toEqual([]);
  });
});

describe('Claude CLI picker helpers', () => {
  const models = [
    claudeCli('Claude Opus 4.8 (CLI)', 'claude-opus-4-8'),
    claudeCli('Claude Sonnet 5 (CLI)', 'claude-sonnet-5'),
    claudeCli('Claude Sonnet 4.6 (CLI)', 'claude-sonnet-4-6'),
    claudeCli('Claude Haiku 4.5 (CLI)', 'claude-haiku-4-5'),
    claudeCli('Claude Fable 5 (CLI)', 'claude-fable-5'),
  ];

  it('splits family and version from Claude CLI names', () => {
    expect(parseClaudeCliModel(models[0])).toEqual({ family: 'Opus', version: '4.8' });
    expect(parseClaudeCliModel(models[1])).toEqual({ family: 'Sonnet', version: '5' });
  });

  it('orders families by capability with Fable on top', () => {
    expect(claudeCliFamilies(models)).toEqual(['Fable', 'Opus', 'Sonnet', 'Haiku']);
    expect(claudeCliVersionsFor(models, 'Sonnet')).toEqual(['5', '4.6']);
    expect(claudeCliModelFor(models, 'Sonnet', '4.6')?.id).toBe('claude-cli:claude-sonnet-4-6');
  });
});

describe('Antigravity picker helpers', () => {
  const models = [
    agy('Gemini 3.5 Flash (Medium)'),
    agy('Gemini 3.5 Flash (High)'),
    agy('Gemini 3.1 Pro (Low)'),
    agy('Claude Sonnet 4.6 (Thinking)'),
    agy('GPT-OSS 120B (Medium)'),
  ];

  it('splits provider, model and mode from Antigravity names', () => {
    expect(parseAntigravityModel(models[0])).toEqual({ provider: 'Gemini', model: '3.5 Flash', mode: 'Medium' });
    expect(parseAntigravityModel(models[3])).toEqual({ provider: 'Claude', model: 'Sonnet 4.6', mode: 'Thinking' });
    expect(parseAntigravityModel(models[4])).toEqual({ provider: 'GPT-OSS', model: '120B', mode: 'Medium' });
  });

  it('resolves Antigravity choices as separate provider/model/stand controls', () => {
    expect(antigravityProviders(models)).toEqual(['Gemini', 'Claude', 'GPT-OSS']);
    expect(antigravityModelNamesFor(models, 'Gemini')).toEqual(['3.1 Pro', '3.5 Flash']);
    expect(antigravityModesFor(models, 'Gemini', '3.5 Flash')).toEqual(['Medium', 'High']);
    expect(antigravityModelFor(models, 'Gemini', '3.5 Flash', 'High')?.id).toBe('Gemini 3.5 Flash (High)');
  });

  it('splits the live hyphenated agy catalog into the same controls', () => {
    const liveModels = [
      agy('Gemini-3.6-flash-medium'),
      agy('Gemini-3.1-pro-high'),
      agy('Claude-opus-4-6-thinking'),
      agy('Claude-sonnet-4-6'),
      agy('GPT-OSS-120B-medium'),
    ];

    expect(parseAntigravityModel(liveModels[0])).toEqual({ provider: 'Gemini', model: '3.6 Flash', mode: 'Medium' });
    expect(parseAntigravityModel(liveModels[2])).toEqual({ provider: 'Claude', model: 'Opus 4.6', mode: 'Thinking' });
    expect(parseAntigravityModel(liveModels[3])).toEqual({ provider: 'Claude', model: 'Sonnet 4.6', mode: 'Standaard' });
    expect(parseAntigravityModel(liveModels[4])).toEqual({ provider: 'GPT-OSS', model: '120B', mode: 'Medium' });
    expect(antigravityProviders(liveModels)).toEqual(['Gemini', 'Claude', 'GPT-OSS']);
    expect(antigravityModesFor(liveModels, 'Gemini', '3.6 Flash')).toEqual(['Medium']);
    expect(antigravityModelFor(liveModels, 'Claude', 'Opus 4.6', 'Thinking')?.id).toBe('Claude-opus-4-6-thinking');
  });
});

describe('modelChoiceLabel', () => {
  it('gebruikt voor Codex dezelfde losse versie-, variant-, effort- en snelheidsnamen', () => {
    const model = codex('5.6 Sol', 'gpt-5.6-sol', {
      runConfig: { reasoningEffort: 'xhigh', serviceTier: 'standard' },
      supportedReasoningEfforts: ['high', 'xhigh'],
      supportedServiceTiers: ['standard'],
    });

    expect(modelChoiceLabel(model)).toBe('Codex CLI · 5.6 · Sol · Zeer Hoog · Standaard');
  });

  it('laat in een gegroepeerde Auto Mode-lijst de dubbele providernaam weg', () => {
    const model = codex('GPT-5.6 Sol', 'gpt-5.6-sol', {
      runConfig: { reasoningEffort: 'medium', serviceTier: 'standard' },
      supportedReasoningEfforts: ['medium'],
      supportedServiceTiers: ['standard'],
    });
    expect(compactModelChoiceLabel(model)).toBe('5.6 · Sol · Gemiddeld · Standaard');
  });

  it('gebruikt de provider-neutrale Claude- en Antigravity-indeling', () => {
    const claude = claudeCli('Claude Opus 4.8 (CLI)', 'claude-opus-4-8');
    claude.defaultReasoningEffort = 'high';
    expect(modelChoiceLabel(claude)).toBe('Claude CLI · Opus · 4.8 · Hoog');
    expect(modelChoiceLabel(agy('Gemini 3.5 Flash (High)'))).toBe('Antigravity CLI · Gemini · 3.5 Flash · High');
  });
});

// ChatGPT levert de kiezer zelf aan. Let op: `gpt-5-6-thinking` hoort bij twee
// niveaus (Gemiddeld en Hoog); alleen de thinking_effort onderscheidt ze.
describe('chatgptPresetLabel', () => {
  const versions = [
    {
      id: 'latest',
      title: 'GPT-5.6 Sol',
      enabled: true,
      slugs: ['gpt-5-5-instant', 'gpt-5-6-thinking', 'gpt-5-6-pro'],
      presets: [
        { title: 'Direct', subtitle: '5.5', modelSlug: 'gpt-5-5-instant', available: true },
        { title: 'Gemiddeld', modelSlug: 'gpt-5-6-thinking', thinkingEffort: 'standard', available: true },
        { title: 'Hoog', modelSlug: 'gpt-5-6-thinking', thinkingEffort: 'extended', available: true },
        { title: 'Pro', modelSlug: 'gpt-5-6-pro', available: true },
      ],
    },
    {
      id: '5.5',
      title: 'GPT-5.5',
      enabled: true,
      slugs: ['gpt-5-5-instant', 'gpt-5-5-thinking'],
      presets: [
        { title: 'Direct', modelSlug: 'gpt-5-5-instant', available: true },
        { title: 'Hoog', modelSlug: 'gpt-5-5-thinking', thinkingEffort: 'extended', available: true },
      ],
    },
    { id: 'o3', title: 'o3', enabled: true, slugs: ['o3'], presets: [] },
  ];

  it('labels a borrowed model by the version it belongs to', () => {
    // "Direct" op GPT-5.6 Sol draait op gpt-5-5-instant (subtitle "5.5"), dus het
    // antwoord kwam van GPT-5.5 — niet van Sol.
    expect(chatgptPresetLabel(versions, 'chatgpt:gpt-5-5-instant')).toBe('GPT-5.5 · Direct');
  });

  it('distinguishes the two levels that share one slug', () => {
    expect(chatgptPresetLabel(versions, 'chatgpt:gpt-5-6-thinking', 'standard')).toBe('GPT-5.6 Sol · Gemiddeld');
    expect(chatgptPresetLabel(versions, 'chatgpt:gpt-5-6-thinking', 'extended')).toBe('GPT-5.6 Sol · Hoog');
  });

  it('falls back to the first matching level when the effort is unknown', () => {
    expect(chatgptPresetLabel(versions, 'chatgpt:gpt-5-6-thinking')).toBe('GPT-5.6 Sol · Gemiddeld');
  });

  it('labels a version without levels by its own title', () => {
    expect(chatgptPresetLabel(versions, 'chatgpt:o3')).toBe('o3');
  });

  it('returns null for a slug ChatGPT does not offer', () => {
    expect(chatgptPresetLabel(versions, 'chatgpt:gpt-5.6-terra-wm')).toBeNull();
    expect(chatgptPresetLabel([], 'chatgpt:gpt-5-6-thinking')).toBeNull();
  });

  it('resolves the version + preset behind a slug (gebruikt door de fallback-keten)', () => {
    const hoog = chatgptPresetFor(versions, 'chatgpt:gpt-5-6-thinking', 'extended');
    expect(hoog?.version.title).toBe('GPT-5.6 Sol');
    expect(hoog?.preset.title).toBe('Hoog');
    expect(hoog?.preset.thinkingEffort).toBe('extended');

    // Direct leent het 5.5-model, dus dat niveau hoort bij GPT-5.5, niet bij Sol.
    const direct = chatgptPresetFor(versions, 'chatgpt:gpt-5-5-instant');
    expect(direct?.version.title).toBe('GPT-5.5');
    expect(direct?.preset.title).toBe('Direct');

    expect(chatgptPresetFor(versions, 'chatgpt:onbekend')).toBeNull();
  });

  it('never treats cached models as proof that the web session is alive', () => {
    // Dit was de bug: modellen worden bewaard als laatst-bekend-goed, dus na uitloggen
    // bleef de kaart "web-sessie actief" tonen en bleef de knop klikbaar.
    expect(chatgptWebSessionUsable(false, 10)).toBe(false);
    expect(chatgptWebSessionUsable(true, 0)).toBe(true);
  });

  it('falls back to cached models only while the session check has not landed', () => {
    expect(chatgptWebSessionUsable(undefined, 10)).toBe(true);
    expect(chatgptWebSessionUsable(undefined, 0)).toBe(false);
  });

  it('keys a level uniquely by slug + effort, since one slug serves two levels', () => {
    expect(chatgptLevelKey('chatgpt:gpt-5-6-thinking', 'standard'))
      .not.toBe(chatgptLevelKey('chatgpt:gpt-5-6-thinking', 'extended'));
    expect(chatgptLevelKey('chatgpt:gpt-5-6-pro')).toBe('chatgpt:gpt-5-6-pro');
  });
});

// Work-mode = modellen uit de live versions[] van een zakelijke workspace.
describe('chatgpt work-mode models', () => {
  const sol = cg('GPT-5.6 Sol', 'gpt-5.6-sol-wm', {
    chatgptWorkMode: true,
    chatgptConfigurableEffort: true,
    chatgptThinkingEfforts: efforts,
  });
  const wm55 = cg('GPT-5.5', 'gpt-5.5-wm', { chatgptWorkMode: true });
  const wmMini = cg('GPT-5.5 Mini', 'gpt-5.5-mini-wm', { chatgptWorkMode: true });

  it('accepteert ieder live subscription-webmodel zonder slugallowlist', () => {
    expect(isChatgptPickerModel(sol)).toBe(true);
    expect(isChatgptPickerModel(wm55)).toBe(true);
  });

  it('verbergt alleen modellen die niet van de live websurface komen', () => {
    expect(isChatgptPickerModel(wmMini)).toBe(true);
    expect(isChatgptPickerModel({ ...wmMini, providerSurface: 'api' })).toBe(false);
  });

});

describe('connectedModels', () => {
  const providers: ProviderType[] = ['openai', 'anthropic', 'google', 'ollama', 'codex', 'antigravity', 'remote'];
  const statuses = (connected: ProviderType[] = []): Record<ProviderType, CredentialStatus> => Object.fromEntries(
    providers.map((provider) => [provider, {
      provider,
      authenticated: connected.includes(provider),
      method: provider === 'ollama' ? 'none' : 'cli',
      canChat: connected.includes(provider),
    }]),
  ) as Record<ProviderType, CredentialStatus>;
  const model = (provider: ProviderType, id: string): AIModel => ({
    id,
    name: id,
    provider,
    contextWindow: 128000,
    maxOutputTokens: 16000,
    supportsVision: false,
    supportsFiles: true,
    supportsStreaming: true,
    canChat: true,
    executionMode: 'chat',
  });

  it('verbergt Gemini en Ollama totdat hun verbinding live is bevestigd', () => {
    const models = [model('google', 'gemini-2.5-flash'), model('ollama', 'ollama:qwen3:8b')];
    expect(connectedModels(models, statuses())).toEqual([]);
    expect(connectedModels(models, statuses(['google']))).toEqual([models[0]]);
    expect(connectedModels(models, statuses(['google', 'ollama']))).toEqual(models);
  });

  it('vereist voor ChatGPT altijd een actieve websessie', () => {
    const chatgpt = model('openai', 'chatgpt:gpt-live');
    expect(connectedModels([chatgpt], statuses(['openai']), false)).toEqual([]);
    expect(connectedModels([chatgpt], statuses(), true)).toEqual([chatgpt]);
  });

  it('laat connector- en expliciet niet-chatbare modellen nooit door', () => {
    const connector = { ...model('google', 'connector'), executionMode: 'connector' as const };
    const disabled = { ...model('google', 'disabled'), canChat: false };
    expect(connectedModels([connector, disabled], statuses(['google']))).toEqual([]);
  });
});

describe('parseGoogleModelChoice', () => {
  const googleModel = (id: string, name: string): AIModel => ({
    id,
    name,
    provider: 'google',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    supportsVision: true,
    supportsFiles: true,
    supportsStreaming: true,
  });

  it('splitst een live Gemini-model in familie, versie en variant', () => {
    expect(parseGoogleModelChoice(googleModel('gemini-3.5-flash', 'Gemini 3.5 Flash')))
      .toEqual({ family: 'Gemini', version: '3.5', variant: 'Flash' });
  });

  it('houdt live Gemma-varianten intact zonder modelallowlist', () => {
    expect(parseGoogleModelChoice(googleModel('gemma-4-26b-it', 'Gemma 4 26B A4B IT')))
      .toEqual({ family: 'Gemma', version: '4', variant: '26B A4B IT' });
  });

  it('plaatst modellen zonder versienummer onder Overig', () => {
    expect(parseGoogleModelChoice(googleModel('gemini-pro-latest', 'Gemini Pro Latest')))
      .toEqual({ family: 'Gemini', version: 'Overig', variant: 'Pro Latest' });
  });
});
