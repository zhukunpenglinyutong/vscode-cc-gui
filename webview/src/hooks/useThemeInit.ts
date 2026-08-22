import { useEffect, useState } from 'react';
import { detectIdeThemeFromDom } from '../utils/detectIdeTheme';
import {
  applyChatBarThemeColor,
  CHAT_BAR_COLOR_STORAGE_KEY,
} from '../utils/chatBarTheme';

/**
 * Manages IDE theme initialization and synchronization.
 * Handles font scaling, background color, and theme mode detection.
 */
export function useThemeInit() {
  // IDE theme state - prefer the theme injected into the DOM by the host
  // (--vscode-editor-background), which is reliable even when the bridge
  // message reports the wrong value. Fall back to the Java-injected hint.
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

  // Initialize theme and font scaling
  useEffect(() => {
    // Resolve the IDE theme, trusting the injected CSS over the bridge flag.
    const resolveTheme = (jsonStr: string): 'light' | 'dark' => {
      const detected = detectIdeThemeFromDom();
      if (detected) {
        return detected;
      }
      const themeData = JSON.parse(jsonStr);
      return themeData.isDark ? 'dark' : 'light';
    };

    // Register IDE theme received callback
    window.onIdeThemeReceived = (jsonStr: string) => {
      try {
        setIdeTheme(resolveTheme(jsonStr));
      } catch {
        // Failed to parse IDE theme response
      }
    };

    // Listen for IDE theme changes (when user switches theme in the IDE)
    window.onIdeThemeChanged = (jsonStr: string) => {
      try {
        setIdeTheme(resolveTheme(jsonStr));
      } catch {
        // Failed to parse IDE theme change
      }
    };

    // Initialize font scaling
    const savedLevel = localStorage.getItem('fontSizeLevel');
    const level = savedLevel ? parseInt(savedLevel, 10) : 2; // Default level 2 (90%)
    const fontSizeLevel = (level >= 1 && level <= 6) ? level : 2;

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
    document.documentElement.style.setProperty('--font-scale', scale.toString());

    // Initialize chat background color (validate hex format before applying)
    const isValidHexColor = (c: string) => /^#[0-9a-fA-F]{6}$/.test(c);
    const savedChatBgColor = localStorage.getItem('chatBgColor');
    if (savedChatBgColor && isValidHexColor(savedChatBgColor)) {
      document.documentElement.style.setProperty('--bg-chat', savedChatBgColor);
    }

    // Initialize user message bubble color
    const savedUserMsgColor = localStorage.getItem('userMsgColor');
    if (savedUserMsgColor && isValidHexColor(savedUserMsgColor)) {
      document.documentElement.style.setProperty('--color-message-user-bg', savedUserMsgColor);
    }

    // Initialize shared chat header / status bar color
    const savedChatBarColor = localStorage.getItem(CHAT_BAR_COLOR_STORAGE_KEY) || '';
    applyChatBarThemeColor(savedChatBarColor);

    // Apply the user's explicit theme choice (light/dark) first
    const savedTheme = localStorage.getItem('theme');

    // Check if there's an initial theme injected by Java
    const injectedTheme = window.__INITIAL_IDE_THEME__;

    // Correct the initial guess as soon as the host's CSS is available.
    const detectedOnMount = detectIdeThemeFromDom();
    if (detectedOnMount) {
      setIdeTheme(detectedOnMount);
    }

    // Catch live IDE theme switches even when the bridge does not notify us:
    // the host toggles the vscode-dark/vscode-light class on <body>.
    let themeObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined' && document.body) {
      themeObserver = new MutationObserver(() => {
        const detected = detectIdeThemeFromDom();
        if (detected) {
          setIdeTheme(detected);
        }
      });
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class'],
      });
    }

    // Request IDE theme (with retry mechanism)
    let retryCount = 0;
    const MAX_RETRIES = 20; // Max 20 retries (2 seconds)

    const requestIdeTheme = () => {
      if (window.sendToJava) {
        window.sendToJava('get_ide_theme:');
      } else {
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          setTimeout(requestIdeTheme, 100);
        } else {
          // If in Follow IDE mode and unable to get IDE theme, use injected theme or dark as fallback
          if (savedTheme === null || savedTheme === 'system') {
            const fallback = injectedTheme || 'dark';
            setIdeTheme(fallback as 'light' | 'dark');
          }
        }
      }
    };

    // Delay 100ms before requesting, giving the bridge time to initialize
    setTimeout(requestIdeTheme, 100);

    return () => {
      themeObserver?.disconnect();
    };
  }, []);

  // Re-apply theme when IDE theme changes (if user chose "Follow IDE")
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');

    // Only process after ideTheme has been loaded
    if (ideTheme === null) {
      return;
    }

    // If user selected "Follow IDE" mode
    if (savedTheme === null || savedTheme === 'system') {
      document.documentElement.setAttribute('data-theme', ideTheme);
    }
  }, [ideTheme]);

  return { ideTheme };
}
