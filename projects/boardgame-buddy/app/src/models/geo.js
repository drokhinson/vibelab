// geo — which country a play happened in (migration 065).
//
// The native port of web/domain/geo.js, minus the parts that need a UI. Read
// that file's header for why this is the device timezone rather than
// expo-location: a permission prompt on the Settle Up screen would cost more
// than the field is worth, and coordinates are a far more sensitive value than
// the coarse one we actually want.
//
// WHAT IS MISSING HERE, ON PURPOSE. The web app shows the resolved country on
// Settle Up and lets the host correct it through a picker sheet; that
// correction is what the sticky-pick logic in the web module exists for. This
// app has neither yet, so it detects and sends, and the value it sends can be
// corrected from the web app's play list. Adding the picker here is the
// follow-up — when it lands, port the sticky rule with it rather than
// re-inventing one.
//
// RESOLUTION ORDER:
//   1. The device timezone, via geoZones.js.
//   2. The region of the device locale ("en_DE" → DE), read straight off the
//      platform rather than through a dependency.
//   3. null. "We don't know" is a legitimate value for the column; a guess is
//      not, because it would poison the aggregate the column exists for.

import { NativeModules, Platform } from 'react-native';

import { ALIAS_ZONES, ZONES_BY_COUNTRY } from './geoZones';

const CODE_RE = /^[A-Z]{2}$/;

let zoneToCountry = null;
let knownCodes = null;

function buildIndex() {
  if (zoneToCountry) return;
  const map = {};
  const codes = [];
  ZONES_BY_COUNTRY.split('\n').forEach((line) => {
    const parts = line.trim().split(/\s+/);
    const code = parts.shift();
    if (!code || !CODE_RE.test(code)) return;
    codes.push(code);
    parts.forEach((zone) => { if (zone) map[zone] = code; });
  });
  ALIAS_ZONES.split('\n').forEach((line) => {
    const [zone, code] = line.trim().split(/\s+/);
    if (zone && code && CODE_RE.test(code) && !map[zone]) map[zone] = code;
  });
  zoneToCountry = map;
  knownCodes = codes;
}

/** The device's IANA timezone, or '' when the platform won't say. */
export function currentTimezone() {
  try {
    return (Intl.DateTimeFormat().resolvedOptions().timeZone || '').trim();
  } catch {
    return '';
  }
}

/**
 * The device's locale tag, without pulling in expo-localization for one field.
 * iOS exposes it through SettingsManager, Android through I18nManager; both
 * hand back something like "en_DE" or "en-DE".
 */
function deviceLocale() {
  try {
    if (Platform.OS === 'ios') {
      const s = NativeModules.SettingsManager?.settings;
      return s?.AppleLocale || (Array.isArray(s?.AppleLanguages) ? s.AppleLanguages[0] : '') || '';
    }
    return NativeModules.I18nManager?.localeIdentifier || '';
  } catch {
    return '';
  }
}

/**
 * A country's name in the user's language, falling back to the bare code.
 *
 * Intl.DisplayNames is present in RN's Hermes builds with Intl, but not
 * guaranteed on every engine configuration this app might be built with — so
 * every call path has to survive its absence, and the code is what gets shown
 * when it does. That is the value actually stored on the play, so it is never
 * misleading, only terse.
 */
export function countryName(code) {
  const value = String(code || '').toUpperCase();
  if (!CODE_RE.test(value)) return '';
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(value) || value;
  } catch {
    return value;
  }
}

/** Is this a country the table knows about? */
export function isKnownCountry(code) {
  buildIndex();
  return !!code && knownCodes.indexOf(String(code).toUpperCase()) !== -1;
}

/**
 * The country to stamp on a play being logged right now.
 * @returns {string|null} ISO 3166-1 alpha-2, upper case, or null when unknown.
 */
export function countryForPlay() {
  buildIndex();
  const tz = currentTimezone();
  if (tz && zoneToCountry[tz]) return zoneToCountry[tz];

  const region = String(deviceLocale()).split(/[-_]/)[1];
  if (region) {
    const code = region.toUpperCase();
    // Checked against the table so a locale like "en-419" (a UN M49 region,
    // not a country) can't land a non-ISO value in the column.
    if (CODE_RE.test(code) && isKnownCountry(code)) return code;
  }
  return null;
}
