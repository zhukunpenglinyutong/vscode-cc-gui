import { describe, expect, it } from 'vitest';
import { CODEX_PROVIDER_PRESETS, PROVIDER_PRESETS } from './provider';

describe('PROVIDER_PRESETS', () => {
  it('uses the current DeepSeek Anthropic-compatible defaults', () => {
    const deepseek = PROVIDER_PRESETS.find(provider => provider.id === 'deepseek');

    expect(deepseek?.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
    });
  });

  it('uses the current Xiaomi MiMo model for all Claude model slots', () => {
    const xiaomi = PROVIDER_PRESETS.find(provider => provider.id === 'xiaomi');

    expect(xiaomi?.env).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.5-pro',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.5-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro',
    });
  });

  it('uses the Cheaper Inference Anthropic-compatible endpoint', () => {
    const cheaperInference = PROVIDER_PRESETS.find(provider => provider.id === 'cheaper-inference');

    expect(cheaperInference?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.cheaperinference.com',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4.5',
    });
  });
});

describe('CODEX_PROVIDER_PRESETS', () => {
  it('does not include DeepSeek (Claude Anthropic-compatible only)', () => {
    expect(CODEX_PROVIDER_PRESETS.find(preset => preset.id === 'deepseek')).toBeUndefined();
  });

  it('uses the Cheaper Inference OpenAI-compatible endpoint', () => {
    const configToml = CODEX_PROVIDER_PRESETS.find(preset => preset.id === 'cheaper-inference')?.configToml;

    expect(configToml).toContain('base_url = "https://api.cheaperinference.com/v1"');
    expect(configToml).toContain('wire_api = "responses"');
  });
});
