import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OLLAMA_TITLE_MODEL,
  resolveOllamaTitleSetup,
  selectOllamaTitleModel,
} from '../electron/chat-title-ollama';

describe('Ollama-model voor gesprekstitels', () => {
  const models = [
    { name: 'gpt-oss:20b', size: 13_000 },
    { name: 'qwen3.5:9b', size: 6_600 },
    { name: 'qwen3:8b', size: 5_200 },
    { name: 'qwen2.5-coder:7b', size: 4_700 },
  ];

  it('kiest het kleinste algemene model in plaats van blind het eerste/grootste model', () => {
    expect(selectOllamaTitleModel(undefined, models)).toBe('qwen3:8b');
  });

  it('respecteert een expliciet ingesteld model', () => {
    expect(selectOllamaTitleModel('ollama:gpt-oss:20b', models)).toBe('gpt-oss:20b');
  });

  it('valt bij uitsluitend code-modellen terug op het kleinste aanwezige model', () => {
    expect(selectOllamaTitleModel(undefined, [
      { name: 'coder:14b', size: 14 },
      { name: 'coder:7b', size: 7 },
    ])).toBe('coder:7b');
  });

  it('meldt een aanwezige lokale runtime en model als gereed', () => {
    expect(resolveOllamaTitleSetup(undefined, models, true)).toMatchObject({
      ready: true,
      runtimeAvailable: true,
      modelAvailable: true,
      model: 'qwen3:8b',
    });
  });

  it('adviseert het lichte titelmodel wanneer nog geen model aanwezig is', () => {
    expect(resolveOllamaTitleSetup(undefined, [], true)).toEqual({
      ready: false,
      runtimeAvailable: true,
      modelAvailable: false,
      model: DEFAULT_OLLAMA_TITLE_MODEL,
      installedModels: [],
    });
  });

  it('onderscheidt een ontbrekende Ollama-runtime van alleen een ontbrekend model', () => {
    expect(resolveOllamaTitleSetup(undefined, [], false)).toMatchObject({
      ready: false,
      runtimeAvailable: false,
      modelAvailable: false,
      model: DEFAULT_OLLAMA_TITLE_MODEL,
    });
  });
});
