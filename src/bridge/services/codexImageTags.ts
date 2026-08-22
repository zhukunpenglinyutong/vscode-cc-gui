export const CODEX_IMAGE_TAG_PATTERN = /<image\b[^>]*\bpath\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>\s*(?:<\/image>)?/gi;

export function stripCodexInlineImageTags(text: string): string {
  return String(text || '')
    .replace(CODEX_IMAGE_TAG_PATTERN, '')
    .replace(/<\/image>/gi, '')
    .trim();
}

export function codexImageTagRegex(): RegExp {
  return new RegExp(CODEX_IMAGE_TAG_PATTERN.source, CODEX_IMAGE_TAG_PATTERN.flags);
}

export function imagePathFromCodexImageTagMatch(match: RegExpExecArray): string {
  return (match[1] ?? match[2] ?? match[3] ?? '').trim();
}
