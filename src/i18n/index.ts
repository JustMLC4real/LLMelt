import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import nl from './locales/nl.json';
import en from './locales/en.json';

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

export const changeLanguage = (lang: string) => {
  i18n.changeLanguage(lang);
  localStorage.setItem('ai-superapp-language', lang);
};
