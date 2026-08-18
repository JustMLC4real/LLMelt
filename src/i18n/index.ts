import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import nl from './locales/nl.json';
import en from './locales/en.json';
import { normalizeUiLanguage } from './language';
import { runLanguageTransition } from './language-transition';

// Detect stored language or browser language
const getDefaultLanguage = (): string => {
  try {
    const stored = localStorage.getItem('ai-superapp-language');
    if (stored) return stored;
  } catch {}
  
  const browserLang = navigator.language.toLowerCase();
  if (browserLang.startsWith('nl')) return 'nl';
  return 'en';
};

i18n
  .use(initReactI18next)
  .init({
    resources: {
      nl: { translation: nl },
      en: { translation: en },
    },
    lng: getDefaultLanguage(),
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;

let languageChangeQueue = Promise.resolve();

export const changeLanguage = (lang: string) => {
  const language = normalizeUiLanguage(lang);
  languageChangeQueue = languageChangeQueue
    .catch(() => {})
    .then(async () => {
      if (normalizeUiLanguage(i18n.resolvedLanguage || i18n.language) === language) return;
      await runLanguageTransition(async () => {
        await i18n.changeLanguage(language);
        try {
          localStorage.setItem('ai-superapp-language', language);
        } catch {}
        // Het main-proces maakt ook providerstatussen en verborgen toolprompts.
        // Synchroniseer dat op hetzelfde omslagmoment als de volledige renderer.
        const sync = window.electronAPI?.settings?.set?.('ui.language', language);
        if (sync) void sync.catch(() => {});
      });
    });
  return languageChangeQueue;
};

const initialLanguage = normalizeUiLanguage(i18n.resolvedLanguage || i18n.language);
const initialSync = window.electronAPI?.settings?.set?.('ui.language', initialLanguage);
if (initialSync) void initialSync.catch(() => {});
