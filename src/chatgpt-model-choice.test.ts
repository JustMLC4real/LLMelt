import { describe, expect, it } from 'vitest';
import { chatGptChoiceValidationError } from '../electron/chatgpt-model-choice';
import type { ChatgptVersion } from './providers/types';

const versions: ChatgptVersion[] = [{
  id: 'latest',
  title: 'GPT-5.6 Sol',
  enabled: true,
  slugs: ['gpt-5-6-thinking', 'gpt-5-6-pro'],
  presets: [
    {
      title: 'Hoog',
      modelSlug: 'gpt-5-6-thinking',
      thinkingEffort: 'extended',
      available: true,
    },
    {
      title: 'Pro',
      modelSlug: 'gpt-5-6-pro',
      available: false,
    },
  ],
}, {
  id: 'o3',
  title: 'o3',
  enabled: true,
  slugs: ['o3'],
  presets: [],
}];

const liveSlugs = new Set(['gpt-5-6-thinking', 'gpt-5-6-pro', 'o3']);

describe('ChatGPT live modelkeuze', () => {
  it('accepteert alleen een live beschikbaar model en intelligentieniveau', () => {
    expect(chatGptChoiceValidationError(
      versions,
      liveSlugs,
      'chatgpt:gpt-5-6-thinking',
      'extended',
    )).toBeNull();
    expect(chatGptChoiceValidationError(versions, liveSlugs, 'chatgpt:o3')).toBeNull();
  });

  it('weigert een verborgen standaardfallback en een grijs niveau', () => {
    expect(chatGptChoiceValidationError(
      versions,
      liveSlugs,
      'chatgpt:gpt-5-3-instant',
    )).toContain('niet in de huidige live webcatalogus');
    expect(chatGptChoiceValidationError(
      versions,
      liveSlugs,
      'chatgpt:gpt-5-6-pro',
    )).toContain('niet beschikbaar');
  });
});
