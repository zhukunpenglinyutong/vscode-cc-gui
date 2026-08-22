import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const originalHome = process.env.HOME;
const originalUserprofile = process.env.USERPROFILE;
let tmpHome: string;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-test-'));
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
  const codexDir = path.join(tmpHome, '.codex');
  if (fs.existsSync(codexDir)) {
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});

// Import after HOME is mocked so `homedir()` resolves to tmpHome at construction.
const { CodexSettingsStore } = await import('../bridge/services/CodexSettingsStore.ts');

const configPath = () => path.join(tmpHome, '.codex', 'config.toml');
const authPath = () => path.join(tmpHome, '.codex', 'auth.json');
const cliBackupPath = () => path.join(tmpHome, '.codex', 'config.toml.cli_backup');

describe('CodexSettingsStore.applyProvider', () => {
  it('no-ops on null provider', () => {
    const store = new CodexSettingsStore();
    store.applyProvider(null);
    assert.equal(fs.existsSync(configPath()), false);
  });

  it('no-ops for the cli login sentinel id', () => {
    const store = new CodexSettingsStore();
    store.applyProvider({ id: '__codex_cli_login__', configToml: 'should not write' });
    assert.equal(fs.existsSync(configPath()), false);
  });

  it('writes configToml atomically', () => {
    const store = new CodexSettingsStore();
    store.applyProvider({ id: 'p1', configToml: 'model = "gpt-4"\n' });
    assert.equal(fs.readFileSync(configPath(), 'utf8'), 'model = "gpt-4"\n');
  });

  it('writes pretty-printed authJson when provided', () => {
    const store = new CodexSettingsStore();
    store.applyProvider({
      id: 'p2',
      configToml: 'model = "gpt-4"\n',
      authJson: '{"tokens":{"access_token":"abc"}}',
    });
    const written = JSON.parse(fs.readFileSync(authPath(), 'utf8'));
    assert.deepEqual(written, { tokens: { access_token: 'abc' } });
    assert.match(fs.readFileSync(authPath(), 'utf8'), /\n {2}"tokens"/);
  });

  it('does not wipe existing config.toml when provider configToml is empty', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(configPath(), 'user_config = true\n', 'utf8');
    const store = new CodexSettingsStore();
    store.applyProvider({
      id: 'p2-empty',
      configToml: '',
      authJson: '{"tokens":{"access_token":"abc"}}',
    });
    assert.equal(fs.readFileSync(configPath(), 'utf8'), 'user_config = true\n');
    const written = JSON.parse(fs.readFileSync(authPath(), 'utf8'));
    assert.deepEqual(written, { tokens: { access_token: 'abc' } });
  });

  it('throws on invalid authJson rather than write garbage', () => {
    const store = new CodexSettingsStore();
    assert.throws(() => store.applyProvider({ id: 'p3', authJson: '{not-json' }));
    assert.equal(fs.existsSync(authPath()), false);
  });

  it('skips authJson write when value is empty string', () => {
    const store = new CodexSettingsStore();
    store.applyProvider({ id: 'p4', configToml: 'x = 1', authJson: '   ' });
    assert.equal(fs.existsSync(authPath()), false);
    assert.equal(fs.readFileSync(configPath(), 'utf8'), 'x = 1');
  });
});

describe('CodexSettingsStore.getCurrentConfig', () => {
  it('reports missing files as exists=false with empty strings', () => {
    const store = new CodexSettingsStore();
    const snapshot = store.getCurrentConfig();
    assert.deepEqual(snapshot.exists, { configToml: false, authJson: false });
    assert.equal(snapshot.configToml, '');
    assert.equal(snapshot.authJson, '');
  });

  it('reads existing files when present', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(configPath(), 'present = true');
    fs.writeFileSync(authPath(), '{"x":1}');
    const store = new CodexSettingsStore();
    const snapshot = store.getCurrentConfig();
    assert.deepEqual(snapshot.exists, { configToml: true, authJson: true });
    assert.equal(snapshot.configToml, 'present = true');
    assert.equal(snapshot.authJson, '{"x":1}');
  });
});

describe('CodexSettingsStore CLI login backup', () => {
  it('backs up non-empty config.toml and clears it', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(configPath(), 'user_config = true');
    const store = new CodexSettingsStore();
    store.applyCliLoginMode();
    assert.equal(fs.readFileSync(configPath(), 'utf8'), '');
    assert.equal(fs.readFileSync(cliBackupPath(), 'utf8'), 'user_config = true');
  });

  it('does not create a backup when existing config is empty', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(configPath(), '   ');
    const store = new CodexSettingsStore();
    store.applyCliLoginMode();
    assert.equal(fs.existsSync(cliBackupPath()), false);
    assert.equal(fs.readFileSync(configPath(), 'utf8'), '');
  });

  it('restoreCliLoginBackup is a no-op when backup missing', () => {
    const store = new CodexSettingsStore();
    assert.doesNotThrow(() => store.restoreCliLoginBackup());
    assert.equal(fs.existsSync(configPath()), false);
  });

  it('restoreCliLoginBackup copies backup into config and removes backup file', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(configPath(), 'cleared');
    fs.writeFileSync(cliBackupPath(), 'restored = true');
    const store = new CodexSettingsStore();
    store.restoreCliLoginBackup();
    assert.equal(fs.readFileSync(configPath(), 'utf8'), 'restored = true');
    assert.equal(fs.existsSync(cliBackupPath()), false);
  });
});
