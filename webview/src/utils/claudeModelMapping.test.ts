import { describe, expect, it, beforeEach, vi } from 'vitest';
import { STORAGE_KEYS } from '../types/provider';
import { writeClaudeModelMapping } from './claudeModelMapping';

describe('writeClaudeModelMapping', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('写入映射后应派发同 tab 刷新事件', () => {
    const listener = vi.fn();
    window.addEventListener('localStorageChange', listener as EventListener);

    writeClaudeModelMapping({ sonnet: 'glm-5' });

    expect(localStorage.getItem(STORAGE_KEYS.CLAUDE_MODEL_MAPPING)).toBe(
      JSON.stringify({ sonnet: 'glm-5' }),
    );
    expect(listener).toHaveBeenCalledTimes(1);

    const event = listener.mock.calls[0]?.[0] as CustomEvent<{ key: string }>;
    expect(event.detail.key).toBe(STORAGE_KEYS.CLAUDE_MODEL_MAPPING);

    window.removeEventListener('localStorageChange', listener as EventListener);
  });
});
