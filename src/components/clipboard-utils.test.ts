import { describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from './clipboard-utils';

describe('copyTextToClipboard', () => {
  it('gebruikt in Electron de vertrouwde native clipboard', async () => {
    const native = vi.fn().mockResolvedValue(true);
    const web = vi.fn().mockResolvedValue(undefined);

    await expect(copyTextToClipboard('hallo', { native, web })).resolves.toBe(true);
    expect(native).toHaveBeenCalledWith('hallo');
    expect(web).not.toHaveBeenCalled();
  });

  it('valt in de browser-preview terug op navigator.clipboard', async () => {
    const native = vi.fn().mockRejectedValue(new Error('geen preload'));
    const web = vi.fn().mockResolvedValue(undefined);

    await expect(copyTextToClipboard('hallo', { native, web })).resolves.toBe(true);
    expect(web).toHaveBeenCalledWith('hallo');
  });

  it('meldt geen vals succes als geen clipboard beschikbaar is', async () => {
    await expect(copyTextToClipboard('hallo', {})).resolves.toBe(false);
  });
});
