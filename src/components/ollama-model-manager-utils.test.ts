import { describe, expect, it } from 'vitest';
import type { AIModel } from '../providers/types';
import { replacementAfterOllamaCatalogChange } from './ollama-model-manager-utils';

function model(id: string, provider: AIModel['provider']): AIModel {
  return {
    id,
    name: id,
    provider,
    contextWindow: 8_192,
    maxOutputTokens: 2_048,
    supportsVision: false,
    supportsFiles: true,
    supportsStreaming: true,
  };
}

describe('actief model na Ollama-modelbeheer', () => {
  it('laat een nog bestaand Ollama-model staan', () => {
    const available = [model('ollama:qwen3:8b', 'ollama')];
    expect(replacementAfterOllamaCatalogChange(
      { provider: 'ollama', modelId: 'ollama:qwen3:8b' },
      available,
    )).toBeNull();
  });

  it('kiest een werkelijk beschikbaar alternatief als het actieve model is verwijderd', () => {
    const available = [model('codex:gpt-5.6', 'codex'), model('ollama:qwen3:8b', 'ollama')];
    expect(replacementAfterOllamaCatalogChange(
      { provider: 'ollama', modelId: 'ollama:verwijderd' },
      available,
    )).toMatchObject({ provider: 'codex', modelId: 'codex:gpt-5.6' });
  });

  it('wijzigt een andere provider nooit en kan zonder alternatieven veilig leegmaken', () => {
    expect(replacementAfterOllamaCatalogChange(
      { provider: 'codex', modelId: 'codex:gpt-5.6' },
      [],
    )).toBeNull();
    expect(replacementAfterOllamaCatalogChange(
      { provider: 'ollama', modelId: 'ollama:verwijderd' },
      [],
    )).toEqual({ provider: 'ollama', modelId: '' });
  });
});
