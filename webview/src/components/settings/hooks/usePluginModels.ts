import { useState, useCallback, useEffect } from 'react';
import type { CodexCustomModel, ModelPricing } from '../../../types/provider';
import { isValidModelPricing, STORAGE_KEYS, validateCodexCustomModels } from '../../../types/provider';
import { sendBridgeEvent } from '../../../utils/bridge';

const STORAGE_KEY_TO_PROVIDER: Partial<Record<string, 'claude' | 'codex'>> = {
  [STORAGE_KEYS.CLAUDE_CUSTOM_MODELS]: 'claude',
  [STORAGE_KEYS.CODEX_CUSTOM_MODELS]: 'codex',
};

/**
 * Read plugin-level custom models from localStorage
 */
function readPluginModels(storageKey: string): CodexCustomModel[] {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return validateCodexCustomModels(parsed);
  } catch {
    return [];
  }
}

/**
 * Write plugin-level custom models to localStorage and notify listeners
 */
function writePluginModels(storageKey: string, models: CodexCustomModel[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(models));
    window.dispatchEvent(new CustomEvent('localStorageChange', { detail: { key: storageKey } }));
  } catch {
    // localStorage write failure (e.g. quota exceeded)
  }
}

function readConfiguredClaudePricingModels(): CodexCustomModel[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.CLAUDE_CONFIGURED_MODEL_PRICING);
    if (!stored) {
      return [];
    }
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [];
    }
    return Object.entries(parsed as Record<string, unknown>)
      .filter(([id, pricing]) => id.trim() && isValidModelPricing(pricing))
      .map(([id, pricing]) => ({
        id: normalizeComparableModelId(id.trim()),
        label: normalizeComparableModelId(id.trim()),
        pricing: pricing as ModelPricing,
      }))
      .filter(model => model.id);
  } catch {
    return [];
  }
}

function normalizeComparableModelId(modelId: string): string {
  return modelId.trim().replace(/\[1m\]$/i, '');
}

/**
 * Mirror custom model pricing into the Java config file used by usage aggregators.
 * The complete model list is sent because deleting a model or clearing all pricing
 * must replace the provider's persisted pricing map, not merge with stale entries.
 */
function syncCustomModelPricing(storageKey: string, models: CodexCustomModel[]) {
  const provider = STORAGE_KEY_TO_PROVIDER[storageKey];
  if (!provider) {
    return;
  }

  const syncModels = provider === 'claude'
    ? [
      ...models,
      ...readConfiguredClaudePricingModels(),
    ]
    : models;

  sendBridgeEvent('set_custom_model_pricing', JSON.stringify({
    provider,
    models: syncModels,
  }));
}

/** Custom event detail shape for localStorageChange */
interface LocalStorageChangeDetail {
  key: string;
}

/**
 * Hook to manage plugin-level custom models with localStorage persistence.
 * Listens for both native StorageEvent (cross-tab) and custom localStorageChange (same-tab) events.
 */
export function usePluginModels(storageKey: string) {
  const [models, setModels] = useState<CodexCustomModel[]>(() => readPluginModels(storageKey));

  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === storageKey) {
        setModels(readPluginModels(storageKey));
      }
    };
    const handleCustomChange = (e: Event) => {
      const detail = (e as CustomEvent<LocalStorageChangeDetail>).detail;
      if (detail?.key === storageKey) {
        setModels(readPluginModels(storageKey));
      }
    };
    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('localStorageChange', handleCustomChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('localStorageChange', handleCustomChange);
    };
  }, [storageKey]);

  const updateModels = useCallback((newModels: CodexCustomModel[]) => {
    const validModels = validateCodexCustomModels(newModels);
    setModels(validModels);
    writePluginModels(storageKey, validModels);
    syncCustomModelPricing(storageKey, validModels);
  }, [storageKey]);

  return { models, updateModels };
}
