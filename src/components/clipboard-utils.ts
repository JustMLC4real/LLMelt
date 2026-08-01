type ClipboardWriters = {
  native?: (text: string) => Promise<unknown>;
  web?: (text: string) => Promise<unknown>;
};

function defaultClipboardWriters(): ClipboardWriters {
  return {
    native: typeof window !== 'undefined'
      ? window.electronAPI?.clipboard?.writeText
      : undefined,
    web: typeof navigator !== 'undefined'
      ? navigator.clipboard?.writeText?.bind(navigator.clipboard)
      : undefined,
  };
}

/**
 * Kopieert eerst via Electron zelf. De browser-clipboard is alleen een fallback voor
 * de losse Vite-preview, waar de preload-brug niet bestaat.
 */
export async function copyTextToClipboard(text: string, writers = defaultClipboardWriters()) {
  if (!text) return false;
  if (writers.native) {
    try {
      await writers.native(text);
      return true;
    } catch { /* probeer de web-fallback */ }
  }
  if (writers.web) {
    try {
      await writers.web(text);
      return true;
    } catch { /* geen clipboard beschikbaar */ }
  }
  return false;
}
