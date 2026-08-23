import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from './persistent-query-service.js';

/**
 * Create a Promise that can be manually resolved.
 * @returns {{ promise: Promise, resolve: Function, reject: Function }}
 */
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createQueryFactory() {
  const runtimes = [];
  return {
    runtimes,
    queryFn({ prompt, options }) {
      // A real SDK query stream blocks on next() while idle and only ends when
      // the runtime is torn down. Returning {done:true} immediately makes the
      // perpetual reader treat the stream as ended out-of-band and evict the
      // runtime via disposeRuntime - which races acquireRuntime's ownership
      // check (the runtime can be closed between createRuntime and the assert).
      // Block on a promise that settles only when close() runs, so the reader
      // idles like the real SDK between turns.
      let closeReject;
      const idle = new Promise((_, reject) => { closeReject = reject; });
      const runtime = {
        prompt,
        options,
        closed: false,
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        close() {
          this.closed = true;
          closeReject(new Error('runtime closed'));
        },
        next() {
          return idle;
        }
      };
      runtimes.push(runtime);
      return runtime;
    }
  };
}

/**
 * Create a query factory that returns next() results in sequence.
 * @param {Array<(() => Promise<{done: boolean, value?: any}>) | {done: boolean, value?: any}>} steps
 */
function createSequencedQueryFactory(steps) {
  const runtimes = [];
  return {
    runtimes,
    queryFn({ prompt, options }) {
      let index = 0;
      // Once the scripted steps are drained, a real SDK stream blocks on next()
      // and only settles when close() runs. Parking here (instead of inventing
      // an instant result) keeps the perpetual reader from hot-looping
      // inter-turn results — those tick readerProgress forever and starve
      // executeTurn's quiescence gate.
      let closeReject;
      const idle = new Promise((_, reject) => { closeReject = reject; });
      // close() rejects idle even when the reader is parked on a scripted step
      // rather than awaiting it (e.g. the abort test); attach a side no-op
      // handler so that rejection never surfaces as an unhandledRejection.
      // The reader's own await still observes the rejection.
      idle.catch(() => {});
      const runtime = {
        prompt,
        options,
        closed: false,
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        close() {
          this.closed = true;
          closeReject(new Error('runtime closed'));
        },
        async next() {
          const step = steps[index++];
          if (!step) {
            return idle;
          }
          return typeof step === 'function' ? await step() : step;
        }
      };
      runtimes.push(runtime);
      return runtime;
    }
  };
}

/**
 * Wait until executeTurn has cleared the reader-quiescence gate and opened the
 * turn sink. Messages the perpetual reader routes before the sink exists are
 * consumed inter-turn and never reach the turn, so tests must hold their
 * scripted deliveries until the sink is up.
 */
async function waitForTurnSink(runtime) {
  while (!runtime.turnSink && !runtime.closed) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test.beforeEach(async () => {
  await __testing.resetState();
});

test.after(async () => {
  await __testing.resetState();
});

test('reasoningEffort is passed as SDK effort and disables fixed thinking tokens', async () => {
  const context = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-effort',
    cwd: process.cwd(),
    message: 'use adaptive effort',
    reasoningEffort: 'xhigh'
  }, false);

  assert.equal(context.options.effort, 'xhigh');
  assert.equal(Object.hasOwn(context.options, 'maxThinkingTokens'), false);
  assert.equal(context.maxThinkingTokens, undefined);
  assert.match(context.runtimeSignature, /"effort":"xhigh"/);
});

test('fixed thinking tokens remain configured when no reasoningEffort is provided', async () => {
  const context = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-thinking',
    cwd: process.cwd(),
    message: 'use default thinking config'
  }, false);

  assert.equal(context.options.effort, undefined);
  assert.equal(context.options.maxThinkingTokens, 10000);
  assert.equal(context.maxThinkingTokens, 10000);
});

test('anonymous runtime is isolated by runtimeSessionEpoch', async () => {
  const factory = createQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const firstContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-1',
    cwd: process.cwd(),
    message: 'hello'
  }, false);

  const runtime1 = await __testing.acquireRuntime(firstContext);
  const runtime1Again = await __testing.acquireRuntime(firstContext);
  assert.equal(runtime1, runtime1Again);
  assert.equal(factory.runtimes.length, 1);

  const secondContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-2',
    cwd: process.cwd(),
    message: 'hello again'
  }, false);

  const runtime2 = await __testing.acquireRuntime(secondContext);
  assert.notEqual(runtime1, runtime2);
  assert.equal(factory.runtimes.length, 2);
});

test('same-tab new-session isolation matches fresh runtime isolation expectations', async () => {
  const factory = createQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const firstContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-a',
    cwd: process.cwd(),
    message: 'first turn'
  }, false);
  const runtimeA = await __testing.acquireRuntime(firstContext);

  await __testing.resetRuntimePersistent({ runtimeSessionEpoch: 'epoch-a' });

  const secondContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-b',
    cwd: process.cwd(),
    message: 'new session turn'
  }, false);
  const runtimeB = await __testing.acquireRuntime(secondContext);

  assert.notEqual(runtimeA, runtimeB);
  assert.equal(factory.runtimes.length, 2);
  assert.equal(__testing.getSnapshot().anonymousRuntimeCount, 1);
});

test('resetRuntimePersistent disposes active turn runtime for interrupted old epoch before next first send', async () => {
  const factory = createQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const oldContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-old',
    cwd: process.cwd(),
    message: 'streaming turn'
  }, false);
  const oldRuntime = await __testing.acquireRuntime(oldContext);
  __testing.setActiveTurnRuntime(oldRuntime);

  await __testing.resetRuntimePersistent({ runtimeSessionEpoch: 'epoch-old' });

  const nextContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-new',
    cwd: process.cwd(),
    message: 'first send after interrupt'
  }, false);
  const nextRuntime = await __testing.acquireRuntime(nextContext);

  assert.equal(oldRuntime.closed, true);
  assert.notEqual(oldRuntime, nextRuntime);
  assert.equal(__testing.getSnapshot().activeTurnEpoch, null);
});

test('restore-history continuation keeps runtime bound to restored session after reset of prior epoch', async () => {
  const factory = createQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const oldAnonymousContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-stale',
    cwd: process.cwd(),
    message: 'stale anonymous'
  }, false);
  await __testing.acquireRuntime(oldAnonymousContext);
  await __testing.resetRuntimePersistent({ runtimeSessionEpoch: 'epoch-stale' });

  const restoredContext = await __testing.buildRequestContext({
    sessionId: 'hist-restore',
    runtimeSessionEpoch: 'epoch-restore',
    cwd: process.cwd(),
    message: 'restored continuation'
  }, false);
  const restoredRuntime = await __testing.acquireRuntime(restoredContext);
  const restoredRuntimeAgain = await __testing.acquireRuntime(restoredContext);

  assert.equal(restoredRuntime, restoredRuntimeAgain);
  assert.equal(__testing.getRuntimeForSession('hist-restore'), restoredRuntime);
});

test('active session runtime is not disposed by idle cleanup while a turn is executing', async () => {
  const nextDeferred = createDeferred();
  const enteredDeferred = createDeferred();
  const factory = createSequencedQueryFactory([
    async () => {
      enteredDeferred.resolve();
      return nextDeferred.promise;
    },
    { done: false, value: { type: 'result', is_error: false } }
  ]);
  __testing.setQueryFn(factory.queryFn);

  const context = await __testing.buildRequestContext({
    sessionId: 'session-active',
    runtimeSessionEpoch: 'epoch-active',
    cwd: process.cwd(),
    message: 'long running turn'
  }, false);
  const runtime = await __testing.acquireRuntime(context);
  runtime.lastUsedAt = Date.now() - (31 * 60 * 1000);

  const turnPromise = __testing.executeTurn(runtime, context);
  await enteredDeferred.promise;
  // executeTurn opens its turnSink only after the reader-quiescence gate, so
  // wait for the sink before delivering more messages — anything the reader
  // routes earlier is consumed inter-turn and never reaches the turn.
  await waitForTurnSink(runtime);

  await __testing.cleanupSessionRuntimes();

  assert.equal(runtime.closed, false);
  assert.equal(__testing.getRuntimeForSession('session-active'), runtime);

  nextDeferred.resolve({ done: false, value: { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } } });
  await turnPromise;
});

test('idle session runtime is still disposed by idle cleanup', async () => {
  const factory = createQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const context = await __testing.buildRequestContext({
    sessionId: 'session-idle',
    runtimeSessionEpoch: 'epoch-idle',
    cwd: process.cwd(),
    message: 'idle turn'
  }, false);
  const runtime = await __testing.acquireRuntime(context);
  runtime.lastUsedAt = Date.now() - (31 * 60 * 1000);

  await __testing.cleanupSessionRuntimes();

  assert.equal(runtime.closed, true);
  assert.equal(__testing.getRuntimeForSession('session-idle'), null);
});

test('active anonymous runtime is not disposed by idle cleanup while a turn is executing', async () => {
  const nextDeferred = createDeferred();
  const enteredDeferred = createDeferred();
  const factory = createSequencedQueryFactory([
    async () => {
      enteredDeferred.resolve();
      return nextDeferred.promise;
    },
    { done: false, value: { type: 'result', is_error: false } }
  ]);
  __testing.setQueryFn(factory.queryFn);

  const context = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-anon-active',
    cwd: process.cwd(),
    message: 'anonymous long running turn'
  }, false);
  const runtime = await __testing.acquireRuntime(context);
  runtime.lastUsedAt = Date.now() - (11 * 60 * 1000);

  const turnPromise = __testing.executeTurn(runtime, context);
  await enteredDeferred.promise;
  // See above: hold scripted deliveries until the turn sink exists.
  await waitForTurnSink(runtime);

  await __testing.cleanupAnonymousRuntimes();

  assert.equal(runtime.closed, false);
  assert.equal(__testing.getSnapshot().anonymousRuntimeCount, 1);

  nextDeferred.resolve({ done: false, value: { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } } });
  await turnPromise;
});

test('executeTurn refreshes lastUsedAt while processing query events', async () => {
  // Gate the first scripted message on the turn sink: the perpetual reader
  // calls next() as soon as the runtime is created, so an instantly-resolving
  // step would be routed inter-turn before executeTurn opens its sink.
  const gate = createDeferred();
  const factory = createSequencedQueryFactory([
    async () => {
      await gate.promise;
      return { done: false, value: { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } } };
    },
    { done: false, value: { type: 'result', is_error: false } }
  ]);
  __testing.setQueryFn(factory.queryFn);

  const context = await __testing.buildRequestContext({
    sessionId: 'session-refresh',
    runtimeSessionEpoch: 'epoch-refresh',
    cwd: process.cwd(),
    message: 'refresh lastUsedAt'
  }, false);
  const runtime = await __testing.acquireRuntime(context);
  runtime.lastUsedAt = 1;

  const turnPromise = __testing.executeTurn(runtime, context);
  await waitForTurnSink(runtime);
  gate.resolve();
  await turnPromise;

  assert.ok(runtime.lastUsedAt > 1);
});

test('abortCurrentTurn still disposes an active runtime explicitly', async () => {
  const nextDeferred = createDeferred();
  const enteredDeferred = createDeferred();
  const factory = createSequencedQueryFactory([
    async () => {
      enteredDeferred.resolve();
      return nextDeferred.promise;
    }
  ]);
  __testing.setQueryFn(factory.queryFn);

  const context = await __testing.buildRequestContext({
    sessionId: 'session-abort',
    runtimeSessionEpoch: 'epoch-abort',
    cwd: process.cwd(),
    message: 'abort me'
  }, false);
  const runtime = await __testing.acquireRuntime(context);
  const turnPromise = __testing.executeTurn(runtime, context);
  await enteredDeferred.promise;
  // Let executeTurn clear the quiescence gate and open its sink so abort's
  // sink.fail('Turn aborted') is what settles the turn promise (otherwise the
  // abort disposes the runtime first and the gate throws 'Runtime closed').
  await waitForTurnSink(runtime);

  await __testing.abortCurrentTurn();
  nextDeferred.reject(new Error('runtime terminated'));

  // abortCurrentTurn fails the turnSink with 'Turn aborted' before the reader's
  // next() rejects, so the turn promise settles on the abort signal rather than
  // the downstream 'runtime terminated' rejection.
  await assert.rejects(turnPromise, /Turn aborted/);
  assert.equal(runtime.closed, true);
});
