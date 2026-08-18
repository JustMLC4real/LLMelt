import { describe, expect, it, vi } from 'vitest';
import {
  assertOllamaModelName,
  deleteOllamaModel,
  friendlyOllamaPullError,
  isRetryableOllamaRegistryError,
  listInstalledOllamaModels,
  parseOllamaLibrarySearchHtml,
  parseOllamaLibraryTagsHtml,
  pullOllamaModel,
} from '../electron/ollama-model-manager';

const searchFixture = `
  <li class="flex items-baseline border-b border-neutral-200 py-6">
    <a href="/library/qwen3.5" class="group w-full">
      <h2><span>qwen3.5</span></h2>
      <p class="max-w-lg break-words text-neutral-800 text-md">Een &amp; multimodaal model.</p>
      <span class="bg-indigo-50">vision</span>
      <span class="bg-indigo-50">tools</span>
      <span class="bg-[#ddf4ff]">0.8b</span>
      <span>16.4M</span><span> Pulls</span>
      <span>64</span><span> Tags</span>
    </a>
  </li>
  <li class="flex items-baseline border-b border-neutral-200 py-6">
    <a href="/maker/code-model" class="group w-full">
      <h2><span>maker/code-model</span></h2>
      <p class="max-w-lg">Communitymodel.</p>
      <span class="bg-indigo-50">thinking</span>
      <span class="bg-[#ddf4ff]">7b</span>
    </a>
  </li>
`;

const tagsFixture = `
  <a href="/library/qwen3.5:0.8b" class="group-hover:underline">qwen3.5:0.8b</a>
  <p class="col-span-2 text-neutral-500">1.0GB</p>
  <p class="col-span-2 text-neutral-500">256K</p>
  <div class="col-span-2 text-neutral-500">Text, Image</div>
  <span class="font-mono">f3817196d142</span>&nbsp;·&nbsp;4 months ago</div>
  <a href="/library/qwen3.5:9b" class="group-hover:underline">qwen3.5:9b</a>
  <p class="col-span-2 text-neutral-500">6.6GB</p>
  <p class="col-span-2 text-neutral-500">256K</p>
  <div class="col-span-2 text-neutral-500">Text, Image</div>
  <span class="font-mono">6488c96fa5fa</span>&nbsp;·&nbsp;2 months ago</div>
`;

function streamResponse(lines: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines.map((line) => JSON.stringify(line)).join('\n')));
      controller.close();
    },
  }), { status: 200 });
}

describe('Ollama-modelbeheer', () => {
  it('valideert modelreferenties zonder shell- of URL-injectie toe te laten', () => {
    expect(assertOllamaModelName('qwen3.5:9b')).toBe('qwen3.5:9b');
    expect(assertOllamaModelName('maker/code-model:Q4_K_M')).toBe('maker/code-model:Q4_K_M');
    for (const invalid of ['', 'qwen 3', '../qwen', 'qwen?x=1', 'qwen; rm']) {
      expect(() => assertOllamaModelName(invalid)).toThrow();
    }
    expect(() => assertOllamaModelName('qwen?x=1', 'en')).toThrow('contains invalid characters');
  });

  it('leest officiële en communityzoekresultaten met capabilities en varianten', () => {
    expect(parseOllamaLibrarySearchHtml(searchFixture)).toEqual([
      {
        name: 'qwen3.5',
        description: 'Een & multimodaal model.',
        libraryPath: '/library/qwen3.5',
        capabilities: ['vision', 'tools'],
        variants: ['0.8b'],
        pulls: '16.4M',
        tagCount: '64',
        updated: undefined,
      },
      {
        name: 'maker/code-model',
        description: 'Communitymodel.',
        libraryPath: '/maker/code-model',
        capabilities: ['thinking'],
        variants: ['7b'],
        pulls: undefined,
        tagCount: undefined,
        updated: undefined,
      },
    ]);
  });

  it('leest downloadbare varianten uit de officiële tagpagina', () => {
    expect(parseOllamaLibraryTagsHtml(tagsFixture)).toEqual([
      {
        name: 'qwen3.5:0.8b',
        tag: '0.8b',
        sizeLabel: '1.0GB',
        contextLabel: '256K',
        inputLabel: 'Text, Image',
        digest: 'f3817196d142',
        updated: '4 months ago',
      },
      {
        name: 'qwen3.5:9b',
        tag: '9b',
        sizeLabel: '6.6GB',
        contextLabel: '256K',
        inputLabel: 'Text, Image',
        digest: '6488c96fa5fa',
        updated: '2 months ago',
      },
    ]);
  });

  it('combineert tags en show-details voor geïnstalleerde modellen', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({
          models: [{
            name: 'qwen3:1.7b',
            size: 1_400_000_000,
            digest: 'abc',
            modified_at: '2026-07-28T10:00:00Z',
            details: { family: 'qwen3', parameter_size: '1.7B', quantization_level: 'Q4_K_M' },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        capabilities: ['completion', 'tools', 'thinking'],
        model_info: { 'qwen3.context_length': 40960 },
      }), { status: 200 });
    });
    const models = await listInstalledOllamaModels('http://localhost:11434/', fetchMock as typeof fetch);
    expect(models).toEqual([expect.objectContaining({
      name: 'qwen3:1.7b',
      size: 1_400_000_000,
      parameterSize: '1.7B',
      capabilities: ['completion', 'tools', 'thinking'],
      contextWindow: 40960,
    })]);
  });

  it('streamt downloadvoortgang, bevestigt succes en verwijdert via de officiële API', async () => {
    const progress: string[] = [];
    const pullFetch = vi.fn(async () => streamResponse([
      { status: 'pulling manifest' },
      { status: 'pulling layer', completed: 50, total: 100 },
      { status: 'verifying sha256 digest', completed: 100, total: 100 },
      { status: 'success' },
    ]));
    await expect(pullOllamaModel(
      'http://localhost:11434',
      'qwen3:1.7b',
      new AbortController().signal,
      (update) => progress.push(update.phase),
      pullFetch as typeof fetch,
    )).resolves.toBe('qwen3:1.7b');
    expect(progress).toContain('downloading');
    expect(progress).toContain('verifying');
    expect(progress.at(-1)).toBe('success');

    const deleteFetch = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(deleteOllamaModel(
      'http://localhost:11434',
      'qwen3:1.7b',
      deleteFetch as typeof fetch,
    )).resolves.toBe('qwen3:1.7b');
    expect(deleteFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/delete',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('probeert een tijdelijke publieke manifest-401 opnieuw en vraagt geen API-key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse([{ error: 'pull model manifest: 401' }]))
      .mockResolvedValueOnce(streamResponse([{ status: 'success' }]));
    const waits: number[] = [];
    await expect(pullOllamaModel(
      'http://localhost:11434',
      'qwen3:1.7b',
      new AbortController().signal,
      () => {},
      fetchMock as typeof fetch,
      async (milliseconds) => { waits.push(milliseconds); },
    )).resolves.toBe('qwen3:1.7b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([750]);
    expect(isRetryableOllamaRegistryError('pull model manifest: 401')).toBe(true);
    expect(friendlyOllamaPullError('qwen3:1.7b', 'pull model manifest: 401'))
      .toContain('geen Ollama API-key nodig');
    expect(friendlyOllamaPullError('qwen3:1.7b', 'pull model manifest: 401', 'en'))
      .toContain('No Ollama API key is required');
  });
});
