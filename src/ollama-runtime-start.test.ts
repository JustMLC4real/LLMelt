import { describe, expect, it } from 'vitest';
import {
  conciseOllamaStartupDiagnostic,
  ollamaProbeBaseUrls,
  ollamaWindowsStartCandidates,
} from '../electron/ollama-runtime-start';

describe('Ollama-runtime starten', () => {
  it('probeert bij een lokale URL zowel localhost als expliciet IPv4', () => {
    expect(ollamaProbeBaseUrls('http://localhost:11434')).toEqual([
      'http://localhost:11434',
      'http://127.0.0.1:11434',
    ]);
  });

  it('probeert eerst de Windows-app en daarna de headless server', () => {
    expect(ollamaWindowsStartCandidates('C:\\Ollama\\ollama.exe')).toEqual([
      {
        file: 'C:\\Ollama\\ollama app.exe',
        args: [],
        label: 'Ollama Windows-app',
        requiresExistingFile: true,
      },
      {
        file: 'C:\\Ollama\\ollama.exe',
        args: ['serve'],
        label: 'ollama serve',
        requiresExistingFile: false,
      },
    ]);
  });

  it('beperkt en dedupliceert startdiagnostiek', () => {
    expect(conciseOllamaStartupDiagnostic('eerste\nzelfde', 'zelfde\ntweede'))
      .toBe('eerste\nzelfde\ntweede');
  });
});
