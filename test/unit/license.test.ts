import { describe, expect, it } from 'vitest';
import { FEATURES, isFeatureEnabled, isValidKeyFormat, tierOf } from '../../src/license/license';

describe('license', () => {
  it('UT-LIC-01 free はキー不要', () => {
    expect(tierOf('structureView')).toBe('free');
    expect(isFeatureEnabled('structureView')).toBe(true);
    expect(isFeatureEnabled('openInEditor', undefined)).toBe(true);
  });

  it('UT-LIC-02 pro はキー必須', () => {
    for (const f of ['ifdefToggle', 'pinMap', 'snippets', 'addressMap'] as const) {
      expect(FEATURES[f]).toBe('pro');
      expect(isFeatureEnabled(f)).toBe(false);
      expect(isFeatureEnabled(f, 'wrong')).toBe(false);
      expect(isFeatureEnabled(f, 'DTV-AB12-CD34-EF56-GH78')).toBe(true);
    }
    expect(isValidKeyFormat(' DTV-AAAA-BBBB-CCCC-DDDD ')).toBe(true);
    expect(isValidKeyFormat('')).toBe(false);
  });
});
