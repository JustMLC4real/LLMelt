import { describe, expect, it } from 'vitest';
import { parseAntigravityModelCatalog } from '../electron/antigravity-model-catalog';

describe('Antigravity live modelcatalogus', () => {
  it('neemt bij de huidige tabelformaat alleen de geldige --model-slug over', () => {
    expect(parseAntigravityModelCatalog([
      'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
      'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
      'Fetching available models...',
    ].join('\r\n'))).toEqual([
      'gemini-3.6-flash-high',
      'claude-opus-4-6-thinking',
    ]);
  });

  it('behoudt oude modelwaarden met spaties en verwijdert alleen exacte dubbelen', () => {
    expect(parseAntigravityModelCatalog([
      'Gemini 3.5 Flash (High)',
      'Gemini 3.5 Flash (High)',
      'Claude Opus 4.6 (Thinking)',
    ].join('\n'))).toEqual([
      'Gemini 3.5 Flash (High)',
      'Claude Opus 4.6 (Thinking)',
    ]);
  });
});
