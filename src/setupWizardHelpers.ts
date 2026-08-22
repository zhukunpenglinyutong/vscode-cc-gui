import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { getCodexCliIntegrity } from './codexCliIntegrity.ts';
import {
  MIN_NODE_MAJOR_VERSION,
  parseNodeMajorVersion,
} from './nodeRequirements.ts';

export const SETUP_COMPLETED_KEY = 'ccg.setupWizardCompleted';
export const SETUP_SKIPPED_AT_KEY = 'ccg.setupWizardSkippedAt';
export { MIN_NODE_MAJOR_VERSION, parseNodeMajorVersion };

const SDK_PACKAGES: Record<string, { id: string; name: string; pkg: string }> = {
  'claude-sdk': { id: 'claude-sdk', name: 'Claude Agent SDK', pkg: '@anthropic-ai/claude-agent-sdk' },
  'codex-sdk': { id: 'codex-sdk', name: 'Codex SDK', pkg: '@openai/codex-sdk' },
};

export interface NodeStatus {
  available: boolean;
  path?: string;
  version?: string;
  warning?: 'missing' | 'too_old';
}

export interface SdkStatus {
  id: string;
  name: string;
  pkg: string;
  installed: boolean;
  version: string;
  errorMessage?: string;
}

export interface WizardSnapshot {
  node: NodeStatus;
  sdks: SdkStatus[];
}

export function evaluateNodeStatus(detectedPath: string | undefined, versionOutput: string | undefined): NodeStatus {
  if (!detectedPath) {
    return { available: false, warning: 'missing' };
  }
  const major = parseNodeMajorVersion(versionOutput);
  if (major !== null && major < MIN_NODE_MAJOR_VERSION) {
    return {
      available: true,
      path: detectedPath,
      version: versionOutput?.trim() ?? '',
      warning: 'too_old',
    };
  }
  return {
    available: true,
    path: detectedPath,
    version: versionOutput?.trim() ?? '',
  };
}

export function sdkInstallDirectory(sdkId: string, home = homedir()): string {
  return path.join(home, '.codemoss', 'dependencies', sdkId);
}

export function getSdkStatus(sdkId: string, home = homedir()): SdkStatus {
  const meta = SDK_PACKAGES[sdkId];
  if (!meta) {
    return { id: sdkId, name: sdkId, pkg: sdkId, installed: false, version: '' };
  }
  const sdkRootDir = sdkInstallDirectory(sdkId, home);
  const pkgDir = path.join(sdkRootDir, 'node_modules', ...meta.pkg.split('/'));
  if (!fs.existsSync(pkgDir)) {
    return { ...meta, installed: false, version: '' };
  }
  let version = '';
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    version = typeof pkgJson?.version === 'string' ? pkgJson.version : '';
  } catch {
    version = '';
  }

  if (sdkId === 'codex-sdk') {
    const integrity = getCodexCliIntegrity(sdkRootDir);
    if (!integrity.complete) {
      return { ...meta, installed: false, version, errorMessage: integrity.reason };
    }
  }

  return { ...meta, installed: true, version };
}

export function snapshotSdks(home = homedir()): SdkStatus[] {
  return Object.keys(SDK_PACKAGES).map((sdkId) => getSdkStatus(sdkId, home));
}

export function summarizeWizardSnapshot(snapshot: WizardSnapshot): string {
  const nodeLine = snapshot.node.available
    ? `Node: ${snapshot.node.version ?? 'unknown'} (${snapshot.node.path ?? '?'})`
    : 'Node: not detected';
  const sdkLines = snapshot.sdks.map((s) => {
    const status = s.installed ? `installed ${s.version}` : 'not installed';
    return s.errorMessage ? `${s.name}: ${status} (${s.errorMessage})` : `${s.name}: ${status}`;
  });
  return [nodeLine, ...sdkLines].join('\n');
}

export function ensureSdkInstallScaffolding(sdkId: string, home = homedir()): { dir: string; created: boolean } {
  const meta = SDK_PACKAGES[sdkId];
  if (!meta) throw new Error(`Unknown SDK id: ${sdkId}`);
  const dir = sdkInstallDirectory(sdkId, home);
  let created = false;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    created = true;
  }
  const pkgJsonPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify({ name: sdkId, version: '1.0.0', private: true }, null, 2));
    created = true;
  }
  return { dir, created };
}

export function sdkPackageName(sdkId: string): string | null {
  return SDK_PACKAGES[sdkId]?.pkg ?? null;
}

export function listSdkIds(): string[] {
  return Object.keys(SDK_PACKAGES);
}
