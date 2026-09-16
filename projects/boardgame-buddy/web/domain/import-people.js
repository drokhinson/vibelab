// domain/import-people.js — who an importer can seat.
//
// Both importers ask the same question — "who was at this table?" — of the
// same three sources: the viewer, their buddies and play-partners, and the
// ghosts nobody has written to the database yet. Both had their own copy of
// the answer, and the copies had already drifted: `_searchEveryone` was
// byte-identical in both, `_playerCandidates` agreed on the viewer row and
// then diverged, and only one of them knew about the ghosts a run invents as
// it goes.
//
// This module is the answer, once. It is stateless: the caller owns the
// partner bundle (domain/buddy.js SWRs it for a day) and passes it in, because
// a wizard that switches source mid-visit should not re-fetch a list it
// already holds.
//
// It lives in domain/ rather than widgets/ because it has no markup and no
// state — it is a helper about people, the same shape as domain/name-match.js,
// which the player suggestions here are ranked by.

(function () {
  // Close matches offered above the full list. Enough to hold the real answer
  // when a note's spelling is ambiguous ("Chris" against a Christina and a
  // Christopher), short enough that the whole buddy list is still visible
  // underneath without a scroll. Both importers picked 5 independently.
  const SUGGEST_MAX = 5;

  /**
   * The viewer as a picker row.
   *
   * YOU come first, and this is the one expression that spells you.
   * GET /play-partners never returns the viewer, because every other caller
   * has already seated them — in Gather you are at the table by construction.
   * In an importer nobody has, so a note recording your own name had no way to
   * become you and every imported play landed with the importer absent from
   * their own history. That also cost them the wins.
   */
  function viewerRow() {
    const me = window.store.get("user");
    if (!me || !me.id) return null;
    return {
      source: "account",
      user_id: me.id,
      name: me.display_name || me.username || "You",
      username: me.username || null,
      avatar: me.avatar || null,
      isViewer: true,
    };
  }

  const ImportPeople = {
    SUGGEST_MAX,

    /**
     * The buddy bundle, or an empty one.
     *
     * A missing buddy list costs auto-matching and the pre-filled rows, never
     * the import: every name is still pickable by hand and still importable as
     * a ghost. So this resolves rather than throws, and the caller's loading
     * flag is the caller's to clear.
     * @returns {Promise<{accounts: any[], ghosts: any[], recent: any[]}>}
     */
    async loadPartners() {
      try {
        return (await window.Buddy.allBuddies())
          || { accounts: [], ghosts: [], recent: [] };
      } catch (_) {
        return { accounts: [], ghosts: [], recent: [] };
      }
    },

    viewerRow,

    /**
     * The viewer as a SEAT, for a flow that starts every play with them at the
     * table (the photo importer: every photo in a camera roll is a game the
     * person holding the phone played, and since migration 023 a play with
     * nobody at it cannot be written at all).
     *
     * Deliberately built from viewerRow() so the seeded seat and the picker
     * row that would duplicate it can never disagree about how the viewer is
     * spelled.
     * @returns {Array<{name: string, userId: string, isWinner: boolean}>}
     */
    viewerSeat() {
      const me = viewerRow();
      return me ? [{ name: me.name, userId: me.user_id, isWinner: false }] : [];
    },

    /**
     * Everyone the picker can offer without a round trip: the viewer, their
     * buddies, everyone they've shared a table with, and their own ghosts —
     * plus, when `extraGhosts` is passed, the ghosts this run has invented.
     *
     * Accounts dedupe by id (a viewer who somehow also appears in their own
     * partner list would otherwise be offered twice, with only one row marked
     * "You"). The extras dedupe BY NAME, and last: `toPlayerCandidates`
     * dedupes accounts by id and ghosts not at all, and the sheet keys every
     * row on `data-picker-name` — two rows sharing one name would both resolve
     * to whichever `_find()` reached first.
     *
     * @param {{accounts: any[], ghosts: any[], recent: any[]}|null} partners
     * @param {any[]} [extraGhosts] rows from ghostsIn(), for a run in progress
     */
    candidates(partners, extraGhosts) {
      const me = viewerRow();
      const rows = [
        ...(me ? [me] : []),
        ...window.Buddy.toPlayerCandidates(partners || { accounts: [], ghosts: [], recent: [] }),
      ].filter((c) => c.name);

      const seenIds = new Set();
      const out = rows.filter((c) => {
        if (!c.user_id) return true;
        if (seenIds.has(c.user_id)) return false;
        seenIds.add(c.user_id);
        return true;
      });

      if (!extraGhosts || !extraGhosts.length) return out;
      const seenNames = new Set(out.map((c) => String(c.name).toLowerCase()));
      for (const g of extraGhosts) {
        const k = String(g.name || "").toLowerCase();
        if (!k || seenNames.has(k)) continue;
        seenNames.add(k);
        out.push(g);
      }
      return out;
    },

    /**
     * The ghosts a run has already invented, from its own rosters.
     *
     * A name typed into the picker on photo 1 goes into that shot's roster and
     * nowhere else: it is not in the buddy bundle, and nothing reaches the
     * database until the final "Import N plays" tap. So photo 2 offered no way
     * to reach it but typing it again — and a second spelling is a second
     * ghost holding half the plays, which is the mess /ghost-players/merge
     * exists to clean up afterwards.
     *
     * Case-insensitive, first spelling wins: it is the one already written
     * into a roster, and both models' seats() collapse on the same key.
     *
     * @param {Iterable<Array<{name?: string, userId?: string|null}>>} rosters
     */
    ghostsIn(rosters) {
      /** @type {Map<string, any>} */
      const out = new Map();
      for (const roster of (rosters || [])) {
        for (const p of (roster || [])) {
          if (!p || p.userId) continue;
          const name = String(p.name || "").trim();
          const k = name.toLowerCase();
          if (!k || out.has(k)) continue;
          out.set(k, { source: "ghost", user_id: null, name, username: null, avatar: null });
        }
      }
      return Array.from(out.values());
    },

    /**
     * The empty-query list: the people from the rows before this one, then
     * everyone this account has actually played with, most frequent first (the
     * server orders `recent` by play count). Cross-referenced against the
     * candidates so the unified shape is kept and anyone already at this table
     * is left out — the same shape play-flow's Gather screen hands the sheet,
     * because it is the same sheet.
     *
     * This run's ghosts LEAD because this is the sheet's empty-query base, and
     * on the second row the people from the first are the likeliest answer —
     * the same bet "Same as the last one" already makes. Reaching one by
     * typing its name a second time is exactly the path that invents a second
     * spelling.
     *
     * @param {{recent?: any[]}|null} partners
     * @param {any[]} runGhosts rows from ghostsIn()
     * @param {any[]} candidates rows from candidates()
     * @param {Set<string>} seated Names already on this table.
     * @param {Set<string>} [seatedAccounts] Account ids already on this table.
     */
    recent(partners, runGhosts, candidates, seated, seatedAccounts) {
      const byUserId = new Map(
        (candidates || []).filter((c) => c.user_id).map((c) => [c.user_id, c]));
      const taken = new Set(Array.from(seated || []).map((n) => String(n).toLowerCase()));
      const accounts = seatedAccounts || new Set();
      const rows = [];
      // One `seen` across both passes: a ghost typed on an earlier row and a
      // `recent` account can carry the same display name, and the sheet keys
      // its rows on that name.
      const seen = new Set();
      for (const g of (runGhosts || [])) {
        const k = String(g.name || "").toLowerCase();
        if (!k || taken.has(k) || seen.has(k)) continue;
        seen.add(k);
        rows.push(g);
      }
      for (const r of ((partners && partners.recent) || [])) {
        if (!r) continue;
        // Offering somebody who is already at this table is offering a seat
        // that cannot be taken — the confirm handler drops it, so the row
        // would just do nothing.
        if (r.user_id && accounts.has(r.user_id)) continue;
        const hit = byUserId.get(r.user_id);
        const row = hit || ((r.display_name && !taken.has(String(r.display_name).toLowerCase()))
          ? {
              source: "account",
              user_id: r.user_id,
              name: r.display_name,
              username: null,
              avatar: r.avatar || null,
            }
          : null);
        if (!row) continue;
        const k = String(row.name).toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push(row);
      }
      return rows;
    },

    /**
     * The rows worth reading first: the candidates whose display name or
     * username is closest to what the note wrote, scored by
     * domain/name-match.js — the same score that pre-filled the row behind the
     * sheet, so the two agree.
     * @param {string} name
     * @param {any[]} candidates
     * @param {number} [max]
     */
    closestTo(name, candidates, max) {
      return window.BgbNameMatch
        .rank(name, candidates || [], namesOf)
        .slice(0, max || SUGGEST_MAX)
        .map((hit) => hit.row);
    },

    /**
     * The whole app, not just the buddy list. Someone can have played with a
     * person they have never added — an opponent at a club night, a friend of
     * a friend — and an import is exactly when that turns up. Picking one
     * links the plays to their real account without a buddy request.
     *
     * A round trip, so it is a button the user presses rather than something
     * that fires on every keystroke; the local list above is cached and
     * filters instantly.
     * @param {string} q
     */
    async searchEveryone(q) {
      const hits = await window.Buddy.searchProfiles(q);
      const me = window.store.get("user");
      return (hits || [])
        .filter((h) => h && h.id && (!me || h.id !== me.id))
        .map((h) => ({
          source: "account",
          user_id: h.id,
          name: h.display_name || h.username || "",
          username: h.username || null,
          avatar: h.avatar || null,
        }))
        .filter((c) => c.name);
    },
  };

  /** The names a candidate can be recognised by, best evidence first. */
  function namesOf(candidate) {
    return [candidate.name, candidate.username];
  }

  window.ImportPeople = ImportPeople;
})();
