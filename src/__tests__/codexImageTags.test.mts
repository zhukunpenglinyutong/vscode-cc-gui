import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  codexImageTagRegex,
  imagePathFromCodexImageTagMatch,
  stripCodexInlineImageTags,
} from '../bridge/services/codexImageTags.ts';

describe('codex image tag helpers', () => {
  it('strips unclosed inline image XML from display text', () => {
    const text = '<image name=[Image #1] path="/tmp/shot.png">图片的问题处理好了么?';

    assert.equal(stripCodexInlineImageTags(text), '图片的问题处理好了么?');
  });

  it('strips orphan closing image tags from display text', () => {
    const text = '</image>\n</image>\n图片里面有啥';

    assert.equal(stripCodexInlineImageTags(text), '图片里面有啥');
  });

  it('extracts image paths from closed, unclosed, and single-quoted image XML', () => {
    const text = [
      '<image path="/tmp/a.png"></image>',
      '<image name=[Image #2] path="/tmp/b.png">',
      "<image path='/tmp/c.png'>",
      '<image name=[Image #4]\n  path = "/tmp/d.png">\n</image>',
    ].join('\n');
    const regex = codexImageTagRegex();
    const paths: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      paths.push(imagePathFromCodexImageTagMatch(match));
    }

    assert.deepEqual(paths, ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png', '/tmp/d.png']);
  });
});
