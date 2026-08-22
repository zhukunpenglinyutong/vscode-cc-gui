import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  captureAppendWriters,
  createDebugGatedOutputChannel,
} from '../debugOutputChannel.ts';

type LineSink = { lines: string[]; disposed: boolean; name: string };

/**
 * Mimic VS Code: same name returns the same channel instance until disposed.
 * Methods live on the instance (own properties), like real OutputChannel.
 */
function createFakeChannelFactory() {
  const byName = new Map<string, { api: any; sink: LineSink }>();

  const create = (name: string) => {
    const existing = byName.get(name);
    if (existing && !existing.sink.disposed) {
      return existing.api;
    }
    const sink: LineSink = { lines: [], disposed: false, name };
    const api: any = {
      name,
      append(value: string) {
        if (sink.disposed) return;
        sink.lines.push(value);
      },
      appendLine(value: string) {
        if (sink.disposed) return;
        sink.lines.push(value);
      },
      replace(value: string) {
        if (sink.disposed) return;
        sink.lines = [value];
      },
      clear() {
        sink.lines = [];
      },
      show() {},
      hide() {},
      dispose() {
        sink.disposed = true;
        byName.delete(name);
      },
    };
    byName.set(name, { api, sink });
    return api;
  };
  return {
    create,
    getSink(name: string) {
      return byName.get(name)?.sink;
    },
  };
}

describe('createDebugGatedOutputChannel', () => {
  it('disposes a prior channel so a poisoned instance is not reused', () => {
    const { create, getSink } = createFakeChannelFactory();
    let enabled = false;

    const first = createDebugGatedOutputChannel('CC GUI', () => enabled, create);
    first.raw.appendLine = () => {};
    first.raw.append = () => {};
    const poisonedSink = getSink('CC GUI');
    assert.ok(poisonedSink);

    const second = createDebugGatedOutputChannel('CC GUI', () => enabled, create);
    assert.equal(poisonedSink.disposed, true);

    enabled = true;
    second.log.appendLine('hello after re-create');
    const live = getSink('CC GUI');
    assert.ok(live);
    assert.equal(live.disposed, false);
    assert.deepEqual(live.lines, ['hello after re-create']);
  });

  it('gates appendLine when disabled and writes when enabled', () => {
    const { create, getSink } = createFakeChannelFactory();
    let enabled = false;
    const gated = createDebugGatedOutputChannel('CC GUI', () => enabled, create);

    gated.log.appendLine('hidden');
    assert.deepEqual(getSink('CC GUI')?.lines, []);

    enabled = true;
    gated.log.appendLine('visible');
    assert.deepEqual(getSink('CC GUI')?.lines, ['visible']);
  });

  it('forceAppendLine always writes regardless of the gate', () => {
    const { create, getSink } = createFakeChannelFactory();
    const gated = createDebugGatedOutputChannel('CC GUI', () => false, create);

    gated.forceAppendLine('always');
    assert.deepEqual(getSink('CC GUI')?.lines, ['always']);
  });

  it('does not lose the real writer after enable→disable→enable cycles', () => {
    const { create, getSink } = createFakeChannelFactory();
    let enabled = true;
    const gated = createDebugGatedOutputChannel('CC GUI', () => enabled, create);

    gated.log.appendLine('on-1');
    enabled = false;
    gated.log.appendLine('off');
    enabled = true;
    gated.log.appendLine('on-2');

    assert.deepEqual(getSink('CC GUI')?.lines, ['on-1', 'on-2']);
  });

  it('bound forceAppendLine keeps writing even if channel.appendLine is later no-opped', () => {
    const { create, getSink } = createFakeChannelFactory();
    const gated = createDebugGatedOutputChannel('CC GUI', () => true, create);
    gated.raw.appendLine = () => {};
    gated.forceAppendLine('via-bound');
    assert.deepEqual(getSink('CC GUI')?.lines, ['via-bound']);
  });

  it('captureAppendWriters does not throw when appendLine is missing', () => {
    const channel = { name: 'x' } as unknown as { appendLine?: unknown; append?: unknown };
    const writers = captureAppendWriters(channel as any);
    assert.doesNotThrow(() => writers.forceAppendLine('noop'));
    assert.doesNotThrow(() => writers.forceAppend('noop'));
  });
});
