// Child process for the "[1m] context toggle rebuild" scenario driven by
// runtime-lifecycle.test.js.
//
// Why a separate process: this scenario calls buildRequestContext(), which
// calls setupApiKey(). setupApiKey resolves credentials ONLY from ~/.codemoss +
// ~/.claude under the real home dir and deliberately ignores env vars, and
// getRealHomeDir() caches that home path on first use. So the credential
// environment must be in place BEFORE this process starts — the parent test
// spawns this script with HOME pointed at a temp dir carrying a CLI-login
// config, mirroring how api-config.test.js runs setupApiKey in a child for the
// same reason.
//
// On success prints SCENARIO_OK and exits 0. Any assertion failure rejects the
// top-level await, so Node exits non-zero and the parent surfaces it.
import assert from 'node:assert/strict';
import { __testing } from './persistent-query-service.js';

/**
 * Create a fake SDK query whose message iterator is a REAL native async
 * generator, mirroring the SDK's readSdkMessages(). It pends until close()
 * is called (the real iterator stays open between turns), so the perpetual
 * reader neither spins nor tears the runtime down mid-test.
 */
function createHangingQuery({ prompt, options }) {
  let closeResolve;
  const closedSignal = new Promise((resolve) => { closeResolve = resolve; });
  async function* messages() {
    await closedSignal;
  }
  const generator = messages();
  return {
    prompt,
    options,
    closed: false,
    setPermissionMode: async () => {},
    setModel: async () => {},
    setMaxThinkingTokens: async () => {},
    close() {
      this.closed = true;
      closeResolve();
    },
    next: () => generator.next(),
  };
}

let created = 0;
__testing.setQueryFn((args) => {
  created += 1;
  return createHangingQuery(args);
});

const baseParams = {
  sessionId: '',
  runtimeSessionEpoch: 'epoch-1m-toggle',
  cwd: process.cwd(),
  message: 'hello',
};
// Settings override keeps the resolved model deterministic regardless of the
// developer's real ~/.claude/settings.json.
const overrides = { settings: { env: {} } };

const ctxOff = await __testing.buildRequestContext(
  { ...baseParams, model: 'claude-sonnet-4-6' }, false, overrides
);
const runtimeOff = await __testing.acquireRuntime(ctxOff);
const runtimeOffAgain = await __testing.acquireRuntime(ctxOff);
assert.equal(runtimeOff, runtimeOffAgain, 'same [1m] state must reuse the runtime');
assert.equal(created, 1);

const ctxOn = await __testing.buildRequestContext(
  { ...baseParams, model: 'claude-sonnet-4-6[1m]' }, false, overrides
);
const runtimeOn = await __testing.acquireRuntime(ctxOn);
assert.notEqual(runtimeOff, runtimeOn, 'toggling [1m] on must build a runtime with a 1M window');
assert.equal(created, 2);

// The subprocess env is frozen at spawn — verify each runtime was spawned
// with the context window it serves. This is the end-to-end guarantee that
// the CLI resolves "sonnet" to the right window for its runtime.
const envOff = runtimeOff.query?.options?.env || {};
const envOn = runtimeOn.query?.options?.env || {};
assert.doesNotMatch(String(envOff.ANTHROPIC_DEFAULT_SONNET_MODEL || ''), /\[1m\]/,
  'non-1M runtime must be spawned without the [1m] suffix in its env');
assert.match(String(envOn.ANTHROPIC_DEFAULT_SONNET_MODEL || ''), /\[1m\]$/,
  '1M runtime must be spawned with the [1m] suffix in its env');

// Toggling back off routes to the still-alive non-1M runtime: anonymous
// runtimes are keyed by signature, and the old runtime's frozen env matches
// the requested window again, so reuse is correct (no rebuild needed).
const ctxOffAgain = await __testing.buildRequestContext(
  { ...baseParams, model: 'claude-sonnet-4-6' }, false, overrides
);
const runtimeOff2 = await __testing.acquireRuntime(ctxOffAgain);
assert.equal(runtimeOff2, runtimeOff, 'toggling back off must route to the non-1M runtime');
assert.equal(created, 2);

await __testing.resetState();
console.log('SCENARIO_OK');
// The perpetual readers left by acquireRuntime keep the event loop alive even
// after resetState(); exit explicitly so execFileSync in the parent returns.
process.exit(0);
