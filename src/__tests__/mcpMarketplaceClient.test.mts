import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { McpMarketplaceService } from '../bridge/services/mcpMarketplaceClient.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-marketplace-client-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('McpMarketplaceService.getSources', () => {
  it('returns the 4 hardcoded sources', () => {
    const service = new McpMarketplaceService({ cacheDir: tmpDir, fetchJson: async () => ({}) });
    const sources = service.getSources();
    assert.equal(sources.length, 4);
    assert.deepEqual(sources.map((s) => s.id), ['built-in', 'official-registry', 'github-mcp-registry', 'official-github-org']);
  });
});

describe('McpMarketplaceService.search', () => {
  it('includes built-in entries without any network calls', async () => {
    const service = new McpMarketplaceService({ cacheDir: tmpDir, fetchJson: async () => { throw new Error('should not be called'); } });
    const { entries, error } = await service.search('fetch', 'built-in', false);
    assert.equal(error, undefined);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'fetch');
  });

  it('paginates a registry source using metadata.next_cursor until cursor is absent', async () => {
    let calls = 0;
    const fetchJson = async (url: string) => {
      calls += 1;
      if (!url.includes('cursor=')) {
        return { servers: [{ name: 'server-page-1' }], metadata: { next_cursor: 'page2' } };
      }
      assert.ok(url.includes('cursor=page2'));
      return { servers: [{ name: 'server-page-2' }], metadata: {} };
    };
    const service = new McpMarketplaceService({ cacheDir: tmpDir, fetchJson });
    const { entries } = await service.search('', 'official-registry', false);
    assert.equal(calls, 2);
    assert.deepEqual(entries.map((e) => e.name).sort(), ['server-page-1', 'server-page-2']);
  });

  it('paginates a GitHub org source and stops once a page returns fewer than 100 repos', async () => {
    let calls = 0;
    const fetchJson = async () => {
      calls += 1;
      return calls === 1
        ? Array.from({ length: 100 }, (_, i) => ({ full_name: `org/repo-${i}`, name: `repo-${i}` }))
        : [{ full_name: 'org/repo-last', name: 'repo-last' }];
    };
    const service = new McpMarketplaceService({ cacheDir: tmpDir, fetchJson });
    const { entries } = await service.search('', 'official-github-org', false);
    assert.equal(calls, 2);
    assert.equal(entries.length, 101);
  });

  it('stops GitHub org pagination immediately when the first page is empty', async () => {
    let calls = 0;
    const fetchJson = async () => { calls += 1; return []; };
    const service = new McpMarketplaceService({ cacheDir: tmpDir, fetchJson });
    const { entries } = await service.search('', 'official-github-org', false);
    assert.equal(calls, 1);
    assert.equal(entries.length, 0);
  });

  it('aggregates from all sources concurrently when sourceId is "all" or omitted', async () => {
    const fetchJson = async (url: string) => {
      if (url.includes('github.com/orgs')) return [];
      return { servers: [{ name: 'registry-server' }], metadata: {} };
    };
    const service = new McpMarketplaceService({ cacheDir: tmpDir, fetchJson });
    const { entries, error } = await service.search('', 'all', false);
    assert.equal(error, undefined);
    // 5 built-in + 1 from each of the 2 registry sources (deduped by sourceId:name, so both registries keep their own copy)
    const names = entries.map((e) => e.name);
    assert.ok(names.includes('fetch'));
    assert.ok(names.filter((n) => n === 'registry-server').length === 2);
  });

  it('ignores a single failing source when others succeed, and reports no error', async () => {
    const fetchJson = async (url: string) => {
      if (url.includes('registry.modelcontextprotocol.io')) {
        throw new Error('registry down');
      }
      if (url.includes('github.com/orgs')) return [];
      return { servers: [], metadata: {} };
    };
    const service = new McpMarketplaceService({ cacheDir: tmpDir, fetchJson });
    const { entries, error } = await service.search('', 'all', false);
    assert.equal(error, undefined);
    assert.ok(entries.some((e) => e.name === 'fetch'));
  });

  it('reports an error only when every requested source fails', async () => {
    const fetchJson = async () => { throw new Error('boom'); };
    const service = new McpMarketplaceService({ cacheDir: tmpDir, fetchJson });
    const { entries, error } = await service.search('', 'official-registry', false);
    assert.equal(entries.length, 0);
    assert.ok(error && error.includes('boom'));
  });

  it('serves a stale cache entry after a fetch failure when not forceRefresh', async () => {
    let callCount = 0;
    const fetchJson = async () => {
      callCount += 1;
      if (callCount === 1) {
        return { servers: [{ name: 'cached-server' }], metadata: {} };
      }
      throw new Error('network down on second call');
    };
    const service = new McpMarketplaceService({ cacheDir: tmpDir, fetchJson, cacheTtlMs: 0 });
    const first = await service.search('', 'official-registry', false);
    assert.equal(first.entries[0]?.name, 'cached-server');

    // cacheTtlMs=0 makes the cache immediately "stale" for a normal read, forcing a second
    // fetch attempt; that fetch fails, so the (still on-disk) stale entry should be served.
    const second = await service.search('', 'official-registry', false);
    assert.equal(second.error, undefined);
    assert.equal(second.entries[0]?.name, 'cached-server');
  });

  it('does NOT fall back to stale cache on failure when forceRefresh is true', async () => {
    let callCount = 0;
    const fetchJson = async () => {
      callCount += 1;
      if (callCount === 1) {
        return { servers: [{ name: 'cached-server' }], metadata: {} };
      }
      throw new Error('network down on refresh');
    };
    const service = new McpMarketplaceService({ cacheDir: tmpDir, fetchJson });
    await service.search('', 'official-registry', false);
    const refreshed = await service.search('', 'official-registry', true);
    assert.ok(refreshed.error && refreshed.error.includes('network down on refresh'));
    assert.equal(refreshed.entries.length, 0);
  });

  it('filters by query across the aggregated entries', async () => {
    const fetchJson = async (url: string) => {
      if (url.includes('github.com/orgs')) return [];
      return { servers: [], metadata: {} };
    };
    const service = new McpMarketplaceService({ cacheDir: tmpDir, fetchJson });
    const { entries } = await service.search('memory graph', 'built-in', false);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'memory');
  });
});
