/**
 * Detects the real IDE theme from CSS signals injected by the host.
 *
 * The bridge message (`get_ide_theme` / `onIdeThemeReceived`) can report the
 * wrong value in some hosts, which leaves "Follow IDE" stuck on the wrong
 * mode. The host always injects `--vscode-editor-background` (that is why
 * dialogs render with the real IDE colors), so its luminance is a reliable
 * source of truth. Falls back to the VS Code body class, then null when no
 * signal is available (non-VS-Code hosts) so callers can use the bridge value.
 */
export function detectIdeThemeFromDom(): 'light' | 'dark' | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const bgLuminance = readEditorBackgroundLuminance();
  if (bgLuminance !== null) {
    return bgLuminance < 0.5 ? 'dark' : 'light';
  }

  const body = document.body;
  if (body) {
    if (body.classList.contains('vscode-dark') || body.classList.contains('vscode-high-contrast')) {
      return 'dark';
    }
    if (body.classList.contains('vscode-light') || body.classList.contains('vscode-high-contrast-light')) {
      return 'light';
    }
  }

  return null;
}

function readEditorBackgroundLuminance(): number | null {
  const root = document.documentElement;
  const raw = getComputedStyle(root).getPropertyValue('--vscode-editor-background').trim();
  if (!raw) {
    return null;
  }
  return colorLuminance(raw);
}

/** Relative luminance in [0, 1] from a hex or rgb(a) color string, or null. */
function colorLuminance(color: string): number | null {
  const rgb = parseColor(color);
  if (!rgb) {
    return null;
  }
  const [r, g, b] = rgb;
  // Perceived luminance (sRGB weighted), normalized to 0..1
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function parseColor(color: string): [number, number, number] | null {
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) {
      hex = hex.split('').map((c) => c + c).join('');
    }
    const num = parseInt(hex, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }

  const rgbMatch = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(',').map((p) => parseFloat(p.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [parts[0], parts[1], parts[2]];
    }
  }

  return null;
}