import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  imageBlockFromLocalPath,
  mediaTypeForImagePath,
  restoreClaudeImageReferenceText,
  restoreClaudeImageReferencesInContent,
} from '../bridge/services/claudeImageRestore.ts';

const fakeLoader = (filePath: string) =>
  filePath.includes('missing') ? null : { type: 'image', source: { type: 'base64', media_type: 'image/png', data: `data-for:${filePath}` } };

describe('restoreClaudeImageReferenceText', () => {
  it('leaves plain text without image markers untouched', () => {
    const result = restoreClaudeImageReferenceText('just a normal message', fakeLoader);
    assert.equal(result.changed, false);
    assert.deepEqual(result.blocks, []);
  });

  it('rewrites a single image marker into an image block plus trailing text', () => {
    const result = restoreClaudeImageReferenceText('[Image #1: /tmp/shot.png]\nplease review this', fakeLoader);
    assert.equal(result.changed, true);
    assert.deepEqual(result.blocks, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'data-for:/tmp/shot.png' } },
      { type: 'text', text: 'please review this' },
    ]);
  });

  it('rewrites multiple image markers, preserving order before the trailing text block', () => {
    const text = '[Image #1: /tmp/a.png]\n[Image #2: /tmp/b.png]\nfix these';
    const result = restoreClaudeImageReferenceText(text, fakeLoader);
    assert.equal(result.changed, true);
    assert.equal(result.blocks.length, 3);
    assert.equal((result.blocks[0] as any).source.data, 'data-for:/tmp/a.png');
    assert.equal((result.blocks[1] as any).source.data, 'data-for:/tmp/b.png');
    assert.deepEqual(result.blocks[2], { type: 'text', text: 'fix these' });
  });

  it('rewrites image XML tags into image blocks', () => {
    const text = '<image name=[Image #1] path="/tmp/shot.png"></image>\nwhat is this?';
    const result = restoreClaudeImageReferenceText(text, fakeLoader);
    assert.equal(result.changed, true);
    assert.deepEqual(result.blocks, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'data-for:/tmp/shot.png' } },
      { type: 'text', text: 'what is this?' },
    ]);
  });

  it('rewrites mixed image markers and XML tags in order', () => {
    const text = '[Image #1: /tmp/a.png]\nfirst\n<image path="/tmp/b.png"></image>\nsecond';
    const result = restoreClaudeImageReferenceText(text, fakeLoader);
    assert.equal(result.changed, true);
    assert.equal(result.blocks.length, 3);
    assert.equal((result.blocks[0] as any).source.data, 'data-for:/tmp/a.png');
    assert.equal((result.blocks[1] as any).source.data, 'data-for:/tmp/b.png');
    assert.deepEqual(result.blocks[2], { type: 'text', text: 'first\n\nsecond' });
  });

  it('falls back to keeping the marker text when the image file cannot be loaded', () => {
    const result = restoreClaudeImageReferenceText('[Image #1: /tmp/missing.png]', fakeLoader);
    assert.equal(result.changed, false);
    assert.deepEqual(result.blocks, []);
  });

  it('strips the CLI-injected attachment hint and collapses extra blank lines', () => {
    const text = '[Image #1: /tmp/a.png]\n\nThe user has attached the image(s) above. Please use the Read tool to view them.\n\n\nlook at this';
    const result = restoreClaudeImageReferenceText(text, fakeLoader);
    assert.equal(result.changed, true);
    const textBlock = result.blocks.find((b) => (b as any).type === 'text');
    assert.equal((textBlock as any).text, 'look at this');
  });

  it('treats empty text as unchanged', () => {
    const result = restoreClaudeImageReferenceText('', fakeLoader);
    assert.equal(result.changed, false);
    assert.deepEqual(result.blocks, []);
  });
});

describe('restoreClaudeImageReferencesInContent', () => {
  it('rewrites string content containing an image marker', () => {
    const result = restoreClaudeImageReferencesInContent('[Image #1: /tmp/a.png]', fakeLoader);
    assert.equal(result.changed, true);
    assert.equal(Array.isArray(result.content), true);
  });

  it('leaves string content without markers unchanged (same reference)', () => {
    const result = restoreClaudeImageReferencesInContent('hello world', fakeLoader);
    assert.equal(result.changed, false);
    assert.equal(result.content, 'hello world');
  });

  it('rewrites only the text blocks inside a block array, leaving other blocks intact', () => {
    const content = [
      { type: 'text', text: '[Image #1: /tmp/a.png]\ncheck this' },
      { type: 'tool_result', tool_use_id: 'abc', content: 'unchanged' },
    ];
    const result = restoreClaudeImageReferencesInContent(content, fakeLoader);
    assert.equal(result.changed, true);
    const blocks = result.content as Array<Record<string, unknown>>;
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].type, 'image');
    assert.deepEqual(blocks[1], { type: 'text', text: 'check this' });
    assert.deepEqual(blocks[2], { type: 'tool_result', tool_use_id: 'abc', content: 'unchanged' });
  });

  it('leaves a block array with no image markers unchanged (same reference)', () => {
    const content = [{ type: 'text', text: 'no images here' }];
    const result = restoreClaudeImageReferencesInContent(content, fakeLoader);
    assert.equal(result.changed, false);
    assert.equal(result.content, content);
  });

  it('passes through non-string/non-array content unchanged', () => {
    const result = restoreClaudeImageReferencesInContent(null, fakeLoader);
    assert.equal(result.changed, false);
    assert.equal(result.content, null);
  });
});

describe('imageBlockFromLocalPath (real filesystem)', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-image-restore-test-'));
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns null when the file does not exist', () => {
    assert.equal(imageBlockFromLocalPath(path.join(tmpDir, 'nope.png')), null);
  });

  it('base64-encodes an existing file and infers its media type', () => {
    const filePath = path.join(tmpDir, 'pic.jpg');
    fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const block = imageBlockFromLocalPath(filePath) as any;
    assert.equal(block.type, 'image');
    assert.equal(block.source.type, 'base64');
    assert.equal(block.source.media_type, 'image/jpeg');
    assert.equal(block.source.data, Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64'));
  });

  it('mediaTypeForImagePath defaults to png for unknown extensions', () => {
    assert.equal(mediaTypeForImagePath('/tmp/file.unknownext'), 'image/png');
    assert.equal(mediaTypeForImagePath('/tmp/file.webp'), 'image/webp');
    assert.equal(mediaTypeForImagePath('/tmp/file.SVG'), 'image/svg+xml');
  });
});
