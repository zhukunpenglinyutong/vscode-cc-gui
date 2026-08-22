import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGrokPromptBlocksJson,
  collectImageAttachments,
  GROK_IMAGE_ONLY_FALLBACK_TEXT,
  attachmentToGrokImageBlock,
} from './grok-image-prompt.js';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('collectImageAttachments', () => {
  it('returns empty for missing/non-image payloads', () => {
    assert.deepEqual(collectImageAttachments(null), []);
    assert.deepEqual(collectImageAttachments([]), []);
    assert.deepEqual(
      collectImageAttachments([{ fileName: 'a.txt', mediaType: 'text/plain', data: 'x' }]),
      [],
    );
  });

  it('keeps image/* attachments and path-based local_image', () => {
    const items = collectImageAttachments([
      { fileName: 'a.png', mediaType: 'image/png', data: TINY_PNG_B64 },
      { type: 'local_image', path: '/tmp/shot.png' },
    ]);
    assert.equal(items.length, 2);
  });
});

describe('buildGrokPromptBlocksJson', () => {
  it('returns null when no images (text-only path stays on -p)', () => {
    assert.equal(buildGrokPromptBlocksJson('hello', []), null);
    assert.equal(buildGrokPromptBlocksJson('hello', undefined), null);
  });

  it('builds ACP text+image blocks for --prompt-file', () => {
    const result = buildGrokPromptBlocksJson('what is this?', [
      { fileName: 'a.png', mediaType: 'image/png', data: TINY_PNG_B64 },
    ]);
    assert.ok(result);
    assert.equal(result.imageCount, 1);
    const blocks = JSON.parse(result.json);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0], { type: 'text', text: 'what is this?' });
    assert.equal(blocks[1].type, 'image');
    assert.equal(blocks[1].mimeType, 'image/png');
    assert.equal(blocks[1].data, TINY_PNG_B64);
  });

  it('injects fallback text when only images are attached', () => {
    const result = buildGrokPromptBlocksJson('   ', [
      { mediaType: 'image/png', data: TINY_PNG_B64 },
    ]);
    const blocks = JSON.parse(result.json);
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[0].text, GROK_IMAGE_ONLY_FALLBACK_TEXT);
    assert.equal(blocks[1].type, 'image');
  });

  it('throws when images are present but none can be loaded', () => {
    assert.throws(
      () => buildGrokPromptBlocksJson('hi', [{ mediaType: 'image/png', path: '/no/data' }]),
      /Grok image input failed/,
    );
  });
});

describe('attachmentToGrokImageBlock', () => {
  it('accepts raw base64 and data URLs', () => {
    const raw = attachmentToGrokImageBlock({ mediaType: 'image/png', data: TINY_PNG_B64 });
    assert.equal(raw?.type, 'image');
    assert.equal(raw?.data, TINY_PNG_B64);

    const fromUrl = attachmentToGrokImageBlock({
      data: `data:image/jpeg;base64,${TINY_PNG_B64}`,
    });
    assert.equal(fromUrl?.mimeType, 'image/jpeg');
    assert.equal(fromUrl?.data, TINY_PNG_B64);
  });
});
