import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isAutoOpenFileGateEnabled,
  setAutoOpenFileGateEnabled,
} from '../../../utils/autoOpenFileGate';
import { registerUsageModeCallbacks } from './usageModeCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';

vi.mock('../../../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(() => true),
}));

import { sendBridgeEvent } from '../../../utils/bridge';

function createOptions(
  overrides?: Partial<UseWindowCallbacksOptions>,
): UseWindowCallbacksOptions {
  return {
    t: ((key: string) => key) as UseWindowCallbacksOptions['t'],
    addToast: vi.fn(),
    clearToasts: vi.fn(),
    setMessages: vi.fn(),
    setStatus: vi.fn(),
    setLoading: vi.fn(),
    setLoadingStartTime: vi.fn(),
    setIsThinking: vi.fn(),
    setStreamingActive: vi.fn(),
    setHistoryData: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setCustomSessionTitle: vi.fn(),
    setUsagePercentage: vi.fn(),
    setUsageUsedTokens: vi.fn(),
    setUsageMaxTokens: vi.fn(),
    setPermissionMode: vi.fn(),
    setClaudePermissionMode: vi.fn(),
    setCodexPermissionMode: vi.fn(),
    setSelectedClaudeModel: vi.fn(),
    setSelectedCodexModel: vi.fn(),
    setProviderConfigVersion: vi.fn(),
    setActiveProviderConfig: vi.fn(),
    setClaudeSettingsAlwaysThinkingEnabled: vi.fn(),
    setStreamingEnabledSetting: vi.fn(),
    setSendShortcut: vi.fn(),
    setAutoOpenFileEnabled: vi.fn(),
    setPermissionDialogTimeoutSeconds: vi.fn(),
    setStreamStallTimeoutSeconds: vi.fn(),
    setSdkStatus: vi.fn(),
    setSdkStatusLoaded: vi.fn(),
    setIsRewinding: vi.fn(),
    setRewindDialogOpen: vi.fn(),
    setCurrentRewindRequest: vi.fn(),
    setContextInfo: vi.fn(),
    setSelectedAgent: vi.fn(),
    currentProviderRef: { current: 'claude' },
    messagesContainerRef: { current: null },
    isUserAtBottomRef: { current: true },
    userPausedRef: { current: false },
    suppressNextStatusToastRef: { current: false },
    streamingContentRef: { current: '' },
    streamingThinkingRef: { current: '' },
    isStreamingRef: { current: false },
    useBackendStreamingRenderRef: { current: false },
    autoExpandedThinkingKeysRef: { current: new Set() },
    streamingMessageIndexRef: { current: -1 },
    streamingTurnIdRef: { current: -1 },
    turnIdCounterRef: { current: 0 },
    lastContentUpdateRef: { current: 0 },
    contentUpdateTimeoutRef: { current: null },
    lastThinkingUpdateRef: { current: 0 },
    thinkingUpdateTimeoutRef: { current: null },
    findLastAssistantIndex: () => -1,
    extractRawBlocks: () => [],
    getOrCreateStreamingAssistantIndex: () => 0,
    patchAssistantForStreaming: (msg) => msg,
    syncActiveProviderModelMapping: vi.fn(),
    openPermissionDialog: vi.fn(),
    openAskUserQuestionDialog: vi.fn(),
    openPlanApprovalDialog: vi.fn(),
    forceClosePermissionDialog: vi.fn(),
    forceCloseAskUserQuestionDialog: vi.fn(),
    forceClosePlanApprovalDialog: vi.fn(),
    openContextUsageDialog: vi.fn(),
    updateContextUsageData: vi.fn(),
    closeContextUsageDialog: vi.fn(),
    customSessionTitleRef: { current: null },
    currentSessionIdRef: { current: null },
    updateHistoryTitle: vi.fn(),
    applyHistoryTitleLocal: vi.fn(),
    ...overrides,
  };
}

describe('updateAutoOpenFileEnabled closes file selection', () => {
  beforeEach(() => {
    setAutoOpenFileGateEnabled(true);
    delete window.updateAutoOpenFileEnabled;
    vi.mocked(sendBridgeEvent).mockClear();
  });

  it('clears ContextBar selection and closes the gate when disabled', () => {
    const setContextInfo = vi.fn();
    const setAutoOpenFileEnabled = vi.fn();
    registerUsageModeCallbacks(createOptions({ setContextInfo, setAutoOpenFileEnabled }));

    window.updateAutoOpenFileEnabled?.(JSON.stringify({ autoOpenFileEnabled: false }));

    expect(setAutoOpenFileEnabled).toHaveBeenCalledWith(false);
    expect(isAutoOpenFileGateEnabled()).toBe(false);
    expect(setContextInfo).toHaveBeenCalledWith(null);
  });

  it('opens the gate and re-requests active file when enabled', () => {
    const setContextInfo = vi.fn();
    const setAutoOpenFileEnabled = vi.fn();
    setAutoOpenFileGateEnabled(false);
    registerUsageModeCallbacks(createOptions({ setContextInfo, setAutoOpenFileEnabled }));

    window.updateAutoOpenFileEnabled?.(JSON.stringify({ autoOpenFileEnabled: true }));

    expect(setAutoOpenFileEnabled).toHaveBeenCalledWith(true);
    expect(isAutoOpenFileGateEnabled()).toBe(true);
    expect(setContextInfo).not.toHaveBeenCalled();
    expect(sendBridgeEvent).toHaveBeenCalledWith('get_active_file');
  });
});
