import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildErrorPayload,
  isCodexConfigError,
  normalizeCodexStreamingFlag,
  normalizeRequestedSandboxMode,
} from './codex-utils.js';

test('normalizeRequestedSandboxMode accepts valid Codex sandbox modes', () => {
  assert.equal(normalizeRequestedSandboxMode('read-only'), 'read-only');
  assert.equal(normalizeRequestedSandboxMode('workspace-write'), 'workspace-write');
  assert.equal(normalizeRequestedSandboxMode('danger-full-access'), 'danger-full-access');
});

test('normalizeRequestedSandboxMode trims valid request values', () => {
  assert.equal(normalizeRequestedSandboxMode('  danger-full-access  '), 'danger-full-access');
});

test('normalizeRequestedSandboxMode ignores empty and invalid values', () => {
  assert.equal(normalizeRequestedSandboxMode(''), '');
  assert.equal(normalizeRequestedSandboxMode('full-access'), '');
  assert.equal(normalizeRequestedSandboxMode(null), '');
  assert.equal(normalizeRequestedSandboxMode({}), '');
});

test('normalizeCodexStreamingFlag defaults to true when omitted', () => {
  assert.equal(normalizeCodexStreamingFlag(null), true);
  assert.equal(normalizeCodexStreamingFlag(undefined), true);
  assert.equal(normalizeCodexStreamingFlag(''), true);
});

test('normalizeCodexStreamingFlag accepts explicit true/false-like values', () => {
  assert.equal(normalizeCodexStreamingFlag(true), true);
  assert.equal(normalizeCodexStreamingFlag('true'), true);
  assert.equal(normalizeCodexStreamingFlag('1'), true);
  assert.equal(normalizeCodexStreamingFlag(false), false);
  assert.equal(normalizeCodexStreamingFlag('false'), false);
  assert.equal(normalizeCodexStreamingFlag('0'), false);
  assert.equal(normalizeCodexStreamingFlag('off'), false);
});

test('isCodexConfigError detects config.toml failures', () => {
  assert.equal(isCodexConfigError('Error loading config.toml: duplicate key'), true);
  assert.equal(
    isCodexConfigError('model_providers contains reserved built-in provider IDs: `openai`'),
    true,
  );
  assert.equal(isCodexConfigError('fetch failed'), false);
});

test('buildErrorPayload surfaces reserved provider config guidance', () => {
  const payload = buildErrorPayload(
    new Error(
      'Error loading config.toml: model_providers contains reserved built-in provider IDs: `openai`. Built-in providers cannot be overridden. Rename your custom provider (for example, `openai-custom`).',
    ),
  );
  assert.equal(payload.success, false);
  assert.equal(payload.details.isConfigError, true);
  assert.match(payload.error, /Codex configuration error:/);
  assert.match(payload.error, /openai-custom/);
  assert.doesNotMatch(payload.error, /Please check network connection and Codex configuration/);
});

test('buildErrorPayload surfaces duplicate key config guidance', () => {
  const payload = buildErrorPayload(
    new Error('Error loading config.toml:\nC:\\Users\\Kele\\.codex\\config.toml:6:1: duplicate key'),
  );
  assert.equal(payload.details.isConfigError, true);
  assert.match(payload.error, /defined more than once/);
});
