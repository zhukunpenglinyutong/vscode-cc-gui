import { describe, expect, it } from 'vitest';
import {
  collectDropPathPayload,
  extractPathsFromDataTransfer,
  isAbsoluteFsPath,
  isExternalFileDrag,
  isInsideChatInputDropZone,
  needsHostPathResolve,
  uriToLocalPath,
} from './dropPathUtils.js';

function mockDataTransfer(data: Record<string, string>, files: Array<File & { path?: string }> = []): DataTransfer {
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? '',
    files: {
      length: files.length,
      item: (i: number) => files[i] ?? null,
      ...files,
      [Symbol.iterator]: function* () {
        yield* files;
      },
    } as unknown as FileList,
  } as unknown as DataTransfer;
}

describe('uriToLocalPath', () => {
  it('decodes file:// URIs on unix', () => {
    expect(uriToLocalPath('file:///Users/me/proj/a.ts')).toBe('/Users/me/proj/a.ts');
  });

  it('decodes Windows file:///C:/ paths', () => {
    expect(uriToLocalPath('file:///C:/Users/me/a.ts')).toBe('C:/Users/me/a.ts');
  });

  it('passes through plain paths', () => {
    expect(uriToLocalPath('/tmp/x')).toBe('/tmp/x');
  });
});

describe('isAbsoluteFsPath', () => {
  it('detects mac/unix absolute paths', () => {
    expect(isAbsoluteFsPath('/Users/me/a.ts')).toBe(true);
  });

  it('detects windows drive paths', () => {
    expect(isAbsoluteFsPath('C:\\Users\\me\\a.ts')).toBe(true);
    expect(isAbsoluteFsPath('D:/work/a.ts')).toBe(true);
  });

  it('rejects bare file names', () => {
    expect(isAbsoluteFsPath('python3.txt')).toBe(false);
    expect(isAbsoluteFsPath('src/index.ts')).toBe(false);
  });
});

describe('collectDropPathPayload / extractPathsFromDataTransfer', () => {
  it('reads text/uri-list (VS Code explorer style)', () => {
    const dt = mockDataTransfer({
      'text/uri-list': 'file:///Users/me/app/src/index.ts\nfile:///Users/me/app/README.md',
    });
    const payload = collectDropPathPayload(dt);
    expect(payload.uris).toEqual([
      'file:///Users/me/app/src/index.ts',
      'file:///Users/me/app/README.md',
    ]);
    expect(extractPathsFromDataTransfer(dt)).toEqual([
      '/Users/me/app/src/index.ts',
      '/Users/me/app/README.md',
    ]);
  });

  it('reads application/vnd.code.uri-list', () => {
    const dt = mockDataTransfer({
      'application/vnd.code.uri-list': 'file:///workspace/foo.ts',
    });
    expect(extractPathsFromDataTransfer(dt)).toEqual(['/workspace/foo.ts']);
  });

  it('reads resourceurls JSON', () => {
    const dt = mockDataTransfer({
      resourceurls: JSON.stringify(['file:///a/b.ts', 'file:///c/d.ts']),
    });
    expect(extractPathsFromDataTransfer(dt)).toEqual(['/a/b.ts', '/c/d.ts']);
  });

  it('reads File.path when available', () => {
    const file = new File(['x'], 'note.txt', { type: 'text/plain' }) as File & { path?: string };
    file.path = '/abs/note.txt';
    const dt = mockDataTransfer({}, [file]);
    expect(extractPathsFromDataTransfer(dt)).toEqual(['/abs/note.txt']);
  });

  it('puts bare File.name into names (needs host resolve), not absolutePaths', () => {
    const file = new File(['x'], 'python3.txt', { type: 'text/plain' }) as File & { path?: string };
    const dt = mockDataTransfer({}, [file]);
    const payload = collectDropPathPayload(dt);
    expect(payload.names).toEqual(['python3.txt']);
    expect(payload.absolutePaths).toEqual([]);
    expect(extractPathsFromDataTransfer(dt)).toEqual([]);
    expect(needsHostPathResolve(payload)).toBe(true);
  });

  it('deduplicates absolute paths from multiple sources', () => {
    const file = new File(['x'], 'a.ts') as File & { path?: string };
    file.path = '/Users/me/a.ts';
    const dt = mockDataTransfer(
      {
        'text/uri-list': 'file:///Users/me/a.ts',
        'text/plain': '/Users/me/a.ts',
      },
      [file]
    );
    expect(extractPathsFromDataTransfer(dt)).toEqual(['/Users/me/a.ts']);
  });
});

describe('isExternalFileDrag / isInsideChatInputDropZone', () => {
  it('detects external file drag types', () => {
    const dt = mockDataTransfer({ 'text/uri-list': 'file:///x' });
    expect(isExternalFileDrag(dt)).toBe(true);
  });

  it('detects chat input drop zone via closest()', () => {
    const box = document.createElement('div');
    box.className = 'chat-input-box';
    const child = document.createElement('div');
    box.appendChild(child);
    document.body.appendChild(box);
    expect(isInsideChatInputDropZone(child)).toBe(true);
    expect(isInsideChatInputDropZone(document.body)).toBe(false);
    box.remove();
  });
});
