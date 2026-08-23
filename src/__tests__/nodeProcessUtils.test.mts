import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyProcess,
  collectProtectedPids,
  providerForCommand,
} from '../bridge/handlers/nodeProcessUtils.ts';

describe('providerForCommand word-boundary detection', () => {
  it('detects grok in real CLI / ACP commands', () => {
    assert.equal(providerForCommand('/Users/dev/.grok/bin/grok agent stdio'), 'grok');
    assert.equal(providerForCommand('node /opt/tools/grok-agent/index.js'), 'grok');
    // Real-world Antigravity-style path pinned by jetbrains NodeProcessRegistryHelpersTest.
    assert.equal(providerForCommand('/home/dev/.antig-grok/bin/node server.js'), 'grok');
  });

  it('does not mislabel coincidental path segments as grok', () => {
    // Username "grokky" must not tag an unrelated process as grok.
    assert.equal(providerForCommand('/Users/grokky/project/node_modules/.bin/vite'), undefined);
    assert.equal(providerForCommand('node /tmp/grokky-server.js'), undefined);
  });

  it('keeps the other providers intact', () => {
    assert.equal(providerForCommand('node /usr/local/bin/codex'), 'codex');
    assert.equal(providerForCommand('node ~/.claude/local/claude'), 'claude');
    assert.equal(providerForCommand('kimi-cli serve'), 'kimi');
    assert.equal(providerForCommand('opencode run'), 'opencode');
    assert.equal(providerForCommand('pi --headless'), 'pi');
    assert.equal(providerForCommand('omp serve'), 'omp');
  });
});

describe('collectProtectedPids / classifyProcess daemon-tree protection', () => {
  const bridgePid = 1000;
  const rows = [
    { pid: 1000, ppid: 1, command: 'node /ext/ai-bridge/daemon.js' },
    // Persistent Grok ACP runtime spawned by the daemon.
    { pid: 1001, ppid: 1000, command: '/Users/dev/.grok/bin/grok agent stdio' },
    // Grandchild of the daemon (e.g. terminal command run by the agent).
    { pid: 1002, ppid: 1001, command: 'node ./build.js' },
    // One-shot channel-manager fallback process tree.
    { pid: 1003, ppid: 999, command: 'node /ext/ai-bridge/channel-manager.js grok send' },
    { pid: 1004, ppid: 1003, command: '/Users/dev/.grok/bin/grok agent stdio' },
    // Genuine orphan: a stray node process not under any live root.
    { pid: 1005, ppid: 1, command: 'node /somewhere/else/leftover-server.js' },
  ];
  const protectedPids = collectProtectedPids(rows, bridgePid);

  it('keeps grok agent stdio daemon children out of the orphan set', () => {
    assert.equal(classifyProcess(rows[1], bridgePid, protectedPids), 'CHANNEL');
    assert.equal(classifyProcess(rows[2], bridgePid, protectedPids), 'CHANNEL');
  });

  it('keeps channel-manager children out of the orphan set', () => {
    assert.equal(classifyProcess(rows[4], bridgePid, protectedPids), 'CHANNEL');
  });

  it('still classifies real orphans as ORPHAN', () => {
    assert.equal(classifyProcess(rows[5], bridgePid, protectedPids), 'ORPHAN');
  });

  it('classifies the bridge daemon itself as DAEMON', () => {
    assert.equal(classifyProcess(rows[0], bridgePid, protectedPids), 'DAEMON');
  });
});
