import { useCallback, useEffect, useRef, useState } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import type { ModelInfo } from '../../components/ChatInputBox/types';
import { KIMI_MODELS, OPENCODE_MODELS, PI_MODELS } from '../../components/ChatInputBox/types';
import { isCliOnlyProvider } from './cliProviders';

type CliModelsByProvider = Record<string, ModelInfo[]>;

/** Java may never answer get_cli_models — don't leave the spinner on forever. */
const CLI_MODELS_TIMEOUT_MS = 15_000;

function fallbackModels(providerId: string): ModelInfo[] {
  if (providerId === 'kimi') return KIMI_MODELS;
  if (providerId === 'opencode') return OPENCODE_MODELS;
  if (providerId === 'pi') return PI_MODELS;
  return [];
}

function normalizeModels(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof row.label === 'string' && row.label.trim()
      ? row.label.trim()
      : id;
    const description = typeof row.description === 'string' ? row.description : undefined;
    out.push({ id, label, description });
  }
  return out;
}

/**
 * Loads model catalogs for headless CLI providers (Kimi / OpenCode) via
 * channel-manager `listModels`. Falls back to static defaults until loaded.
 */
export function useCliModels(currentProvider: string) {
  const [modelsByProvider, setModelsByProvider] = useState<CliModelsByProvider>({});
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [errorByProvider, setErrorByProvider] = useState<Record<string, string>>({});
  const pendingLoadRef = useRef<{ provider: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  const clearPendingLoad = useCallback(() => {
    if (pendingLoadRef.current) {
      clearTimeout(pendingLoadRef.current.timer);
      pendingLoadRef.current = null;
    }
  }, []);

  const beginLoad = useCallback((providerId: string) => {
    clearPendingLoad();
    setLoadingProvider(providerId);
    setErrorByProvider((prev) => {
      if (!(providerId in prev)) return prev;
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
    sendBridgeEvent('get_cli_models', providerId);
    pendingLoadRef.current = {
      provider: providerId,
      timer: setTimeout(() => {
        pendingLoadRef.current = null;
        // No response arrived in time — fall back to the static catalog and
        // surface the failure so the user isn't staring at a bare fallback list.
        setLoadingProvider((current) => (current === providerId ? null : current));
        setErrorByProvider((prev) => ({ ...prev, [providerId]: 'timeout' }));
      }, CLI_MODELS_TIMEOUT_MS),
    };
  }, [clearPendingLoad]);

  useEffect(() => {
    const handler = (dataOrStr: string | { provider?: string; models?: unknown; success?: boolean; error?: string }) => {
      let payload: { provider?: string; models?: unknown; success?: boolean; error?: string } | null = null;
      if (typeof dataOrStr === 'string') {
        try {
          payload = JSON.parse(dataOrStr);
        } catch {
          return;
        }
      } else if (dataOrStr && typeof dataOrStr === 'object') {
        payload = dataOrStr;
      }
      if (!payload?.provider) return;
      const provider = payload.provider;
      const models = normalizeModels(payload.models);
      setModelsByProvider((prev) => ({
        ...prev,
        [provider]: models.length > 0 ? models : fallbackModels(provider),
      }));
      if (payload.success === false) {
        // Backend reported a failure (CLI missing, non-zero exit, …) — keep the
        // fallback list but remember the error so the dropdown can show it.
        const message = typeof payload.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : 'unknown error';
        setErrorByProvider((prev) => ({ ...prev, [provider]: message }));
      } else {
        setErrorByProvider((prev) => {
          if (!(provider in prev)) return prev;
          const next = { ...prev };
          delete next[provider];
          return next;
        });
      }
      if (pendingLoadRef.current?.provider === provider) {
        clearPendingLoad();
      }
      setLoadingProvider((current) => (current === provider ? null : current));
    };

    window.setCliModels = handler;
    return () => {
      if (window.setCliModels === handler) {
        delete window.setCliModels;
      }
      clearPendingLoad();
    };
  }, [clearPendingLoad]);

  useEffect(() => {
    if (!isCliOnlyProvider(currentProvider)) return;
    if (currentProvider === 'grok') return; // Grok uses static profile list for now
    if (modelsByProvider[currentProvider]?.length) return;

    beginLoad(currentProvider);
  }, [currentProvider, modelsByProvider, beginLoad]);

  const refreshCliModels = useCallback((providerId: string) => {
    if (!isCliOnlyProvider(providerId) || providerId === 'grok') return;
    beginLoad(providerId);
  }, [beginLoad]);

  const cliModels = modelsByProvider[currentProvider]?.length
    ? modelsByProvider[currentProvider]
    : fallbackModels(currentProvider);

  return {
    cliModels,
    cliModelsLoading: loadingProvider === currentProvider,
    cliModelsError: errorByProvider[currentProvider] ?? null,
    refreshCliModels,
    modelsByProvider,
  };
}

export type UseCliModelsReturn = ReturnType<typeof useCliModels>;
