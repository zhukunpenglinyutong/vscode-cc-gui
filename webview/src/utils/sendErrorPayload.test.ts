import { describe, expect, it } from 'vitest';
import { isEmptyAssistantPlaceholder, parseSendErrorPayload } from './sendErrorPayload';

describe('parseSendErrorPayload', () => {
  it('extracts error field from Codex JSON payload', () => {
    const text = parseSendErrorPayload(
      JSON.stringify({
        success: false,
        error: 'Codex configuration error:\n- Error message: duplicate key',
      }),
    );
    expect(text).toContain('Codex configuration error');
    expect(text).toContain('duplicate key');
  });

  it('accepts plain string JSON and raw text', () => {
    expect(parseSendErrorPayload(JSON.stringify('plain fail'))).toBe('plain fail');
    expect(parseSendErrorPayload('not-json error')).toBe('not-json error');
  });

  it('falls back for empty payloads', () => {
    expect(parseSendErrorPayload('')).toBe('Unknown error');
    expect(parseSendErrorPayload(null)).toBe('Unknown error');
  });
});

describe('isEmptyAssistantPlaceholder', () => {
  it('treats empty streaming assistants as placeholders', () => {
    expect(
      isEmptyAssistantPlaceholder({ type: 'assistant', content: '', isStreaming: true }),
    ).toBe(true);
    expect(
      isEmptyAssistantPlaceholder({ type: 'assistant', content: 'hello' }),
    ).toBe(false);
  });

  it('keeps assistants that already have tool_use blocks', () => {
    expect(
      isEmptyAssistantPlaceholder({
        type: 'assistant',
        content: '',
        raw: {
          message: {
            content: [{ type: 'tool_use', id: 't1', name: 'Bash' }],
          },
        },
      }),
    ).toBe(false);
  });
});
