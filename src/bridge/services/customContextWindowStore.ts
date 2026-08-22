import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT_KEY = 'customModelContextWindows';
const CODEX_PROVIDER = 'codex';
const TOKENS_PER_K = 1_000;

type ProviderWindows = Record<string, number>;
type RootWindows = Record<string, ProviderWindows>;

function getConfigPath(): string {
  return path.join(os.homedir(), '.codemoss', 'config.json');
}

function readRoot(): RootWindows {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return {};
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const node = raw?.[ROOT_KEY];
    if (!node || typeof node !== 'object') return {};
    const out: RootWindows = {};
    for (const [provider, models] of Object.entries(node as Record<string, unknown>)) {
      if (!models || typeof models !== 'object') continue;
      const map: ProviderWindows = {};
      for (const [modelId, value] of Object.entries(models as Record<string, unknown>)) {
        const tokens = normalizeTokens(value);
        if (tokens !== undefined) map[modelId] = tokens;
      }
      if (Object.keys(map).length > 0) out[provider] = map;
    }
    return out;
  } catch {
    return {};
  }
}

function writeRoot(root: RootWindows): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  let config: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
    }
  } catch {
    config = {};
  }
  config[ROOT_KEY] = root;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function normalizeTokens(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(num) || num < TOKENS_PER_K || num % TOKENS_PER_K !== 0) {
    return undefined;
  }
  if (num > 2_147_483_647) return undefined;
  return num;
}

/**
 * Look up user-configured Codex context window (tokens) for a model.
 */
export function getCustomContextWindow(provider: string, modelId: string): number | undefined {
  if (!provider || !modelId) return undefined;
  const normalized = provider.trim().toLowerCase();
  if (normalized !== CODEX_PROVIDER) return undefined;
  const root = readRoot();
  return root[CODEX_PROVIDER]?.[modelId.trim()];
}

/**
 * Replace Codex custom context windows map.
 * Payload: { modelId: tokens }
 */
export function setCustomContextWindows(provider: string, windows: Record<string, number>): void {
  const normalized = provider.trim().toLowerCase();
  if (normalized !== CODEX_PROVIDER) return;
  const root = readRoot();
  const cleaned: ProviderWindows = {};
  for (const [modelId, value] of Object.entries(windows || {})) {
    const tokens = normalizeTokens(value);
    if (tokens !== undefined && modelId.trim()) {
      cleaned[modelId.trim()] = tokens;
    }
  }
  if (Object.keys(cleaned).length === 0) {
    delete root[CODEX_PROVIDER];
  } else {
    root[CODEX_PROVIDER] = cleaned;
  }
  writeRoot(root);
}
