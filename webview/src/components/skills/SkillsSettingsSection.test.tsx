import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendToJava } from '../../utils/bridge';
import { SkillsSettingsSection } from './SkillsSettingsSection';

vi.mock('../../utils/bridge', () => ({
  sendToJava: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('SkillsSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderWithCodexSkill(skillId: string) {
    render(<SkillsSettingsSection currentProvider="codex" />);
    act(() => {
      window.updateSkills?.(JSON.stringify({
        global: {},
        local: {},
        user: {
          [skillId]: {
            id: skillId,
            name: 'review',
            type: 'directory',
            scope: 'user',
            path: '/skills/review',
            skillPath: '/skills/review/SKILL.md',
            enabled: true,
          },
        },
        repo: {},
      }));
    });
  }

  it('correlates Codex toggle responses by the stable skill id', () => {
    const skillId = 'user:/skills/review';
    renderWithCodexSkill(skillId);

    const toggleButton = screen.getByTitle('chat.clickToDisable') as HTMLButtonElement;
    fireEvent.click(toggleButton);

    expect(toggleButton.disabled).toBe(true);
    expect(sendToJava).toHaveBeenLastCalledWith('toggle_skill', {
      id: skillId,
      requestId: expect.any(String),
      name: 'review',
      scope: 'user',
      enabled: true,
      skillPath: '/skills/review/SKILL.md',
    });

    act(() => {
      const request = vi.mocked(sendToJava).mock.calls.at(-1)?.[1] as { requestId: string };
      window.skillToggleResult?.(JSON.stringify({
        success: false,
        id: skillId,
        requestId: request.requestId,
        name: 'review',
        error: 'denied',
      }));
    });

    expect(toggleButton.disabled).toBe(false);
  });

  it('ignores a late response after a timed-out toggle is retried', () => {
    vi.useFakeTimers();
    const skillId = 'user:/skills/review';
    renderWithCodexSkill(skillId);

    fireEvent.click(screen.getByTitle('chat.clickToDisable'));
    const firstRequest = vi.mocked(sendToJava).mock.calls.at(-1)?.[1] as { requestId: string };
    act(() => vi.advanceTimersByTime(15000));

    fireEvent.click(screen.getByTitle('chat.clickToDisable'));
    const secondRequest = vi.mocked(sendToJava).mock.calls.at(-1)?.[1] as { requestId: string };
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);

    // A stale response for the first request must not unblock the retry.
    act(() => {
      window.skillToggleResult?.(JSON.stringify({
        success: true,
        enabled: false,
        id: skillId,
        requestId: firstRequest.requestId,
        name: 'review',
      }));
    });
    expect((screen.getByTitle('chat.clickToDisable') as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      window.skillToggleResult?.(JSON.stringify({
        success: false,
        id: skillId,
        requestId: secondRequest.requestId,
        name: 'review',
        error: 'denied',
      }));
    });
    expect((screen.getByTitle('chat.clickToDisable') as HTMLButtonElement).disabled).toBe(false);
  });
});
