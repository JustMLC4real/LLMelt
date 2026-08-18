import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectStatuslineQuotas,
  localOllamaQuotaSnapshots,
  readRecentJson,
  STATUSLINE_QUOTA_MAX_AGE_MS,
} from '../electron/quota-collectors';
import type { AIModel } from './providers/types';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('providerquotumcollectors', () => {
  it('gebruikt voor statusregels dezelfde freshness-grens als live snapshots', () => {
    const now = Date.now();
    const file = temporaryJson({ observedAt: new Date(now - STATUSLINE_QUOTA_MAX_AGE_MS).toISOString() });
    expect(readRecentJson(file, now)).toBeNull();
  });

  it('vervangt verlopen Claude- en Antigravity-data door actuele unknown-rijen', async () => {
    const observedAt = new Date(Date.now() - STATUSLINE_QUOTA_MAX_AGE_MS - 1).toISOString();
    const claude = temporaryJson({ observedAt, rate_limits: { five_hour: { used_percentage: 10 } } });
    const antigravity = temporaryJson({ observedAt, quota: { live: { model: 'future-model', remaining_fraction: 0.9 } } });

    const snapshots = await collectStatuslineQuotas(antigravity, claude);

    expect(snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'anthropic:cli:anthropic:account',
        state: 'unknown',
        accuracy: 'unavailable',
        source: 'claude-statusline',
      }),
      expect.objectContaining({
        id: 'antigravity:cli:antigravity:account',
        state: 'unknown',
        accuracy: 'unavailable',
        source: 'antigravity-statusline',
      }),
    ]));
    expect(snapshots.every((snapshot) => !snapshot.staleAfter)).toBe(true);
  });

  it('claimt zonder ontdekt Ollama-model geen onbeperkt lokaal quotum', () => {
    expect(localOllamaQuotaSnapshots([])).toEqual([
      expect.objectContaining({
        id: 'ollama:local:ollama:local',
        provider: 'ollama',
        surface: 'local',
        state: 'unknown',
        accuracy: 'unavailable',
        buckets: [],
      }),
    ]);
  });

  it('meldt alleen werkelijk ontdekte Ollama-modellen als lokaal onbeperkt', () => {
    const snapshots = localOllamaQuotaSnapshots([
      ollamaModel('ollama:qwen-live'),
      ollamaModel('ollama:qwen-live'),
      ollamaModel('ollama:future-large'),
    ]);
    expect(snapshots.map((snapshot) => [snapshot.modelId, snapshot.state])).toEqual([
      ['ollama:qwen-live', 'unlimited'],
      ['ollama:future-large', 'unlimited'],
    ]);
  });
});

function temporaryJson(value: unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmelt-quota-'));
  temporaryDirectories.push(directory);
  const file = path.join(directory, 'status.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function ollamaModel(id: string): AIModel {
  return {
    id,
    name: id,
    provider: 'ollama',
    contextWindow: 8_000,
    maxOutputTokens: 2_000,
    supportsVision: false,
    supportsFiles: true,
    supportsStreaming: true,
  };
}
