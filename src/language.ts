/**
 * Map VS Code / BCP-47 locale tags to CC GUI i18n language codes.
 *
 * Supported UI languages: zh, en, zh-TW, hi, es, fr, ja, ru, ko, pt-BR.
 * Unknown locales fall back to Simplified Chinese (zh).
 */

export const SUPPORTED_UI_LANGUAGES = [
  'zh',
  'en',
  'zh-TW',
  'hi',
  'es',
  'fr',
  'ja',
  'ru',
  'ko',
  'pt-BR',
] as const;

export type UiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number];

export const DEFAULT_UI_LANGUAGE: UiLanguage = 'zh';

export type LanguageConfigPayload = {
  language: UiLanguage;
  /** 'user' = manual override; 'idea' = follow IDE (kept for webview compatibility). */
  source: 'user' | 'idea';
  /** Raw VS Code / host locale, e.g. zh-cn, en, ja. */
  ideaLocale?: string;
  /** Legacy field some call sites still emit. */
  manuallySet?: boolean;
};

export function isSupportedUiLanguage(value: string | undefined | null): value is UiLanguage {
  return !!value && (SUPPORTED_UI_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Convert a VS Code display language / system locale into a supported UI language.
 *
 * Examples:
 * - zh-cn / zh-hans / zh → zh
 * - zh-tw / zh-hk / zh-hant → zh-TW
 * - pt-br / pt → pt-BR
 * - en / en-us → en
 * - unknown → zh
 */
export function mapVscodeLocaleToLanguage(locale: string | undefined | null): UiLanguage {
  if (!locale || !locale.trim()) {
    return DEFAULT_UI_LANGUAGE;
  }

  const normalized = locale.trim().toLowerCase().replace(/_/g, '-');

  // Traditional Chinese variants first (more specific than bare "zh")
  if (
    normalized === 'zh-tw'
    || normalized === 'zh-hk'
    || normalized === 'zh-mo'
    || normalized === 'zh-hant'
    || normalized.startsWith('zh-tw')
    || normalized.startsWith('zh-hk')
    || normalized.startsWith('zh-mo')
    || normalized.startsWith('zh-hant')
  ) {
    return 'zh-TW';
  }

  if (normalized === 'zh' || normalized.startsWith('zh-')) {
    return 'zh';
  }

  if (normalized === 'pt-br' || normalized.startsWith('pt-br') || normalized === 'pt' || normalized.startsWith('pt-')) {
    return 'pt-BR';
  }

  const primary = normalized.split('-')[0] ?? '';
  switch (primary) {
    case 'en':
      return 'en';
    case 'ja':
      return 'ja';
    case 'ko':
      return 'ko';
    case 'fr':
      return 'fr';
    case 'es':
      return 'es';
    case 'ru':
      return 'ru';
    case 'hi':
      return 'hi';
    default:
      return DEFAULT_UI_LANGUAGE;
  }
}

/**
 * Resolve the effective UI language config.
 * Manual user override wins; otherwise follow the host IDE locale.
 */
export function resolveLanguageConfig(
  userLanguage: string | undefined | null,
  ideLocale: string | undefined | null,
): LanguageConfigPayload {
  const ideaLocale = ideLocale?.trim() || undefined;

  if (isSupportedUiLanguage(userLanguage)) {
    return {
      language: userLanguage,
      source: 'user',
      ideaLocale,
      manuallySet: true,
    };
  }

  return {
    language: mapVscodeLocaleToLanguage(ideLocale),
    source: 'idea',
    ideaLocale,
    manuallySet: false,
  };
}
