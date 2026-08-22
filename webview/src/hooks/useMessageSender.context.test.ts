import { act, renderHook } from '@testing-library/react';
import { useMessageSender } from './useMessageSender';
import type { UseMessageSenderOptions } from './useMessageSender';

describe('useMessageSender - /context command', () => {
  const t = ((key: string, opts?: any) => opts?.defaultValue ?? key) as any;

  const createOptions = (overrides: Partial<UseMessageSenderOptions> = {}): UseMessageSenderOptions => ({
    t,
    addToast: vi.fn(),
    currentProvider: 'claude',
    selectedModel: 'claude-opus-4-8',
    permissionMode: 'default',
    reasoningEffort: 'high',
    codexFastMode: 'normal',
    streamingEnabledSetting: true,
    selectedAgent: null,
    currentSessionId: null,
    sdkStatusLoaded: true,
    currentSdkInstalled: true,
    sentAttachmentsRef: { current: new Map() },
    chatInputRef: { current: null },
    messagesContainerRef: { current: null },
    isUserAtBottomRef: { current: true },
    userPausedRef: { current: false },
    isStreamingRef: { current: false },
    setMessages: vi.fn(),
    setLoading: vi.fn(),
    setLoadingStartTime: vi.fn(),
    setStreamingActive: vi.fn(),
    setSettingsInitialTab: vi.fn(),
    setCurrentView: vi.fn(),
    forceCreateNewSession: vi.fn(),
    handleModeSelect: vi.fn(),
    longContextEnabled: false,
    openContextUsageDialog: vi.fn(),
    closeContextUsageDialog: vi.fn().mockReturnValue(true),
    ...overrides,
  });

  const getBridgePayload = (eventName: string) => {
    const calls = (window.sendToJava as any).mock.calls.map((call: [string]) => call[0]);
    const prefix = `${eventName}:`;
    const sendCall = calls.find((call: string) => call.startsWith(prefix));
    expect(sendCall).toBeTruthy();
    return JSON.parse(sendCall!.substring(prefix.length));
  };

  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('sends get_context_usage with base model when longContext is disabled', () => {
    const opts = createOptions({
      selectedModel: 'claude-opus-4-8',
      longContextEnabled: false,
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/context');
    });

    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    const call = (window.sendToJava as any).mock.calls[0][0] as string;
    expect(call).toMatch(/^get_context_usage:/);

    const payload = JSON.parse(call.substring('get_context_usage:'.length));
    expect(payload.model).toBe('claude-opus-4-8');
    expect(payload.requestId).toBeTruthy();
  });

  it('sends get_context_usage with [1m] suffix when longContext is enabled', () => {
    const opts = createOptions({
      selectedModel: 'claude-opus-4-8',
      longContextEnabled: true,
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/context');
    });

    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    const call = (window.sendToJava as any).mock.calls[0][0] as string;
    const payload = JSON.parse(call.substring('get_context_usage:'.length));
    expect(payload.model).toBe('claude-opus-4-8[1m]');
  });

  it('opens dialog with loading state before sending bridge event', () => {
    const openContextUsageDialog = vi.fn();
    const opts = createOptions({ openContextUsageDialog });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/context');
    });

    expect(openContextUsageDialog).toHaveBeenCalledTimes(1);
    expect(openContextUsageDialog).toHaveBeenCalledWith(
      expect.any(String),
      true, // loading = true
    );
    // Dialog opened BEFORE bridge event sent
    expect(openContextUsageDialog.mock.invocationCallOrder[0]).toBeLessThan(
      (window.sendToJava as any).mock.invocationCallOrder[0],
    );
  });

  it('shows warning toast and does not send bridge event for Codex provider', () => {
    const addToast = vi.fn();
    const opts = createOptions({
      currentProvider: 'codex',
      addToast,
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/context');
    });

    expect(window.sendToJava).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining('Claude'),
      'warning',
    );
  });

  it('closes dialog with error toast when bridge is unavailable', () => {
    // Don't set window.sendToJava → bridge unavailable
    delete (window as any).sendToJava;

    const addToast = vi.fn();
    const closeContextUsageDialog = vi.fn().mockReturnValue(true);
    const opts = createOptions({ addToast, closeContextUsageDialog });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/context');
    });

    expect(closeContextUsageDialog).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(
      expect.any(String),
      'error',
    );
  });

  it('includes explicit Claude high reasoning effort in plain message payload', () => {
    const opts = createOptions({
      currentProvider: 'claude',
      selectedModel: 'claude-opus-4-8',
      reasoningEffort: 'high',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload.streaming).toBe(true);
    expect(payload.reasoningEffort).toBe('high');
  });

  it('includes provider and model on send so multi-window requests stay self-contained', () => {
    const opts = createOptions({
      currentProvider: 'codex',
      selectedModel: 'gpt-5.5',
      longContextEnabled: false,
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello multi-window');
    });

    const payload = getBridgePayload('send_message');
    expect(payload.provider).toBe('codex');
    expect(payload.model).toBe('gpt-5.5');
  });

  it('includes ContextBar file path when auto-open-file is enabled', () => {
    const opts = createOptions({
      currentProvider: 'opencode',
      selectedModel: 'gpt-oss',
      autoOpenFileEnabled: true,
      contextBarFile: '/Users/zhukunpenglinyutong/Desktop/github/vscode-cc-gui/README.md',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('这个文件的路径是什么？');
    });

    const payload = getBridgePayload('send_message');
    expect(payload.contextBarFile).toBe(
      '/Users/zhukunpenglinyutong/Desktop/github/vscode-cc-gui/README.md',
    );
  });

  it('omits ContextBar file path when auto-open-file is closed', () => {
    const opts = createOptions({
      autoOpenFileEnabled: false,
      contextBarFile: '/repo/README.md',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload.contextBarFile).toBeUndefined();
  });

  it('applies [1m] model suffix on send when long context is enabled for Claude only', () => {
    const opts = createOptions({
      currentProvider: 'claude',
      selectedModel: 'claude-opus-4-8',
      longContextEnabled: true,
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello 1m');
    });

    const payload = getBridgePayload('send_message');
    expect(payload.provider).toBe('claude');
    expect(payload.model).toBe('claude-opus-4-8[1m]');
  });

  it('does not append [1m] to Grok profile ids even when long context is enabled', () => {
    // Regression: multi-window fix applied apply1MContextSuffix to every provider.
    // longContext is a Claude-only toggle but was shared globally, turning "grok"
    // into "grok[1m]" which Grok CLI rejects as unknown model id.
    const opts = createOptions({
      currentProvider: 'grok',
      selectedModel: 'grok',
      longContextEnabled: true,
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello grok');
    });

    const payload = getBridgePayload('send_message');
    expect(payload.provider).toBe('grok');
    expect(payload.model).toBe('grok');
  });

  it('does not append [1m] to Codex model ids even when long context is enabled', () => {
    const opts = createOptions({
      currentProvider: 'codex',
      selectedModel: 'gpt-5.6-sol',
      longContextEnabled: true,
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello codex');
    });

    const payload = getBridgePayload('send_message');
    expect(payload.provider).toBe('codex');
    expect(payload.model).toBe('gpt-5.6-sol');
  });

  it('sends streaming=false when the streaming setting is disabled', () => {
    const opts = createOptions({
      streamingEnabledSetting: false,
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload.streaming).toBe(false);
  });

  it('includes current session identifiers in Codex payload so follow-up messages resume the same thread', () => {
    const opts = createOptions({
      currentProvider: 'codex',
      selectedModel: 'gpt-5.5',
      currentSessionId: 'thread-123',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('follow up');
    });

    const payload = getBridgePayload('send_message');
    expect(payload.threadId).toBe('thread-123');
    expect(payload.sessionId).toBe('thread-123');
  });

  it('includes explicit Claude high reasoning effort in attachment message payload', () => {
    const opts = createOptions({
      currentProvider: 'claude',
      selectedModel: 'claude-opus-4-8',
      reasoningEffort: 'high',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello', [{
        id: 'att-1',
        fileName: 'note.txt',
        mediaType: 'text/plain',
        data: 'aGVsbG8=',
      }]);
    });

    const payload = getBridgePayload('send_message_with_attachments');
    expect(payload.reasoningEffort).toBe('high');
  });

  it('omits reasoning effort for Claude models without adaptive thinking support', () => {
    const opts = createOptions({
      currentProvider: 'claude',
      selectedModel: 'claude-haiku-4-5',
      reasoningEffort: 'low',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload).not.toHaveProperty('reasoningEffort');
  });

  it('includes explicit non-default Claude reasoning effort in plain message payload', () => {
    const opts = createOptions({
      reasoningEffort: 'low',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload.reasoningEffort).toBe('low');
  });

  it('includes explicit non-default Claude reasoning effort in attachment message payload', () => {
    const opts = createOptions({
      reasoningEffort: 'low',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello', [{
        id: 'att-1',
        fileName: 'note.txt',
        mediaType: 'text/plain',
        data: 'aGVsbG8=',
      }]);
    });

    const payload = getBridgePayload('send_message_with_attachments');
    expect(payload.reasoningEffort).toBe('low');
  });
});
