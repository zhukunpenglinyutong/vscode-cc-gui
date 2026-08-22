import { render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';

import { WelcomeScreen } from './WelcomeScreen';

vi.mock('../BlinkingLogo', () => ({
  BlinkingLogo: () => <div data-testid="blinking-logo" />,
}));

vi.mock('../AnimatedText', () => ({
  AnimatedText: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock('../../version/version', () => ({
  APP_VERSION: '0.0.0-test',
}));

describe('WelcomeScreen', () => {
  const t = ((key: string, options?: Record<string, unknown>) => {
    if (key === 'chat.sendMessage') {
      return `给 ${String(options?.provider ?? '')} 发送消息`;
    }
    if (key === 'providers.codex.label') {
      return 'Codex';
    }
    if (key === 'providers.claude.label') {
      return 'Claude Code';
    }
    return key;
  }) as unknown as TFunction;

  it('uses the translated Codex provider label in the welcome copy', () => {
    render(
      <WelcomeScreen
        currentProvider="codex"
        t={t}
        onProviderChange={vi.fn()}
      />,
    );

    expect(screen.getByText('给 Codex 发送消息')).toBeTruthy();
    expect(screen.queryByText('给 Codex Cli 发送消息')).toBeNull();
  });

  it('keeps the Claude provider label in the welcome copy', () => {
    render(
      <WelcomeScreen
        currentProvider="claude"
        t={t}
        onProviderChange={vi.fn()}
      />,
    );

    expect(screen.getByText('给 Claude Code 发送消息')).toBeTruthy();
  });
});
