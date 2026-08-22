import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDialogManagement } from './useDialogManagement';

const t = ((key: string) => key) as any;

const sendBridgeEvent = vi.fn();

vi.mock('../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEvent(...args),
}));

describe('useDialogManagement - multi-dialog queue isolation', () => {
  beforeEach(() => {
    sendBridgeEvent.mockClear();
  });

  it('queues a second permission request instead of replacing the first', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => {
      result.current.openPermissionDialog({
        channelId: 'perm-a',
        toolName: 'Bash',
        inputs: { command: 'echo A' },
      });
    });
    expect(result.current.currentPermissionRequest?.channelId).toBe('perm-a');

    act(() => {
      result.current.openPermissionDialog({
        channelId: 'perm-b',
        toolName: 'Bash',
        inputs: { command: 'echo B' },
      });
    });
    // Still showing A — B must not 串台 onto the open dialog
    expect(result.current.currentPermissionRequest?.channelId).toBe('perm-a');
    expect(result.current.permissionDialogOpen).toBe(true);
  });

  it('does not close dialog B when a stale decision for A arrives', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => {
      result.current.openPermissionDialog({
        channelId: 'perm-a',
        toolName: 'Bash',
        inputs: { command: 'echo A' },
      });
    });
    act(() => {
      result.current.openPermissionDialog({
        channelId: 'perm-b',
        toolName: 'Bash',
        inputs: { command: 'echo B' },
      });
    });

    // Finish A → B becomes current
    act(() => {
      result.current.handlePermissionApprove('perm-a');
    });
    expect(result.current.currentPermissionRequest?.channelId).toBe('perm-b');
    expect(result.current.permissionDialogOpen).toBe(true);

    // Late/stale skip for A must not dismiss B
    act(() => {
      result.current.handlePermissionSkip('perm-a');
    });
    expect(result.current.currentPermissionRequest?.channelId).toBe('perm-b');
    expect(result.current.permissionDialogOpen).toBe(true);

    // Only B's decision closes B
    act(() => {
      result.current.handlePermissionApprove('perm-b');
    });
    expect(result.current.permissionDialogOpen).toBe(false);
    expect(result.current.currentPermissionRequest).toBeNull();
  });

  it('does not close ask-dialog B when stale cancel for A arrives', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => {
      result.current.openAskUserQuestionDialog({
        requestId: 'ask-a',
        toolName: 'AskUserQuestion',
        questions: [{ question: 'A?', header: 'A', options: [{ label: '1', description: '' }], multiSelect: false }],
      });
    });
    act(() => {
      result.current.openAskUserQuestionDialog({
        requestId: 'ask-b',
        toolName: 'AskUserQuestion',
        questions: [{ question: 'B?', header: 'B', options: [{ label: '1', description: '' }], multiSelect: false }],
      });
    });

    act(() => {
      result.current.handleAskUserQuestionSubmit('ask-a', { 'A?': '1' });
    });
    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('ask-b');

    act(() => {
      result.current.handleAskUserQuestionCancel('ask-a');
    });
    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('ask-b');
    expect(result.current.askUserQuestionDialogOpen).toBe(true);
  });
});
