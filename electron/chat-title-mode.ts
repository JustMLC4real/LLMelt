export type ChatTitleMode = 'ollama' | 'simple' | 'off';

export function resolveConfiguredChatTitleMode(
  configured: unknown,
): ChatTitleMode {
  if (configured === 'ollama' || configured === 'simple' || configured === 'off') {
    return configured;
  }
  // Oude installaties kunnen nog `auto` of `gpt` bevatten. Beide migreren naar
  // de enige AI-titelprovider: Ollama.
  return 'ollama';
}

function comparableTitle(value: string) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('nl-NL')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function simpleChatTitleFrom(text: string): string {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  return oneLine.length > 42 ? `${oneLine.slice(0, 42).trim()}…` : oneLine;
}

export function sanitizeGeneratedChatTitle(raw: string): string {
  let title = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  title = title.replace(/^["'`]+|["'`]+$/g, '').trim();
  title = title
    .replace(/^(?:(?:korte\s+)?(?:gespreks)?titel|onderwerp)\s*[:-]\s*/i, '')
    .trim();
  title = title.replace(/[.。?!]+$/, '').trim();
  return title.length > 60 ? `${title.slice(0, 60).trim()}…` : title;
}

export function isGeneratedTitleDistinct(title: string, firstUserText: string) {
  const generated = comparableTitle(title);
  const source = comparableTitle(firstUserText);
  return !!generated && generated !== source;
}

export function isUsableGeneratedChatTitle(title: string, firstUserText: string) {
  const cleaned = sanitizeGeneratedChatTitle(title);
  const words = cleaned.match(/[\p{L}\p{N}]+/gu) || [];
  return isGeneratedTitleDistinct(cleaned, firstUserText)
    && words.length >= 2
    && words.length <= 8
    && !/^[\\/]|[{}<>]/.test(cleaned);
}

export function isLikelyLegacyPromptTitle(title: string, firstUserText: string) {
  return !isGeneratedTitleDistinct(title, firstUserText)
    || !isGeneratedTitleDistinct(title, simpleChatTitleFrom(firstUserText));
}
