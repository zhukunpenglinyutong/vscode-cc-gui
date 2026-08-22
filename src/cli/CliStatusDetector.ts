import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CLI_TOOL_DEFINITIONS,
  type CliToolDefinition,
  type CliToolId,
  type CliToolStatus,
} from './cliTools';

const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 30_000;
const VERSION_TOKEN = /(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.]+)?)/;

interface ProbeResult {
  ok: boolean;
  version?: string;
  resolvedPath?: string;
}

interface CachedDetection {
  result: Record<string, CliToolStatus>;
  timestampMillis: number;
}

let detectAllCache: CachedDetection | null = null;

/**
 * Detects whether headless CLI tools are installed and probes their versions.
 * Path resolution mirrors ai-bridge/utils/cli-path.js.
 */
export class CliStatusDetector {
  static detectAll(force = false): Record<string, CliToolStatus> {
    const now = Date.now();
    if (!force && detectAllCache && now - detectAllCache.timestampMillis < CACHE_TTL_MS) {
      return detectAllCache.result;
    }

    const result: Record<string, CliToolStatus> = {};
    for (const tool of CLI_TOOL_DEFINITIONS) {
      result[tool.id] = this.detect(tool);
    }
    detectAllCache = { result, timestampMillis: Date.now() };
    return result;
  }

  static detect(tool: CliToolDefinition): CliToolStatus {
    try {
      for (const candidate of this.candidatesFor(tool)) {
        const probe = this.probe(candidate);
        if (probe.ok) {
          return {
            id: tool.id,
            name: tool.displayName,
            binaryName: tool.binaryName,
            installed: true,
            version: probe.version,
            path: probe.resolvedPath ?? candidate,
          };
        }
      }
      return {
        id: tool.id,
        name: tool.displayName,
        binaryName: tool.binaryName,
        installed: false,
      };
    } catch (error) {
      return {
        id: tool.id,
        name: tool.displayName,
        binaryName: tool.binaryName,
        installed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private static candidatesFor(tool: CliToolDefinition): string[] {
    const candidates = new Set<string>();
    const binary = tool.binaryName;
    const extensions = process.platform === 'win32' ? ['.cmd', '.bat', '.exe', ''] : [''];
    const home = os.homedir();

    for (const envKey of tool.envKeys) {
      const value = process.env[envKey]?.trim();
      if (value) candidates.add(value);
    }

    for (const rel of tool.homeBinDirs) {
      for (const ext of extensions) {
        const full = path.join(home, rel, binary + ext);
        if (this.pathExists(full)) candidates.add(full);
      }
    }

    // Shared install locations
    const sharedDirs: string[] = [];
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      sharedDirs.push(path.join(appData, 'npm'));
    } else {
      sharedDirs.push(
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        path.join(home, '.npm-global', 'bin'),
        path.join(home, '.volta', 'bin'),
        path.join(home, '.cargo', 'bin'),
        path.join(home, '.local', 'bin'),
      );
    }
    for (const dir of sharedDirs) {
      for (const ext of extensions) {
        const full = path.join(dir, binary + ext);
        if (this.pathExists(full)) candidates.add(full);
      }
    }

    for (const ext of extensions) {
      candidates.add(binary + ext);
    }

    return Array.from(candidates);
  }

  private static probe(candidate: string): ProbeResult {
    for (const flag of ['--version', '-v']) {
      const result = this.run([candidate, flag]);
      if (result.exitCode === 0 && result.stdout?.trim()) {
        return {
          ok: true,
          version: this.extractVersion(result.stdout) ?? 'unknown',
          resolvedPath: this.resolveWhichLike(candidate) ?? candidate,
        };
      }
      if (result.combined?.trim() && result.exitCode === 0) {
        const version = this.extractVersion(result.combined);
        if (version && version !== 'unknown') {
          return {
            ok: true,
            version,
            resolvedPath: this.resolveWhichLike(candidate) ?? candidate,
          };
        }
      }
    }
    return { ok: false };
  }

  private static run(command: string[]): { exitCode: number; stdout: string; combined: string } {
    try {
      const [bin, ...args] = command;
      const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
      const stdout = cp.execFileSync(bin, args, {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell,
        env: process.env,
      });
      return {
        exitCode: 0,
        stdout: String(stdout ?? ''),
        combined: String(stdout ?? ''),
      };
    } catch (error: any) {
      const stdout = String(error?.stdout ?? '');
      const stderr = String(error?.stderr ?? '');
      return {
        exitCode: typeof error?.status === 'number' ? error.status : 1,
        stdout,
        combined: `${stdout}\n${stderr}`.trim(),
      };
    }
  }

  private static extractVersion(text: string): string | undefined {
    const match = String(text || '').match(VERSION_TOKEN);
    return match?.[1];
  }

  private static resolveWhichLike(candidate: string): string | null {
    if (path.isAbsolute(candidate) && this.pathExists(candidate)) {
      return candidate;
    }
    try {
      const lookup = process.platform === 'win32' ? `where ${candidate}` : `which ${candidate}`;
      const output = cp.execSync(lookup, {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env,
      });
      const first = String(output || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      return first || null;
    } catch {
      return null;
    }
  }

  private static pathExists(candidate: string): boolean {
    try {
      return !!candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }
}

export type { CliToolId };
