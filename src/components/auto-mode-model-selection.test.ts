import { describe, expect, it } from 'vitest';
import type { AIModel, ChatgptVersion, ModelRef } from '../providers/types';
import {
  autoModeChatgptChoiceForRef,
  autoModeChatgptChoiceForVersion,
  autoModeChatgptRefForChoice,
  autoModeModelKey,
  autoModeModelRef,
  autoModeModelsForSurface,
  autoModeSurfaces,
  availableAutoModeChatgptPresets,
  availableAutoModeChatgptVersions,
  normalizeAutoModeChatgptRef,
  withAutoModeReasoningEffort,
} from './auto-mode-model-selection';

function model(overrides: Partial<AIModel>): AIModel {
  return {
    id: 'model',
    name: 'Model',
    provider: 'codex',
    contextWindow: 128_000,
    maxOutputTokens: 8_000,
    supportsVision: false,
    supportsFiles: true,
    supportsStreaming: true,
    ...overrides,
  };
}

const chatgptVersions: ChatgptVersion[] = [
  {
    id: 'gpt-5-6',
    title: 'GPT-5.6 Sol',
    enabled: true,
    slugs: ['gpt-5-6-thinking'],
    presets: [
      { title: 'Direct', subtitle: '5.5', modelSlug: 'gpt-5-5-instant', available: true },
      { title: 'Hoog', modelSlug: 'gpt-5-6-thinking', thinkingEffort: 'extended', available: true },
    ],
  },
  {
    id: 'gpt-5-5',
    title: 'GPT-5.5',
    enabled: true,
    slugs: ['gpt-5-5-instant'],
    presets: [
      { title: 'Direct', modelSlug: 'gpt-5-5-instant', available: true },
    ],
  },
  {
    id: 'onbeschikbaar',
    title: 'Niet beschikbaar',
    enabled: true,
    slugs: ['missing-model'],
    presets: [
      { title: 'Direct', modelSlug: 'missing-model', available: false },
    ],
  },
];

const chatgptModels = [
  model({ id: 'chatgpt:gpt-5-6-thinking', name: 'GPT-5.6 thinking', provider: 'openai' }),
  model({ id: 'chatgpt:gpt-5-5-instant', name: 'GPT-5.5 instant', provider: 'openai' }),
];

describe('Auto Mode-modelkeuze', () => {
  it('splitst de live catalogus op provideroppervlak zonder modellen weg te filteren', () => {
    const models = [
      model({ id: 'a', surfaceLabel: 'Codex CLI' }),
      model({ id: 'b', provider: 'anthropic', surfaceLabel: 'Claude CLI' }),
      model({ id: 'c', provider: 'anthropic', surfaceLabel: 'Claude CLI' }),
    ];

    expect(autoModeSurfaces(models)).toEqual(['Codex CLI', 'Claude CLI']);
    expect(autoModeModelsForSurface(models, 'Claude CLI').map(autoModeModelKey)).toEqual([
      'anthropic:b',
      'anthropic:c',
    ]);
  });

  it('bewaart alleen een inspanning die het gekozen live model ondersteunt', () => {
    const claude = model({
      id: 'claude-cli:opus',
      provider: 'anthropic',
      supportedReasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'high',
    });
    const selected = autoModeModelRef(claude);
    expect(selected.runConfig?.reasoningEffort).toBe('high');
    expect(withAutoModeReasoningEffort(selected, 'low').runConfig?.reasoningEffort).toBe('low');
  });

  it('toont bij ChatGPT alleen werkelijk beschikbare niveaus en versies', () => {
    expect(availableAutoModeChatgptPresets(chatgptVersions[0], chatgptModels).map((preset) => preset.title))
      .toEqual(['Hoog']);
    expect(availableAutoModeChatgptVersions(chatgptVersions, chatgptModels).map((version) => version.title))
      .toEqual(['GPT-5.6 Sol', 'GPT-5.5']);
  });

  it('kiest bij een andere ChatGPT-versie atomair het eerste geldige niveau', () => {
    const choice = autoModeChatgptChoiceForVersion(chatgptVersions[0], chatgptModels, 'Direct');
    expect(choice?.preset?.title).toBe('Hoog');
    expect(autoModeChatgptRefForChoice(choice!).runConfig?.chatgptThinkingEffort).toBe('extended');
  });

  it('normaliseert een niet-beschikbare oude combinatie naar een klikbare combinatie', () => {
    const invalid: ModelRef = {
      provider: 'openai',
      modelId: 'chatgpt:gpt-5-6-thinking',
      runConfig: { chatgptThinkingEffort: 'direct' },
    };
    expect(autoModeChatgptChoiceForRef(chatgptVersions, chatgptModels, invalid)?.preset?.title).toBe('Hoog');
    expect(normalizeAutoModeChatgptRef(chatgptVersions, chatgptModels, invalid)?.runConfig?.chatgptThinkingEffort)
      .toBe('extended');
  });
});
