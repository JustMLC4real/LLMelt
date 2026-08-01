import { describe, expect, it } from 'vitest';
import { finalNativeAssistantText } from '../electron/native-tool-loop-utils';

describe('native toolbeurt-tekst', () => {
  it('toont alleen het eindantwoord na de laatste tool', () => {
    expect(finalNativeAssistantText([
      'Ik ga het bestand nu maken.',
      'Ik voer het script uit.',
      'Klaar: skyline.py is gemaakt en succesvol getest.',
    ], 'fallback')).toBe('Klaar: skyline.py is gemaakt en succesvol getest.');
  });

  it('valt terug op het providerantwoord als er geen tekstsegment is', () => {
    expect(finalNativeAssistantText(['', '   '], '  Afgerond.  ')).toBe('Afgerond.');
  });
});
