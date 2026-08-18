import { describe, expect, it } from 'vitest';
import type { AIModel, ModelRunConfig, ProviderType } from '../providers/types';
import {
  applyCommandPreset,
  clearCommandConfig,
  composerCommandPreset,
  commandPresetMatchesQuery,
  commandPresetsForModel,
  hasSelectableNativeRunControls,
  nativeRunControls,
  nativeCommandPresets,
  parseCommandInput,
} from './command-presets';

function model(provider: ProviderType, patch: Partial<AIModel> = {}): AIModel {
  return {
    id: `${provider}-live-model`,
    name: 'Live model',
    provider,
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    supportsVision: false,
    supportsFiles: true,
    supportsStreaming: true,
    ...patch,
  };
}

describe('providerneutrale slashcommands', () => {
  it('toont snel/diep niet wanneer de live modelcatalogus geen native controls meldt', () => {
    const presets = commandPresetsForModel('nl', 'google', model('google'));
    expect(presets.map((preset) => preset.id)).toEqual([]);
  });

  it('toont het native-instellingentandwiel alleen bij een echte providerkeuze', () => {
    expect(hasSelectableNativeRunControls(model('openai'))).toBe(false);
    expect(hasSelectableNativeRunControls(model('anthropic', {
      supportedReasoningEfforts: ['high'],
    }))).toBe(false);
    expect(hasSelectableNativeRunControls(model('anthropic', {
      supportedReasoningEfforts: ['low', 'high'],
    }))).toBe(true);
    expect(hasSelectableNativeRunControls(model('codex', {
      supportedServiceTiers: ['future-fast'],
    }))).toBe(true);
    expect(hasSelectableNativeRunControls(model('openai', {
      chatgptThinkingEfforts: [
        { value: 'instant', label: 'Instant' },
        { value: 'thinking', label: 'Thinking' },
      ],
    }))).toBe(true);
  });

  it('houdt een gekozen slashworkflow met het eigen icoon zichtbaar in de composer', () => {
    const presets = nativeCommandPresets([{
      id: 'codex:goal', provider: 'codex', slash: '/goal', aliases: [],
      label: 'Goal', description: 'Native goal', source: 'app-server', kind: 'goal',
    }]);
    const selected = composerCommandPreset(presets, undefined, 'codex:goal');

    expect(selected?.id).toBe('codex:goal');
    expect(selected?.label).toBe('Goal');
    expect(selected?.icon).toBeTypeOf('object');
  });

  it('presenteert een vaste effort niet als keuze maar wel één live extra snelheid', () => {
    const presets = commandPresetsForModel('nl', 'anthropic', model('anthropic', {
      supportedReasoningEfforts: ['high'],
      supportedServiceTiers: ['fast'],
    }));
    expect(presets.map((preset) => preset.id)).toEqual(['fast', 'reset']);
  });

  it('gebruikt uitsluitend Engelse commandnamen', () => {
    const nl = nativeCommandPresets([{
      id: 'codex:goal', provider: 'codex', slash: '/goal', aliases: [],
      label: 'Doel', description: 'Native goal', source: 'app-server', kind: 'goal',
    }]);
    const en = nativeCommandPresets([{
      id: 'codex:goal', provider: 'codex', slash: '/goal', aliases: [],
      label: 'Goal', description: 'Native goal', source: 'app-server', kind: 'goal',
    }]);

    expect(nl[0]?.slash).toBe('/goal');
    expect(nl[0]?.label).toBe('Goal');
    expect(en[0]?.slash).toBe('/goal');
    expect(parseCommandInput('/goal ship it', nl)?.preset.id).toBe('codex:goal');
    expect(parseCommandInput('/doel ship it', en)).toBeNull();
  });

  it('toont ook in de Nederlandse UI de vaste Engelse LLMelt-slashes', () => {
    const presets = commandPresetsForModel('nl', 'codex', model('codex', {
      supportedReasoningEfforts: ['low', 'high'],
      supportedServiceTiers: ['fast'],
    }));

    expect(presets.map((preset) => preset.slash)).toEqual(['/fast', '/deep', '/reset']);
    expect(presets.map((preset) => preset.label)).toEqual(['Fast', 'Deep', 'Reset']);
    expect(parseCommandInput('/snel', presets)).toBeNull();
    expect(parseCommandInput('/diep', presets)).toBeNull();
  });

  it('toont geen vertaalde aliases in het slash-palet', () => {
    const presets = nativeCommandPresets([{
      id: 'codex:goal', provider: 'codex', slash: '/goal', aliases: [],
      label: 'Goal', description: 'Native goal', source: 'app-server', kind: 'goal',
    }]);
    expect(presets.filter((preset) => commandPresetMatchesQuery(preset, 'goal')).map((preset) => preset.id)).toContain('codex:goal');
    expect(presets.filter((preset) => commandPresetMatchesQuery(preset, '/doel'))).toEqual([]);
  });

  it('past /fast uitsluitend toe via live modelcontrols en voegt geen nep-instructie toe', () => {
    const live = model('codex', {
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      supportedServiceTiers: ['fast'],
      runConfig: { baseModelId: 'codex-live-model', reasoningEffort: 'medium' },
    });
    const preset = commandPresetsForModel('nl', 'codex', live).find((candidate) => candidate.id === 'fast')!;
    const result = applyCommandPreset(preset, 'codex', live, live.runConfig);

    expect(result).toMatchObject({
      reasoningEffort: 'low',
      serviceTier: 'fast',
      commandPresetId: 'fast',
    });
    expect(result?.commandInstruction).toBeUndefined();
  });

  it('toont /fast bij live tiers en kiest de laatste zonder tiernaam-allowlist', () => {
    const live = model('codex', {
      supportedServiceTiers: ['baseline-v2', 'turbo-v7'],
    });
    const preset = commandPresetsForModel('en', 'codex', live)
      .find((candidate) => candidate.id === 'fast');

    expect(preset).toBeDefined();
    expect(applyCommandPreset(preset!, 'codex', live, undefined)).toMatchObject({
      serviceTier: 'turbo-v7',
      commandPresetId: 'fast',
    });
    expect(commandPresetsForModel('en', 'codex', live).some((candidate) => candidate.id === 'deep')).toBe(false);
  });

  it('kiest /fast en /deep uitsluitend via de volgorde van toekomstige effortwaarden', () => {
    const live = model('antigravity', {
      supportedReasoningEfforts: ['swift-v3', 'balanced-v4', 'thorough-v9'],
    });
    const presets = commandPresetsForModel('en', 'antigravity', live);

    expect(applyCommandPreset(
      presets.find((candidate) => candidate.id === 'fast')!,
      'antigravity',
      live,
      undefined,
    )?.reasoningEffort).toBe('swift-v3');
    expect(applyCommandPreset(
      presets.find((candidate) => candidate.id === 'deep')!,
      'antigravity',
      live,
      undefined,
    )?.reasoningEffort).toBe('thorough-v9');
  });

  it('kiest voor /deep de laatste live effort zonder modelnaam-allowlist', () => {
    const future = model('antigravity', {
      id: 'future-model-from-cli',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
    });
    const preset = commandPresetsForModel('en', 'antigravity', future).find((candidate) => candidate.id === 'deep')!;

    expect(applyCommandPreset(preset, 'antigravity', future, undefined)).toMatchObject({
      reasoningEffort: 'high',
      commandPresetId: 'deep',
    });
  });

  it('gebruikt de officiële live ChatGPT-volgorde voor fast/deep', () => {
    const chatgpt = model('openai', {
      id: 'chatgpt:future',
      chatgptThinkingEfforts: [
        { value: 'instant-live', label: 'Instant' },
        { value: 'pro-live', label: 'Pro' },
      ],
    });
    const presets = commandPresetsForModel('en', 'openai', chatgpt);
    const fast = presets.find((candidate) => candidate.id === 'fast')!;
    const deep = presets.find((candidate) => candidate.id === 'deep')!;

    expect(applyCommandPreset(fast, 'openai', chatgpt, undefined)?.chatgptThinkingEffort).toBe('instant-live');
    expect(applyCommandPreset(deep, 'openai', chatgpt, undefined)?.chatgptThinkingEffort).toBe('pro-live');
  });

  it('herstelt na fast/deep de modelstandaard en behoudt timeout', () => {
    const live = model('codex', {
      runConfig: { baseModelId: 'codex-live-model', reasoningEffort: 'medium', serviceTier: 'standard' },
    });
    const active: ModelRunConfig = {
      baseModelId: live.id,
      reasoningEffort: 'low',
      serviceTier: 'fast',
      timeoutSeconds: 240,
      commandPresetId: 'fast',
    };

    expect(clearCommandConfig(active, live)).toEqual({
      baseModelId: 'codex-live-model',
      reasoningEffort: 'medium',
      serviceTier: 'standard',
      timeoutSeconds: 240,
    });
  });

  it('dedupliceert uitsluitend live gepubliceerde controls', () => {
    expect(nativeRunControls(model('anthropic', {
      supportedReasoningEfforts: ['low', 'low', 'max'],
    })).reasoningEfforts).toEqual(['low', 'max']);
  });
});
