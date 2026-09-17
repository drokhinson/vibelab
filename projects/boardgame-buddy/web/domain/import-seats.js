// @ts-check
// domain/import-seats.js — who is at an imported table, and how two spellings
// become one person.
//
// Every import source resolves names into seats, and every one of them has to
// answer the same two questions the same way, because migration 023's
// uq_bgb_play_players_play_user REFUSES a play that seats one account twice.
// The notes importer learned that the hard way: a note saying "Jas" on one
// line and "Jasmine" on the next imported a two-player game with Jasmine in it
// twice, once winning and once not.
//
// WHY THIS EXISTS NOW. `.claude/rules/ui-object-design.md` §4 says extract at
// instance #2. The BGA source is instance #3, and copying the collapse a third
// time is how the three copies start disagreeing about a merge — which is not
// a cosmetic drift, it is a play the server rejects.
//
// WHAT IT DOES NOT DO YET. domain/play-import.js and domain/photo-import.js
// still carry their own copies; only domain/bga-import.js reads this. That is
// deliberate sequencing, not an oversight: migrating two shipping importers in
// the same change that adds a third source risks all three at once. What makes
// the migration safe later is that tools/check-import-wizard.mjs asserts all
// three models' whoOf() agree on the key shape — so the day they are pointed
// here, the gate already covers it. Point them here; do not copy this again.

(function () {
  const key = (s) => String(s || "").trim().toLowerCase();

  /**
   * @typedef {Object} Seat
   * @property {string} name
   * @property {boolean} is_winner
   * @property {number|null} score
   * @property {string|null} user_id
   */

  const ImportSeats = {
    /**
     * WHO a seat is, with nothing about how this play went.
     *
     * `seatKey` below carries the win and the score, so it changes the moment
     * either is edited and cannot address a seat across the edit that changes
     * it. This is the stable half, and it is what every seat handler takes.
     *
     * The spelling must stay identical to PlayImport.whoOf and
     * PhotoImport.whoOf — a handler in the shared review passes a key minted
     * by one model to a method on another's draft, and two key shapes would
     * silently address nobody. The gate asserts it.
     * @param {{name?: string, user_id?: string|null}} seat
     */
    whoOf(seat) {
      return seat.user_id ? `u:${seat.user_id}` : `g:${key(seat.name)}`;
    },

    /**
     * One written seat's identity, for the row and group keys. The ACCOUNT
     * when the name resolved to one; the resolved label otherwise. Never the
     * name the source wrote — that is what the Players step translates.
     * @param {Seat} seat
     */
    seatKey(seat) {
      return `${ImportSeats.whoOf(seat)}#${seat.is_winner ? "w" : ""}`
           + `#${seat.score == null ? "" : seat.score}`;
    },

    /**
     * Merge seats that are the same person, whatever they were called.
     *
     * The winner flag ORs and the first non-null score wins — a merge must not
     * lose a win, and it must not overwrite a number with a blank.
     *
     * A seat that names nobody at all is dropped rather than merged: a source
     * can emit one from a line it could not read, and it would land as a blank
     * row on the scoreboard that no ghost claim could ever reach.
     * @param {Seat[]} seats
     * @returns {Seat[]}
     */
    collapse(seats) {
      const out = [];
      const byWho = new Map();
      for (const seat of seats || []) {
        if (!seat) continue;
        const label = seat.name;
        if (!seat.user_id && !key(label)) continue;
        const who = ImportSeats.whoOf(seat);
        const taken = byWho.get(who);
        if (taken) {
          taken.is_winner = taken.is_winner || !!seat.is_winner;
          if (taken.score == null && (seat.score === 0 || seat.score)) taken.score = seat.score;
          continue;
        }
        const next = {
          name: label,
          is_winner: !!seat.is_winner,
          score: (seat.score === 0 || seat.score) ? seat.score : null,
          user_id: seat.user_id || null,
        };
        byWho.set(who, next);
        out.push(next);
      }
      return out;
    },
  };

  window.ImportSeats = ImportSeats;
})();
