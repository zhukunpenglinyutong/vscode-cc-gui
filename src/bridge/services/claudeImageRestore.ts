import * as fs from 'fs';

// Claude Code CLI writes pasted images into user-turn JSONL text as a marker line
// like `[Image #1: /path/to/file.png]` or an inline `<image path="..."></image>`
// tag instead of an inline content block. Restore them to real `image` blocks so
// history replay renders the image, not the marker text.
const IMAGE_REFERENCE_PATTERN = /^\[Image #\d+:\s*(.+?)\]\s*$/gm;
const IMAGE_TAG_PATTERN = /<image\b[^>]*\bpath=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>\s*(?:<\/image>)?/gi;
const IMAGE_ATTACHMENT_HINT = 'The user has attached the image(s) above. Please use the Read tool to view them.';

export type ImageBlockLoader = (filePath: string) => Record<string, unknown> | null;

export function mediaTypeForImagePath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'image/png';
}

export function imageBlockFromLocalPath(filePath: string): Record<string, unknown> | null {
  try {
    const normalizedPath = String(filePath || '').trim();
    if (!normalizedPath || !fs.existsSync(normalizedPath)) return null;
    const data = fs.readFileSync(normalizedPath).toString('base64');
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaTypeForImagePath(normalizedPath),
        data,
      },
    };
  } catch {
    return null;
  }
}

function normalizeRemainingText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split(IMAGE_ATTACHMENT_HINT).join('')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type ImageReferenceMatch = {
  index: number;
  end: number;
  raw: string;
  imagePath: string;
};

function collectImageReferences(text: string): ImageReferenceMatch[] {
  const references: ImageReferenceMatch[] = [];

  const markerRegex = new RegExp(IMAGE_REFERENCE_PATTERN.source, 'gm');
  let markerMatch: RegExpExecArray | null;
  while ((markerMatch = markerRegex.exec(text))) {
    references.push({
      index: markerMatch.index,
      end: markerRegex.lastIndex,
      raw: markerMatch[0],
      imagePath: (markerMatch[1] ?? '').trim(),
    });
  }

  const tagRegex = new RegExp(IMAGE_TAG_PATTERN.source, 'gi');
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(text))) {
    references.push({
      index: tagMatch.index,
      end: tagRegex.lastIndex,
      raw: tagMatch[0],
      imagePath: (tagMatch[1] ?? tagMatch[2] ?? tagMatch[3] ?? '').trim(),
    });
  }

  references.sort((a, b) => a.index - b.index || a.end - b.end);
  return references.filter((reference, index) => index === 0 || reference.index >= references[index - 1].end);
}

/** Rewrites image markers/tags in a single text block into image + text blocks. */
export function restoreClaudeImageReferenceText(
  text: string,
  loadImage: ImageBlockLoader = imageBlockFromLocalPath,
): { changed: boolean; blocks: Array<Record<string, unknown>> } {
  if (!text) return { changed: false, blocks: [] };

  const references = collectImageReferences(text);
  const blocks: Array<Record<string, unknown>> = [];
  let remaining = '';
  let lastIndex = 0;
  let restoredImage = false;

  for (const reference of references) {
    remaining += text.slice(lastIndex, reference.index);
    lastIndex = reference.end;

    const imageBlock = loadImage(reference.imagePath);
    if (imageBlock) {
      blocks.push(imageBlock);
      restoredImage = true;
    } else {
      remaining += reference.raw;
    }
  }

  if (references.length === 0 || !restoredImage) {
    return { changed: false, blocks: [] };
  }

  remaining += text.slice(lastIndex);
  const cleaned = normalizeRemainingText(remaining);
  if (cleaned) {
    blocks.push({ type: 'text', text: cleaned });
  }
  return { changed: true, blocks };
}

/** Applies image-reference restoration across a Claude JSONL `message.content` value (string or block array). */
export function restoreClaudeImageReferencesInContent(
  content: unknown,
  loadImage: ImageBlockLoader = imageBlockFromLocalPath,
): { changed: boolean; content: unknown } {
  if (typeof content === 'string') {
    const rewrite = restoreClaudeImageReferenceText(content, loadImage);
    return rewrite.changed ? { changed: true, content: rewrite.blocks } : { changed: false, content };
  }

  if (Array.isArray(content)) {
    let changed = false;
    const rebuilt: Array<Record<string, unknown>> = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text' && typeof (block as Record<string, unknown>).text === 'string') {
        const rewrite = restoreClaudeImageReferenceText((block as Record<string, unknown>).text as string, loadImage);
        if (rewrite.changed) {
          changed = true;
          rebuilt.push(...rewrite.blocks);
          continue;
        }
      }
      rebuilt.push(block);
    }
    return changed ? { changed: true, content: rebuilt } : { changed: false, content };
  }

  return { changed: false, content };
}
