import { describe, expect, it, vi } from 'vitest';
import type { AIModel, ChatgptVersion } from '../providers/types';
import {
  enabledChatgptModelIds,
  isChatgptCatalogReady,
  modelsInCurrentChatgptCatalog,
  retryChatgptCatalog,
  type ChatgptCatalogSnapshot,
} from './chatgpt-catalog-sync';

const model: AIModel = {
  id: 'chatgpt:live-model',
  name: 'Live model',
  provider: 'openai',
  contextWindow: 1,
  maxOutputTokens: 1,
  supportsVision: false,
  supportsFiles: false,
  supportsStreaming: true,
};

const version: ChatgptVersion = {
  id: 'live-version',
  title: 'Live version',
  enabled: true,
  slugs: ['live-model'],
  presets: [],
};

describe('ChatGPT-catalogussynchronisatie', () => {
  it('vereist zowel een live webmodel als een ingeschakelde versie', () => {
    expect(isChatgptCatalogReady([model], [version])).toBe(true);
    expect(isChatgptCatalogReady([], [version])).toBe(false);
    expect(isChatgptCatalogReady([model], [])).toBe(false);
  });

  it('accepteert alleen modellen die door dezelfde ingeschakelde preset worden genoemd', () => {
    const staleModel = { ...model, id: 'chatgpt:oude-directe-slug' };
    expect(isChatgptCatalogReady([staleModel], [version])).toBe(false);
    expect(modelsInCurrentChatgptCatalog([staleModel, model], [version])).toEqual([model]);
    expect([...enabledChatgptModelIds([version])]).toEqual(['chatgpt:live-model']);
  });

  it('gebruikt bij een versie zonder presets de live versieslugs', () => {
    const presetloos = { ...version, presets: [], slugs: ['live-model'] };
    expect(isChatgptCatalogReady([model], [presetloos])).toBe(true);
  });

  it('probeert na een actieve sessie vanzelf opnieuw totdat de modellen beschikbaar zijn', async () => {
    const snapshots: ChatgptCatalogSnapshot[] = [
      { models: [], versions: [], sessionActive: true },
      { models: [model], versions: [version], sessionActive: true },
    ];
    const load = vi.fn(async () => snapshots.shift()!);
    const apply = vi.fn();

    await expect(retryChatgptCatalog({
      load,
      apply,
      delays: [0, 1],
      wait: async () => {},
    })).resolves.toBe(true);

    expect(load).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith({
      models: [model],
      versions: [version],
      sessionActive: true,
    });
  });

  it('stopt met proberen wanneer de websessie niet meer actief is', async () => {
    const load = vi.fn(async () => ({ models: [], versions: [], sessionActive: false }));

    await expect(retryChatgptCatalog({
      load,
      apply: () => {},
      delays: [0, 1, 2],
      wait: async () => {},
    })).resolves.toBe(false);

    expect(load).toHaveBeenCalledTimes(1);
  });
});
