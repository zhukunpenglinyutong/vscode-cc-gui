import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BashToolBlock from './BashToolBlock';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../hooks/useIsToolDenied', () => ({
  useIsToolDenied: () => false,
}));

describe('BashToolBlock', () => {
  it('renders command and stdout text in code-font-targeted nodes', () => {
    const { container } = render(
      <BashToolBlock
        input={{
          command: 'node --version',
        }}
        result={{
          type: 'tool_result',
          content: 'v22.0.0',
        }}
      />,
    );

    fireEvent.click(container.querySelector('.bash-tool-header') as HTMLElement);

    expect(container.querySelector('.bash-command-block')?.textContent).toBe('node --version');
    expect(container.querySelector('.bash-output-text')?.textContent).toBe('v22.0.0');
  });

  it('normalizes shell_command inputs that use cmd and justification fields', () => {
    const { container } = render(
      <BashToolBlock
        name="shell_command"
        input={{
          cmd: 'git status --short',
          justification: 'Check git status',
        }}
      />,
    );

    expect(container.textContent).toContain('Check git status');

    fireEvent.click(container.querySelector('.bash-tool-header') as HTMLElement);

    expect(container.querySelector('.bash-command-block')?.textContent).toBe('git status --short');
  });
});
