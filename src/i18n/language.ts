import type { UiLanguage } from '../providers/types';

export type { UiLanguage } from '../providers/types';

export function normalizeUiLanguage(value: unknown, fallback: UiLanguage = 'en'): UiLanguage {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized.startsWith('nl')) return 'nl';
  if (normalized.startsWith('en')) return 'en';
  return fallback;
}

export function localizedText(language: UiLanguage | undefined, nl: string, en: string) {
  return normalizeUiLanguage(language) === 'nl' ? nl : en;
}
