import { describe, expect, it, vi } from 'vitest';
import {
  describeWindowsClockSkew,
  diagnoseOllamaClockSkew,
} from '../electron/ollama-clock-skew';

describe('Ollama-klokdiagnose', () => {
  const serverTime = Date.parse('2026-07-29T18:34:00Z');

  it('herkent dat een Windows-klok meerdere dagen achterloopt', () => {
    expect(describeWindowsClockSkew(
      'Wed, 29 Jul 2026 18:34:00 GMT',
      Date.parse('2026-07-26T18:34:00Z'),
    )).toContain('ongeveer 3 dagen achter');
  });

  it('herkent ook een klok die voorloopt', () => {
    expect(describeWindowsClockSkew(
      'Wed, 29 Jul 2026 18:34:00 GMT',
      Date.parse('2026-07-29T20:34:00Z'),
    )).toContain('ongeveer 2 uur voor');
  });

  it('meldt geen irrelevant klein verschil of ongeldige serverdatum', () => {
    expect(describeWindowsClockSkew(
      'Wed, 29 Jul 2026 18:34:00 GMT',
      serverTime + 30_000,
    )).toBeNull();
    expect(describeWindowsClockSkew('geen datum', serverTime)).toBeNull();
  });

  it('gebruikt alleen de officiële Ollama-server als tijdreferentie', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 200,
      headers: { date: 'Wed, 29 Jul 2026 18:34:00 GMT' },
    })) as unknown as typeof fetch;

    await expect(diagnoseOllamaClockSkew(
      fetchImpl,
      Date.parse('2026-07-26T18:34:00Z'),
    )).resolves.toContain('3 dagen achter');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ollama.com/',
      expect.objectContaining({ method: 'HEAD', cache: 'no-store' }),
    );
  });

  it('laat de oorspronkelijke fout intact wanneer de klokcontrole niet lukt', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(diagnoseOllamaClockSkew(fetchImpl, serverTime)).resolves.toBeNull();
  });
});
