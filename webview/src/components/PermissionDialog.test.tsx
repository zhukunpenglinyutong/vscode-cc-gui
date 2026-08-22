import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PermissionDialog, {
  formatPermissionWorkingDirectoryDisplay,
  resolvePermissionWorkingDirectory,
  type PermissionRequest,
} from './PermissionDialog';
import { resetLinkifyCapabilities, setLinkifyCapabilities } from '../utils/linkifyCapabilities';

vi.mock('../hooks/useDialogResize', () => ({
  useDialogResize: () => ({
    dialogRef: { current: null },
    dialogHeight: null,
    setDialogHeight: vi.fn(),
    handleResizeStart: vi.fn(),
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: unknown) => {
      if (typeof fallbackOrOptions === 'string') {
        return fallbackOrOptions;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

describe('resolvePermissionWorkingDirectory', () => {
  it('prefers top-level cwd from the bridge over inputs', () => {
    expect(
      resolvePermissionWorkingDirectory({
        cwd: '/Users/zhukunpenglinyutong/project',
        inputs: { cwd: '/tmp/other' },
      }),
    ).toBe('/Users/zhukunpenglinyutong/project');
  });

  it('falls back to inputs.cwd then file_path/path', () => {
    expect(
      resolvePermissionWorkingDirectory({
        inputs: { cwd: 'src/components' },
      }),
    ).toBe('src/components');
    expect(
      resolvePermissionWorkingDirectory({
        inputs: { file_path: 'README.md' },
      }),
    ).toBe('README.md');
  });

  it('returns ~ when cwd is missing or blank (no double tilde source)', () => {
    expect(resolvePermissionWorkingDirectory({ inputs: {} })).toBe('~');
    expect(resolvePermissionWorkingDirectory({ cwd: '  ', inputs: { cwd: '' } })).toBe('~');
  });
});

describe('formatPermissionWorkingDirectoryDisplay', () => {
  it('never produces a double tilde label', () => {
    expect(formatPermissionWorkingDirectoryDisplay('~')).toBe('~');
    expect(formatPermissionWorkingDirectoryDisplay('')).toBe('~');
    expect(formatPermissionWorkingDirectoryDisplay('  ')).toBe('~');
  });

  it('keeps absolute and home-relative paths intact', () => {
    expect(formatPermissionWorkingDirectoryDisplay('/Users/zhukunpenglinyutong/project')).toBe(
      '/Users/zhukunpenglinyutong/project',
    );
    expect(formatPermissionWorkingDirectoryDisplay('~/Desktop')).toBe('~/Desktop');
  });
});

describe('PermissionDialog', () => {
  const buildRequest = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
    channelId: 'perm-1',
    toolName: 'bash',
    inputs: {
      cwd: 'src/components',
      command: 'echo hello',
    },
    ...overrides,
  });

  beforeEach(() => {
    resetLinkifyCapabilities();
    setLinkifyCapabilities({ classNavigationEnabled: true });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('renders a single working-directory label (not "→ ~ ~") when cwd is missing', () => {
    render(
      <PermissionDialog
        isOpen
        request={buildRequest({ cwd: undefined, inputs: { command: 'echo CCG_CLEAR_TEST_2134' } })}
        onApprove={() => {}}
        onSkip={() => {}}
        onApproveAlways={() => {}}
      />,
    );

    const path = document.querySelector('.command-path');
    // Arrow and cwd are separate nodes spaced by CSS gap (textContent may be "→~")
    expect(path?.querySelector('.command-arrow')?.textContent).toBe('→');
    expect(path?.querySelector('.command-cwd')?.textContent).toBe('~');
    expect(path?.textContent).not.toMatch(/~\s*~/);
  });

  it('renders top-level bridge cwd in the path header', () => {
    render(
      <PermissionDialog
        isOpen
        request={buildRequest({
          cwd: '/Users/zhukunpenglinyutong/Desktop/github/vscode-cc-gui',
          inputs: { command: 'echo hello' },
        })}
        onApprove={() => {}}
        onSkip={() => {}}
        onApproveAlways={() => {}}
      />,
    );

    expect(document.querySelector('.command-cwd')?.textContent).toBe(
      '/Users/zhukunpenglinyutong/Desktop/github/vscode-cc-gui',
    );
  });

  it('reuses MarkdownBlock linkify inside the command content area', () => {
    const request: PermissionRequest = {
      channelId: 'perm-1',
      toolName: 'bash',
      inputs: {
        cwd: 'src/components',
        command: [
          'Read src/components/App.tsx',
          '',
          'Inspect com.github.claudecodegui.handler.file.OpenFileHandler',
          '',
          'Reference https://example.com/docs',
        ].join('\n'),
      },
    };

    render(
      <PermissionDialog
        isOpen
        request={request}
        onApprove={() => {}}
        onSkip={() => {}}
        onApproveAlways={() => {}}
      />,
    );

    expect(screen.getByRole('link', { name: 'src/components/App.tsx' })).toBeTruthy();
    expect(
      screen.getByRole('link', {
        name: 'com.github.claudecodegui.handler.file.OpenFileHandler',
      }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'https://example.com/docs' })).toBeTruthy();
  });

  it('auto-denies with the original channelId after timeoutSeconds elapses', () => {
    vi.useFakeTimers();
    const onApprove = vi.fn();
    const onSkip = vi.fn();
    const onApproveAlways = vi.fn();

    render(
      <PermissionDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onSkip={onSkip}
        onApproveAlways={onApproveAlways}
        timeoutSeconds={30}
      />,
    );

    expect(onSkip).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledWith('perm-1');
    expect(onApprove).not.toHaveBeenCalled();
    expect(onApproveAlways).not.toHaveBeenCalled();
  });

  it('manual approval suppresses the later auto-deny', () => {
    vi.useFakeTimers();
    const onApprove = vi.fn();
    const onSkip = vi.fn();
    const onApproveAlways = vi.fn();

    render(
      <PermissionDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onSkip={onSkip}
        onApproveAlways={onApproveAlways}
        timeoutSeconds={30}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'permission.allow 1' }));
    expect(onApprove).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith('perm-1');
    expect(onSkip).not.toHaveBeenCalled();
    expect(onApproveAlways).not.toHaveBeenCalled();
  });

  it('keeps the duplicate-response guard when timeoutSeconds changes after approval', () => {
    vi.useFakeTimers();
    const onApprove = vi.fn();
    const onSkip = vi.fn();
    const onApproveAlways = vi.fn();
    const request = buildRequest();

    const { rerender } = render(
      <PermissionDialog
        isOpen
        request={request}
        onApprove={onApprove}
        onSkip={onSkip}
        onApproveAlways={onApproveAlways}
        timeoutSeconds={30}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'permission.allow 1' }));

    rerender(
      <PermissionDialog
        isOpen
        request={request}
        onApprove={onApprove}
        onSkip={onSkip}
        onApproveAlways={onApproveAlways}
        timeoutSeconds={60}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith('perm-1');
    expect(onSkip).not.toHaveBeenCalled();
    expect(onApproveAlways).not.toHaveBeenCalled();
  });

  // The dialog overlay sits above the chat input but the keydown listener is on
  // window, so without the editable-target guard a stray Enter in any input
  // (chat box, settings, etc.) would silently auto-approve the pending tool call.
  it('ignores Enter when focus is on an INPUT element', () => {
    const onApprove = vi.fn();
    const onSkip = vi.fn();
    const onApproveAlways = vi.fn();

    render(
      <PermissionDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onSkip={onSkip}
        onApproveAlways={onApproveAlways}
      />,
    );

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    } finally {
      input.remove();
    }

    expect(onApprove).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
    expect(onApproveAlways).not.toHaveBeenCalled();
  });

  it('ignores option-shortcut digits (1/2/3) when focus is on an INPUT element', () => {
    const onApprove = vi.fn();
    const onSkip = vi.fn();
    const onApproveAlways = vi.fn();

    render(
      <PermissionDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onSkip={onSkip}
        onApproveAlways={onApproveAlways}
      />,
    );

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      for (const key of ['1', '2', '3']) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      }
    } finally {
      input.remove();
    }

    expect(onApprove).not.toHaveBeenCalled();
    expect(onApproveAlways).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('still honors Enter when no editable element has focus', () => {
    const onApprove = vi.fn();
    const onSkip = vi.fn();
    const onApproveAlways = vi.fn();

    render(
      <PermissionDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onSkip={onSkip}
        onApproveAlways={onApproveAlways}
      />,
    );

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith('perm-1');
  });
});
