import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planClaudeSettingsSync } from '../bridge/services/claudeSettingsSync.ts';

function buildProvider(id: string, model: string) {
  return {
    id,
    name: `Test Provider ${id}`,
    isActive: true,
    settingsConfig: {
      model,
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-provider-key',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      },
    },
  };
}

const MINIMAX = {
  id: 'minimax',
  isActive: false,
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'mm-token',
      API_TIMEOUT_MS: '3000000',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3',
    },
  },
};

const DEEPSEEK = {
  id: 'deepseek',
  isActive: true,
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'ds-token',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
    },
  },
};

describe('planClaudeSettingsSync', () => {
  it('skips local settings mode so user/cc-switch credentials stay intact', () => {
    const decision = planClaudeSettingsSync(
      { env: { ANTHROPIC_AUTH_TOKEN: 'keep-me' } },
      { id: '__local_settings_json__', isActive: true },
    );
    assert.deepEqual(decision, { action: 'skip', reason: 'sync-exempt-mode' });
  });

  it('skips CLI login mode without touching settings.json', () => {
    const decision = planClaudeSettingsSync(
      { env: { ANTHROPIC_AUTH_TOKEN: 'keep-me' } },
      { id: '__cli_login__', isActive: true },
    );
    assert.deepEqual(decision, { action: 'skip', reason: 'sync-exempt-mode' });
  });

  it('skips when no provider is active', () => {
    const decision = planClaudeSettingsSync(
      { env: { ANTHROPIC_AUTH_TOKEN: 'keep-me' } },
      null,
    );
    assert.deepEqual(decision, { action: 'skip', reason: 'sync-exempt-mode' });
  });

  it('skips managed providers that have an empty env payload', () => {
    const decision = planClaudeSettingsSync(
      { env: { ANTHROPIC_AUTH_TOKEN: 'keep-me' }, model: 'claude-opus-4-8' },
      { id: 'proxy-a', settingsConfig: { model: 'claude-opus-4-8' }, isActive: true },
    );
    assert.deepEqual(decision, { action: 'skip', reason: 'empty-env-payload' });
  });

  it('skips providers without settingsConfig as a graceful no-op', () => {
    const decision = planClaudeSettingsSync(undefined, { id: 'p1', isActive: true });
    assert.deepEqual(decision, { action: 'skip', reason: 'empty-env-payload' });
  });

  it('writes provider fields on a fresh install', () => {
    const decision = planClaudeSettingsSync(undefined, buildProvider('p1', 'claude-sonnet-4-6'));
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.equal(decision.nextSettings.model, 'claude-sonnet-4-6');
    assert.equal(decision.nextSettings.env.ANTHROPIC_API_KEY, 'sk-ant-provider-key');
    assert.equal(decision.nextSettings.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
    assert.equal(decision.nextSettings.codemossProviderId, 'p1');
  });

  // Issue #16: switching MiniMax -> DeepSeek left MiniMax endpoint, token and
  // model mappings in settings.json, so requests kept going to MiniMax.
  it('switching providers replaces the previous provider endpoint, token and model mappings', () => {
    const current = {
      codemossProviderId: 'minimax',
      env: { ...MINIMAX.settingsConfig.env },
    };
    const decision = planClaudeSettingsSync(current, DEEPSEEK, MINIMAX);
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.deepEqual(decision.nextSettings.env, DEEPSEEK.settingsConfig.env);
    assert.equal(decision.nextSettings.codemossProviderId, 'deepseek');
    // Input settings object must not be mutated.
    assert.equal(current.codemossProviderId, 'minimax');
    assert.equal(current.env.ANTHROPIC_BASE_URL, 'https://api.minimaxi.com/anthropic');
  });

  it('clears managed env keys the new provider does not set', () => {
    const decision = planClaudeSettingsSync(
      { env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3', ANTHROPIC_API_KEY: 'old-key' } },
      DEEPSEEK,
    );
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.equal('ANTHROPIC_DEFAULT_HAIKU_MODEL' in decision.nextSettings.env, false);
    assert.equal('ANTHROPIC_API_KEY' in decision.nextSettings.env, false);
  });

  it('keeps user-owned env keys such as proxies', () => {
    const decision = planClaudeSettingsSync(
      { env: { HTTPS_PROXY: 'http://127.0.0.1:7890', ANTHROPIC_BASE_URL: 'https://old.example.com' } },
      DEEPSEEK,
    );
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.equal(decision.nextSettings.env.HTTPS_PROXY, 'http://127.0.0.1:7890');
    assert.equal(decision.nextSettings.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  });

  it('drops unmanaged preset values the previous provider wrote, keeps ones the user changed', () => {
    const removed = planClaudeSettingsSync(
      { codemossProviderId: 'minimax', env: { API_TIMEOUT_MS: '3000000' } },
      DEEPSEEK,
      MINIMAX,
    );
    assert.equal(removed.action, 'write');
    if (removed.action !== 'write') return;
    assert.equal('API_TIMEOUT_MS' in removed.nextSettings.env, false);

    const userEdited = planClaudeSettingsSync(
      { codemossProviderId: 'minimax', env: { API_TIMEOUT_MS: '600000' } },
      DEEPSEEK,
      MINIMAX,
    );
    assert.equal(userEdited.action, 'write');
    if (userEdited.action !== 'write') return;
    assert.equal(userEdited.nextSettings.env.API_TIMEOUT_MS, '600000');
  });

  it('does not drop unmanaged values when settings.json was written by another provider', () => {
    const decision = planClaudeSettingsSync(
      { codemossProviderId: 'someone-else', env: { API_TIMEOUT_MS: '3000000' } },
      DEEPSEEK,
      MINIMAX,
    );
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.equal(decision.nextSettings.env.API_TIMEOUT_MS, '3000000');
  });

  it('replaces top-level provider fields the new provider sets', () => {
    const decision = planClaudeSettingsSync(
      { model: 'old-model', codemossProviderId: 'old' },
      buildProvider('p1', 'claude-sonnet-4-6'),
    );
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.equal(decision.nextSettings.model, 'claude-sonnet-4-6');
    assert.equal(decision.nextSettings.codemossProviderId, 'p1');
  });

  it('preserves non-managed top-level fields (hooks, custom)', () => {
    const decision = planClaudeSettingsSync(
      { hooks: { PreToolUse: [] }, custom: 42 },
      buildProvider('p1', 'claude-sonnet-4-6'),
    );
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.deepEqual(decision.nextSettings.hooks, { PreToolUse: [] });
    assert.equal(decision.nextSettings.custom, 42);
  });

  it('ignores non-managed fields carried by the provider settingsConfig', () => {
    const provider = buildProvider('p1', 'claude-sonnet-4-6');
    (provider.settingsConfig as any).hooks = { PreToolUse: ['x'] };
    (provider.settingsConfig as any).permissions = { allow: ['Bash(ls)'] };
    const decision = planClaudeSettingsSync(undefined, provider);
    assert.equal(decision.action, 'write');
    if (decision.action !== 'write') return;
    assert.equal('hooks' in decision.nextSettings, false);
    assert.equal('permissions' in decision.nextSettings, false);
  });
});
