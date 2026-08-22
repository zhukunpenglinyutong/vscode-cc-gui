/**
 * Build Grok CLI multimodal prompt payloads (ACP content blocks).
 *
 * When images are attached we MUST NOT put base64 on argv (ARG_MAX). Desktop
 * mossx uses `grok --prompt-file <staging.json>` with blocks like:
 *   { "type": "text", "text": "..." }
 *   { "type": "image", "mimeType": "image/png", "data": "<base64>" }
 *
 * vscode-cc-gui previously dropped attachments for Grok and only sent `-p text`,
 * so the UI showed the image bubble but the model never received it.
 */

import { mkdir, writeFile, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/** Soft per-image cap (decoded bytes). Staging rides --prompt-file, not argv. */
export const GROK_MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const GROK_IMAGE_ONLY_FALLBACK_TEXT = 'Please analyze the attached image(s).';

/**
 * @typedef {{ fileName?: string, mediaType?: string, data?: string, path?: string, type?: string }} GrokAttachment
 */

/**
 * @param {unknown} attachments
 * @returns {GrokAttachment[]}
 */
export function collectImageAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const out = [];
  for (const item of attachments) {
    if (!item || typeof item !== 'object') continue;
    const a = /** @type {GrokAttachment} */ (item);
    const mediaType = typeof a.mediaType === 'string' ? a.mediaType : '';
    if (mediaType.startsWith('image/')) {
      out.push(a);
      continue;
    }
    // Explicit local_image / image path without mediaType (Codex-style).
    if (a.type === 'local_image' && typeof a.path === 'string' && a.path) {
      out.push(a);
      continue;
    }
    if (a.type === 'image' && (typeof a.data === 'string' || typeof a.path === 'string')) {
      out.push(a);
    }
  }
  return out;
}

/**
 * Build ACP content-block JSON string for Grok --prompt-file / --prompt-json.
 * Returns null when there are no images (caller should keep the lighter `-p` path).
 *
 * @param {string} text
 * @param {unknown} attachments
 * @returns {{ json: string, imageCount: number } | null}
 */
export function buildGrokPromptBlocksJson(text, attachments) {
  const images = collectImageAttachments(attachments);
  if (images.length === 0) return null;

  /** @type {Array<Record<string, unknown>>} */
  const blocks = [];
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed) {
    blocks.push({ type: 'text', text: trimmed });
  }

  let loaded = 0;
  const errors = [];
  for (const image of images) {
    try {
      const block = attachmentToGrokImageBlock(image);
      if (block) {
        blocks.push(block);
        loaded += 1;
      } else {
        errors.push(image.fileName || image.path || '(unnamed)');
      }
    } catch (error) {
      errors.push(`${image.fileName || image.path || '(unnamed)'}: ${error?.message || error}`);
    }
  }

  if (loaded === 0) {
    throw new Error(
      `Grok image input failed: none of the attached images could be loaded (${errors.join('; ') || 'unknown'})`,
    );
  }

  // Grok requires at least one text content block when using multimodal prompt-file.
  if (!blocks.some((b) => b.type === 'text')) {
    blocks.unshift({ type: 'text', text: GROK_IMAGE_ONLY_FALLBACK_TEXT });
  }

  return {
    json: JSON.stringify(blocks),
    imageCount: loaded,
  };
}

/**
 * Write ACP blocks to a staging file under os.tmpdir()/cc-gui-grok-prompts/.
 * Caller must clean up with cleanupGrokPromptFile.
 *
 * @param {string} promptJson
 * @param {string} [cwd] unused reserved for future workspace staging
 * @returns {Promise<string>} absolute path
 */
export async function writeGrokPromptFile(promptJson, cwd = '') {
  const base = cwd && cwd !== 'undefined' && cwd !== 'null'
    ? path.join(cwd, '.cc-gui', 'image-staging')
    : path.join(os.tmpdir(), 'cc-gui-grok-prompts');
  await mkdir(base, { recursive: true });
  const filePath = path.join(base, `grok-prompt-${crypto.randomUUID()}.json`);
  await writeFile(filePath, promptJson, 'utf8');
  return filePath;
}

/**
 * @param {string | null | undefined} filePath
 */
export async function cleanupGrokPromptFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return;
  try {
    await unlink(filePath);
  } catch {
    // best-effort
  }
}

/**
 * @param {GrokAttachment} attachment
 * @returns {Record<string, unknown> | null}
 */
export function attachmentToGrokImageBlock(attachment) {
  const mediaType =
    (typeof attachment.mediaType === 'string' && attachment.mediaType.startsWith('image/')
      ? attachment.mediaType
      : null) || 'image/png';

  if (typeof attachment.data === 'string' && attachment.data.length > 0) {
    let raw = attachment.data.trim();
    // Accept full data URLs from some callers.
    const dataUrl = /^data:([^;,]+);base64,(.+)$/i.exec(raw);
    if (dataUrl) {
      raw = dataUrl[2];
      const mt = dataUrl[1];
      return assertSizeAndBuild(raw, mt.startsWith('image/') ? mt : mediaType);
    }
    return assertSizeAndBuild(raw, mediaType);
  }

  // Path-based attachments are handled by the caller materialising to base64 first
  // (message-service can use saveImageToTemp reverse — read file). Keep null here
  // so we don't silently skip without an error when only path is present without data.
  if (typeof attachment.path === 'string' && attachment.path) {
    return null;
  }
  return null;
}

/**
 * @param {string} base64Data
 * @param {string} mediaType
 */
function assertSizeAndBuild(base64Data, mediaType) {
  // Rough decoded size ≈ base64_len * 3/4
  const approxBytes = Math.floor((base64Data.length * 3) / 4);
  if (approxBytes > GROK_MAX_IMAGE_BYTES) {
    throw new Error(`image exceeds ${GROK_MAX_IMAGE_BYTES} byte limit (~${approxBytes} bytes)`);
  }
  return {
    type: 'image',
    mimeType: mediaType || 'image/png',
    data: base64Data,
  };
}
