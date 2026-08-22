import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const TT_LOCALE_STORAGE_KEY = 'tokentracker-locale';
const TT_THEME_STORAGE_KEY = 'tokentracker-theme';

/** 宿主 app 语言 → vendored dashboard locale（tokentracker-locale）。 */
export function mapAppLanguageToTtLocale(language: string | undefined): string {
  switch (language) {
    case 'zh':
      return 'zh-CN';
    case 'zh-TW':
      return 'zh-TW';
    case 'ja':
      return 'ja';
    case 'ko':
      return 'ko';
    case 'de':
      return 'de';
    default:
      return 'en';
  }
}

/** documentElement[data-theme] → vendored dashboard theme（tokentracker-theme）。 */
function readAppTheme(): 'light' | 'dark' | 'system' {
  if (typeof document === 'undefined') return 'system';
  const value = document.documentElement.dataset.theme;
  if (value === 'dark' || value === 'dim') return 'dark';
  if (value === 'light') return 'light';
  return 'system';
}

/** 跟随宿主 app 主题（useThemeInit 把 IDE 主题写入 data-theme；缺省时按 system）。 */
function useAppTheme(): 'light' | 'dark' | 'system' {
  const [theme, setTheme] = useState(readAppTheme);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      setTheme(readAppTheme());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/**
 * 在渲染 dashboard 前同步桥接值。vendored LocaleProvider / ThemeProvider 只在
 * mount 时读一次 localStorage，所以这里同步写 + 调用方用 key 强制 remount。
 */
function syncBridgeStorage(ttLocale: string, ttTheme: string): void {
  try {
    localStorage.setItem(TT_LOCALE_STORAGE_KEY, ttLocale);
    localStorage.setItem(TT_THEME_STORAGE_KEY, ttTheme);
  } catch {
    // localStorage 不可用时由 dashboard 自身默认值兜底。
  }
}

/**
 * vendored TokenTracker 使用统计页的 locale/theme 桥接：
 * 渲染前把宿主语言与主题写入 localStorage，并返回 remount key
 * （`${ttLocale}:${appTheme}`，变化时强制 vendored tree 重新 mount）。
 */
export function useTokenTrackerViewBridge(): { remountKey: string } {
  const { i18n } = useTranslation();
  const appTheme = useAppTheme();
  const ttLocale = mapAppLanguageToTtLocale(i18n.language);
  // 注意:这是渲染期副作用(写 localStorage),有意为之 —— vendored dashboard
  // 的 providers 在 children mount 时同步读 localStorage,放进 useEffect 会太晚。
  // 写入幂等,StrictMode 双写无害;变化通过 remountKey 强制 remount 生效。
  syncBridgeStorage(ttLocale, appTheme);
  return { remountKey: `${ttLocale}:${appTheme}` };
}
