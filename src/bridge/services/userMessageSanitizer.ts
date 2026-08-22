const APPENDED_CONTEXT_MARKERS = [
  '\n\n## Agent Role and Instructions\n\n',
  '\n\n## Workspace Context\n\n',
  '\n\n## Project Modules\n\nThis project contains multiple modules:\n',
  '\n\n## Active Terminal Session\n\nThe user is working in the following terminal context:\n\n',
  '\n\n## Referenced Files\n\nThe following files were referenced by the user:\n\n',
  '\n\n## IDE Context\n\n',
  "\n\n## User's Current IDE Context\n\nThe user is viewing this file in their IDE.",
  "\n\n## User's Current IDE Context\n\nThe user is working in an IDE.",
  '\n\n## Runtime Context\n\n',
  '\n\n### Multi-Project Workspace Structure\n\n',
  '\n\n### Project Module Structure\n\nThis project contains multiple modules:\n',
] as const;

const INLINE_IMAGE_TAG_REGEX = /<image\b[^>]*\bpath\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)[^>]*>\s*(?:<\/image>)?/gi;

function stripAppendedContextMarkers(text: string): string {
  let cutIndex = -1;
  for (const marker of APPENDED_CONTEXT_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx <= 0) continue;
    if (text.slice(0, idx).trim() === '') continue;
    if (cutIndex === -1 || idx < cutIndex) cutIndex = idx;
  }
  return cutIndex < 0 ? text : text.slice(0, cutIndex);
}

export function sanitizeUserFacingText(text: string): string {
  if (!text) return text;
  let normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (/^\s*#\s*AGENTS\.md instructions for\b/i.test(normalized)) return '';

  normalized = normalized.replace(/<agents?-instructions>[\s\S]*?<\/agents?-instructions>\s*/gi, '');
  normalized = normalized.replace(/<environment_context>[\s\S]*?<\/environment_context>\s*/gi, '');
  normalized = normalized.replace(/<ide-context>[\s\S]*?<\/ide-context>\s*/gi, '');
  normalized = normalized.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/gi, '');
  normalized = normalized.replace(/<system-prompt>[\s\S]*?<\/system-prompt>\s*/gi, '');
  normalized = normalized.replace(INLINE_IMAGE_TAG_REGEX, '');
  normalized = normalized.replace(/<\/image>/gi, '');

  normalized = normalized.replace(/<agents?-instructions>[\s\S]*$/i, '');
  normalized = normalized.replace(/<environment_context>[\s\S]*$/i, '');
  normalized = normalized.replace(/<ide-context>[\s\S]*$/i, '');
  normalized = normalized.replace(/<system-reminder>[\s\S]*$/i, '');
  normalized = normalized.replace(/<system-prompt>[\s\S]*$/i, '');

  normalized = stripAppendedContextMarkers(normalized);
  return normalized.trim();
}

export function sanitizeUserFacingContent(content: unknown): unknown {
  if (typeof content === 'string') {
    return sanitizeUserFacingText(content);
  }
  if (!Array.isArray(content)) {
    return content;
  }

  return content
    .map((block) => {
      if (typeof block === 'string') {
        const text = sanitizeUserFacingText(block);
        return text ? text : null;
      }
      if (!block || typeof block !== 'object') return block;

      const candidate = block as Record<string, unknown>;
      if ((candidate.type === 'text' || candidate.type === 'input_text') && typeof candidate.text === 'string') {
        const text = sanitizeUserFacingText(candidate.text);
        return text ? { ...candidate, text } : null;
      }
      return block;
    })
    .filter(Boolean);
}

export function sanitizeUserMessagePayload<T>(payload: T): T {
  if (!payload || typeof payload !== 'object') return payload;

  const candidate = payload as Record<string, any>;
  const message = candidate.message;
  const isUserMessage = candidate.type === 'user' || message?.role === 'user';
  if (!isUserMessage || !message || typeof message !== 'object' || !('content' in message)) {
    return payload;
  }

  return {
    ...candidate,
    message: {
      ...message,
      content: sanitizeUserFacingContent(message.content),
    },
  } as T;
}
