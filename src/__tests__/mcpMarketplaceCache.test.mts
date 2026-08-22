import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  MCP_MARKETPLACE_CACHE_TTL_MS,
  readMcpMarketplaceCache,
  sanitizeMcpMarketplaceCacheKey,
  writeMcpMarketplaceCache,
} from '../bridge/services/mcpMarketplaceClient.ts';

describe('sanitizeMcpMarketplaceCacheKey', () => {
  it('replaces disallowed characters with underscores and keeps safe characters intact', () => {
    assert.equal(sanitizeMcpMarketplaceCacheKey('all:built-in'), 'all_built-in');
    assert.equal(sanitizeMcpMarketplaceCacheKey('official-registry'), 'official-registry');
    assert.equal(sanitizeMcpMarketplaceCacheKey('a/b c?d*e'), 'a_b_c_d_e');
  });
});

describe('readMcpMarketplaceCache / writeMcpMarketplaceCache', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-marketplace-cache-test-'));
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns undefined for a missing cache key', () => {
    const result = readMcpMarketplaceCache(tmpDir, 'missing-key');
    assert.equal(result, undefined);
  });

  it('writes then reads back the same JSON data', () => {
    const data = { entries: [{ name: 'foo' }] };
    writeMcpMarketplaceCache(tmpDir, 'round-trip', data);
    const result = readMcpMarketplaceCache(tmpDir, 'round-trip');
    assert.deepEqual(result, data);
  });

  it('sanitizes the cache key into the on-disk filename', () => {
    writeMcpMarketplaceCache(tmpDir, 'a/b c?d', { value: 1 });
    const expectedFile = path.join(tmpDir, `${sanitizeMcpMarketplaceCacheKey('a/b c?d')}.json`);
    assert.ok(fs.existsSync(expectedFile));
  });

  it('writes atomically, leaving no leftover .tmp file', () => {
    writeMcpMarketplaceCache(tmpDir, 'atomic-key', { value: 2 });
    const tmpFile = path.join(tmpDir, `${sanitizeMcpMarketplaceCacheKey('atomic-key')}.json.tmp`);
    assert.equal(fs.existsSync(tmpFile), false);
  });

  it('treats a cache entry older than the TTL as a miss', () => {
    writeMcpMarketplaceCache(tmpDir, 'stale-key', { value: 3 });
    const file = path.join(tmpDir, `${sanitizeMcpMarketplaceCacheKey('stale-key')}.json`);
    const oldTime = new Date(Date.now() - MCP_MARKETPLACE_CACHE_TTL_MS - 60_000);
    fs.utimesSync(file, oldTime, oldTime);
    const result = readMcpMarketplaceCache(tmpDir, 'stale-key');
    assert.equal(result, undefined);
  });

  it('returns a stale entry when allowStale is true regardless of age', () => {
    writeMcpMarketplaceCache(tmpDir, 'stale-allowed-key', { value: 4 });
    const file = path.join(tmpDir, `${sanitizeMcpMarketplaceCacheKey('stale-allowed-key')}.json`);
    const oldTime = new Date(Date.now() - MCP_MARKETPLACE_CACHE_TTL_MS - 60_000);
    fs.utimesSync(file, oldTime, oldTime);
    const result = readMcpMarketplaceCache(tmpDir, 'stale-allowed-key', { allowStale: true });
    assert.deepEqual(result, { value: 4 });
  });

  it('honors a custom ttlMs override', () => {
    writeMcpMarketplaceCache(tmpDir, 'custom-ttl-key', { value: 5 });
    const file = path.join(tmpDir, `${sanitizeMcpMarketplaceCacheKey('custom-ttl-key')}.json`);
    const oldTime = new Date(Date.now() - 5_000);
    fs.utimesSync(file, oldTime, oldTime);
    const result = readMcpMarketplaceCache(tmpDir, 'custom-ttl-key', { ttlMs: 1_000 });
    assert.equal(result, undefined);
  });
});
