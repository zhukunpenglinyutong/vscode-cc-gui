// hooks/useSettingsThemeSync.ts
import { useState, useEffect } from 'react';
import { applyDiffTheme, getStoredDiffTheme, type DiffThemeMode } from '../../../utils/diffTheme';
import { detectIdeThemeFromDom } from '../../../utils/detectIdeTheme';
import {
  applyChatBarThemeColor,
  CHAT_BAR_COLOR_STORAGE_KEY,
  isValidHexColor,
} from '../../../utils/chatBarTheme';

// Extend window type for IDE theme injection
declare global {
  interface Window {
    __INITIAL_IDE_THEME__?: 'light' | 'dark';
  }
}

export interface UseSettingsThemeSyncReturn {
  themePreference: 'light' | 'dark' | 'system';
  setThemePreference: (theme: 'light' | 'dark' | 'system') => void;
  ideTheme: 'light' | 'dark' | null;
  setIdeTheme: (theme: 'light' | 'dark' | null) => void;
  fontSizeLevel: number;
  setFontSizeLevel: (level: number) => void;
  chatBgColor: string;
  setChatBgColor: (color: string) => void;
  userMsgColor: string;
  setUserMsgColor: (color: string) => void;
  chatBarColor: string;
  setChatBarColor: (color: string) => void;
  diffTheme: DiffThemeMode;
  setDiffTheme: (theme: DiffThemeMode) => void;
}

export function useSettingsThemeSync(): UseSettingsThemeSyncReturn {
  const [themePreference, setThemePreference] = useState<'light' | 'dark' | 'system'>(() => {
    // Read theme preference from localStorage
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
      return savedTheme;
    }
    return 'system'; // Default: follow IDE
  });

  // IDE theme state - prefer the host's injected CSS (reliable), then the
  // Java-injected hint. Used to handle dynamic theme changes.
  const [ideTheme, setIdeTheme] = useState<'light' | 'dark' | null>(() => {
    const detected = detectIdeThemeFromDom();
    if (detected) {
      return detected;
    }
    const injectedTheme = window.__INITIAL_IDE_THEME__;
    if (injectedTheme === 'light' || injectedTheme === 'dark') {
      return injectedTheme;
    }
    return null;
  });

  // Font size level state (1-6, default is 2, i.e. 90%)
  const [fontSizeLevel, setFontSizeLevel] = useState<number>(() => {
    const savedLevel = localStorage.getItem('fontSizeLevel');
    const level = savedLevel ? parseInt(savedLevel, 10) : 2;
    return level >= 1 && level <= 6 ? level : 2;
  });

  // Chat background color configuration
  const [chatBgColor, setChatBgColor] = useState<string>(() => {
    const saved = localStorage.getItem('chatBgColor');
    if (saved && /^#[0-9a-fA-F]{6}$/.test(saved)) {
      return saved;
    }
    return '';
  });

  // User message bubble color configuration
  const [userMsgColor, setUserMsgColor] = useState<string>(() => {
    const saved = localStorage.getItem('userMsgColor');
    if (saved && /^#[0-9a-fA-F]{6}$/.test(saved)) {
      return saved;
    }
    return '';
  });

  // Shared chat header / status bar color
  const [chatBarColor, setChatBarColor] = useState<string>(() => {
    const saved = localStorage.getItem(CHAT_BAR_COLOR_STORAGE_KEY);
    if (saved && isValidHexColor(saved)) {
      return saved;
    }
    return '';
  });

  // Diff theme configuration
  const [diffTheme, setDiffTheme] = useState<DiffThemeMode>(() => getStoredDiffTheme());

  // Theme switching handler (supports following IDE theme)
  useEffect(() => {
    const applyTheme = (preference: 'light' | 'dark' | 'system') => {
      if (preference === 'system') {
        // If following IDE, trust the host's injected CSS over stale state.
        const resolved = detectIdeThemeFromDom() ?? ideTheme;
        if (resolved === null) {
          return; // Wait for the IDE theme to become available
        }
        document.documentElement.setAttribute('data-theme', resolved);
      } else {
        // Explicit light/dark selection, apply immediately
        document.documentElement.setAttribute('data-theme', preference);
      }
    };

    applyTheme(themePreference);
    // Save to localStorage
    localStorage.setItem('theme', themePreference);
  }, [themePreference, ideTheme]);

  // Font size scaling handler
  useEffect(() => {
    // Map level to scale ratio
    const fontSizeMap: Record<number, number> = {
      1: 0.8,   // 80%
      2: 0.9,   // 90% (default)
      3: 1.0,   // 100%
      4: 1.1,   // 110%
      5: 1.2,   // 120%
      6: 1.4,   // 140%
    };
    const scale = fontSizeMap[fontSizeLevel] || 1.0;

    // Apply to root element
    document.documentElement.style.setProperty('--font-scale', scale.toString());

    // Save to localStorage
    localStorage.setItem('fontSizeLevel', fontSizeLevel.toString());
  }, [fontSizeLevel]);

  // Chat background color handler
  useEffect(() => {
    if (chatBgColor) {
      document.documentElement.style.setProperty('--bg-chat', chatBgColor);
      localStorage.setItem('chatBgColor', chatBgColor);
    } else {
      document.documentElement.style.removeProperty('--bg-chat');
      localStorage.removeItem('chatBgColor');
    }
  }, [chatBgColor]);

  // User message bubble color handler
  useEffect(() => {
    if (userMsgColor) {
      document.documentElement.style.setProperty('--color-message-user-bg', userMsgColor);
      localStorage.setItem('userMsgColor', userMsgColor);
    } else {
      document.documentElement.style.removeProperty('--color-message-user-bg');
      localStorage.removeItem('userMsgColor');
    }
  }, [userMsgColor]);

  // Chat bar (header / status) color handler
  useEffect(() => {
    applyChatBarThemeColor(chatBarColor);
    if (chatBarColor && isValidHexColor(chatBarColor)) {
      localStorage.setItem(CHAT_BAR_COLOR_STORAGE_KEY, chatBarColor);
    } else {
      localStorage.removeItem(CHAT_BAR_COLOR_STORAGE_KEY);
    }
  }, [chatBarColor]);

  // Diff theme handler
  useEffect(() => {
    applyDiffTheme(diffTheme, ideTheme);
  }, [diffTheme, ideTheme, themePreference]);

  return {
    themePreference,
    setThemePreference,
    ideTheme,
    setIdeTheme,
    fontSizeLevel,
    setFontSizeLevel,
    chatBgColor,
    setChatBgColor,
    userMsgColor,
    setUserMsgColor,
    chatBarColor,
    setChatBarColor,
    diffTheme,
    setDiffTheme,
  };
}
