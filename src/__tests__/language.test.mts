import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_UI_LANGUAGE,
  isSupportedUiLanguage,
  mapVscodeLocaleToLanguage,
  resolveLanguageConfig,
} from '../language.ts';

describe('mapVscodeLocaleToLanguage', () => {
  it('maps Simplified Chinese variants to zh', () => {
    assert.equal(mapVscodeLocaleToLanguage('zh-cn'), 'zh');
    assert.equal(mapVscodeLocaleToLanguage('zh-CN'), 'zh');
    assert.equal(mapVscodeLocaleToLanguage('zh-hans'), 'zh');
    assert.equal(mapVscodeLocaleToLanguage('zh'), 'zh');
  });

  it('maps Traditional Chinese variants to zh-TW', () => {
    assert.equal(mapVscodeLocaleToLanguage('zh-tw'), 'zh-TW');
    assert.equal(mapVscodeLocaleToLanguage('zh-TW'), 'zh-TW');
    assert.equal(mapVscodeLocaleToLanguage('zh-hk'), 'zh-TW');
    assert.equal(mapVscodeLocaleToLanguage('zh-hant'), 'zh-TW');
  });

  it('maps common locales to supported languages', () => {
    assert.equal(mapVscodeLocaleToLanguage('en'), 'en');
    assert.equal(mapVscodeLocaleToLanguage('en-us'), 'en');
    assert.equal(mapVscodeLocaleToLanguage('ja'), 'ja');
    assert.equal(mapVscodeLocaleToLanguage('ko-kr'), 'ko');
    assert.equal(mapVscodeLocaleToLanguage('fr-fr'), 'fr');
    assert.equal(mapVscodeLocaleToLanguage('es'), 'es');
    assert.equal(mapVscodeLocaleToLanguage('ru'), 'ru');
    assert.equal(mapVscodeLocaleToLanguage('hi'), 'hi');
    assert.equal(mapVscodeLocaleToLanguage('pt-br'), 'pt-BR');
    assert.equal(mapVscodeLocaleToLanguage('pt'), 'pt-BR');
  });

  it('falls back to Simplified Chinese for empty or unknown locales', () => {
    assert.equal(mapVscodeLocaleToLanguage(''), DEFAULT_UI_LANGUAGE);
    assert.equal(mapVscodeLocaleToLanguage(null), DEFAULT_UI_LANGUAGE);
    assert.equal(mapVscodeLocaleToLanguage(undefined), DEFAULT_UI_LANGUAGE);
    assert.equal(mapVscodeLocaleToLanguage('de'), DEFAULT_UI_LANGUAGE);
    assert.equal(mapVscodeLocaleToLanguage('it-IT'), DEFAULT_UI_LANGUAGE);
  });
});

describe('resolveLanguageConfig', () => {
  it('prefers manual user language over IDE locale', () => {
    assert.deepEqual(resolveLanguageConfig('en', 'zh-cn'), {
      language: 'en',
      source: 'user',
      ideaLocale: 'zh-cn',
      manuallySet: true,
    });
  });

  it('follows IDE locale when user language is empty', () => {
    assert.deepEqual(resolveLanguageConfig('', 'zh-cn'), {
      language: 'zh',
      source: 'idea',
      ideaLocale: 'zh-cn',
      manuallySet: false,
    });
    assert.deepEqual(resolveLanguageConfig(undefined, 'ja'), {
      language: 'ja',
      source: 'idea',
      ideaLocale: 'ja',
      manuallySet: false,
    });
  });

  it('ignores unsupported user language and follows IDE', () => {
    assert.deepEqual(resolveLanguageConfig('de', 'en'), {
      language: 'en',
      source: 'idea',
      ideaLocale: 'en',
      manuallySet: false,
    });
  });

  it('defaults to Chinese when neither user nor IDE locale is usable', () => {
    assert.deepEqual(resolveLanguageConfig('', ''), {
      language: 'zh',
      source: 'idea',
      ideaLocale: undefined,
      manuallySet: false,
    });
  });
});

describe('isSupportedUiLanguage', () => {
  it('accepts known codes only', () => {
    assert.equal(isSupportedUiLanguage('zh'), true);
    assert.equal(isSupportedUiLanguage('pt-BR'), true);
    assert.equal(isSupportedUiLanguage('de'), false);
    assert.equal(isSupportedUiLanguage(''), false);
  });
});
