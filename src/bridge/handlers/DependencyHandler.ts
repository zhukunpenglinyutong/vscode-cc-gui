import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { homedir } from 'os';
import * as vscode from 'vscode';
import { getCodexCliIntegrity } from '../../codexCliIntegrity';
import { NodeDetector } from '../../nodeDetector';
import {
  MIN_NODE_MAJOR_VERSION,
  formatNodeRequirementError,
  isNodeVersionSupported,
  readNodeVersion,
} from '../../nodeRequirements';
import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { callWindowFunction, parseJson, postJson } from './helpers';

interface NpmCommandResult {
  stdout: string;
  stderr: string;
}

interface NpmInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  shell: boolean;
}

export class DependencyHandler implements BridgeHandler {
  readonly supportedEvents = [
    'get_dependency_status',
    'update_dependency',
    'check_dependency_updates',
    'check_node_environment',
    'install_dependency',
    'update_dependency_sdk',
    'uninstall_dependency',
    'get_dependency_versions',
  ] as const;

  constructor(private readonly context: BridgeContext) {}

  handle({ event, content, webview }: BridgeMessage): boolean {
    switch (event) {
      case 'get_dependency_status':
        this.sendDependencyStatus(webview);
        return true;
      case 'check_dependency_updates':
        this.checkDependencyUpdates(content, webview);
        return true;
      case 'check_node_environment': {
        const nodePath = NodeDetector.find(this.context.extensionContext) ?? '';
        const version = nodePath ? readNodeVersion(nodePath) : null;
        const available = !!nodePath && isNodeVersionSupported(version);
        postJson(webview, 'node_environment_status', {
          available,
          nodePath,
          version,
          minVersion: MIN_NODE_MAJOR_VERSION,
          error: available ? undefined : formatNodeRequirementError(nodePath || undefined, version),
        });
        return true;
      }
      case 'install_dependency':
      case 'update_dependency':
      case 'update_dependency_sdk':
        this.installDependency(content, webview);
        return true;
      case 'uninstall_dependency':
        this.uninstallDependency(content, webview);
        return true;
      case 'get_dependency_versions':
        this.getDependencyVersions(content, webview);
        return true;
      default:
        return false;
    }
  }

  private sendDependencyStatus(webview: vscode.Webview): void {
    // Fable tier requires Claude Agent SDK >= 0.3.182 (v0.4.9).
    const CLAUDE_MIN_REQUIRED = '0.3.182';
    const check = (sdkId: string, pkg: string): {
      installed: boolean;
      version: string;
      errorMessage?: string;
      meetsMinimum?: boolean;
      minRequiredVersion?: string;
    } => {
      const sdkRootDir = path.join(homedir(), '.codemoss', 'dependencies', sdkId);
      const pkgDir = path.join(sdkRootDir, 'node_modules', ...pkg.split('/'));
      if (!fs.existsSync(pkgDir)) {
        return {
          installed: false,
          version: '',
          meetsMinimum: false,
          minRequiredVersion: sdkId === 'claude-sdk' ? CLAUDE_MIN_REQUIRED : undefined,
        };
      }
      let version = '';
      try {
        const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        version = pkgJson.version ?? '';
      } catch {
        version = '';
      }

      if (sdkId === 'codex-sdk') {
        const integrity = getCodexCliIntegrity(sdkRootDir);
        if (!integrity.complete) {
          return {
            installed: false,
            version,
            errorMessage: integrity.reason,
          };
        }
      }

      const meetsMinimum = sdkId === 'claude-sdk'
        ? this.compareSemver(version, CLAUDE_MIN_REQUIRED) >= 0
        : true;

      return {
        installed: true,
        version,
        meetsMinimum,
        minRequiredVersion: sdkId === 'claude-sdk' ? CLAUDE_MIN_REQUIRED : undefined,
      };
    };
    const claudeSdk = check('claude-sdk', '@anthropic-ai/claude-agent-sdk');
    const codexSdk = check('codex-sdk', '@openai/codex-sdk');
    postJson(webview, 'update_dependency_status', {
      'claude-sdk': {
        id: 'claude-sdk',
        name: 'Claude Agent SDK',
        status: claudeSdk.installed ? 'installed' : 'not_installed',
        installedVersion: claudeSdk.version,
        installPath: path.join(homedir(), '.codemoss', 'dependencies', 'claude-sdk'),
        meetsMinimum: claudeSdk.meetsMinimum,
        minRequiredVersion: claudeSdk.minRequiredVersion,
      },
      'codex-sdk': {
        id: 'codex-sdk',
        name: 'Codex SDK',
        status: codexSdk.installed ? 'installed' : 'not_installed',
        installedVersion: codexSdk.version,
        errorMessage: codexSdk.errorMessage,
        installPath: path.join(homedir(), '.codemoss', 'dependencies', 'codex-sdk'),
      },
    });
  }

  /** Compare dotted semver-like versions. Returns -1 / 0 / 1. */
  private compareSemver(a: string, b: string): number {
    const pa = a.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
    const pb = b.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i += 1) {
      const da = pa[i] ?? 0;
      const db = pb[i] ?? 0;
      if (da > db) return 1;
      if (da < db) return -1;
    }
    return 0;
  }

  private resolveNpm(): { npmPath: string; env: NodeJS.ProcessEnv } {
    const npmPath = NodeDetector.findNpm(this.context.extensionContext) ?? 'npm';
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'npm_config_offline') {
        delete env[key];
      }
    }
    env.NPM_CONFIG_OFFLINE = 'false';
    const npmDir = path.dirname(npmPath);
    if (npmDir && npmDir !== '.') {
      const currentPath = env.PATH ?? env.Path ?? '';
      if (!currentPath.split(path.delimiter).includes(npmDir)) {
        const nextPath = `${npmDir}${path.delimiter}${currentPath}`;
        env.PATH = nextPath;
        if (process.platform === 'win32') {
          env.Path = nextPath;
        }
      }
    }
    return { npmPath, env };
  }

  private resolveNpmInvocation(args: string[]): NpmInvocation {
    const { npmPath, env } = this.resolveNpm();
    if (process.platform === 'win32' && npmPath.toLowerCase().endsWith('.cmd')) {
      const nodePath = NodeDetector.find(this.context.extensionContext);
      const npmCliPath = path.join(path.dirname(npmPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (nodePath && fs.existsSync(npmCliPath)) {
        return {
          command: nodePath,
          args: [npmCliPath, ...args],
          env,
          shell: false,
        };
      }
    }

    return {
      command: process.platform === 'win32' ? path.basename(npmPath) : npmPath,
      args,
      env,
      shell: process.platform === 'win32',
    };
  }

  private installDependency(content: string, webview: vscode.Webview): void {
    const payload = parseJson<any>(content, {});
    const sdkId = payload.id ?? 'claude-sdk';
    const pkg = this.packageForSdk(sdkId);
    const sdkDir = path.join(homedir(), '.codemoss', 'dependencies', sdkId);
    fs.mkdirSync(sdkDir, { recursive: true });
    const pkgJsonPath = path.join(sdkDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      fs.writeFileSync(pkgJsonPath, JSON.stringify({ name: sdkId, version: '1.0.0', private: true }, null, 2));
    }
    const requested = payload.version && payload.version !== 'latest' ? `${pkg}@${payload.version}` : pkg;
    const send = (log: string) => postJson(webview, 'dependency_install_progress', { sdkId, log });
    send(`Installing ${requested}...\n`);
    this.cleanupBrokenCodexInstall(sdkId, sdkDir, send);
    const invocation = this.resolveNpmInvocation(['install', '--ignore-scripts', requested]);
    const proc = cp.spawn(invocation.command, invocation.args, {
      cwd: sdkDir,
      env: invocation.env,
      shell: invocation.shell,
      windowsHide: true,
    });
    proc.stdout?.on('data', (data: Buffer) => send(data.toString()));
    proc.stderr?.on('data', (data: Buffer) => send(data.toString()));
    proc.on('close', (code) => {
      postJson(webview, 'dependency_install_result', { sdkId, success: code === 0, error: code !== 0 ? `exit code ${code}` : undefined });
      this.sendDependencyStatus(webview);
    });
    proc.on('error', (error) => {
      postJson(webview, 'dependency_install_result', { sdkId, success: false, error: error.message });
    });
  }

  private uninstallDependency(content: string, webview: vscode.Webview): void {
    const payload = parseJson<any>(content, {});
    const sdkId = payload.id ?? 'claude-sdk';
    const sdkDir = path.join(homedir(), '.codemoss', 'dependencies', sdkId);

    try {
      fs.rmSync(sdkDir, { recursive: true, force: true });
      postJson(webview, 'dependency_uninstall_result', { sdkId, success: true });
      this.sendDependencyStatus(webview);
      void this.getDependencyVersions(JSON.stringify({ id: sdkId }), webview);
    } catch (error) {
      postJson(webview, 'dependency_uninstall_result', {
        sdkId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private getDependencyVersions(content: string, webview: vscode.Webview): void {
    const { id } = parseJson<any>(content, { id: '' });
    const ids = id ? [id] : ['claude-sdk', 'codex-sdk'];
    Promise.all(ids.map((sdkId) => this.fetchDependencyVersions(sdkId)))
      .then((entries) => {
        postJson(webview, 'dependency_versions_loaded', Object.fromEntries(entries));
      });
  }

  private packageForSdk(sdkId: string): string {
    return sdkId === 'codex-sdk' ? '@openai/codex-sdk' : '@anthropic-ai/claude-agent-sdk';
  }

  private checkDependencyUpdates(content: string, webview: vscode.Webview): void {
    this.sendDependencyStatus(webview);

    const { id } = parseJson<any>(content, { id: '' });
    const ids = id ? [id] : ['claude-sdk', 'codex-sdk'];

    Promise.all(ids.map(async (sdkId) => {
      const local = this.getInstalledVersion(sdkId);
      const latestResult = await this.fetchLatestVersion(sdkId);
      const remote = latestResult.version;
      const hasUpdate = !!local && !!remote && this.compareVersions(local, remote) < 0;

      return [sdkId, {
        sdkId,
        sdkName: sdkId === 'codex-sdk' ? 'Codex SDK' : 'Claude Agent SDK',
        currentVersion: local,
        latestVersion: remote ?? local ?? '',
        hasUpdate,
        error: remote ? undefined : latestResult.error ?? 'Failed to fetch latest version',
      }];
    })).then((entries) => {
      postJson(webview, 'dependency_update_available', Object.fromEntries(entries));
    });
  }

  private async fetchDependencyVersions(sdkId: string): Promise<[string, any]> {
    const fallbackVersions = this.buildFallbackVersions(sdkId);
    try {
      const { stdout } = await this.runNpm([
        'view',
        this.packageForSdk(sdkId),
        'versions',
        '--json',
      ]);
      const allVersions = JSON.parse(stdout.trim());
      if (!Array.isArray(allVersions)) {
        throw new Error('npm returned an invalid version list');
      }
      const versions = allVersions
        .filter((version): version is string => typeof version === 'string')
        .slice(-20)
        .reverse();
      return [sdkId, {
        sdkId,
        versions,
        latestVersion: versions[0] ?? fallbackVersions[0] ?? '',
        fallbackVersions,
        source: 'remote',
      }];
    } catch (error) {
      const message = this.errorMessage(error);
      console.warn(`[DependencyHandler] Failed to fetch ${sdkId} versions: ${message}`);
      return [sdkId, {
        sdkId,
        versions: fallbackVersions,
        latestVersion: fallbackVersions[0] ?? '',
        fallbackVersions,
        source: 'fallback',
        error: message,
      }];
    }
  }

  private async fetchLatestVersion(sdkId: string): Promise<{ version?: string; error?: string }> {
    try {
      const { stdout } = await this.runNpm([
        'view',
        this.packageForSdk(sdkId),
        'version',
        '--json',
      ]);
      const parsed = JSON.parse(stdout.trim());
      if (typeof parsed !== 'string' || !parsed) {
        throw new Error('npm returned an invalid latest version');
      }
      return { version: parsed };
    } catch (error) {
      const message = this.errorMessage(error);
      console.warn(`[DependencyHandler] Failed to fetch latest ${sdkId} version: ${message}`);
      return { error: message };
    }
  }

  private runNpm(args: string[], timeout = 30000): Promise<NpmCommandResult> {
    const invocation = this.resolveNpmInvocation(args);
    return new Promise((resolve, reject) => {
      const proc = cp.spawn(invocation.command, invocation.args, {
        env: invocation.env,
        shell: invocation.shell,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        proc.kill();
        finish(() => reject(new Error(`npm command timed out after ${timeout / 1000}s`)));
      }, timeout);

      proc.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      proc.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      proc.on('error', (error) => finish(() => reject(error)));
      proc.on('close', (code) => finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(`npm command failed: ${detail}`));
      }));
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private getInstalledVersion(sdkId: string): string | undefined {
    const sdkDir = path.join(homedir(), '.codemoss', 'dependencies', sdkId);
    const pkgDir = path.join(sdkDir, 'node_modules', ...this.packageForSdk(sdkId).split('/'));
    try {
      const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      return typeof pkgJson?.version === 'string' ? pkgJson.version : undefined;
    } catch {
      return undefined;
    }
  }

  private buildFallbackVersions(sdkId: string): string[] {
    const installedVersion = this.getInstalledVersion(sdkId);
    return installedVersion ? [installedVersion] : [];
  }

  private compareVersions(left: string, right: string): number {
    const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const maxLength = Math.max(leftParts.length, rightParts.length);

    for (let index = 0; index < maxLength; index += 1) {
      const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
      if (delta !== 0) {
        return delta;
      }
    }

    return 0;
  }

  private cleanupBrokenCodexInstall(sdkId: string, sdkDir: string, send: (log: string) => void): void {
    if (sdkId !== 'codex-sdk') {
      return;
    }

    const openaiDir = path.join(sdkDir, 'node_modules', '@openai');
    const packageDirs = [
      'codex-sdk',
      'codex',
      'codex-linux-x64',
      'codex-linux-arm64',
      'codex-darwin-x64',
      'codex-darwin-arm64',
      'codex-win32-x64',
      'codex-win32-arm64',
    ];
    const hasExistingCodexPackages = packageDirs.some((dirName) => fs.existsSync(path.join(openaiDir, dirName)));
    if (!hasExistingCodexPackages) {
      return;
    }

    const integrity = getCodexCliIntegrity(sdkDir);
    if (integrity.complete) {
      return;
    }

    send(`Existing Codex SDK install is incomplete: ${integrity.reason ?? 'unknown reason'}\n`);
    send('Cleaning incomplete Codex packages before reinstall...\n');

    const packageLock = path.join(sdkDir, 'package-lock.json');
    for (const dirName of packageDirs) {
      const packageDir = path.join(openaiDir, dirName);
      if (fs.existsSync(packageDir)) {
        fs.rmSync(packageDir, { recursive: true, force: true });
      }
    }

    if (fs.existsSync(packageLock)) {
      fs.rmSync(packageLock, { force: true });
    }
  }
}
