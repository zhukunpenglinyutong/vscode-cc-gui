import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './locales/zh.json';
import en from './locales/en.json';
import zhTW from './locales/zh-TW.json';
import hi from './locales/hi.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import ja from './locales/ja.json';
import ru from './locales/ru.json';
import ko from './locales/ko.json';
import ptBR from './locales/pt-BR.json';

const SUPPORTED_LANGUAGES = ['zh', 'en', 'zh-TW', 'hi', 'es', 'fr', 'ja', 'ru', 'ko', 'pt-BR'] as const;

/**
 * Initial UI language:
 * 1. Manual user choice in settings (languageSelectionMode === 'manual')
 * 2. Host-injected config (VS Code display language / IDEA locale)
 * 3. Previously synced language from localStorage
 * 4. Simplified Chinese default
 */
const getInitialLanguage = (): string => {
  try {
    const mode = localStorage.getItem('languageSelectionMode');
    const savedLanguage = localStorage.getItem('language');

    if (mode === 'manual' && savedLanguage && (SUPPORTED_LANGUAGES as readonly string[]).includes(savedLanguage)) {
      return savedLanguage;
    }

    const pending = typeof window !== 'undefined' ? window.__pendingLanguageConfig : undefined;
    if (pending) {
      const language =
        typeof pending === 'string'
          ? (() => {
              try {
                return (JSON.parse(pending) as { language?: string }).language;
              } catch {
                return undefined;
              }
            })()
          : pending.language;
      if (language && (SUPPORTED_LANGUAGES as readonly string[]).includes(language)) {
        return language;
      }
    }

    if (savedLanguage && (SUPPORTED_LANGUAGES as readonly string[]).includes(savedLanguage)) {
      return savedLanguage;
    }
  } catch {
    // localStorage / window may be unavailable in some test environments
  }

  return 'zh';
};

i18n
  .use(initReactI18next) // Integrate i18n with React
  .init({
    resources: {
      zh: { translation: zh }, // Simplified Chinese
      en: { translation: en }, // English
      'zh-TW': { translation: zhTW }, // Traditional Chinese
      hi: { translation: hi }, // Hindi
      es: { translation: es }, // Spanish
      fr: { translation: fr }, // French
      ja: { translation: ja }, // Japanese
      ru: { translation: ru }, // Russian
      ko: { translation: ko }, // Korean
      'pt-BR': { translation: ptBR }, // Portuguese (Brazil)
    },
    lng: getInitialLanguage(), // Initial language
    fallbackLng: 'zh', // Fallback to Chinese when a translation is missing
    interpolation: {
      escapeValue: false, // React already handles XSS protection
    },
  });

export default i18n;
