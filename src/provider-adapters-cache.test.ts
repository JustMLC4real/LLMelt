import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockStore = vi.hoisted(() => {
  let cache: Record<string, { value: unknown; expires: number }> = {};
  return {
    get(key: string) {
      return key === 'cliCache' ? cache : undefined;
    },
    set(key: string, value: unknown) {
      if (key === 'cliCache') cache = value as typeof cache;
    },
    reset() {
      cache = {};
    },
    seed(key: string, value: unknown) {
      cache[key] = { value, expires: Date.now() + 60_000 };
    },
    read(key: string) {
      return cache[key];
    },
  };
});

vi.mock('../electron/settings-store', () => ({
  getStore: async () => mockStore,
}));

import {
  cachedCliResult,
  claudeCliChatArgs,
  classifyProviderError,
  codexCliChatArgs,
  createAdapters,
  geminiSmokeCandidates,
  googleCatalogCapabilities,
  invalidateCachedCliResults,
  listableCodexCatalogModels,
  pickOpenAISmokeModel,
} from '../electron/provider-adapters';

afterEach(() => {
  vi.unstubAllGlobals();
});

const nonEmptyArray = (value: unknown[]) => value.length > 0;

describe('cachedCliResult', () => {
  beforeEach(() => mockStore.reset());

  it('retries and replaces a persisted empty CLI result', async () => {
    const key = `codex-stale-${crypto.randomUUID()}`;
    mockStore.seed(key, []);
    const probe = vi.fn(async () => ['gpt-5.5']);

    await expect(cachedCliResult(key, 60_000, probe, nonEmptyArray)).resolves.toEqual(['gpt-5.5']);
    expect(probe).toHaveBeenCalledOnce();
    expect(mockStore.read(key)?.value).toEqual(['gpt-5.5']);
  });

  it('does not cache failed empty CLI probes', async () => {
    const key = `codex-empty-${crypto.randomUUID()}`;
    const probe = vi.fn(async () => [] as string[]);

    await cachedCliResult(key, 60_000, probe, nonEmptyArray);
    await cachedCliResult(key, 60_000, probe, nonEmptyArray);

    expect(probe).toHaveBeenCalledTimes(2);
    expect(mockStore.read(key)).toBeUndefined();
  });

  it('reuses a successful CLI probe', async () => {
    const key = `codex-success-${crypto.randomUUID()}`;
    const probe = vi.fn(async () => ['gpt-5.5']);

    await cachedCliResult(key, 60_000, probe, nonEmptyArray);
    await cachedCliResult(key, 60_000, probe, nonEmptyArray);

    expect(probe).toHaveBeenCalledOnce();
  });

  it('kan een niet-lege live CLI-snapshot expliciet cachevrij vernieuwen', async () => {
    const key = `codex-catalog:${crypto.randomUUID()}`;
    const probe = vi.fn()
      .mockResolvedValueOnce(['eerste-snapshot'])
      .mockResolvedValueOnce(['actuele-snapshot']);

    await expect(cachedCliResult(key, 60_000, probe, nonEmptyArray, { persist: false }))
      .resolves.toEqual(['eerste-snapshot']);
    invalidateCachedCliResults('codex-catalog:');
    await expect(cachedCliResult(key, 60_000, probe, nonEmptyArray, { persist: false }))
      .resolves.toEqual(['actuele-snapshot']);

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('houdt een live modelcatalogus alleen kort in geheugen en niet over appstarts', async () => {
    const key = `codex-live-${crypto.randomUUID()}`;
    const probe = vi.fn(async () => ['gpt-live']);

    await cachedCliResult(key, 60_000, probe, nonEmptyArray, { persist: false });

    expect(mockStore.read(key)).toBeUndefined();
  });

  it('coalesces concurrent probes for the same CLI result', async () => {
    const key = `codex-concurrent-${crypto.randomUUID()}`;
    const probe = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return ['gpt-5.6-codex'];
    });

    const first = cachedCliResult(key, 60_000, probe, nonEmptyArray);
    const second = cachedCliResult(key, 60_000, probe, nonEmptyArray);

    await expect(Promise.all([first, second])).resolves.toEqual([
      ['gpt-5.6-codex'],
      ['gpt-5.6-codex'],
    ]);
    expect(probe).toHaveBeenCalledOnce();
  });
});

describe('live Codex-catalogus', () => {
  it('houdt alle door Codex zichtbare modellen, ook met een upgrade-advies', () => {
    expect(listableCodexCatalogModels([
      { slug: 'gpt-current', visibility: 'list' },
      { slug: 'gpt-older', visibility: 'list', upgrade: { model: 'gpt-current' } },
      { slug: 'intern', visibility: 'hide' },
    ]).map((model) => model.slug)).toEqual(['gpt-current', 'gpt-older']);
  });

  it('verzint geen modellen wanneer de live catalogus ontbreekt', () => {
    expect(listableCodexCatalogModels([])).toEqual([]);
    expect(listableCodexCatalogModels(undefined)).toEqual([]);
  });
});

describe('geminiSmokeCandidates', () => {
  it('kiest generiek het nieuwste live model zonder vaste modelallowlist', () => {
    expect(geminiSmokeCandidates([
      'gemini-2.5-flash',
      'gemini-4.2-future',
      'gemini-3.8-preview',
      'gemma-9.0-future',
    ])).toEqual([
      'gemini-4.2-future',
      'gemini-3.8-preview',
      'gemini-2.5-flash',
      'gemma-9.0-future',
    ]);
  });

  it('ontdubbelt de live catalogus', () => {
    expect(geminiSmokeCandidates(['gemini-7-alpha', 'gemini-7-alpha']))
      .toEqual(['gemini-7-alpha']);
  });
});

describe('googleCatalogCapabilities', () => {
  it('claimt geen capabilities die de live catalogus niet meldt', () => {
    expect(googleCatalogCapabilities({ supportedGenerationMethods: ['generateContent'] }))
      .toEqual({ vision: false, tools: false });
  });

  it('normaliseert expliciete provider-capabilities zonder modelnamen te hardcoden', () => {
    expect(googleCatalogCapabilities({
      supportedCapabilities: ['function_calling'],
      supportedInputModalities: ['TEXT', 'IMAGE'],
    })).toEqual({ vision: true, tools: true });
  });
});

describe('pickOpenAISmokeModel', () => {
  it('kiest uit de live catalogus generiek een lichte variant zonder vaste modelnamen', () => {
    expect(pickOpenAISmokeModel(['future-9-pro', 'future-10-mini', 'future-8-nano']))
      .toBe('future-10-mini');
  });

  it('werkt ook voor volledig nieuwe namen zonder bekende families', () => {
    expect(pickOpenAISmokeModel(['nova-2', 'nova-7'])).toBe('nova-7');
  });
});

describe('native providerfouten', () => {
  it('schakelt na een gestarte tool niet over naar een tweede provider', () => {
    const error = Object.assign(new Error('timeout na bestandswijziging'), { preventFallback: true });
    expect(classifyProviderError(error)).toMatchObject({
      reason: 'provider_error',
      message: 'timeout na bestandswijziging',
    });
  });
});

describe('CLI-chat zonder PC-tools', () => {
  it('zet Claude in plan/safe-mode zonder sessiepersistentie', () => {
    expect(claudeCliChatArgs('live-model', 'high')).toEqual(expect.arrayContaining([
      '--permission-mode', 'plan', '--safe-mode', '--no-session-persistence', '--effort', 'high',
    ]));
  });

  it('isoleert Codex van schrijfmodi en gebruikersconfig', () => {
    const args = codexCliChatArgs('live-model', 'high', 'fast');
    expect(args).toEqual(expect.arrayContaining([
      '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only',
    ]));
    expect(args).not.toContain('danger-full-access');
  });
});

describe('Ollama-modelcache na installatie', () => {
  it('kan direct worden geleegd zodat een zojuist gedownload model zichtbaar wordt', async () => {
    let installed = 'qwen3:8b';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: installed }] }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ capabilities: ['tools'] }),
      } as Response;
    }));
    const ollama = createAdapters().ollama;

    await expect(ollama.listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'ollama:qwen3:8b' }),
    ]);
    installed = 'qwen3:1.7b';
    await expect(ollama.listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'ollama:qwen3:8b' }),
    ]);

    ollama.invalidateModelCache?.();
    await expect(ollama.listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'ollama:qwen3:1.7b' }),
    ]);
  });
});
