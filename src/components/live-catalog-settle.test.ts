import { describe, expect, it, vi } from 'vitest';
import { settleLiveCatalog } from './live-catalog-settle';

describe('live catalogus stabiliseren', () => {
  it('ververst ook na een niet-lege eerste snapshot twee keer', async () => {
    const snapshots = [
      ['oud-a', 'oud-b'],
      ['nieuw-a', 'nieuw-b', 'nieuw-c'],
    ];
    const refresh = vi.fn(async () => snapshots.shift() || []);
    const apply = vi.fn();

    await expect(settleLiveCatalog({
      refresh,
      apply,
      delays: [1, 2],
      wait: async () => {},
    })).resolves.toBe(2);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(['nieuw-a', 'nieuw-b', 'nieuw-c']);
  });

  it('gaat na een tijdelijke fout door en respecteert annulering', async () => {
    let cancelled = false;
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error('CLI warmt nog op'))
      .mockResolvedValueOnce(['live']);
    const apply = vi.fn(() => { cancelled = true; });

    await expect(settleLiveCatalog({
      refresh,
      apply,
      isCancelled: () => cancelled,
      delays: [0, 0, 0],
      wait: async () => {},
    })).resolves.toBe(1);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledWith(['live']);
  });
});
