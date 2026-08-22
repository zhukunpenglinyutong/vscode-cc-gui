import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ensureSdkInstallScaffolding,
  evaluateNodeStatus,
  getSdkStatus,
  listSdkIds,
  parseNodeMajorVersion,
  sdkInstallDirectory,
  sdkPackageName,
  snapshotSdks,
  summarizeWizardSnapshot,
} from '../setupWizardHelpers.ts';
import { resolveCodexTargetTriple } from '../codexCliIntegrity.ts';

let tmpHome: string;

const CODEX_PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': 'codex-linux-x64',
  'aarch64-unknown-linux-musl': 'codex-linux-arm64',
  'x86_64-apple-darwin': 'codex-darwin-x64',
  'aarch64-apple-darwin': 'codex-darwin-arm64',
  'x86_64-pc-windows-msvc': 'codex-win32-x64',
  'aarch64-pc-windows-msvc': 'codex-win32-arm64',
};

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-wizard-test-'));
});

after(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  const dependenciesDir = path.join(tmpHome, '.codemoss', 'dependencies');
  if (fs.existsSync(dependenciesDir)) {
    fs.rmSync(dependenciesDir, { recursive: true, force: true });
  }
});

describe('parseNodeMajorVersion', () => {
  it('parses v-prefixed version output', () => {
    assert.equal(parseNodeMajorVersion('v20.10.0\n'), 20);
  });

  it('parses bare numeric version', () => {
    assert.equal(parseNodeMajorVersion('18.17.1'), 18);
  });

  it('returns null for empty / invalid', () => {
    assert.equal(parseNodeMajorVersion(''), null);
    assert.equal(parseNodeMajorVersion(undefined), null);
    assert.equal(parseNodeMajorVersion('not-a-version'), null);
  });
});

describe('evaluateNodeStatus', () => {
  it('returns missing when path absent', () => {
    const status = evaluateNodeStatus(undefined, undefined);
    assert.equal(status.available, false);
    assert.equal(status.warning, 'missing');
  });

  it('returns too_old for Node < 20', () => {
    const status = evaluateNodeStatus('/path/to/node', 'v16.20.2');
    assert.equal(status.available, true);
    assert.equal(status.warning, 'too_old');
    assert.equal(status.version, 'v16.20.2');
  });

  it('returns too_old for Node 18 (plugin now requires 20+)', () => {
    const status = evaluateNodeStatus('/path/to/node', 'v18.20.0');
    assert.equal(status.warning, 'too_old');
  });

  it('returns available with no warning for Node 20+', () => {
    const status = evaluateNodeStatus('/path/to/node', 'v20.10.0');
    assert.equal(status.available, true);
    assert.equal(status.warning, undefined);
    assert.equal(status.version, 'v20.10.0');
  });

  it('treats unknown version as ok rather than warning', () => {
    const status = evaluateNodeStatus('/path/to/node', undefined);
    assert.equal(status.available, true);
    assert.equal(status.warning, undefined);
  });
});

describe('sdkInstallDirectory', () => {
  it('returns ~/.codemoss/dependencies/<sdkId> path', () => {
    assert.equal(
      sdkInstallDirectory('claude-sdk', tmpHome),
      path.join(tmpHome, '.codemoss', 'dependencies', 'claude-sdk'),
    );
  });
});

describe('listSdkIds', () => {
  it('includes both claude-sdk and codex-sdk', () => {
    const ids = listSdkIds();
    assert.ok(ids.includes('claude-sdk'));
    assert.ok(ids.includes('codex-sdk'));
  });
});

describe('sdkPackageName', () => {
  it('returns npm package name for known SDKs', () => {
    assert.equal(sdkPackageName('claude-sdk'), '@anthropic-ai/claude-agent-sdk');
    assert.equal(sdkPackageName('codex-sdk'), '@openai/codex-sdk');
  });

  it('returns null for unknown SDK id', () => {
    assert.equal(sdkPackageName('mystery-sdk'), null);
  });
});

describe('getSdkStatus', () => {
  it('reports not installed when scaffolding missing', () => {
    const status = getSdkStatus('claude-sdk', tmpHome);
    assert.equal(status.installed, false);
    assert.equal(status.version, '');
    assert.equal(status.name, 'Claude Agent SDK');
  });

  it('reports installed with version when package.json present', () => {
    const dir = path.join(tmpHome, '.codemoss', 'dependencies', 'claude-sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    const status = getSdkStatus('claude-sdk', tmpHome);
    assert.equal(status.installed, true);
    assert.equal(status.version, '1.2.3');
  });

  it('reports installed with empty version when package.json malformed', () => {
    const dir = path.join(tmpHome, '.codemoss', 'dependencies', 'codex-sdk', 'node_modules', '@openai', 'codex-sdk');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{not json');
    const status = getSdkStatus('codex-sdk', tmpHome);
    assert.equal(status.installed, false);
    assert.equal(status.version, '');
    assert.match(status.errorMessage ?? '', /Missing @openai\/codex package/);
  });

  it('reports codex-sdk as not installed when the CLI binary is missing', () => {
    const root = path.join(tmpHome, '.codemoss', 'dependencies', 'codex-sdk');
    const sdkDir = path.join(root, 'node_modules', '@openai', 'codex-sdk');
    const codexDir = path.join(root, 'node_modules', '@openai', 'codex');
    const platformDir = path.join(root, 'node_modules', '@openai', 'codex-darwin-arm64');
    fs.mkdirSync(sdkDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    fs.mkdirSync(platformDir, { recursive: true });
    fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ version: '0.111.0' }));
    fs.writeFileSync(path.join(codexDir, 'package.json'), JSON.stringify({ version: '0.111.0' }));
    fs.writeFileSync(path.join(platformDir, 'package.json'), JSON.stringify({ version: '0.111.0-darwin-arm64' }));

    const status = getSdkStatus('codex-sdk', tmpHome);
    assert.equal(status.installed, false);
    assert.equal(status.version, '0.111.0');
    assert.match(status.errorMessage ?? '', /Missing Codex CLI binary|Missing optional dependency/);
  });

  it('reports codex-sdk as installed when the current CLI binary layout exists', () => {
    const targetTriple = resolveCodexTargetTriple();
    assert.ok(targetTriple);
    const platformPackage = CODEX_PLATFORM_PACKAGE_BY_TARGET[targetTriple];
    assert.ok(platformPackage);

    const root = path.join(tmpHome, '.codemoss', 'dependencies', 'codex-sdk');
    const sdkDir = path.join(root, 'node_modules', '@openai', 'codex-sdk');
    const codexDir = path.join(root, 'node_modules', '@openai', 'codex');
    const platformDir = path.join(root, 'node_modules', '@openai', platformPackage);
    const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const binaryPath = path.join(platformDir, 'vendor', targetTriple, 'bin', binaryName);

    fs.mkdirSync(sdkDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ version: '0.142.4' }));
    fs.writeFileSync(path.join(codexDir, 'package.json'), JSON.stringify({ version: '0.142.4' }));
    fs.writeFileSync(path.join(platformDir, 'package.json'), JSON.stringify({ version: '0.142.4' }));
    fs.writeFileSync(path.join(platformDir, 'vendor', targetTriple, 'codex-package.json'), '{}');
    fs.writeFileSync(binaryPath, '');
    if (process.platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
    }

    const status = getSdkStatus('codex-sdk', tmpHome);
    assert.equal(status.installed, true);
    assert.equal(status.version, '0.142.4');
    assert.equal(status.errorMessage, undefined);
  });

  it('gracefully handles unknown sdkId', () => {
    const status = getSdkStatus('mystery-sdk', tmpHome);
    assert.equal(status.installed, false);
  });
});

describe('snapshotSdks', () => {
  it('returns an entry per known SDK', () => {
    const all = snapshotSdks(tmpHome);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((s) => s.id).sort(), ['claude-sdk', 'codex-sdk']);
  });
});

describe('summarizeWizardSnapshot', () => {
  it('produces a multi-line summary including node and each SDK', () => {
    const summary = summarizeWizardSnapshot({
      node: { available: true, path: '/usr/bin/node', version: 'v20.10.0' },
      sdks: [
        { id: 'claude-sdk', name: 'Claude Agent SDK', pkg: '@anthropic-ai/claude-agent-sdk', installed: true, version: '1.2.3' },
        { id: 'codex-sdk', name: 'Codex SDK', pkg: '@openai/codex-sdk', installed: false, version: '' },
      ],
    });
    assert.match(summary, /Node: v20\.10\.0 \(\/usr\/bin\/node\)/);
    assert.match(summary, /Claude Agent SDK: installed 1\.2\.3/);
    assert.match(summary, /Codex SDK: not installed/);
  });

  it('prints "not detected" when node missing', () => {
    const summary = summarizeWizardSnapshot({
      node: { available: false, warning: 'missing' },
      sdks: [],
    });
    assert.match(summary, /Node: not detected/);
  });
});

describe('ensureSdkInstallScaffolding', () => {
  it('creates the install directory and package.json the first time', () => {
    const result = ensureSdkInstallScaffolding('claude-sdk', tmpHome);
    assert.equal(result.created, true);
    assert.ok(fs.existsSync(result.dir));
    const pkgJson = JSON.parse(fs.readFileSync(path.join(result.dir, 'package.json'), 'utf8'));
    assert.equal(pkgJson.name, 'claude-sdk');
    assert.equal(pkgJson.private, true);
  });

  it('does not overwrite an existing package.json on second call', () => {
    const { dir } = ensureSdkInstallScaffolding('codex-sdk', tmpHome);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'codex-sdk', custom: true }));
    const second = ensureSdkInstallScaffolding('codex-sdk', tmpHome);
    assert.equal(second.created, false);
    const pkgJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkgJson.custom, true);
  });

  it('throws for unknown sdkId', () => {
    assert.throws(() => ensureSdkInstallScaffolding('mystery-sdk', tmpHome), /Unknown SDK id/);
  });
});
