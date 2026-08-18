import { describe, expect, it } from 'vitest';
import { normalizeLegacyModelId } from './providers/model-ref-normalization';

describe('legacy modelreferenties', () => {
  it('stript een oude Codex-suffix zonder een effort te verzinnen', () => {
    expect(normalizeLegacyModelId('codex', 'future-codex#thinking')).toEqual({
      modelId: 'future-codex',
      runConfig: { baseModelId: 'future-codex' },
    });
    expect(normalizeLegacyModelId('codex', 'future-codex#onbekend')).toEqual({
      modelId: 'future-codex',
      runConfig: { baseModelId: 'future-codex' },
    });
  });

  it('laat model-id\'s van andere providers intact', () => {
    expect(normalizeLegacyModelId('antigravity', 'future#high')).toEqual({
      modelId: 'future#high',
    });
  });
});
