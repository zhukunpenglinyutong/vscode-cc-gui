import { afterEach, describe, expect, it } from 'vitest';
import { detectIdeThemeFromDom } from './detectIdeTheme';

afterEach(() => {
  document.documentElement.style.removeProperty('--vscode-editor-background');
  document.body.className = '';
});

describe('detectIdeThemeFromDom', () => {
  it('reads a dark editor background as dark', () => {
    document.documentElement.style.setProperty('--vscode-editor-background', '#1e1e1e');
    expect(detectIdeThemeFromDom()).toBe('dark');
  });

  it('reads a light editor background as light', () => {
    document.documentElement.style.setProperty('--vscode-editor-background', '#ffffff');
    expect(detectIdeThemeFromDom()).toBe('light');
  });

  it('parses rgb() backgrounds', () => {
    document.documentElement.style.setProperty('--vscode-editor-background', 'rgb(30, 30, 30)');
    expect(detectIdeThemeFromDom()).toBe('dark');
  });

  it('falls back to the vscode body class when no background is set', () => {
    document.body.classList.add('vscode-light');
    expect(detectIdeThemeFromDom()).toBe('light');
  });

  it('returns null when the host provides no theme signal', () => {
    expect(detectIdeThemeFromDom()).toBeNull();
  });
});
