import { describe, expect, it } from 'vitest';
import { normalizeAntigravityModelCatalog, parseAntigravityModelCatalog } from '../electron/antigravity-model-catalog';

describe('Antigravity live modelcatalogus', () => {
  it('neemt bij het huidige tabelformaat de commandowaarde en live weergavenaam over', () => {
    expect(parseAntigravityModelCatalog([
      'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
      'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
      'Fetching available models...',
    ].join('\r\n'))).toEqual([
      { id: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (High)' },
      { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
    ]);
  });

  it('behoudt oude modelwaarden met spaties en verwijdert alleen exacte dubbelen', () => {
    expect(parseAntigravityModelCatalog([
      'Gemini 3.5 Flash (High)',
      'Gemini 3.5 Flash (High)',
      'Claude Opus 4.6 (Thinking)',
    ].join('\n'))).toEqual([
      { id: 'Gemini 3.5 Flash (High)', name: 'Gemini 3.5 Flash (High)' },
      { id: 'Claude Opus 4.6 (Thinking)', name: 'Claude Opus 4.6 (Thinking)' },
    ]);
  });

  it('herstelt een persistent opgeslagen catalogus uit een oudere versie', () => {
    expect(normalizeAntigravityModelCatalog([
      'gemini-3.7-flash-high',
      'claude-opus-4-6-thinking',
      'gemini-3.7-flash-high',
    ])).toEqual([
      { id: 'gemini-3.7-flash-high', name: 'gemini-3.7-flash-high' },
      { id: 'claude-opus-4-6-thinking', name: 'claude-opus-4-6-thinking' },
    ]);
  });

  it('laat ongeldige cachewaarden nooit als lege modellen door', () => {
    expect(normalizeAntigravityModelCatalog([
      null,
      {},
      { id: '  ', name: 'Leeg' },
      { id: 'gemini-live', name: '' },
    ])).toEqual([{ id: 'gemini-live', name: 'gemini-live' }]);
  });
});
