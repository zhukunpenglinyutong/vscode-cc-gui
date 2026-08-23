import { act, renderHook } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { sendToJava } from '../../../utils/bridge';
import type { CacheKeys, ServerToolsState } from '../types';
import type { McpServer } from '../../../types/mcp';
import { useServerManagement } from './useServerManagement';

vi.mock('../../../utils/bridge', () => ({
  sendToJava: vi.fn(),
}));

const sendToJavaMock = vi.mocked(sendToJava);

const cacheKeys: CacheKeys = {
  SERVERS: 'test.servers',
  STATUS: 'test.status',
  TOOLS: 'test.tools',
  LAST_SERVER_ID: 'test.lastServerId',
};

const server: McpServer = {
  id: 'memory',
  name: 'memory',
  server: { command: 'npx' },
  enabled: true,
} as McpServer;

function renderManagementHook(isCodexMode: boolean, overrides: Record<string, unknown> = {}) {
  const onToast = vi.fn();
  const loadServers = vi.fn();
  const loadServerStatus = vi.fn();
  const hook = renderHook(() => useServerManagement({
    isCodexMode,
    messagePrefix: isCodexMode ? 'codex_' : '',
    cacheKeys,
    setServerTools: vi.fn() as unknown as React.Dispatch<React.SetStateAction<ServerToolsState>>,
    loadServers,
    loadServerStatus,
    loadServerTools: vi.fn(),
    onLog: vi.fn(),
    onToast,
    t: (key) => key,
    ...overrides,
  }));
  return { hook, onToast, loadServers, loadServerStatus };
}

describe('useServerManagement toggle acknowledgement', () => {
  it('waits for the backend result before reporting a Codex toggle success', () => {
    const { hook, onToast, loadServers, loadServerStatus } = renderManagementHook(true);

    act(() => {
      hook.result.current.handleToggleServer(server, false);
    });

    expect(sendToJavaMock).toHaveBeenCalledWith('toggle_codex_mcp_server', expect.objectContaining({
      id: server.id,
      enabled: false,
    }));
    expect(onToast).not.toHaveBeenCalled();
    expect(loadServers).not.toHaveBeenCalled();
    expect(loadServerStatus).not.toHaveBeenCalled();
  });

  it('keeps the optimistic toast + reload for Claude toggles', () => {
    const { hook, onToast, loadServers, loadServerStatus } = renderManagementHook(false);

    act(() => {
      hook.result.current.handleToggleServer(server, false);
    });

    expect(sendToJavaMock).toHaveBeenCalledWith('toggle_mcp_server', expect.objectContaining({
      id: server.id,
      enabled: false,
    }));
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining(server.id), 'success');
    expect(loadServers).toHaveBeenCalled();
    expect(loadServerStatus).toHaveBeenCalled();
  });
});
