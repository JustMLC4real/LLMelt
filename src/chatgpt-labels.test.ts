import { describe, expect, it } from 'vitest';
import { chatgptIntelligenceLabel } from './providers/chatgpt-labels';

describe('ChatGPT-intelligentielabels', () => {
  it('vertaalt Engelstalige providerlabels voor de Nederlandse UI', () => {
    expect(chatgptIntelligenceLabel('Instant')).toBe('Direct');
    expect(chatgptIntelligenceLabel('Medium')).toBe('Gemiddeld');
    expect(chatgptIntelligenceLabel('High')).toBe('Hoog');
    expect(chatgptIntelligenceLabel('Extra High')).toBe('Zeer Hoog');
    expect(chatgptIntelligenceLabel('Pro')).toBe('Pro');
  });

  it('laat onbekende toekomstige providerlabels intact', () => {
    expect(chatgptIntelligenceLabel('Adaptive')).toBe('Adaptive');
  });
});
