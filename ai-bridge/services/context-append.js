import fs from 'node:fs';
import path from 'node:path';

const PROMPT_VALUE_MAX_LEN = 256;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 160 * 1024;
const MAX_RUNTIME_CHARS = 24 * 1024;

function sanitizePromptValue(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  str = str.replace(/[\x00-\x1F\x7F`]/g, ' ').replace(/\s+/g, ' ').trim();
  if (str.length > PROMPT_VALUE_MAX_LEN) {
    str = str.slice(0, PROMPT_VALUE_MAX_LEN) + '...';
  }
  return str;
}

function languageFromPath(filePath) {
  return path.extname(String(filePath || '')).replace('.', '');
}

function normalizeFilePath(value) {
  return String(value || '').replace(/#L\d+(-\d+)?$/, '');
}

function normalizeRuntimeContent(content) {
  const text = String(content || '');
  return text.length > MAX_RUNTIME_CHARS ? text.slice(text.length - MAX_RUNTIME_CHARS) : text;
}

function referencedFilesFromOpenedFiles(openedFiles) {
  if (!openedFiles || typeof openedFiles !== 'object' || !Array.isArray(openedFiles.referencedFiles)) {
    return [];
  }
  return openedFiles.referencedFiles
    .filter(file => file && typeof file.path === 'string' && typeof file.content === 'string')
    .map(file => ({
      path: file.path,
      displayPath: file.displayPath || file.path,
      language: file.language || languageFromPath(file.path),
      content: file.content,
      truncated: !!file.truncated,
    }));
}

function runtimeContextsFromOpenedFiles(openedFiles) {
  if (!openedFiles || typeof openedFiles !== 'object' || !Array.isArray(openedFiles.runtimeContexts)) {
    return [];
  }
  return openedFiles.runtimeContexts
    .filter(item => item && typeof item.path === 'string' && typeof item.content === 'string')
    .map(item => ({
      type: item.type || 'runtime',
      name: item.name || item.path,
      path: item.path,
      content: normalizeRuntimeContent(item.content),
      captured: !!item.captured,
    }));
}

function normalizeFileTagPath(tag) {
  if (!tag || typeof tag !== 'object') return '';
  return String(tag.absolutePath || tag.displayPath || '').trim();
}

function readFileTagContents(fileTags, alreadyIncluded = new Set()) {
  if (!Array.isArray(fileTags)) return [];
  const files = [];
  let totalBytes = 0;

  for (const tag of fileTags) {
    const tagPath = normalizeFileTagPath(tag);
    if (!tagPath || tagPath.startsWith('terminal://') || tagPath.startsWith('service://')) {
      continue;
    }
    const cleanPath = tagPath.replace(/#L\d+(-\d+)?$/, '');
    if (alreadyIncluded.has(cleanPath) || alreadyIncluded.has(path.resolve(cleanPath))) {
      continue;
    }
    try {
      const stat = fs.statSync(cleanPath);
      if (!stat.isFile() || stat.size <= 0) continue;
      const remaining = MAX_TOTAL_BYTES - totalBytes;
      if (remaining <= 0) break;
      const bytesToRead = Math.min(MAX_FILE_BYTES, remaining, stat.size);
      const fd = fs.openSync(cleanPath, 'r');
      try {
        const buffer = Buffer.alloc(bytesToRead);
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
        const content = buffer.subarray(0, bytesRead).toString('utf8');
        files.push({
          path: cleanPath,
          displayPath: tag.displayPath || cleanPath,
          language: languageFromPath(cleanPath),
          content,
          truncated: stat.size > bytesRead,
        });
        alreadyIncluded.add(cleanPath);
        totalBytes += bytesRead;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Ignore unreadable tags; the IDE side already treats context as best effort.
    }
  }

  return files;
}

function readActiveFileContent(filePath, alreadyIncluded = new Set()) {
  const cleanPath = normalizeFilePath(filePath);
  if (!cleanPath || alreadyIncluded.has(cleanPath) || alreadyIncluded.has(path.resolve(cleanPath))) {
    return null;
  }
  try {
    const stat = fs.statSync(cleanPath);
    if (!stat.isFile() || stat.size <= 0) return null;
    const bytesToRead = Math.min(MAX_FILE_BYTES, stat.size);
    const fd = fs.openSync(cleanPath, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
      return {
        path: cleanPath,
        displayPath: cleanPath,
        language: languageFromPath(cleanPath),
        content: buffer.subarray(0, bytesRead).toString('utf8'),
        truncated: stat.size > bytesRead,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function buildReferencedFilesSection(files) {
  if (!files.length) return '';
  let prompt = '\n\n## Referenced Files\n\n';
  prompt += 'The following files were referenced by the user:\n\n';

  for (const file of files) {
    const displayPath = sanitizePromptValue(file.displayPath || file.path);
    const language = sanitizePromptValue(file.language || languageFromPath(file.path));
    prompt += `### \`${displayPath}\`\n\n`;
    prompt += '```' + language + '\n';
    prompt += file.content;
    if (!file.content.endsWith('\n')) {
      prompt += '\n';
    }
    prompt += '```\n\n';
    if (file.truncated) {
      prompt += '\n[File content truncated]\n';
    }
  }

  return prompt;
}

function buildRuntimeContextSection(runtimeContexts) {
  if (!runtimeContexts.length) return '';
  let prompt = '\n\n## Runtime Context\n\n';
  prompt += 'The user explicitly referenced these runtime resources from the IDE.\n\n';

  for (const item of runtimeContexts) {
    prompt += `### ${sanitizePromptValue(item.name)} (${sanitizePromptValue(item.type)})\n\n`;
    prompt += `Path: \`${sanitizePromptValue(item.path)}\`\n\n`;
    prompt += '```text\n';
    prompt += normalizeRuntimeContent(item.content);
    prompt += '\n```\n\n';
  }

  return prompt;
}

function buildSelectionSection(openedFiles) {
  const selection = openedFiles?.selection;
  if (!selection?.selectedText || !openedFiles?.active) return '';

  let prompt = '\n\n## IDE Context\n\n';
  prompt += `Active file: \`${sanitizePromptValue(openedFiles.active)}\`\n\n`;
  prompt += 'Selected code:\n';
  prompt += '```\n';
  prompt += selection.selectedText;
  prompt += '\n```\n';
  prompt += "The selected code above is the primary subject of the user's question.\n";
  return prompt;
}

function buildActiveFileSection(openedFiles, alreadyIncluded = new Set()) {
  if (!openedFiles || typeof openedFiles !== 'object' || openedFiles?.selection?.selectedText) return '';
  const activeFile = openedFiles.active;
  if (!activeFile || typeof activeFile !== 'string') return '';

  const file = readActiveFileContent(activeFile, alreadyIncluded);
  if (!file) return '';

  let prompt = "\n\n## User's Current IDE Context\n\n";
  prompt += "The user is viewing this file in their IDE. This is the PRIMARY SUBJECT of the user's question.\n\n";
  prompt += `### \`${sanitizePromptValue(file.displayPath || file.path)}\`\n\n`;
  prompt += '```' + sanitizePromptValue(file.language || languageFromPath(file.path)) + '\n';
  prompt += file.content;
  if (!file.content.endsWith('\n')) {
    prompt += '\n';
  }
  prompt += '```\n\n';
  if (file.truncated) {
    prompt += '[File content truncated]\n\n';
  }
  return prompt;
}

function buildWorkspaceSection(openedFiles) {
  if (!openedFiles || typeof openedFiles !== 'object') return '';
  if (openedFiles.isWorkspace !== true) return '';
  const workspaceRoot = openedFiles.workspaceRoot;
  const subprojects = Array.isArray(openedFiles.subprojects) ? openedFiles.subprojects : [];
  if (!workspaceRoot && subprojects.length === 0) return '';

  let prompt = '\n\n## Workspace Context\n\n';
  prompt += 'You are working in a multi-project workspace environment.\n\n';
  if (workspaceRoot) {
    prompt += `Workspace root: \`${sanitizePromptValue(workspaceRoot)}\`\n\n`;
  }
  if (subprojects.length > 0) {
    prompt += 'Subprojects in this workspace:\n';
    for (const item of subprojects) {
      const name = sanitizePromptValue(item.name || 'unknown');
      const type = sanitizePromptValue(item.type || '');
      const loaded = item.loaded !== false;
      prompt += `- **${name}**`;
      if (type) {
        prompt += ` (${type})`;
      }
      if (!loaded) {
        prompt += ' [not loaded]';
      }
      prompt += `: \`${sanitizePromptValue(item.path || '')}\`\n`;
    }
    prompt += '\n';
  }
  if (openedFiles.activeSubproject) {
    prompt += `The current file belongs to subproject: **${sanitizePromptValue(openedFiles.activeSubproject)}**\n\n`;
  }
  prompt += 'When working with files, consider which subproject they belong to. ';
  prompt += 'Each subproject may have its own build configuration, dependencies, and codebase structure.\n';
  return prompt;
}

export function buildContextAppend(openedFiles = null, fileTags = null) {
  const includedPaths = new Set();
  const referencedFiles = referencedFilesFromOpenedFiles(openedFiles);
  for (const file of referencedFiles) {
    includedPaths.add(file.path);
  }
  referencedFiles.push(...readFileTagContents(fileTags, includedPaths));

  const runtimeContexts = runtimeContextsFromOpenedFiles(openedFiles);
  const sections = [
    buildWorkspaceSection(openedFiles),
    buildReferencedFilesSection(referencedFiles),
    buildSelectionSection(openedFiles),
    buildActiveFileSection(openedFiles, includedPaths),
    buildRuntimeContextSection(runtimeContexts),
  ].filter(section => section && section.trim() !== '');

  if (sections.length === 0) {
    return '';
  }

  return sections.join('');
}

export {
  sanitizePromptValue,
  referencedFilesFromOpenedFiles,
  runtimeContextsFromOpenedFiles,
};
