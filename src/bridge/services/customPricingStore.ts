import * as fs from 'fs';
import { codemossConfigPath } from './codemossJsonStore';

/** Per-million-token pricing for a model. Every field is optional; a missing field falls back to the default rate. */
export interface ModelPricing {
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  cacheWriteCostPer1M?: number;
  cacheReadCostPer1M?: number;
}

const CONFIG_FILE = codemossConfigPath('config.json');
const ROOT_KEY = 'customModelPricing';
const PROVIDERS = ['claude', 'codex'] as const;
const PRICE_FIELDS: (keyof ModelPricing)[] = [
  'inputCostPer1M',
  'outputCostPer1M',
  'cacheWriteCostPer1M',
  'cacheReadCostPer1M',
];

type ProviderPricing = Record<string, ModelPricing>;

function readPrice(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function parsePricing(raw: unknown): ModelPricing | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const pricing = PRICE_FIELDS.reduce<ModelPricing>((acc, field) => {
    const value = readPrice(obj[field]);
    return value === undefined ? acc : { ...acc, [field]: value };
  }, {});
  return PRICE_FIELDS.some((field) => pricing[field] !== undefined) ? pricing : undefined;
}

function readConfig(): Record<string, any> {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Persist the pricing map for one provider family, replacing the whole provider entry.
 * An empty map clears the provider so cost calculation falls back to the default table.
 * Other keys in `config.json` are preserved (read-modify-write).
 */
export function setCustomModelPricing(provider: string, pricing: ProviderPricing): void {
  if (provider !== 'claude' && provider !== 'codex') {
    return;
  }
  const config = readConfig();
  const root: Record<string, ProviderPricing> =
    config[ROOT_KEY] && typeof config[ROOT_KEY] === 'object' ? config[ROOT_KEY] : {};

  const entries = Object.entries(pricing).filter(([, value]) => parsePricing(value));
  if (entries.length === 0) {
    delete root[provider];
  } else {
    root[provider] = entries.reduce<ProviderPricing>((acc, [id, value]) => {
      const parsed = parsePricing(value);
      return parsed ? { ...acc, [id.trim()]: parsed } : acc;
    }, {});
  }

  if (Object.keys(root).length === 0) {
    delete config[ROOT_KEY];
  } else {
    config[ROOT_KEY] = root;
  }

  fs.mkdirSync(codemossConfigPath(), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  cache = null;
}

interface CachedPricing {
  mtime: number;
  byProvider: Record<string, ProviderPricing>;
}

let cache: CachedPricing | null = null;

function readMtime(): number {
  try {
    return fs.statSync(CONFIG_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function loadPricing(): Record<string, ProviderPricing> {
  const config = readConfig();
  const root = config[ROOT_KEY];
  if (!root || typeof root !== 'object') {
    return {};
  }
  return PROVIDERS.reduce<Record<string, ProviderPricing>>((acc, provider) => {
    const providerNode = (root as Record<string, unknown>)[provider];
    if (!providerNode || typeof providerNode !== 'object') {
      return acc;
    }
    const modelMap = Object.entries(providerNode as Record<string, unknown>).reduce<ProviderPricing>(
      (models, [modelId, value]) => {
        const parsed = parsePricing(value);
        return parsed ? { ...models, [modelId.trim()]: parsed } : models;
      },
      {},
    );
    return Object.keys(modelMap).length > 0 ? { ...acc, [provider]: modelMap } : acc;
  }, {});
}

function getCached(): Record<string, ProviderPricing> {
  const mtime = readMtime();
  if (cache && cache.mtime === mtime) {
    return cache.byProvider;
  }
  const byProvider = loadPricing();
  cache = { mtime, byProvider };
  return byProvider;
}

function stripContextSuffix(modelId: string): string {
  return modelId.replace(/\[1m\]$/i, '');
}

/**
 * Look up user-configured pricing for a model across both provider families (claude first).
 * Handles the "[1m]" long-context suffix the webview can append to Claude model IDs.
 */
export function getCustomModelPricing(model: string): ModelPricing | undefined {
  if (!model || !model.trim()) {
    return undefined;
  }
  const byProvider = getCached();
  const trimmed = model.trim();
  const base = stripContextSuffix(trimmed);
  for (const provider of PROVIDERS) {
    const map = byProvider[provider];
    if (!map) {
      continue;
    }
    if (map[trimmed]) {
      return map[trimmed];
    }
    if (base !== trimmed && map[base]) {
      return map[base];
    }
  }
  return undefined;
}
