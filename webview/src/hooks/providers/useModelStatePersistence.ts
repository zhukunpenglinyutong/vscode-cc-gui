import { useEffect } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  GROK_DEFAULT_MODEL_ID,
  KIMI_DEFAULT_MODEL_ID,
  OPENCODE_DEFAULT_MODEL_ID,
  PI_DEFAULT_MODEL_ID,
  isValidPermissionMode,
  normalizeClaudeModelId,
  apply1MContextSuffix,
  strip1MContextSuffix,
} from '../../components/ChatInputBox/types';
import type { CodexFastMode, PermissionMode, ReasoningEffort } from '../../components/ChatInputBox/types';
import { isCliOnlyProvider, normalizeCliPermissionMode } from './cliProviders';

const STORAGE_KEY = 'model-selection-state';
const REASONING_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CODEX_FAST_MODE_VALUES = ['normal', 'fast'] as const;

const getCustomModels = (key: string): { id: string }[] => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && (REASONING_VALUES as readonly string[]).includes(value);

const isCodexFastMode = (value: unknown): value is CodexFastMode =>
  typeof value === 'string' && (CODEX_FAST_MODE_VALUES as readonly string[]).includes(value);

export interface UseModelStatePersistenceOptions {
  setCurrentProvider: (value: string) => void;
  setSelectedClaudeModel: (value: string) => void;
  setSelectedCodexModel: (value: string) => void;
  setClaudePermissionMode: (value: PermissionMode) => void;
  setCodexPermissionMode: (value: PermissionMode) => void;
  setSelectedGrokModel: (value: string) => void;
  setSelectedKimiModel: (value: string) => void;
  setSelectedOpenCodeModel: (value: string) => void;
  setSelectedPiModel: (value: string) => void;
  setGrokPermissionMode: (value: PermissionMode) => void;
  setKimiPermissionMode: (value: PermissionMode) => void;
  setOpenCodePermissionMode: (value: PermissionMode) => void;
  setPiPermissionMode: (value: PermissionMode) => void;
  setPermissionMode: (value: PermissionMode) => void;
  setLongContextEnabled: (value: boolean) => void;
  setReasoningEffort: (value: ReasoningEffort) => void;
  setCodexFastMode: (value: CodexFastMode) => void;
  currentProvider: string;
  selectedClaudeModel: string;
  selectedCodexModel: string;
  claudePermissionMode: PermissionMode;
  codexPermissionMode: PermissionMode;
  selectedGrokModel: string;
  selectedKimiModel: string;
  selectedOpenCodeModel: string;
  selectedPiModel: string;
  grokPermissionMode: PermissionMode;
  kimiPermissionMode: PermissionMode;
  openCodePermissionMode: PermissionMode;
  piPermissionMode: PermissionMode;
  longContextEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  codexFastMode: CodexFastMode;
}

/**
 * Persist provider/model/permission state across reloads (including CLI providers).
 */
export function useModelStatePersistence(options: UseModelStatePersistenceOptions) {
  const {
    setCurrentProvider,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setClaudePermissionMode,
    setCodexPermissionMode,
    setSelectedGrokModel,
    setSelectedKimiModel,
    setSelectedOpenCodeModel,
    setSelectedPiModel,
    setGrokPermissionMode,
    setKimiPermissionMode,
    setOpenCodePermissionMode,
    setPiPermissionMode,
    setPermissionMode,
    setLongContextEnabled,
    setReasoningEffort,
    setCodexFastMode,
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    claudePermissionMode,
    codexPermissionMode,
    selectedGrokModel,
    selectedKimiModel,
    selectedOpenCodeModel,
    selectedPiModel,
    grokPermissionMode,
    kimiPermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    longContextEnabled,
    reasoningEffort,
    codexFastMode,
  } = options;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      let restoredProvider = 'claude';
      let restoredClaudeModel = CLAUDE_MODELS[0].id;
      let restoredCodexModel = CODEX_MODELS[0].id;
      let restoredClaudePermissionMode: PermissionMode = 'bypassPermissions';
      let restoredCodexPermissionMode: PermissionMode = 'default';
      let restoredGrokModel = GROK_DEFAULT_MODEL_ID;
      let restoredKimiModel = KIMI_DEFAULT_MODEL_ID;
      let restoredOpenCodeModel = OPENCODE_DEFAULT_MODEL_ID;
      let restoredPiModel = PI_DEFAULT_MODEL_ID;
      let restoredGrokPermissionMode: PermissionMode = 'default';
      let restoredKimiPermissionMode: PermissionMode = 'default';
      let restoredOpenCodePermissionMode: PermissionMode = 'default';
      let restoredPiPermissionMode: PermissionMode = 'default';
      let restoredLongContextEnabled = true;
      let restoredCodexFastMode: CodexFastMode = 'normal';

      if (saved) {
        const state = JSON.parse(saved);

        if (
          state.provider === 'claude'
          || state.provider === 'codex'
          || isCliOnlyProvider(state.provider)
        ) {
          restoredProvider = state.provider;
          setCurrentProvider(state.provider);
        }

        if (isValidPermissionMode(state.claudePermissionMode)) {
          restoredClaudePermissionMode = state.claudePermissionMode;
        }
        if (isValidPermissionMode(state.codexPermissionMode)) {
          restoredCodexPermissionMode = state.codexPermissionMode === 'plan'
            ? 'default'
            : state.codexPermissionMode;
        }
        if (isValidPermissionMode(state.grokPermissionMode)) {
          restoredGrokPermissionMode = normalizeCliPermissionMode(state.grokPermissionMode);
        }
        if (isValidPermissionMode(state.kimiPermissionMode)) {
          restoredKimiPermissionMode = normalizeCliPermissionMode(state.kimiPermissionMode);
        }
        if (isValidPermissionMode(state.openCodePermissionMode)) {
          restoredOpenCodePermissionMode = normalizeCliPermissionMode(state.openCodePermissionMode);
        }
        if (isValidPermissionMode(state.piPermissionMode)) {
          restoredPiPermissionMode = normalizeCliPermissionMode(state.piPermissionMode);
        }

        if (typeof state.longContextEnabled === 'boolean') {
          restoredLongContextEnabled = state.longContextEnabled;
          setLongContextEnabled(state.longContextEnabled);
        }

        if (isReasoningEffort(state.reasoningEffort)) {
          setReasoningEffort(state.reasoningEffort);
        }
        if (isCodexFastMode(state.codexFastMode)) {
          restoredCodexFastMode = state.codexFastMode;
          setCodexFastMode(restoredCodexFastMode);
        }

        const savedClaudeCustomModels = getCustomModels('claude-custom-models');
        const strippedClaudeModel = strip1MContextSuffix(state.claudeModel);
        const normalizedClaudeModel = normalizeClaudeModelId(strippedClaudeModel);
        if (
          CLAUDE_MODELS.find(m => m.id === normalizedClaudeModel) ||
          savedClaudeCustomModels.find(m => m.id === normalizedClaudeModel)
        ) {
          restoredClaudeModel = normalizedClaudeModel;
          setSelectedClaudeModel(normalizedClaudeModel);
        }

        const savedCodexCustomModels = getCustomModels('codex-custom-models');
        if (
          CODEX_MODELS.find(m => m.id === state.codexModel) ||
          savedCodexCustomModels.find(m => m.id === state.codexModel)
        ) {
          restoredCodexModel = state.codexModel;
          setSelectedCodexModel(state.codexModel);
        }

        // CLI catalogs are dynamic — accept any non-empty saved id.
        if (typeof state.grokModel === 'string' && state.grokModel.trim()) {
          restoredGrokModel = state.grokModel;
          setSelectedGrokModel(state.grokModel);
        }
        if (typeof state.kimiModel === 'string' && state.kimiModel.trim()) {
          restoredKimiModel = state.kimiModel;
          setSelectedKimiModel(state.kimiModel);
        }
        if (typeof state.openCodeModel === 'string' && state.openCodeModel.trim()) {
          restoredOpenCodeModel = state.openCodeModel;
          setSelectedOpenCodeModel(state.openCodeModel);
        }
        if (typeof state.piModel === 'string' && state.piModel.trim()) {
          restoredPiModel = state.piModel;
          setSelectedPiModel(state.piModel);
        }
      }

      setClaudePermissionMode(restoredClaudePermissionMode);
      setCodexPermissionMode(restoredCodexPermissionMode);
      setGrokPermissionMode(restoredGrokPermissionMode);
      setKimiPermissionMode(restoredKimiPermissionMode);
      setOpenCodePermissionMode(restoredOpenCodePermissionMode);
      setPiPermissionMode(restoredPiPermissionMode);

      let initialPermissionMode: PermissionMode = restoredClaudePermissionMode;
      if (restoredProvider === 'codex') initialPermissionMode = restoredCodexPermissionMode;
      else if (restoredProvider === 'grok') initialPermissionMode = restoredGrokPermissionMode;
      else if (restoredProvider === 'kimi') initialPermissionMode = restoredKimiPermissionMode;
      else if (restoredProvider === 'opencode') initialPermissionMode = restoredOpenCodePermissionMode;
      else if (restoredProvider === 'pi') initialPermissionMode = restoredPiPermissionMode;
      setPermissionMode(initialPermissionMode);

      let syncRetryCount = 0;
      const MAX_SYNC_RETRIES = 30;

      const syncToBackend = () => {
        if (window.sendToJava) {
          sendBridgeEvent('set_provider', restoredProvider);
          let modelToSync = apply1MContextSuffix(restoredClaudeModel, restoredLongContextEnabled);
          if (restoredProvider === 'codex') modelToSync = restoredCodexModel;
          else if (restoredProvider === 'grok') modelToSync = restoredGrokModel;
          else if (restoredProvider === 'kimi') modelToSync = restoredKimiModel;
          else if (restoredProvider === 'opencode') modelToSync = restoredOpenCodeModel;
          else if (restoredProvider === 'pi') modelToSync = restoredPiModel;
          sendBridgeEvent('set_model', modelToSync);
          sendBridgeEvent('set_mode', initialPermissionMode);
          sendBridgeEvent('set_codex_fast_mode', restoredCodexFastMode);
        } else {
          syncRetryCount++;
          if (syncRetryCount < MAX_SYNC_RETRIES) {
            setTimeout(syncToBackend, 100);
          }
        }
      };
      setTimeout(syncToBackend, 200);
    } catch {
      // Failed to load model selection state — fall back to defaults.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        provider: currentProvider,
        claudeModel: selectedClaudeModel,
        codexModel: selectedCodexModel,
        claudePermissionMode,
        codexPermissionMode,
        grokModel: selectedGrokModel,
        kimiModel: selectedKimiModel,
        openCodeModel: selectedOpenCodeModel,
        piModel: selectedPiModel,
        grokPermissionMode,
        kimiPermissionMode,
        openCodePermissionMode,
        piPermissionMode,
        longContextEnabled,
        reasoningEffort,
        codexFastMode,
      }));
    } catch {
      // Failed to save model selection state — non-fatal.
    }
  }, [
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    claudePermissionMode,
    codexPermissionMode,
    selectedGrokModel,
    selectedKimiModel,
    selectedOpenCodeModel,
    selectedPiModel,
    grokPermissionMode,
    kimiPermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    longContextEnabled,
    reasoningEffort,
    codexFastMode,
  ]);
}
