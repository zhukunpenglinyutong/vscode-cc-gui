import * as vscode from 'vscode';

export function postJson(webview: vscode.Webview, type: string, payload: unknown): void {
  webview.postMessage({ type, content: JSON.stringify(payload) });
}

export function postRaw(webview: vscode.Webview, type: string, content: string): void {
  webview.postMessage({ type, content });
}

export function callWindowFunction(webview: vscode.Webview, functionName: string, payload?: unknown): void {
  const arg = payload === undefined ? '' : JSON.stringify(JSON.stringify(payload));
  webview.postMessage({
    type: 'js_eval',
    content: payload === undefined
      ? `window.${functionName} && window.${functionName}()`
      : `window.${functionName} && window.${functionName}(${arg})`,
  });
}

export function parseJson<T>(content: string, fallback: T): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}
