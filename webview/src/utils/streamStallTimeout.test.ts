import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STREAM_STALL_TIMEOUT_SECONDS,
  MAX_STREAM_STALL_TIMEOUT_SECONDS,
  MIN_STREAM_STALL_TIMEOUT_SECONDS,
  clampStreamStallTimeoutSeconds,
  streamStallTimeoutSecondsToMs,
} from './streamStallTimeout';

describe('clampStreamStallTimeoutSeconds', () => {
  it('defaults invalid values', () => {
    expect(clampStreamStallTimeoutSeconds(undefined)).toBe(DEFAULT_STREAM_STALL_TIMEOUT_SECONDS);
    expect(clampStreamStallTimeoutSeconds('bad')).toBe(DEFAULT_STREAM_STALL_TIMEOUT_SECONDS);
    expect(clampStreamStallTimeoutSeconds(Number.NaN)).toBe(DEFAULT_STREAM_STALL_TIMEOUT_SECONDS);
  });

  it('allows 1s and clamps only zero/negative and extreme upper values', () => {
    expect(clampStreamStallTimeoutSeconds(1)).toBe(1);
    expect(clampStreamStallTimeoutSeconds(0)).toBe(MIN_STREAM_STALL_TIMEOUT_SECONDS);
    expect(clampStreamStallTimeoutSeconds(999999)).toBe(MAX_STREAM_STALL_TIMEOUT_SECONDS);
    expect(clampStreamStallTimeoutSeconds(90.9)).toBe(90);
  });
});

describe('streamStallTimeoutSecondsToMs', () => {
  it('converts seconds to ms after clamping', () => {
    expect(streamStallTimeoutSecondsToMs(180)).toBe(180_000);
    expect(streamStallTimeoutSecondsToMs(0)).toBe(MIN_STREAM_STALL_TIMEOUT_SECONDS * 1000);
  });
});
