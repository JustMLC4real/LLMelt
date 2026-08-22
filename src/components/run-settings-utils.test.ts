import { describe, expect, it } from 'vitest';
import type { AIModel, ChatgptVersion } from '../providers/types';
import { activeRunSettingsChoiceKey, runSettingsModelChoices } from './run-settings-utils';

const model = (values: Partial<AIModel> & Pick<AIModel, 'id' | 'name' | 'provider'>): AIModel => ({
  contextWindow: 100_000,
  maxOutputTokens: 4_096,
  supportsVision: false,
  supportsFiles: true,
  supportsStreaming: true,
  canChat: true,
  ...values,
});

describe('runSettingsModelChoices', () => {
  it('blijft binnen hetzelfde CLI-oppervlak en volgt de live catalogusvolgorde', () => {
    const active = model({ id: 'claude-cli:opus', name: 'Opus', provider: 'anthropic', providerSurface: 'cli', catalogPriority: 2 });
    const choices = runSettingsModelChoices([
      active,
      model({ id: 'claude-cli:sonnet', name: 'Sonnet', provider: 'anthropic', providerSurface: 'cli', catalogPriority: 1 }),
      model({ id: 'claude-api:opus', name: 'Opus API', provider: 'anthropic', providerSurface: 'api', catalogPriority: 0 }),
    ], active, undefined, [], 'nl');

    expect(choices.map((choice) => choice.modelId)).toEqual(['claude-cli:sonnet', 'claude-cli:opus']);
  });

  it('behoudt alleen controls die het nieuw gekozen model live ondersteunt', () => {
    const active = model({ id: 'codex:a', name: 'A', provider: 'codex', supportedReasoningEfforts: ['low', 'high'], supportedServiceTiers: ['fast'] });
    const next = model({ id: 'codex:b', name: 'B', provider: 'codex', supportedReasoningEfforts: ['low'], supportedServiceTiers: [] });
    const choices = runSettingsModelChoices([active, next], active, {
      reasoningEffort: 'high',
      serviceTier: 'fast',
      commandPresetId: 'review',
    }, [], 'nl');

    expect(choices.find((choice) => choice.modelId === next.id)?.runConfig).toEqual({
      baseModelId: 'codex:b',
      commandPresetId: 'review',
    });
  });

  it('toont modelnamen zonder inspanning en kiest live High voor een nieuw Codex-model', () => {
    const active = model({
      id: 'codex:sol',
      name: 'GPT-5.6-Sol',
      provider: 'codex',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      runConfig: { reasoningEffort: 'medium' },
    });
    const terra = model({
      id: 'codex:terra',
      name: 'GPT-5.6-Terra',
      provider: 'codex',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      runConfig: { reasoningEffort: 'medium' },
    });
    const choices = runSettingsModelChoices([active, terra], active, { reasoningEffort: 'medium' }, [], 'nl');

    expect(choices.map((choice) => choice.label)).toEqual(['5.6 Sol', '5.6 Terra']);
    expect(choices.find((choice) => choice.modelId === terra.id)?.runConfig).toMatchObject({
      baseModelId: terra.id,
      reasoningEffort: 'high',
    });
  });

  it('bouwt ChatGPT-modelpunten uit live versions en bewaart het niveau waar mogelijk', () => {
    const active = model({ id: 'chatgpt:thinking-a', name: 'A', provider: 'openai', providerSurface: 'subscription-web' });
    const models = [
      active,
      model({ id: 'chatgpt:thinking-b', name: 'B', provider: 'openai', providerSurface: 'subscription-web' }),
    ];
    const versions: ChatgptVersion[] = [
      { id: 'a', title: 'Model A', enabled: true, slugs: ['thinking-a'], presets: [{ title: 'High', modelSlug: 'thinking-a', thinkingEffort: 'high', available: true }] },
      { id: 'b', title: 'Model B', enabled: true, slugs: ['thinking-b'], presets: [{ title: 'High', modelSlug: 'thinking-b', thinkingEffort: 'high', available: true }] },
    ];
    const choices = runSettingsModelChoices(models, active, { chatgptVersionId: 'a', chatgptThinkingEffort: 'high' }, versions, 'en');

    expect(choices.map((choice) => choice.label)).toEqual(['Model A', 'Model B']);
    expect(choices[1]).toMatchObject({ key: 'b', modelId: 'chatgpt:thinking-b', runConfig: { chatgptVersionId: 'b', chatgptThinkingEffort: 'high' } });
    expect(activeRunSettingsChoiceKey(active, { chatgptVersionId: 'a' })).toBe('a');
  });
});
