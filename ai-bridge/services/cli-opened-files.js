/**
 * CLI providers (Grok / OpenCode / Kimi / Pi) cannot use Claude-style systemPrompt.append.
 * When the IDE sends openedFiles (auto "发送打开的文件路径"), inject a short path hint
 * into the user message so the model can answer "这个文件的路径是什么？".
 */

function sanitizePath(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\x00-\x1F\x7F]/g, ' ').trim();
}

/**
 * Build a compact IDE active-file hint (path only; no file body).
 * @param {object|null|undefined} openedFiles
 * @returns {string}
 */
export function buildCliActiveFileHint(openedFiles) {
  if (!openedFiles || typeof openedFiles !== 'object') return '';
  const active = sanitizePath(openedFiles.active);
  if (!active) return '';

  let hint = '\n\n[IDE Context]\n';
  hint += `Active file path: ${active}\n`;
  const selection = openedFiles.selection;
  if (
    selection
    && typeof selection === 'object'
    && selection.startLine != null
    && selection.endLine != null
  ) {
    hint += `Selected lines: ${selection.startLine}-${selection.endLine}\n`;
  }
  hint += 'When the user refers to "this file" / "这个文件", they mean the active file path above.\n';
  return hint;
}

/**
 * Append IDE active-file path context to a CLI user message.
 * @param {string} message
 * @param {object|null|undefined} openedFiles
 * @returns {string}
 */
export function applyOpenedFilesToCliMessage(message, openedFiles) {
  const base = typeof message === 'string' ? message : '';
  const hint = buildCliActiveFileHint(openedFiles);
  if (!hint) return base;
  return `${base}${hint}`;
}
