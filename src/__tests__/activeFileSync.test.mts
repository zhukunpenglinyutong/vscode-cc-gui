import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatActiveFileSelectionInfo,
  shouldSyncActiveFileToWebview,
} from '../bridge/activeFileSync.ts';

describe('shouldSyncActiveFileToWebview', () => {
  it('returns false when auto-open-file is disabled (closed)', () => {
    assert.equal(shouldSyncActiveFileToWebview(false), false);
  });

  it('returns true when auto-open-file is enabled', () => {
    assert.equal(shouldSyncActiveFileToWebview(true), true);
  });
});

describe('formatActiveFileSelectionInfo', () => {
  it('formats whole-file reference when selection is empty', () => {
    assert.equal(
      formatActiveFileSelectionInfo('/repo/README.md', 1, 1, true),
      '@/repo/README.md',
    );
  });

  it('formats single-line reference', () => {
    assert.equal(
      formatActiveFileSelectionInfo('/repo/src/a.ts', 12, 12, false),
      '@/repo/src/a.ts#L12',
    );
  });

  it('formats multi-line reference', () => {
    assert.equal(
      formatActiveFileSelectionInfo('/repo/src/a.ts', 3, 9, false),
      '@/repo/src/a.ts#L3-9',
    );
  });
});
