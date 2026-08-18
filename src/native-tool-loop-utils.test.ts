import { describe, expect, it } from 'vitest';
import {
  clipNativeToolDetail,
  finalNativeAssistantText,
  modelSafeToolOutput,
  nativeToolCallSignature,
  nativeToolFeedback,
  nativeToolLedgerSignature,
} from '../electron/native-tool-loop-utils';

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

  it('geeft Engelse protocolfeedback en afkaplabels in English-mode', () => {
    expect(nativeToolCallSignature(undefined, {}, 'en')).toContain('unknown_tool');
    expect(nativeToolFeedback({ ok: false, denied: true, output: 'no' }, false, 'en').instruction)
      .toContain('Do not request another PC tool action');
    expect(clipNativeToolDetail('abcdef', 3, 'en')).toContain('[truncated]');
    expect(modelSafeToolOutput('x'.repeat(50_000), 'en')).toContain('[tool output for model truncated]');
  });

  it('maakt provideraliases en padvelden gelijk voor de uitvoeringsledger', () => {
    const cwd = 'C:\\werkmap';
    expect(nativeToolLedgerSignature('Write', {
      file_path: 'src\\demo.py',
      content: 'print(1)',
    }, cwd)).toBe(nativeToolLedgerSignature('write_file', {
      path: 'src/demo.py',
      content: 'print(1)',
    }, cwd));
    expect(nativeToolLedgerSignature('Bash', {
      command: ['python', 'src/demo.py'],
      cwd,
    }, cwd)).toBe(nativeToolLedgerSignature('run_command', {
      command: 'python src/demo.py',
    }, cwd));
  });
});
