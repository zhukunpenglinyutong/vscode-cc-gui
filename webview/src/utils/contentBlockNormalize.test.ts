import { describe, it, expect } from 'vitest';
import { stripInjectedContextTags } from './contentBlockNormalize';

describe('stripInjectedContextTags', () => {
  it('keeps plain user text untouched', () => {
    expect(stripInjectedContextTags('你好')).toBe('你好');
  });

  it('cuts the appended "## Agent Role and Instructions" block (the reported bug)', () => {
    const raw =
      '你好\n\n## Agent Role and Instructions\n\n' +
      'You are acting as a specialized agent with the following role:\n\n' +
      '我叫 黄\n我老婆家 陈\n我孩子叫 小不点';
    expect(stripInjectedContextTags(raw)).toBe('你好');
  });

  it('cuts other appended markdown context markers', () => {
    expect(stripInjectedContextTags('hi\n\n## Workspace Context\n\nroot: /a')).toBe('hi');
    expect(
      stripInjectedContextTags(
        'hi\n\n## Referenced Files\n\nThe following files were referenced by the user:\n\n- a.ts',
      ),
    ).toBe('hi');
    expect(stripInjectedContextTags("hi\n\n## User's Current IDE Context\n\nThe user is working in an IDE.")).toBe('hi');
  });

  it('still strips XML wrapper blocks', () => {
    expect(stripInjectedContextTags('hi <ide-context>path</ide-context>')).toBe('hi');
    expect(stripInjectedContextTags('hi <agents-instructions>x</agents-instructions>')).toBe('hi');
    expect(stripInjectedContextTags('hi <system-reminder>note</system-reminder>')).toBe('hi');
  });

  it('strips inline image XML markers even when the closing tag is missing', () => {
    expect(stripInjectedContextTags('<image name=[Image #1] path="/tmp/shot.png">看这个')).toBe('看这个');
    expect(stripInjectedContextTags("before <image path='/tmp/shot.png'></image> after")).toBe('before  after');
    expect(stripInjectedContextTags('<image name=[Image #1]\n  path = "/tmp/shot.png">\n</image>\n看这个')).toBe('看这个');
    expect(stripInjectedContextTags('</image>\n</image>\n看这个')).toBe('看这个');
  });

  it('normalizes CRLF before matching markers', () => {
    expect(stripInjectedContextTags('你好\r\n\r\n## Agent Role and Instructions\r\n\r\nx')).toBe('你好');
  });

  it('does not empty a message whose only content is a marker-like heading with no preceding text', () => {
    // idx === 0 → nothing before the marker, so no cut (guarded by idx > 0).
    const raw = '## Agent Role and Instructions\n\nfoo';
    expect(stripInjectedContextTags(raw)).toBe(raw.trim());
  });

  it('drops a whole-message AGENTS.md injection (Codex auto-context turn)', () => {
    const raw =
      '# AGENTS.md instructions for /Users/me/proj\n\n<INSTRUCTIONS>\n# rules\n</INSTRUCTIONS>';
    expect(stripInjectedContextTags(raw)).toBe('');
  });

  it('cuts the Codex-stored "你好." + Agent Role augmentation', () => {
    const raw = '你好.\n\n## Agent Role and Instructions\n\n我叫, 黄\n我老婆家 陈\n我孩子叫 小不点';
    expect(stripInjectedContextTags(raw)).toBe('你好.');
  });
});
