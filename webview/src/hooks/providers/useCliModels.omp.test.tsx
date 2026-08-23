// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCliModels, useOmpRoles } from './useCliModels';
import { OMP_MODELS, OMP_ROLE_MODELS } from '../../components/ChatInputBox/types';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

function emitCliModels(payload: unknown) {
  act(() => {
    window.setCliModels?.(JSON.stringify(payload));
  });
}

function useOmpModelsAndRoles() {
  useCliModels('omp'); // installs window.setCliModels
  return useOmpRoles();
}

describe('useCliModels (omp)', () => {
  beforeEach(() => {
    sendBridgeEventMock.mockClear();
  });

  it('fetches the omp catalog when the omp provider is active', () => {
    renderHook(() => useCliModels('omp'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'omp');
  });

  it('falls back to the static OMP list before the catalog arrives', () => {
    const { result } = renderHook(() => useCliModels('omp'));
    expect(result.current.cliModels).toEqual(OMP_MODELS);
  });

  it('falls back to the static smol/slow/plan roles until a payload with roles arrives', () => {
    const { result } = renderHook(useOmpModelsAndRoles);
    expect(result.current).toEqual(OMP_ROLE_MODELS);
  });

  it('stores the omp catalog and dynamic roles from the listModels payload', () => {
    const { result } = renderHook(useOmpModelsAndRoles);
    emitCliModels({
      success: true,
      provider: 'omp',
      models: [{ id: 'openai/gpt-5-mini', label: 'openai/gpt-5-mini' }],
      roles: [{ id: 'designer', label: 'designer', description: 'opencode-go/deepseek-v4-flash' }],
    });
    expect(result.current).toEqual([
      { id: 'designer', label: 'designer', description: 'opencode-go/deepseek-v4-flash' },
    ]);
  });

  it('keeps the static role fallback when the payload carries no roles', () => {
    const { result } = renderHook(useOmpModelsAndRoles);
    emitCliModels({
      success: true,
      provider: 'omp',
      models: [{ id: 'openai/gpt-5-mini', label: 'openai/gpt-5-mini' }],
    });
    expect(result.current).toEqual(OMP_ROLE_MODELS);
  });
});
