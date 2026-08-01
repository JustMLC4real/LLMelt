import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('live-provider launcher', () => {
  it('leest de Gemini-key uitsluitend voor een Gemini-run of een volledige run', () => {
    const source = readFileSync(new URL('../scripts/native-provider-bootstrap.mjs', import.meta.url), 'utf8');
    expect(source).toContain('const needsGemini = !filter || /gemini/i.test(filter)')
    expect(source).toContain("String(process.env.GEMINI_API_KEY || '').trim() || readGeminiKey()")
    expect(source).toContain("...(geminiApiKey ? { GEMINI_API_KEY: geminiApiKey } : {})")
  });

  it('slaat discovery van niet-geselecteerde providers over', () => {
    const source = readFileSync(new URL('./native-providers.integration.test.ts', import.meta.url), 'utf8');
    expect(source).toContain("includesLiveProvider('gemini')")
    expect(source).toContain("includesLiveProvider('ollama')")
    expect(source).toContain("includesLiveProvider('codex')")
  });
});
