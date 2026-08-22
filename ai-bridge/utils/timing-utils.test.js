import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { debounce, throttle } from './timing-utils.js';

test('debounce invokes once with the latest arguments after calls settle', async () => {
  const calls = [];
  const debounced = debounce((value) => calls.push(value), 20);

  debounced('a');
  debounced('b');
  debounced('c');

  assert.equal(debounced.pending(), true);
  assert.deepEqual(calls, []);

  await sleep(30);

  assert.equal(debounced.pending(), false);
  assert.deepEqual(calls, ['c']);
});

test('debounce supports leading-only calls', async () => {
  const calls = [];
  const debounced = debounce((value) => calls.push(value), 20, {
    leading: true,
    trailing: false,
  });

  debounced('first');
  debounced('second');

  assert.deepEqual(calls, ['first']);

  await sleep(30);

  assert.deepEqual(calls, ['first']);
});

test('debounce flush invokes pending trailing call immediately', () => {
  const calls = [];
  const debounced = debounce((value) => {
    calls.push(value);
    return value.toUpperCase();
  }, 50);

  debounced('ready');

  assert.equal(debounced.pending(), true);
  assert.equal(debounced.flush(), 'READY');
  assert.equal(debounced.pending(), false);
  assert.deepEqual(calls, ['ready']);
});

test('debounce cancel drops pending work', async () => {
  const calls = [];
  const debounced = debounce((value) => calls.push(value), 10);

  debounced('skip');
  debounced.cancel();

  await sleep(20);

  assert.deepEqual(calls, []);
});

test('throttle invokes immediately by default and keeps the latest trailing call', async () => {
  const calls = [];
  const throttled = throttle((value) => calls.push(value), 30);

  throttled('a');
  throttled('b');
  throttled('c');

  assert.deepEqual(calls, ['a']);
  assert.equal(throttled.pending(), true);

  await sleep(40);

  assert.equal(throttled.pending(), false);
  assert.deepEqual(calls, ['a', 'c']);
});

test('throttle can defer the first call when leading is false', async () => {
  const calls = [];
  const throttled = throttle((value) => calls.push(value), 20, {
    leading: false,
  });

  throttled('a');
  throttled('b');

  assert.deepEqual(calls, []);

  await sleep(30);

  assert.deepEqual(calls, ['b']);
});

test('throttle flush invokes pending trailing call immediately', () => {
  const calls = [];
  const throttled = throttle((value) => {
    calls.push(value);
    return value.length;
  }, 50);

  throttled('one');
  throttled('three');

  assert.deepEqual(calls, ['one']);
  assert.equal(throttled.pending(), true);
  assert.equal(throttled.flush(), 5);
  assert.equal(throttled.pending(), false);
  assert.deepEqual(calls, ['one', 'three']);
});

test('throttle cancel resets pending work and leading state', async () => {
  const calls = [];
  const throttled = throttle((value) => calls.push(value), 30);

  throttled('a');
  throttled('b');
  throttled.cancel();
  throttled('c');

  assert.deepEqual(calls, ['a', 'c']);

  await sleep(40);

  assert.deepEqual(calls, ['a', 'c']);
});

test('timing helpers preserve this binding', async () => {
  const context = {
    prefix: 'value:',
    calls: [],
    debounced: debounce(function recordDebounced(value) {
      this.calls.push(`${this.prefix}${value}`);
    }, 10),
    throttled: throttle(function recordThrottled(value) {
      this.calls.push(`${this.prefix}${value}`);
    }, 10),
  };

  context.debounced('debounce');
  context.throttled('throttle');

  await sleep(20);

  assert.deepEqual(context.calls, ['value:throttle', 'value:debounce']);
});

test('timing helpers validate callback arguments', () => {
  assert.throws(() => debounce(null), /expected a function/);
  assert.throws(() => throttle(null), /expected a function/);
});
