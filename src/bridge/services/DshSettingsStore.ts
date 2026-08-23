import {
  codemossConfigPath,
  readCodemossConfigFile,
  writeCodemossConfigFile,
} from './codemossJsonStore.ts';

/**
 * DSH connection settings, persisted in the `dsh` section of
 * ~/.codemoss/config.json — the same file and section the JetBrains plugin's
 * CodemossSettingsService uses, so both IDEs share one configuration.
 *
 * Only bin / host / port / autoStart live here. Provider keys and the model
 * catalog stay in the DSH Web UI ($DSH_HOME) — the extension never writes them.
 */

export const DSH_DEFAULT_HOST = '127.0.0.1';
export const DSH_DEFAULT_PORT = 3080;

const DSH_SECTION_KEY = 'dsh';

export interface DshSettings {
  /** Custom dsh binary path ('' = PATH / well-known locations lookup). */
  bin: string;
  host: string;
  port: number;
  autoStart: boolean;
}

function readDshSection(): Record<string, any> {
  const config = readCodemossConfigFile<Record<string, any>>(codemossConfigPath('config.json'), {});
  const section = config[DSH_SECTION_KEY];
  return section && typeof section === 'object' && !Array.isArray(section) ? section : {};
}

export function getDshSettings(): DshSettings {
  const section = readDshSection();
  const host = typeof section.host === 'string' && section.host.trim() ? section.host.trim() : DSH_DEFAULT_HOST;
  const rawPort = Number(section.port);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : DSH_DEFAULT_PORT;
  return {
    bin: typeof section.bin === 'string' ? section.bin.trim() : '',
    host,
    port,
    autoStart: section.autoStart !== false,
  };
}

/**
 * Persist a partial update. Every field is validated by the caller before
 * this runs — the section is written in one pass so a failure never leaves it
 * half-written. Empty bin/host clear the override (defaults apply), matching
 * the JetBrains settings service.
 */
export function saveDshSettings(update: {
  bin?: string;
  host?: string;
  port?: number;
  autoStart?: boolean;
}): DshSettings {
  const configPath = codemossConfigPath('config.json');
  const config = readCodemossConfigFile<Record<string, any>>(configPath, {});
  const section = readDshSection();

  if (update.bin !== undefined) {
    const value = update.bin.trim();
    if (value) section.bin = value;
    else delete section.bin;
  }
  if (update.host !== undefined) {
    const value = update.host.trim();
    if (value) section.host = value;
    else delete section.host;
  }
  if (update.port !== undefined) {
    section.port = update.port;
  }
  if (update.autoStart !== undefined) {
    section.autoStart = update.autoStart;
  }

  config[DSH_SECTION_KEY] = section;
  writeCodemossConfigFile(configPath, config);
  return getDshSettings();
}

/**
 * Validate a DSH host value: host name or IP only — no whitespace, scheme or
 * port (`:`), and no path separators. Empty clears the override (the default
 * host applies). Returns an error message when invalid, null when acceptable.
 */
export function validateDshHost(host: string): string | null {
  if (!host) {
    return null;
  }
  for (const c of host) {
    if (/\s/.test(c) || c === '/' || c === '\\' || c === ':') {
      return `Invalid DSH host (host name or IP only, no scheme or port): ${host}`;
    }
  }
  return null;
}

/**
 * Validate a DSH bin path: reject control characters/newlines and, when the
 * path exists, anything that is not a regular file. Empty clears the override
 * (PATH lookup applies). Returns an error message when invalid, null when OK.
 */
export function validateDshBin(bin: string, exists?: (p: string) => { isFile(): boolean } | null): string | null {
  if (!bin) {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(bin)) {
    return 'Invalid DSH bin path (contains control characters)';
  }
  if (exists) {
    const stat = exists(bin);
    if (stat && !stat.isFile()) {
      return `Invalid DSH bin path (not a regular file): ${bin}`;
    }
  }
  return null;
}
