import { describe, expect, it } from 'vitest';
import {
  DSH_PRESET_NONE,
  DSH_PRESETS,
  getUserDshPresetOptions,
  isValidDshPreset,
} from './types';

describe('isValidDshPreset', () => {
  it('accepts the empty (default composition) preset', () => {
    expect(isValidDshPreset(DSH_PRESET_NONE)).toBe(true);
  });

  it('accepts every curated preset id', () => {
    for (const preset of DSH_PRESETS) {
      expect(isValidDshPreset(preset.id)).toBe(true);
    }
  });

  it('rejects unknown ids and non-strings', () => {
    expect(isValidDshPreset('no-such-preset')).toBe(false);
    expect(isValidDshPreset(undefined)).toBe(false);
    expect(isValidDshPreset(null)).toBe(false);
    expect(isValidDshPreset(42)).toBe(false);
  });
});

describe('getUserDshPresetOptions', () => {
  it('returns no options when nothing was injected', () => {
    window.__INITIAL_DSH_PRESETS__ = undefined;
    expect(getUserDshPresetOptions()).toEqual([]);
  });

  it('maps injected user preset ids and filters curated/blank entries', () => {
    window.__INITIAL_DSH_PRESETS__ = ['router-standard', 'standard', '  ', 'router-flash'];
    const options = getUserDshPresetOptions();
    expect(options.map((option) => option.id)).toEqual(['router-standard', 'router-flash']);
    expect(options[0].label).toBe('router-standard');
    expect(options[0].descriptionKey).toBe('dshPresets.user.description');
  });

  it('makes injected user presets valid selections', () => {
    window.__INITIAL_DSH_PRESETS__ = ['router-standard'];
    expect(isValidDshPreset('router-standard')).toBe(true);
    window.__INITIAL_DSH_PRESETS__ = undefined;
  });
});
