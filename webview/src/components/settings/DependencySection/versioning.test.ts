import { describe, expect, it } from 'vitest';
import {
  buildVersionOptions,
  getRequestedVersion,
  getVersionAction,
} from './versioning';

describe('DependencySection versioning helpers', () => {
  it('uses the selected dropdown version as the requested version', () => {
    expect(getRequestedVersion(' v0.2.88 ')).toBe('0.2.88');
  });

  it('returns undefined when no dropdown version is selected', () => {
    expect(getRequestedVersion('')).toBeUndefined();
  });

  it('classifies a higher target version as an update', () => {
    expect(getVersionAction({
      installedVersion: '0.2.81',
      requestedVersion: '0.2.88',
      installed: true,
    })).toBe('update');
  });

  it('classifies a lower target version as a rollback', () => {
    expect(getVersionAction({
      installedVersion: '0.2.88',
      requestedVersion: '0.2.81',
      installed: true,
    })).toBe('rollback');
  });

  it('classifies the installed version as current when target matches', () => {
    expect(getVersionAction({
      installedVersion: '0.2.88',
      requestedVersion: '0.2.88',
      installed: true,
    })).toBe('current');
  });

  it('keeps the installed version in the options even when it was not returned by the registry', () => {
    expect(buildVersionOptions({
      availableVersions: ['0.2.90', '0.2.89'],
      fallbackVersions: ['0.2.88'],
      installedVersion: '0.2.81',
    })).toEqual(['0.2.90', '0.2.89', '0.2.88', '0.2.81']);
  });

});
