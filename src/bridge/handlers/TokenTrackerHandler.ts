import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { NodeDetector } from '../../nodeDetector';
import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { callWindowFunction } from './helpers';

/**
 * TokenTracker local-server bridge (ported from JetBrains TokenTrackerHandler, v0.4.9).
 * Detects/installs tokentracker-cli, ensures a 127.0.0.1 server, and whitelist-proxies
 * dashboard requests for the vendored usage UI.
 */
export class TokenTrackerHandler implements BridgeHandler {
  readonly supportedEvents = [
    'tt_detect_cli',
    'tt_install_cli',
    'tt_ensure_server',
    'tt_proxy',
  ] as const;

  private static rememberedPort = 0;

  private static readonly CLI_BIN_NAMES = ['tokentracker', 'tracker', 'tokentracker-cli'];
  private static readonly TT_CLI_PACKAGE = 'tokentracker-cli@0.87.3';
  private static readonly TT_DEFAULT_PORT = 7680;
  private static readonly TT_STATUS_SCAN_FIRST = 7680;
  private static readonly TT_STATUS_SCAN_LAST = 7684;
  private static readonly TT_ENSURE_PORT_FIRST = 7680;
  private static readonly TT_ENSURE_PORT_LAST = 7690;
  private static readonly TT_USER_STATUS_PATH = '/functions/tokentracker-user-status';
  private static ensureLock: Promise<void> = Promise.resolve();

  constructor(private readonly context: BridgeContext) {}

  handle({ event, content, webview }: BridgeMessage): boolean {
    switch (event) {
      case 'tt_detect_cli':
        void this.runAsync(webview, content, async () => this.detectCliPayload());
        return true;
      case 'tt_install_cli':
        void this.runAsync(webview, content, async () => this.installCli());
        return true;
      case 'tt_ensure_server':
        void this.runAsync(webview, content, async () => this.ensureServer());
        return true;
      case 'tt_proxy':
        void this.runAsync(webview, content, async () => this.proxy(content));
        return true;
      default:
        return false;
    }
  }

  private parseRequestId(content: string): string {
    try {
      const json = JSON.parse(content) as { requestId?: string };
      return typeof json.requestId === 'string' ? json.requestId : '';
    } catch {
      return '';
    }
  }

  private async runAsync(
    webview: vscode.Webview,
    content: string,
    operation: () => Promise<Record<string, unknown>>,
  ): Promise<void> {
    const requestId = this.parseRequestId(content);
    try {
      const data = await operation();
      callWindowFunction(webview, 'onTokenTrackerResponse', { requestId, ok: true, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.context.log.appendLine(`[TokenTracker] ${message}`);
      callWindowFunction(webview, 'onTokenTrackerResponse', {
        requestId,
        ok: false,
        error: message || 'unknown error',
      });
    }
  }

  private detectCliPayload(): Record<string, unknown> {
    const status = this.detectCli();
    const data: Record<string, unknown> = { installed: status.installed };
    if (status.binPath) data.binPath = status.binPath;
    if (status.version) data.version = status.version;
    return data;
  }

  private detectCli(): { installed: boolean; binPath?: string; version?: string } {
    for (const candidate of this.cliCandidates()) {
      const version = this.probeCliVersion(candidate);
      if (version) {
        return { installed: true, binPath: candidate, version };
      }
    }
    return { installed: false };
  }

  private cliCandidates(): string[] {
    const candidates = new Set<string>();
    const isWin = process.platform === 'win32';
    const extensions = isWin ? ['.cmd', '.exe', ''] : [''];
    const home = os.homedir();
    const binDirs: string[] = [];

    if (isWin) {
      const appData = process.env.APPDATA;
      if (appData) binDirs.push(path.join(appData, 'npm'));
    } else {
      binDirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin');
      binDirs.push(path.join(home, '.npm-global', 'bin'));
      binDirs.push(path.join(home, '.hermes', 'node', 'bin'));
      binDirs.push(path.join(home, '.volta', 'bin'));
      binDirs.push(path.join(home, '.fnm', 'aliases', 'default', 'bin'));
      binDirs.push(path.join(home, '.nvmd', 'bin'));
      const nvmVersions = path.join(home, '.nvm', 'versions', 'node');
      try {
        for (const version of fs.readdirSync(nvmVersions).sort().reverse()) {
          binDirs.push(path.join(nvmVersions, version, 'bin'));
        }
      } catch {
        // nvm not installed
      }
    }

    const nodePath = NodeDetector.find(this.context.extensionContext);
    if (nodePath) {
      binDirs.push(path.dirname(nodePath));
    }

    for (const dir of binDirs) {
      for (const name of TokenTrackerHandler.CLI_BIN_NAMES) {
        for (const ext of extensions) {
          const file = path.join(dir, name + ext);
          try {
            if (fs.existsSync(file)) candidates.add(file);
          } catch {
            // ignore
          }
        }
      }
    }
    for (const name of TokenTrackerHandler.CLI_BIN_NAMES) {
      for (const ext of extensions) {
        candidates.add(name + ext);
      }
    }
    return [...candidates];
  }

  private probeCliVersion(bin: string): string | null {
    try {
      const command = process.platform === 'win32' ? path.basename(bin) : bin;
      const result = cp.spawnSync(command, ['--version'], {
        encoding: 'utf8',
        timeout: 10_000,
        env: this.childEnv(bin),
        shell: process.platform === 'win32',
      });
      if (result.status === 0 && result.stdout?.trim()) {
        return result.stdout.split('\n')[0]?.trim() || 'unknown';
      }
    } catch {
      // probe failed
    }
    return null;
  }

  private childEnv(commandBin?: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    const dirs: string[] = [];
    const nodePath = NodeDetector.find(this.context.extensionContext);
    if (nodePath) dirs.push(path.dirname(nodePath));
    if (commandBin) dirs.push(path.dirname(commandBin));
    if (dirs.length) {
      const key = process.platform === 'win32' ? 'Path' : 'PATH';
      env[key] = `${dirs.join(path.delimiter)}${path.delimiter}${env[key] ?? ''}`;
    }
    return env;
  }

  private resolveNpmBin(): string {
    const nodePath = NodeDetector.find(this.context.extensionContext);
    if (nodePath) {
      const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const candidate = path.join(path.dirname(nodePath), npmName);
      if (fs.existsSync(candidate)) return candidate;
    }
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
  }

  /**
   * TokenTracker only needs @mongodb-js/zstd when Node cannot decode zstd
   * itself. Node 24 provides the native zstd API, so installing the native
   * addon on Windows is unnecessary and can fail when its GitHub prebuild
   * download times out (the fallback script requires bash).
   */
  private nodeSupportsNativeZstd(nodePath: string | undefined): boolean {
    const executable = nodePath || process.execPath;
    try {
      const result = cp.spawnSync(
        executable,
        ['-e', "const zlib = require('zlib'); process.exit(typeof zlib.zstdDecompressSync === 'function' ? 0 : 1)"],
        { timeout: 5_000, windowsHide: true },
      );
      return result.status === 0;
    } catch {
      return false;
    }
  }

  private formatInstallOutput(output: string): string {
    const normalized = output.replace(/\r/g, '').trim();
    if (!normalized) return 'npm returned no diagnostic output';
    // npm prints the useful `npm error` lines at the end after dependency
    // progress logs. Keep the message bounded for the webview error panel.
    const maxLength = 2_000;
    return normalized.length > maxLength
      ? `...${normalized.slice(-maxLength)}`
      : normalized;
  }

  private decodeProcessOutput(chunks: Buffer[]): string {
    const buffer = Buffer.concat(chunks);
    const utf8 = buffer.toString('utf8');
    if (!utf8.includes('\uFFFD')) return utf8;
    try {
      // cmd.exe commonly uses the system GBK code page on Chinese Windows.
      // Decode that byte stream only when UTF-8 decoding produced replacements.
      return new TextDecoder('gb18030').decode(buffer);
    } catch {
      return utf8;
    }
  }

  private async installCli(): Promise<Record<string, unknown>> {
    const npm = this.resolveNpmBin();
    const nodePath = NodeDetector.find(this.context.extensionContext);
    const args = ['install', '-g', TokenTrackerHandler.TT_CLI_PACKAGE];
    if (process.platform === 'win32' && this.nodeSupportsNativeZstd(nodePath)) {
      // Node 24+ has zlib.zstdDecompressSync, while zstd's Windows install
      // fallback invokes bash. Skipping lifecycle scripts avoids that fragile
      // native build without removing any runtime capability.
      args.push('--ignore-scripts');
    }
    await new Promise<void>((resolve, reject) => {
      const proc = cp.spawn(npm, args, {
        env: this.childEnv(npm),
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      const outputChunks: Buffer[] = [];
      const collectOutput = (chunk: Buffer | string) => {
        outputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      };
      proc.stdout?.on('data', collectOutput);
      proc.stderr?.on('data', collectOutput);
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error('tokentracker-cli install timed out after 180s'));
      }, 180_000);
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(
          `tokentracker-cli install failed with exit code ${code}: ${this.formatInstallOutput(
            this.decodeProcessOutput(outputChunks),
          )}`,
        ));
      });
      proc.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return { installed: true };
  }

  private async ensureServer(): Promise<Record<string, unknown>> {
    const previous = TokenTrackerHandler.ensureLock;
    let release!: () => void;
    TokenTrackerHandler.ensureLock = new Promise<void>((r) => { release = r; });
    await previous;
    try {
      const runningPort = await this.detectRunningServerPort();
      if (runningPort > 0) {
        return { running: true, port: runningPort };
      }
      const cli = this.detectCli();
      if (!cli.installed || !cli.binPath) {
        throw new Error('tokentracker_cli_not_installed');
      }
      const port = await this.findFreePort();
      if (port < 0) {
        throw new Error(
          `No free port for tokentracker server (${TokenTrackerHandler.TT_ENSURE_PORT_FIRST}-${TokenTrackerHandler.TT_ENSURE_PORT_LAST})`,
        );
      }
      this.spawnServer(cli.binPath, port);
      await this.awaitServerReady(port);
      TokenTrackerHandler.rememberedPort = port;
      return { running: true, port };
    } finally {
      release();
    }
  }

  private async detectRunningServerPort(): Promise<number> {
    if (TokenTrackerHandler.rememberedPort > 0
      && await this.probeServerOnPort(TokenTrackerHandler.rememberedPort)) {
      return TokenTrackerHandler.rememberedPort;
    }
    for (let port = TokenTrackerHandler.TT_STATUS_SCAN_FIRST; port <= TokenTrackerHandler.TT_STATUS_SCAN_LAST; port += 1) {
      if (await this.probeServerOnPort(port)) {
        TokenTrackerHandler.rememberedPort = port;
        return port;
      }
    }
    return -1;
  }

  private probeServerOnPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: TokenTrackerHandler.TT_USER_STATUS_PATH,
          timeout: 2000,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  private findFreePort(): Promise<number> {
    const tryPort = (port: number): Promise<number> => new Promise((resolve) => {
      if (port > TokenTrackerHandler.TT_ENSURE_PORT_LAST) {
        resolve(-1);
        return;
      }
      const server = net.createServer();
      server.unref();
      server.on('error', () => {
        void tryPort(port + 1).then(resolve);
      });
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(port));
      });
    });
    return tryPort(TokenTrackerHandler.TT_ENSURE_PORT_FIRST);
  }

  private spawnServer(bin: string, port: number): void {
    const command = process.platform === 'win32' ? path.basename(bin) : bin;
    const child = cp.spawn(command, ['serve', '--no-open', '--port', String(port)], {
      env: { ...this.childEnv(bin), TOKENTRACKER_NO_TELEMETRY: '1' },
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    child.unref();
    this.context.log.appendLine(`[TokenTracker] Started tokentracker server on port ${port}`);
  }

  private async awaitServerReady(port: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await this.probeServerOnPort(port)) return;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`tokentracker server did not become ready on port ${port} within 30s`);
  }

  private async proxy(content: string): Promise<Record<string, unknown>> {
    let payload: {
      method?: string;
      path?: string;
      body?: string;
      headers?: Record<string, string>;
    };
    try {
      payload = JSON.parse(content);
    } catch {
      throw new Error('tokentracker proxy: invalid request payload');
    }
    const method = (payload.method || 'GET').trim().toUpperCase();
    const reqPath = payload.path || '';
    const pathOnly = reqPath.split('?')[0] || '';
    if (!(pathOnly.startsWith('/functions/tokentracker-') || pathOnly === '/api/local-auth')) {
      throw new Error(`tokentracker proxy path not allowed: ${reqPath}`);
    }
    if (method !== 'GET' && method !== 'POST') {
      throw new Error(`tokentracker proxy method not allowed: ${method}`);
    }
    const port = TokenTrackerHandler.rememberedPort > 0
      ? TokenTrackerHandler.rememberedPort
      : TokenTrackerHandler.TT_DEFAULT_PORT;

    const bodyText = await new Promise<string>((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (payload.headers && typeof payload.headers === 'object') {
        for (const [name, value] of Object.entries(payload.headers)) {
          const lower = name.toLowerCase();
          if (['host', 'content-length', 'connection', 'expect', 'upgrade'].includes(lower)) continue;
          if (typeof value === 'string') headers[name] = value;
        }
      }
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: reqPath,
          method,
          headers,
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`tokentracker server returned HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
              return;
            }
            resolve(text);
          });
        },
      );
      req.on('error', (error) => reject(new Error(`tokentracker server unreachable: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('tokentracker proxy timed out'));
      });
      if (method === 'POST') {
        req.write(payload.body ?? '');
      }
      req.end();
    });

    return { body: bodyText };
  }
}
