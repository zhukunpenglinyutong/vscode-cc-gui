import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateDshBin, validateDshHost } from '../bridge/services/DshSettingsStore.ts';

describe('validateDshHost', () => {
  it('accepts empty (clears the override)', () => {
    assert.equal(validateDshHost(''), null);
  });

  it('accepts host names and IPs', () => {
    assert.equal(validateDshHost('127.0.0.1'), null);
    assert.equal(validateDshHost('localhost'), null);
    assert.equal(validateDshHost('dsh.internal'), null);
  });

  it('rejects scheme, port, whitespace and path separators', () => {
    assert.match(validateDshHost('http://localhost') ?? '', /Invalid DSH host/);
    assert.match(validateDshHost('localhost:3080') ?? '', /Invalid DSH host/);
    assert.match(validateDshHost('my host') ?? '', /Invalid DSH host/);
    assert.match(validateDshHost('/etc/hosts') ?? '', /Invalid DSH host/);
    assert.match(validateDshHost('..\\dsh') ?? '', /Invalid DSH host/);
  });
});

describe('validateDshBin', () => {
  it('accepts empty (PATH lookup applies)', () => {
    assert.equal(validateDshBin(''), null);
  });

  it('rejects control characters', () => {
    assert.match(validateDshBin('/usr/bin/dsh\nrm -rf /') ?? '', /control characters/);
    assert.match(validateDshBin('/usr/bin/dsh\thack') ?? '', /control characters/);
  });

  it('accepts a path that does not exist (not yet installed)', () => {
    assert.equal(validateDshBin('/opt/dsh/bin/dsh', () => null), null);
  });

  it('rejects an existing path that is not a regular file', () => {
    const asDirectory = () => ({ isFile: () => false });
    assert.match(validateDshBin('/opt/dsh', asDirectory) ?? '', /not a regular file/);
  });

  it('accepts an existing regular file', () => {
    const asFile = () => ({ isFile: () => true });
    assert.equal(validateDshBin('/opt/dsh/bin/dsh', asFile), null);
  });
});
