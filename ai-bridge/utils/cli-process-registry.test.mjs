import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';

// request-context uses ALS; drive register via requestContext.run
import { requestContext } from './request-context.js';
import {
  registerCliProcess,
  abortCliProcesses,
  listActiveCliRequestIds,
} from './cli-process-registry.js';

test('registerCliProcess tracks by request id and abort kills it', async () => {
  let killed = 0;
  await requestContext.run({ id: 'req-a' }, async () => {
    registerCliProcess(() => {
      killed += 1;
    }, 'test');
    assert.deepEqual(listActiveCliRequestIds(), ['req-a']);
  });

  const result = abortCliProcesses(['req-a']);
  assert.deepEqual(result, ['req-a']);
  assert.equal(killed, 1);
  assert.deepEqual(listActiveCliRequestIds(), []);
});

test('scoped empty abort kills none; unscoped kills all', async () => {
  let a = 0;
  let b = 0;
  await requestContext.run({ id: 'r1' }, async () => {
    registerCliProcess(() => {
      a += 1;
    }, 'A');
  });
  await requestContext.run({ id: 'r2' }, async () => {
    registerCliProcess(() => {
      b += 1;
    }, 'B');
  });

  assert.deepEqual(abortCliProcesses([]).sort(), []);
  assert.equal(a, 0);
  assert.equal(b, 0);
  assert.equal(listActiveCliRequestIds().length, 2);

  const killed = abortCliProcesses(undefined).sort();
  assert.deepEqual(killed, ['r1', 'r2']);
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test('unregister removes entry so abort is a no-op', async () => {
  let killed = 0;
  await requestContext.run({ id: 'req-x' }, async () => {
    const unregister = registerCliProcess(() => {
      killed += 1;
    }, 'X');
    unregister();
  });
  assert.deepEqual(abortCliProcesses(['req-x']), []);
  assert.equal(killed, 0);
});
