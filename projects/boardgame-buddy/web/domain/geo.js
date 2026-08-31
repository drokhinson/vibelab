// @ts-check
// domain/geo.js — which country a play happened in.
//
// The play row carries an ISO 3166-1 alpha-2 code (migration 065) so that
// "what gets played in Germany" is answerable later. Nothing renders that
// answer yet; this module exists so the data starts accumulating now, because
// a play logged today with no country can never be given one afterwards.
//
// WHY THE TIMEZONE AND NOT THE GEOLOCATION API. navigator.geolocation is a
// permission prompt, and a prompt on the Settle Up screen — after the game,
// while everyone is packing up — is the most expensive thing this feature
// could possibly cost. It also returns coordinates, which is a far more
// sensitive value than the one we want, for a field whose whole point is that
// it is coarse. `Intl.DateTimeFormat().resolvedOptions().timeZone` needs no
// permission, no network and no external service, is available in every
// browser this app supports, and resolves to a country almost everywhere.
// (Its known blind spots are countries that share a zone with a neighbour —
// which is exactly what the picker in Settle Up is for.)
//
// WHY NOT AN IP LOOKUP ON THE BACKEND. Railway sits behind no geo-aware edge,
// so there is no country header to read; it would mean shipping the user's IP
// to a third-party service on every play write, which is a bigger privacy
// surface than the field it fills, and a VPN gets it wrong anyway.
//
// RESOLUTION ORDER, and why the sticky pick is scoped to a timezone:
//   1. A country the user picked themselves, IF the device is still in the
//      timezone they picked it in.
//   2. The device timezone, via domain/geo-data.js.
//   3. The region subtag of the device locale ("en-GB" → GB). Weak — a locale
//      is a language preference, not a location — so it only runs when the
//      timezone told us nothing.
//   4. null. "We don't know" is a legitimate value; guessing would poison the
//      exact aggregate the column exists for.
//
// The scoping in (1) is the whole trick. A host who corrects Ireland to the UK
// once should not have to correct it again every week — but a host who flies
// to a convention in Essen should get Germany without touching anything, and a
// sticky pick that outranked detection unconditionally would quietly label
// that whole weekend as home. Tying the pick to the timezone it was made in
// gives both: same zone, trust the human; new zone, trust the device.

(function () {
  const LS_KEY = "bgb.play.country";
  const CODE_RE = /^[A-Z]{2}$/;

  /** @type {Record<string, string>|null} zone → country, built on first use. */
  let _zoneToCountry = null;
  /** @type {string[]|null} every country code we know, sorted. */
  let _codes = null;
  /** @type {any} Intl.DisplayNames instance, or false once known unavailable. */
  let _displayNames;

  function _data() {
    return window.BGB_GEO_DATA || { zonesByCountry: "", aliasZones: "" };
  }

  /** Invert geo-data's country-grouped table into the lookup we actually use. */
  function _buildIndex() {
    if (_zoneToCountry) return;
    const map = /** @type {Record<string, string>} */ ({});
    const codes = [];
    String(_data().zonesByCountry || "")
      .split("\n")
      .forEach((line) => {
        const parts = line.trim().split(/\s+/);
        const code = parts.shift();
        if (!code || !CODE_RE.test(code)) return;
        codes.push(code);
        parts.forEach((zone) => { if (zone) map[zone] = code; });
      });
    // Retired zone names, applied second so a name that is somehow in both
    // tables keeps its current-tzdata country.
    String(_data().aliasZones || "")
      .split("\n")
      .forEach((line) => {
        const [zone, code] = line.trim().split(/\s+/);
        if (zone && code && CODE_RE.test(code) && !map[zone]) map[zone] = code;
      });
    _zoneToCountry = map;
    _codes = codes.sort();
  }

  /** The device's IANA timezone, or "" when the platform won't say. */
  function currentTimezone() {
    try {
      return (Intl.DateTimeFormat().resolvedOptions().timeZone || "").trim();
    } catch (_) {
      return "";
    }
  }

  /** Step 2: timezone → country. */
  function _fromTimezone() {
    _buildIndex();
    const tz = currentTimezone();
    if (!tz) return null;
    return (_zoneToCountry && _zoneToCountry[tz]) || null;
  }

  /**
   * Step 3: the region subtag of the device locale.
   *
   * Only reached when the timezone resolved nothing, because a locale says
   * what language someone reads, not where they are — an expat keeps en-US
   * for a decade. Codes are checked against the known list so a locale like
   * "en-419" (Latin America, a UN M49 region) can't land a non-ISO value in
   * the column.
   */
  function _fromLocale() {
    _buildIndex();
    const tags = [];
    try {
      if (navigator.languages && navigator.languages.length) {
        tags.push.apply(tags, Array.prototype.slice.call(navigator.languages));
      }
      if (navigator.language) tags.push(navigator.language);
    } catch (_) { /* fall through to the empty list */ }

    for (let i = 0; i < tags.length; i++) {
      const part = String(tags[i] || "").split("-")[1];
      if (!part) continue;
      const code = part.toUpperCase();
      if (CODE_RE.test(code) && isKnown(code)) return code;
    }
    return null;
  }

  /** @returns {{code: string, tz: string}|null} the stored manual pick. */
  function _sticky() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const code = String((parsed && parsed.code) || "").toUpperCase();
      if (!CODE_RE.test(code)) return null;
      return { code, tz: String((parsed && parsed.tz) || "") };
    } catch (_) {
      return null;
    }
  }

  /** Is this a country the app knows about (and can therefore display)? */
  function isKnown(code) {
    _buildIndex();
    return !!code && (_codes || []).indexOf(String(code).toUpperCase()) !== -1;
  }

  /**
   * Detect from the device alone, ignoring any stored pick.
   * @returns {{code: string|null, source: "timezone"|"locale"|"unknown"}}
   */
  function detect() {
    const byZone = _fromTimezone();
    if (byZone) return { code: byZone, source: "timezone" };
    const byLocale = _fromLocale();
    if (byLocale) return { code: byLocale, source: "locale" };
    return { code: null, source: "unknown" };
  }

  /**
   * The country to stamp on a play being logged right now.
   *
   * The one function the play flow calls. Null means "don't send the field",
   * never "send an empty string" — the backend takes an absent country as
   * unknown and a malformed one as a validation error.
   *
   * @returns {string|null} ISO 3166-1 alpha-2, upper case.
   */
  function countryForPlay() {
    const pick = _sticky();
    if (pick && pick.tz && pick.tz === currentTimezone()) return pick.code;
    return detect().code;
  }

  /**
   * Remember a country the user picked by hand, against the timezone they
   * picked it in. Called only from the Settle Up picker — never from
   * detection, or a wrong guess would make itself permanent.
   */
  function remember(code) {
    const value = String(code || "").toUpperCase();
    if (!CODE_RE.test(value)) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ code: value, tz: currentTimezone() }));
    } catch (_) { /* private mode — the pick just won't be sticky */ }
  }

  /**
   * A country's name in the user's own language.
   *
   * Intl.DisplayNames rather than a vendored name table: ~250 English names
   * would be 6 KB of data that is wrong for every non-English speaker, when
   * the platform already holds every translation. Where it is missing (or
   * doesn't know the code) the bare code is shown — ugly, but never blank,
   * and it is the value that actually gets stored.
   */
  function countryName(code) {
    const value = String(code || "").toUpperCase();
    if (!CODE_RE.test(value)) return "";
    if (_displayNames === undefined) {
      try {
        _displayNames = new Intl.DisplayNames(undefined, { type: "region" });
      } catch (_) {
        _displayNames = false;
      }
    }
    if (!_displayNames) return value;
    try {
      return _displayNames.of(value) || value;
    } catch (_) {
      return value;
    }
  }

  /**
   * Every country, name-sorted in the user's locale, for the picker.
   * @returns {{code: string, name: string}[]}
   */
  function countryList() {
    _buildIndex();
    const collator = new Intl.Collator(undefined, { sensitivity: "base" });
    return (_codes || [])
      .map((code) => ({ code, name: countryName(code) }))
      .sort((a, b) => collator.compare(a.name, b.name));
  }

  window.Geo = {
    countryForPlay,
    countryList,
    countryName,
    currentTimezone,
    detect,
    isKnown,
    remember,
  };
})();
