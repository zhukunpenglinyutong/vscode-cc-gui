import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  builtInMarketplaceEntries,
  capMarketplaceEntries,
  dedupeMarketplaceEntries,
  filterMarketplaceEntries,
  mapGitHubRepoToEntry,
  mapRegistryEnvelopeToEntry,
  MCP_MARKETPLACE_SOURCES,
  sortMarketplaceEntries,
} from '../bridge/services/mcpMarketplaceClient.ts';

const builtInSource = MCP_MARKETPLACE_SOURCES.find((s) => s.id === 'built-in')!;
const officialRegistrySource = MCP_MARKETPLACE_SOURCES.find((s) => s.id === 'official-registry')!;
const githubRegistrySource = MCP_MARKETPLACE_SOURCES.find((s) => s.id === 'github-mcp-registry')!;
const githubOrgSource = MCP_MARKETPLACE_SOURCES.find((s) => s.id === 'official-github-org')!;

describe('builtInMarketplaceEntries', () => {
  it('returns the 5 curated npm presets with a single stdio install option each', () => {
    const entries = builtInMarketplaceEntries(builtInSource);
    assert.equal(entries.length, 5);
    const names = entries.map((e) => e.name);
    assert.deepEqual(names, ['fetch', 'time', 'memory', 'sequential-thinking', 'context7']);

    const fetchEntry = entries.find((e) => e.name === 'fetch')!;
    assert.equal(fetchEntry.id, 'built-in:fetch');
    assert.equal(fetchEntry.sourceId, 'built-in');
    assert.equal(fetchEntry.sourceName, 'Built-in Presets');
    assert.equal(fetchEntry.sourceType, 'BUILT_IN');
    assert.equal(fetchEntry.official, true);
    assert.deepEqual(fetchEntry.tags, []);
    assert.deepEqual(fetchEntry.installOptions, [
      { label: 'npx', type: 'stdio', command: 'npx', args: ['-y', 'mcp-server-fetch'], riskLevel: 'local-command' },
    ]);
  });

  it('uses the scoped package name for context7', () => {
    const entries = builtInMarketplaceEntries(builtInSource);
    const context7 = entries.find((e) => e.name === 'context7')!;
    assert.deepEqual(context7.installOptions[0].args, ['-y', '@upstash/context7-mcp']);
  });
});

describe('mapRegistryEnvelopeToEntry', () => {
  it('normalizes a wrapped `{ server, _meta }` envelope from the trusted official registry', () => {
    const envelope = {
      server: {
        name: 'io.github.acme/weather',
        description: 'Weather lookups',
        version: '1.2.3',
        repository: { url: 'https://github.com/acme/weather' },
        packages: [
          {
            registryType: 'npm',
            name: '@acme/weather-mcp',
            environmentVariables: [{ name: 'API_KEY' }],
          },
        ],
      },
      _meta: {
        'io.modelcontextprotocol.registry/official': { id: 'abc', isLatest: true },
      },
    };

    const entry = mapRegistryEnvelopeToEntry(envelope, officialRegistrySource);
    assert.equal(entry.id, 'official-registry:io.github.acme/weather');
    assert.equal(entry.name, 'io.github.acme/weather');
    assert.equal(entry.displayName, 'weather');
    assert.equal(entry.description, 'Weather lookups');
    assert.equal(entry.official, true);
    assert.ok(entry.tags.includes('official'));
    assert.equal(entry.repositoryUrl, 'https://github.com/acme/weather');
    assert.equal(entry.installOptions.length, 1);

    const option = entry.installOptions[0];
    assert.equal(option.command, 'npx');
    assert.equal(option.type, 'stdio');
    assert.equal(option.riskLevel, 'verified');
    assert.deepEqual(option.args, ['@acme/weather-mcp']);
    assert.deepEqual(option.env, { API_KEY: '{api_key}' });
  });

  it('normalizes a flat (unwrapped) envelope the same way as a wrapped one', () => {
    const flat = {
      name: 'flat-server',
      description: 'no envelope wrapper',
      packages: [{ registryType: 'pypi', name: 'flat-pkg' }],
    };
    const entry = mapRegistryEnvelopeToEntry(flat, officialRegistrySource);
    assert.equal(entry.name, 'flat-server');
    assert.equal(entry.installOptions[0].command, 'uvx');
  });

  it('does not mark an entry official when _meta only has an empty official object', () => {
    const envelope = {
      name: 'sneaky',
      _meta: { 'io.modelcontextprotocol.registry/official': {} },
    };
    const entry = mapRegistryEnvelopeToEntry(envelope, officialRegistrySource);
    assert.equal(entry.official, false);
  });

  it('never trusts the official _meta flag from a non-canonical registry source (github-mcp-registry)', () => {
    const envelope = {
      name: 'claims-official',
      _meta: {
        'io.modelcontextprotocol.registry/official': { id: 'x', publishedAt: '2024-01-01', isLatest: true },
      },
    };
    const entry = mapRegistryEnvelopeToEntry(envelope, githubRegistrySource);
    assert.equal(entry.official, false);
  });

  it('falls back to the registryType when runtimeHint is absent (npm -> npx, pypi -> uvx, docker -> docker)', () => {
    const npmEntry = mapRegistryEnvelopeToEntry({ name: 'npm-srv', packages: [{ registryType: 'npm', name: 'pkg-a' }] }, officialRegistrySource);
    const pypiEntry = mapRegistryEnvelopeToEntry({ name: 'pypi-srv', packages: [{ registryType: 'pypi', name: 'pkg-b' }] }, officialRegistrySource);
    const dockerEntry = mapRegistryEnvelopeToEntry({ name: 'docker-srv', packages: [{ registryType: 'docker', name: 'pkg-c' }] }, officialRegistrySource);
    assert.equal(npmEntry.installOptions[0].command, 'npx');
    assert.equal(pypiEntry.installOptions[0].command, 'uvx');
    assert.equal(dockerEntry.installOptions[0].command, 'docker');
    for (const entry of [npmEntry, pypiEntry, dockerEntry]) {
      assert.equal(entry.installOptions[0].riskLevel, 'verified');
    }
  });

  it('flags an unknown runtimeHint as unverified-command but still uses it as the command', () => {
    const entry = mapRegistryEnvelopeToEntry(
      { name: 'weird-srv', packages: [{ registryType: 'npm', name: 'pkg-d', runtimeHint: 'some-custom-runner' }] },
      officialRegistrySource,
    );
    assert.equal(entry.installOptions[0].command, 'some-custom-runner');
    assert.equal(entry.installOptions[0].riskLevel, 'unverified-command');
  });

  it('downgrades a known runner to unverified-command when dangerous runtimeArguments are present', () => {
    const entry = mapRegistryEnvelopeToEntry(
      {
        name: 'danger-srv',
        packages: [{
          registryType: 'docker',
          name: 'pkg-e',
          runtimeArguments: [{ type: 'positional', value: '--privileged' }],
        }],
      },
      officialRegistrySource,
    );
    assert.equal(entry.installOptions[0].command, 'docker');
    assert.equal(entry.installOptions[0].riskLevel, 'unverified-command');
  });

  it('infers http/sse transport type from the package transport.type', () => {
    const httpEntry = mapRegistryEnvelopeToEntry({ name: 'http-srv', packages: [{ registryType: 'npm', name: 'pkg-f', transport: { type: 'streamable-http' } }] }, officialRegistrySource);
    const sseEntry = mapRegistryEnvelopeToEntry({ name: 'sse-srv', packages: [{ registryType: 'npm', name: 'pkg-g', transport: { type: 'sse' } }] }, officialRegistrySource);
    const stdioEntry = mapRegistryEnvelopeToEntry({ name: 'stdio-srv', packages: [{ registryType: 'npm', name: 'pkg-h' }] }, officialRegistrySource);
    assert.equal(httpEntry.installOptions[0].type, 'http');
    assert.equal(sseEntry.installOptions[0].type, 'sse');
    assert.equal(stdioEntry.installOptions[0].type, 'stdio');
  });

  it('produces no install options when the server has no packages', () => {
    const entry = mapRegistryEnvelopeToEntry({ name: 'no-pkg-srv' }, officialRegistrySource);
    assert.deepEqual(entry.installOptions, []);
  });
});

describe('mapGitHubRepoToEntry', () => {
  it('maps a public repo into a browse-only entry with no install options', () => {
    const repo = {
      full_name: 'modelcontextprotocol/servers',
      name: 'servers',
      description: 'Reference MCP servers',
      html_url: 'https://github.com/modelcontextprotocol/servers',
      homepage: 'https://modelcontextprotocol.io',
      topics: ['mcp', 'servers'],
      fork: false,
    };
    const entry = mapGitHubRepoToEntry(repo, githubOrgSource)!;
    assert.equal(entry.id, 'modelcontextprotocol/servers');
    assert.equal(entry.name, 'servers');
    assert.equal(entry.displayName, 'servers');
    assert.equal(entry.description, 'Reference MCP servers');
    assert.equal(entry.sourceId, 'official-github-org');
    assert.equal(entry.sourceType, 'GITHUB_ORG');
    assert.equal(entry.official, false);
    assert.deepEqual(entry.tags, ['mcp', 'servers']);
    assert.equal(entry.repositoryUrl, 'https://github.com/modelcontextprotocol/servers');
    assert.equal(entry.homepage, 'https://modelcontextprotocol.io');
    assert.deepEqual(entry.installOptions, []);
  });

  it('skips forked repos', () => {
    const repo = { full_name: 'someone/fork-of-servers', name: 'fork-of-servers', fork: true };
    assert.equal(mapGitHubRepoToEntry(repo, githubOrgSource), undefined);
  });
});

describe('dedupeMarketplaceEntries', () => {
  it('keeps the first entry seen for a given sourceId:name pair', () => {
    const base = builtInMarketplaceEntries(builtInSource);
    const duplicate = { ...base[0], description: 'a different description' };
    const deduped = dedupeMarketplaceEntries([base[0], duplicate, base[1]]);
    assert.equal(deduped.length, 2);
    assert.equal(deduped[0].description, base[0].description);
  });
});

describe('filterMarketplaceEntries', () => {
  const entries = builtInMarketplaceEntries(builtInSource);

  it('returns all entries when the query is empty or whitespace', () => {
    assert.equal(filterMarketplaceEntries(entries, '').length, entries.length);
    assert.equal(filterMarketplaceEntries(entries, '   ').length, entries.length);
    assert.equal(filterMarketplaceEntries(entries, undefined).length, entries.length);
  });

  it('AND-matches multiple whitespace-separated terms case-insensitively', () => {
    const result = filterMarketplaceEntries(entries, 'FETCH web');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'fetch');
  });

  it('returns no entries when one of the AND terms matches nothing', () => {
    const result = filterMarketplaceEntries(entries, 'fetch nonexistentterm');
    assert.equal(result.length, 0);
  });
});

describe('sortMarketplaceEntries', () => {
  it('sorts official first, then installable, then by displayName ascending', () => {
    const entries = [
      { id: '1', name: 'zeta', displayName: 'Zeta', sourceId: 's', sourceName: 's', sourceType: 'GITHUB_ORG' as const, official: false, tags: [], installOptions: [] },
      { id: '2', name: 'alpha', displayName: 'Alpha', sourceId: 's', sourceName: 's', sourceType: 'BUILT_IN' as const, official: true, tags: [], installOptions: [] },
      { id: '3', name: 'beta', displayName: 'Beta', sourceId: 's', sourceName: 's', sourceType: 'REGISTRY' as const, official: false, tags: [], installOptions: [{ label: 'x', type: 'stdio' as const, riskLevel: 'verified' as const }] },
    ];
    const sorted = sortMarketplaceEntries(entries);
    assert.deepEqual(sorted.map((e) => e.name), ['alpha', 'beta', 'zeta']);
  });
});

describe('capMarketplaceEntries', () => {
  it('caps the result list at 250 entries', () => {
    const many = Array.from({ length: 260 }, (_, i) => ({
      id: `id-${i}`, name: `n${i}`, displayName: `n${i}`, sourceId: 's', sourceName: 's',
      sourceType: 'BUILT_IN' as const, official: false, tags: [], installOptions: [],
    }));
    assert.equal(capMarketplaceEntries(many).length, 250);
  });

  it('leaves a short list untouched', () => {
    const few = [{ id: '1', name: 'n', displayName: 'n', sourceId: 's', sourceName: 's', sourceType: 'BUILT_IN' as const, official: false, tags: [], installOptions: [] }];
    assert.equal(capMarketplaceEntries(few).length, 1);
  });
});
