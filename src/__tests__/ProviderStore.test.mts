import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const originalHome = process.env.HOME;
const originalUserprofile = process.env.USERPROFILE;
let tmpHome: string;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-store-test-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserprofile;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  const codemossDir = path.join(tmpHome, '.codemoss');
  if (fs.existsSync(codemossDir)) {
    fs.rmSync(codemossDir, { recursive: true, force: true });
  }
});

const { ProviderStore } = await import('../bridge/services/ProviderStore.ts');

function configPath(): string {
  return path.join(tmpHome, '.codemoss', 'config.json');
}

function readConfig(): any {
  return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
}

function createContext(initialState: Record<string, any> = {}) {
  const state = new Map(Object.entries(initialState));
  return {
    globalState: {
      get<T>(key: string): T | undefined {
        return state.get(key);
      },
      update(key: string, value: any) {
        state.set(key, value);
        return Promise.resolve();
      },
    },
  } as any;
}

describe('ProviderStore shared config', () => {
  it('writes Claude providers into ~/.codemoss/config.json using the shared shape', async () => {
    const syncedSnapshots: any[] = [];
    const store = new ProviderStore(createContext(), {
      syncProviderToDisk: (providers) => {
        syncedSnapshots.push(providers);
      },
    });

    await store.saveClaudeProviders([
      { id: '__local_settings_json__', name: 'Local Settings (settings.json)', isActive: false },
      {
        id: 'proxy-a',
        name: 'Proxy A',
        remark: 'shared-provider',
        settingsConfig: {
          env: {
            ANTHROPIC_BASE_URL: 'https://example.test',
          },
        },
        isActive: true,
      },
    ], true);

    const config = readConfig();
    assert.equal(config.version, 2);
    assert.equal(config.claude.current, 'proxy-a');
    assert.deepEqual(config.claude.providerOrder, ['proxy-a']);
    assert.equal(config.claude.providers['proxy-a'].name, 'Proxy A');
    assert.equal(config.claude.providers['proxy-a'].remark, 'shared-provider');
    assert.equal(config.claude.providers['proxy-a'].settingsConfig.env.ANTHROPIC_BASE_URL, 'https://example.test');
    assert.equal(store.getActiveClaudeProvider()?.id, 'proxy-a');
    assert.equal(syncedSnapshots.length, 1);
  });

  it('clears claude.current when revoking local settings auth (all providers inactive)', async () => {
    const store = new ProviderStore(createContext(), {
      syncProviderToDisk: () => {},
    });

    await store.saveClaudeProviders([
      { id: '__local_settings_json__', name: 'Local Settings', isActive: true },
      { id: 'proxy-a', name: 'Proxy A', isActive: false },
    ]);
    assert.equal(readConfig().claude.current, '__local_settings_json__');
    assert.equal(store.getActiveClaudeProvider()?.id, '__local_settings_json__');

    // Mirrors switch_provider { id: '__disabled__' }: every card isActive=false.
    await store.saveClaudeProviders([
      { id: '__local_settings_json__', name: 'Local Settings', isActive: false },
      { id: 'proxy-a', name: 'Proxy A', isActive: false },
    ]);

    assert.equal(readConfig().claude.current, '');
    assert.equal(store.getActiveClaudeProvider(), null);
    const list = store.getClaudeProviders();
    assert.equal(list.find((p: any) => p.id === '__local_settings_json__')?.isActive, false);
  });

  it('reads legacy Codex globalState without rewriting shared config', () => {
    const store = new ProviderStore(
      createContext({
        'ccg.codex_providers': [
          { id: 'codex-proxy', name: 'Codex Proxy', remark: 'legacy' },
        ],
        'ccg.codex_current_provider_id': '__codex_cli_login__',
        'ccg.codex_local_config_authorized': true,
      }),
      { syncProviderToDisk: () => {} },
    );

    const providers = store.getCodexProviders();
    assert.equal(providers[0].id, '__codex_cli_login__');
    assert.equal(providers[0].isActive, true);
    assert.equal(providers[1].id, 'codex-proxy');
    assert.equal(providers[1].isActive, false);
    assert.equal(fs.existsSync(configPath()), false);
  });

  it('prefers existing shared config over legacy globalState data', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({
      version: 2,
      claude: {
        current: 'shared-claude',
        providers: {
          'shared-claude': { id: 'shared-claude', name: 'Shared Claude' },
        },
        providerOrder: ['shared-claude'],
      },
      codex: {
        current: 'shared-codex',
        localConfigAuthorized: false,
        providers: {
          'shared-codex': { id: 'shared-codex', name: 'Shared Codex' },
        },
        providerOrder: ['shared-codex'],
      },
    }, null, 2));

    const store = new ProviderStore(
      createContext({
        'ccg.providers': [{ id: 'legacy-claude', name: 'Legacy Claude', isActive: true }],
        'ccg.codex_providers': [{ id: 'legacy-codex', name: 'Legacy Codex', isActive: true }],
        'ccg.codex_current_provider_id': 'legacy-codex',
        'ccg.codex_local_config_authorized': true,
      }),
      { syncProviderToDisk: () => {} },
    );

    assert.equal(store.getActiveClaudeProvider()?.id, 'shared-claude');
    assert.equal(store.getActiveCodexProvider()?.id, 'shared-codex');
    assert.equal(store.isCodexLocalConfigAuthorized(), false);
  });

  it('does not rewrite shared config during provider reads', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    const original = {
      version: 2,
      claude: {
        current: 'missing-provider',
        providers: {
          'real-provider': { id: 'real-provider', name: 'Real Provider' },
        },
        providerOrder: ['real-provider'],
      },
      codex: {
        current: '',
        providers: {},
        localConfigAuthorized: false,
      },
    };
    fs.writeFileSync(configPath(), JSON.stringify(original, null, 2), 'utf8');

    const store = new ProviderStore(createContext(), { syncProviderToDisk: () => {} });
    const providers = store.getClaudeProviders();

    assert.equal(providers.find((p: any) => p.id === 'real-provider')?.isActive, true);
    assert.deepEqual(readConfig(), original);
  });
});
