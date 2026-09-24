/** 機能ごとの free / pro 区分。今回は区分表と判定関数だけ（有料機能そのものはまだ無い）。 */
export type Tier = 'free' | 'pro';

export const FEATURES = {
  structureView: 'free',
  openInEditor: 'free',
  selectTopDts: 'free',
  macroPanel: 'free',
  dtcDiagnostics: 'free',
  ifdefToggle: 'pro',
  pinMap: 'pro',
  snippets: 'pro',
  addressMap: 'pro',
} as const satisfies Record<string, Tier>;

export type Feature = keyof typeof FEATURES;

export function tierOf(feature: Feature): Tier {
  return FEATURES[feature];
}

/** キーの形だけ見る（DTV-XXXX-XXXX-XXXX-XXXX）。本物の検証は後で入れる。 */
export function isValidKeyFormat(key: string | undefined): boolean {
  return !!key && /^DTV(-[0-9A-Z]{4}){4}$/.test(key.trim());
}

/** その機能が使えるか。free はキー不要、pro はキー必須 */
export function isFeatureEnabled(feature: Feature, licenseKey?: string): boolean {
  return tierOf(feature) === 'free' || isValidKeyFormat(licenseKey);
}
