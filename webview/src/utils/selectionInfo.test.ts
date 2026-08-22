import { describe, expect, it } from 'vitest';
import {
  parseSelectionInfo,
  shouldApplyAutoSelectionInfo,
} from './selectionInfo';

describe('shouldApplyAutoSelectionInfo', () => {
  it('rejects auto selection when auto-open-file is closed', () => {
    expect(shouldApplyAutoSelectionInfo(false)).toBe(false);
  });

  it('accepts auto selection when auto-open-file is enabled', () => {
    expect(shouldApplyAutoSelectionInfo(true)).toBe(true);
  });
});

describe('parseSelectionInfo', () => {
  it('returns null for empty input', () => {
    expect(parseSelectionInfo('')).toBeNull();
  });

  it('parses file-only references', () => {
    expect(parseSelectionInfo('@/repo/README.md')).toEqual({
      file: '/repo/README.md',
      startLine: undefined,
      endLine: undefined,
      raw: '@/repo/README.md',
    });
  });

  it('parses single-line references', () => {
    expect(parseSelectionInfo('@/repo/a.ts#L10')).toEqual({
      file: '/repo/a.ts',
      startLine: 10,
      endLine: 10,
      raw: '@/repo/a.ts#L10',
    });
  });

  it('parses multi-line references', () => {
    expect(parseSelectionInfo('@/repo/a.ts#L3-9')).toEqual({
      file: '/repo/a.ts',
      startLine: 3,
      endLine: 9,
      raw: '@/repo/a.ts#L3-9',
    });
  });
});
