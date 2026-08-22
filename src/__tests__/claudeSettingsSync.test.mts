import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planClaudeSettingsSync } from '../bridge/services/claudeSettingsSync.ts';

describe('planClaudeSettingsSync', () => {
  it('skips local settings mode so user/cc-switch credentials stay intact', () => {
    const decision = planClaudeSettingsSync(
      { env: { ANTHROPIC_AUTH_TOKEN: 'keep-me' } },
      { id: '__local_settings_json__', isActive: true },
    );
    assert.deepEqual(decision, { action: 'skip', reason: 'no-managed-provider' });
  });

  it('skips when no provider is active (would otherwise wipe env to empty)', () => {
    const decision = planClaudeSettingsSync(
      { env: { ANTHROPIC_AUTH_TOKEN: 'keep-me', ANTHROPIC_BASE_URL: 'https://example.test' } },
      null,
    );
    assert.deepEqual(decision, { action: 'skip', reason: 'no-managed-provider' });
  });

  it('skips managed providers that have an empty env payload', () => {
    const decision = planClaudeSettingsSync(
      { env: { ANTHROPIC_AUTH_TOKEN: 'keep-me' }, model: 'claude-opus-4-8' },
      { id: 'proxy-a', settingsConfig: { model: 'claude-opus-4-8' }, isActive: true },
    );
    assert.deepEqual(decision, { action: 'skip', reason: 'empty-env-payload' });
  });

  it('writes env when active provider has a real env payload', () => {
    const decision = planClaudeSettingsSync(
      {
        model: 'claude-opus-4-8',
        env: {
          ANTHROPIC_AUTH_TOKEN: 'old',
          ANTHROPIC_BASE_URL: 'https://old.test',
          CUSTOM_KEEP: '1',
        },
      },
      {
        id: 'proxy-b',
        isActive: true,
        settingsConfig: {
          env: {
            ANTHROPIC_AUTH_TOKEN: 'new',
            ANTHROPIC_BASE_URL: 'https://new.test',
          },
        },
      },
    );
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.equal(decision.nextSettings.env.ANTHROPIC_AUTH_TOKEN, 'new');
    assert.equal(decision.nextSettings.env.ANTHROPIC_BASE_URL, 'https://new.test');
    assert.equal(decision.nextSettings.env.CUSTOM_KEEP, '1');
    assert.equal(decision.nextSettings.model, 'claude-opus-4-8');
  });

  it('writes CLI login flag without requiring env payload', () => {
    const decision = planClaudeSettingsSync(
      { env: { ANTHROPIC_AUTH_TOKEN: 'old' } },
      { id: '__cli_login__', isActive: true },
    );
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.equal(decision.nextSettings.env.CCGUI_CLI_LOGIN_AUTHORIZED, '1');
    assert.equal(decision.nextSettings.env.ANTHROPIC_AUTH_TOKEN, undefined);
  });
});
