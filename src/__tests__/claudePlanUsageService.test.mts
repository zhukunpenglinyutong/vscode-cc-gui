import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaudeCapacityPayload,
  cacheClaudeRateLimitInfo,
  clampClaudePct,
  resolveClaudePlanUsagePayload,
  resetClaudePlanUsageCacheForTests,
} from '../bridge/services/claudePlanUsageService.ts';

function info(utilization: number, resetsAtMs: number, status?: string) {
  return { utilization, resetsAt: resetsAtMs, ...(status ? { status } : {}) };
}

describe('buildClaudeCapacityPayload', () => {
  it('maps fraction utilization to percent with a 5h window', () => {
    const resetsAt = Date.now() + 3 * 60 * 60 * 1000; // ~3h out → 5h bucket
    const payload = buildClaudeCapacityPayload(info(0.42, resetsAt, 'allowed_warning'))!;

    assert.ok(Math.abs((payload.capacity_pct as number) - 42.0) < 0.01);
    assert.equal(payload.provider, 'claude');
    assert.equal(payload.source, 'sdk-rate-limit');
    assert.equal(payload.present, true);
    assert.equal(payload.period_type, '5h');
    assert.equal(payload.rate_limit_status, 'allowed_warning');
    assert.ok(typeof payload.reset_at === 'string');

    const windows = payload.windows as Array<Record<string, unknown>>;
    assert.equal(windows[0].id, '5h');
    assert.ok(Math.abs((windows[0].used_pct as number) - 42.0) < 0.01);
    assert.equal(windows[0].period_type, '5h');
  });

  it('treats utilization above one as already-percent (7d bucket)', () => {
    const resetsAt = Date.now() + 5 * 24 * 60 * 60 * 1000; // ~5d → 7d bucket
    const payload = buildClaudeCapacityPayload(info(87.0, resetsAt, 'rejected'))!;

    assert.ok(Math.abs((payload.capacity_pct as number) - 87.0) < 0.01);
    assert.equal(payload.period_type, '7d');
    assert.equal(payload.rate_limit_status, 'rejected');
  });

  it('returns null when utilization is missing', () => {
    assert.equal(buildClaudeCapacityPayload({ resetsAt: Date.now() + 1000 }), null);
  });
});

describe('clampClaudePct', () => {
  it('bounds values to [0, 100]', () => {
    assert.equal(clampClaudePct(-5), 0);
    assert.equal(clampClaudePct(144), 100);
    assert.equal(clampClaudePct(50), 50);
    assert.equal(clampClaudePct(Number.NaN), 0);
  });
});

describe('cache + resolve', () => {
  it('serves the cached snapshot and marks unavailable before the first event', () => {
    resetClaudePlanUsageCacheForTests();
    const unavailable = resolveClaudePlanUsagePayload();
    assert.equal(unavailable.present, false);
    assert.equal(unavailable.unavailable, true);
    assert.equal(unavailable.provider, 'claude');

    cacheClaudeRateLimitInfo(info(0.42, Date.now() + 3 * 60 * 60 * 1000));
    const resolved = resolveClaudePlanUsagePayload();
    assert.equal(resolved.present, true);
    assert.ok(Math.abs((resolved.capacity_pct as number) - 42.0) < 0.01);

    // Malformed payloads never clobber the last good snapshot.
    cacheClaudeRateLimitInfo({ resetsAt: Date.now() });
    assert.equal(resolveClaudePlanUsagePayload().present, true);

    resetClaudePlanUsageCacheForTests();
  });
});
