import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useCodexProviderManagement } from './useCodexProviderManagement';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('useCodexProviderManagement', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('sends a revoke message when local Codex authorization is canceled', () => {
    const { result } = renderHook(() => useCodexProviderManagement());

    act(() => {
      result.current.handleRevokeCodexLocalConfigAuthorization('provider-1');
    });

    expect(window.sendToJava).toHaveBeenCalledWith(
      'revoke_codex_local_config_authorization:{"fallbackProviderId":"provider-1"}'
    );
    expect(result.current.codexLoading).toBe(true);
  });
});
