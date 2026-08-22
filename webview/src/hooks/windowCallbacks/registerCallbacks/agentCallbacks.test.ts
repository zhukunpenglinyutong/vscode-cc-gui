import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAutoOpenFileGateEnabled } from '../../../utils/autoOpenFileGate';
import { registerAgentAndSelectionCallbacks } from './agentCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';

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

describe('registerAgentAndSelectionCallbacks addSelectionInfo gate', () => {
  beforeEach(() => {
    setAutoOpenFileGateEnabled(false);
    delete window.addSelectionInfo;
    delete window.clearSelectionInfo;
  });

  it('does not select a file when auto-open-file is closed', () => {
    const setContextInfo = vi.fn();
    registerAgentAndSelectionCallbacks(createOptions({ setContextInfo }));

    setAutoOpenFileGateEnabled(false);
    window.addSelectionInfo?.('@/repo/README.md');

    expect(setContextInfo).not.toHaveBeenCalled();
  });

  it('selects a file when auto-open-file is enabled', () => {
    const setContextInfo = vi.fn();
    registerAgentAndSelectionCallbacks(createOptions({ setContextInfo }));

    setAutoOpenFileGateEnabled(true);
    window.addSelectionInfo?.('@/repo/README.md');

    expect(setContextInfo).toHaveBeenCalledWith({
      file: '/repo/README.md',
      startLine: undefined,
      endLine: undefined,
      raw: '@/repo/README.md',
    });
  });

  it('still clears selection info while closed', () => {
    const setContextInfo = vi.fn();
    registerAgentAndSelectionCallbacks(createOptions({ setContextInfo }));

    setAutoOpenFileGateEnabled(false);
    window.clearSelectionInfo?.();

    expect(setContextInfo).toHaveBeenCalledWith(null);
  });

  it('does not gate manual addCodeSnippet / insertCodeSnippetAtCursor', () => {
    registerAgentAndSelectionCallbacks(createOptions());
    setAutoOpenFileGateEnabled(false);
    const insert = vi.fn();
    window.insertCodeSnippetAtCursor = insert;

    window.addCodeSnippet?.('@/repo/a.ts#L1-2');

    expect(insert).toHaveBeenCalledWith('@/repo/a.ts#L1-2');
  });
});
