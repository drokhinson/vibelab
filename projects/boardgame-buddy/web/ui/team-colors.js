// @ts-check
// ui/team-colors.js — which side is which colour.
//
// A team play's sides are picked on Gather from six colour circles, or typed as
// a custom name (up to six characters, because it has to fit a scoring column).
// Either way the seat stores a WORD — "Blue", or "Owls" — and migration 048
// persists it on each seat. This file is the single answer to "which of the six
// colour slots does this tag get", so the Gather discs, the play-detail popup's
// banded player list and the scoring grid's tinted column headers cannot
// disagree about which side is which.
//
// A tag that names a colour always gets THAT colour's slot; a custom name takes
// the lowest slot no colour-named side is using. So "Red" paints red wherever
// it sits in the roster, and a table of Blue vs Owls never paints Owls blue.
//
// In ui/ rather than domain/ because the answer is a PRESENTATION decision. The
// row holds "Red"; nothing in the database knows Red is slot 5.
//
// The normalization is not free choice: it has to match the comparison
// PlaySession.applyTeamTag uses to settle a side's win flags (trim, then
// lowercase). If the two ever disagreed, "Red" and "red" would share a win and
// render as two different colours — one side of the table crowned together and
// painted apart.

(function () {
  // Six is enough for any table this app can seat and small enough that the
  // hues stay far apart (they are measured: min dE 28 at full strength, see the
  // token block in styles.css). A seventh tag wraps rather than falling back to
  // no colour, because two sides sharing a tint reads as a hard-to-spot mistake
  // where an untinted seventh side reads as a bug.
  const TEAM_SLOTS = 6;

  // The circles Gather offers, in the order it offers them. `slot` points at
  // the --team-N token that already carries that hue (styles.css), so naming
  // the palette moved no colour. `label` is what gets stored on the seat.
  const TEAM_COLORS = [
    { id: "red",    label: "Red",    slot: 5 },
    { id: "orange", label: "Orange", slot: 2 },
    { id: "green",  label: "Green",  slot: 3 },
    { id: "blue",   label: "Blue",   slot: 1 },
    { id: "purple", label: "Purple", slot: 4 },
    { id: "gray",   label: "Gray",   slot: 6 },
  ];
  // Spellings a host may have typed before the circles existed, or the token
  // block's own names for the hues. They paint as the colour they name.
  const ALIASES = { grey: "gray", violet: "purple", crimson: "red", slate: "gray" };
  const BY_ID = new Map(TEAM_COLORS.map((c) => [c.id, c]));

  /**
   * The tag two seats have to share to be on one side.
   * @param {string|null|undefined} team
   * @returns {string} "" when the seat carries no side.
   */
  function keyOf(team) {
    return String(team == null ? "" : team).trim().toLowerCase();
  }

  /**
   * The palette entry a tag names, or null for a custom name / no side.
   * @param {string|null|undefined} team
   * @returns {{id: string, label: string, slot: number}|null}
   */
  function colorOf(team) {
    const key = keyOf(team);
    return BY_ID.get(ALIASES[key] || key) || null;
  }

  /**
   * tag → colour slot (1..TEAM_SLOTS).
   *
   * Two passes. A tag naming a colour is pinned to that colour's slot. Custom
   * names then take the lowest free slot in order of first appearance, and
   * wrap only once all six are spoken for — two sides sharing a tint reads as
   * a hard-to-spot mistake, but an untinted side reads as a bug.
   *
   * Callers hand over a ranked roster (Play.rankPlayers is score-descending),
   * so among custom names the winning side still gets the first free slot.
   * Both ends of a live session pass the roster in the same order, so both
   * derive the same slots.
   *
   * @param {any[]} players
   * @returns {Map<string, number>|null} null when no seat carries a side, which
   *   is the signal to render exactly as a non-team play does.
   */
  function indexMap(players) {
    const map = new Map();
    const used = new Set();
    const custom = [];
    for (const p of (players || [])) {
      const key = keyOf(p && p.team);
      if (!key || map.has(key) || custom.includes(key)) continue;
      const c = colorOf(key);
      if (c) { map.set(key, c.slot); used.add(c.slot); }
      else custom.push(key);
    }
    let wrap = 0;
    for (const key of custom) {
      let slot = 0;
      for (let n = 1; n <= TEAM_SLOTS; n++) if (!used.has(n)) { slot = n; break; }
      if (!slot) slot = (wrap++ % TEAM_SLOTS) + 1;
      used.add(slot);
      map.set(key, slot);
    }
    if (!map.size) return null;
    // Re-key in first-appearance order so iteration order stays what it was
    // before colours were pinned: callers read .values() as "the sides, in
    // roster order".
    const ordered = new Map();
    for (const p of (players || [])) {
      const key = keyOf(p && p.team);
      if (key && !ordered.has(key)) ordered.set(key, map.get(key) || 1);
    }
    return ordered;
  }

  /**
   * The roster split into sides, best side first, with the untagged seats last.
   *
   * Seats keep their input order inside a band, so a band is still ranked. The
   * trailing band carries `key: null` and no label or colour: a half-tagged
   * roster's leftovers have to look like a non-team play's list, not like a
   * side called nothing.
   *
   * `label` is the FIRST seat's original spelling, so "Red" prints the way the
   * host typed it even though the grouping ignores case.
   *
   * `isColor` is true when the side is one of the palette circles rather than
   * a custom name.
   *
   * @param {any[]} players an already-ranked roster
   * @returns {{key: string|null, label: string, index: number, isColor: boolean, players: any[]}[]|null}
   */
  function bands(players) {
    const map = indexMap(players);
    if (!map) return null;
    /** @type {Map<string, {key: string|null, label: string, index: number, isColor: boolean, players: any[]}>} */
    const byKey = new Map();
    const loose = [];
    for (const p of (players || [])) {
      const key = keyOf(p && p.team);
      if (!key) { loose.push(p); continue; }
      let band = byKey.get(key);
      if (!band) {
        band = { key, label: String(p.team).trim(), index: map.get(key) || 1,
                 isColor: !!colorOf(key), players: [] };
        byKey.set(key, band);
      }
      band.players.push(p);
    }
    // Map insertion order IS first appearance in the ranked roster, so the
    // winning side leads — whatever colour it wears.
    const out = [...byKey.values()];
    if (loose.length) out.push({ key: null, label: "", index: 0, isColor: false, players: loose });
    return out;
  }

  window.BgbTeams = { TEAM_SLOTS, TEAM_COLORS, keyOf, colorOf, indexMap, bands };
})();
