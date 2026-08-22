import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Builds a path under `~/.codemoss/`, matching the shared config directory jetbrains-cc-gui also reads/writes. */
export function codemossConfigPath(...segments: string[]): string {
  return path.join(os.homedir(), '.codemoss', ...segments);
}

export function readCodemossConfigFile<T extends Record<string, any>>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : fallback;
  } catch {
    return fallback;
  }
}

export function writeCodemossConfigFile(filePath: string, config: Record<string, any>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on platforms that ignore mode.
  }
}
