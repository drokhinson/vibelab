// @ts-check
// ui/team-colors.js — which side is which colour.
//
// A team play's sides are free text the host typed on the Play screen (up to
// six characters, because the field has to fit a scoring column). Migration 048
// persists the tag on each seat; this file is the single answer to "which of
// the six colour slots does this tag get", so the play-detail popup's banded
// player list and the scoring grid's tinted column headers cannot disagree
// about which side is which.
//
// In ui/ rather than domain/ because the answer is a PRESENTATION decision —
// order of first appearance in the ranked roster — not a fact about a Play. The
// row holds "Red"; nothing in the database knows Red is slot 1.
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

  /**
   * The tag two seats have to share to be on one side.
   * @param {string|null|undefined} team
   * @returns {string} "" when the seat carries no side.
   */
  function keyOf(team) {
    return String(team == null ? "" : team).trim().toLowerCase();
  }

  /**
   * tag → colour slot (1..TEAM_SLOTS), by order of first appearance.
   *
   * Takes an ALREADY-RANKED roster and never sorts. Because Play.rankPlayers is
   * score-descending, "order of first appearance" IS "sides ordered by their
   * best seat" — the winning side is slot 1 — with no second ordering step for
   * the two consumers to drift on.
   *
   * @param {any[]} players
   * @returns {Map<string, number>|null} null when no seat carries a side, which
   *   is the signal to render exactly as a non-team play does.
   */
  function indexMap(players) {
    const map = new Map();
    for (const p of (players || [])) {
      const key = keyOf(p && p.team);
      if (!key || map.has(key)) continue;
      map.set(key, (map.size % TEAM_SLOTS) + 1);
    }
    return map.size ? map : null;
  }

  /**
   * The roster split into sides, in slot order, with the untagged seats last.
   *
   * Seats keep their input order inside a band, so a band is still ranked. The
   * trailing band carries `key: null` and no label or colour: a half-tagged
   * roster's leftovers have to look like a non-team play's list, not like a
   * side called nothing.
   *
   * `label` is the FIRST seat's original spelling, so "Red" prints the way the
   * host typed it even though the grouping ignores case.
   *
   * @param {any[]} players an already-ranked roster
   * @returns {{key: string|null, label: string, index: number, players: any[]}[]|null}
   */
  function bands(players) {
    const map = indexMap(players);
    if (!map) return null;
    /** @type {Map<string, {key: string|null, label: string, index: number, players: any[]}>} */
    const byKey = new Map();
    const loose = [];
    for (const p of (players || [])) {
      const key = keyOf(p && p.team);
      if (!key) { loose.push(p); continue; }
      let band = byKey.get(key);
      if (!band) {
        band = { key, label: String(p.team).trim(), index: map.get(key) || 1, players: [] };
        byKey.set(key, band);
      }
      band.players.push(p);
    }
    const out = [...byKey.values()].sort((a, b) => a.index - b.index);
    if (loose.length) out.push({ key: null, label: "", index: 0, players: loose });
    return out;
  }

  window.BgbTeams = { TEAM_SLOTS, keyOf, indexMap, bands };
})();
