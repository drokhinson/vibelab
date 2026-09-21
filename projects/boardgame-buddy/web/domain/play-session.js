// domain/play-session.js — Local + remote play-session state.
//
// Two responsibilities:
//   1. Local in-progress draft (game, players, photo) persisted to
//      localStorage so a refresh doesn't lose work. The photo blob stays in
//      memory only; on reload we surface a "re-attach photo" affordance.
//   2. Optional short-code "join from another phone" lobby, backed by the
//      /sessions endpoints. When `code` is set the participant list is
//      polled every 2s while the LogPlayView is mounted.

(function () {
  const LS_KEY = "bgb_play_session_v1";

  // ── Lobby prefetch channel ─────────────────────────────────────────────────
  //
  // POST /sessions used to fire from PlayFlowView.onMount, i.e. only after the
  // router had swapped views and the Gather screen had painted — so the invite
  // card sat on its "— — — — —" placeholder for a whole round trip. The mint
  // is now kicked off in the tap handler instead and parked here; the record
  // outlives the view swap because producer (chooser) and consumer (play flow)
  // are different views.
  //
  // Module-level and single-slot on purpose: a host may only ever have one
  // open session (bgb_create_session abandons their others), so holding two
  // would mean the second silently killed the first.
  let _prefetch = null;   // { promise, gameId, startedAt }
  // Past this, assume the user wandered off and the lobby is stale enough that
  // minting fresh is safer than adopting it.
  const PREFETCH_MAX_AGE_MS = 30 * 1000;

  // ── Removed seats ──────────────────────────────────────────────────────────
  //
  // Taking a seat off the roster is a local act — splice the array, DELETE the
  // lobby row — and for one round trip the two disagree: the draft says four
  // players, the lobby still says five. PlayFlowView's Gather poll reads the
  // lobby and seats anyone it doesn't recognise, so any bundle fetched inside
  // that window puts the removed seat straight back, at the END of the roster
  // (the rightmost, off-screen column of the scoring grid). That is how a
  // four-person table saved FIVE seats and unlocked Full Table: nobody saw the
  // fifth column, and bgb_log_play writes exactly the roster it is handed.
  //
  // So a removal is recorded, not just applied. The tombstone outlives the
  // DELETE — which can be slow, can fail (only a definitive 404/410 surfaces,
  // see _withLobby), or can never have been issued at all because the row had
  // no id yet — and it is PERSISTED, because a refresh re-reads the same lobby
  // and would otherwise re-seat the same ghost.
  const REMOVED_SEAT_MAX = 40;

  /** A seat's name as the identity rules below compare it. */
  function _seatName(name) {
    return String(name || "").trim().toLowerCase();
  }

  // Two seat identities are the same person when they name the same lobby row,
  // the same account, or — for a GHOST, which has no account and no handle but
  // its spelling — the same name.
  //
  // The name rule is ghost-to-ghost ONLY, and that restriction is the whole
  // reason this is a function rather than a string key. "Take the ghost Dave
  // off, put Dave's real account on" is the commonest thing a host does next,
  // and it is exactly the sequence that produced the report; a tombstone that
  // matched the account by name would block the seat the host meant to keep,
  // which is the same bug with the sign flipped.
  function _sameSeat(a, b) {
    if (a.participant_id && b.participant_id && a.participant_id === b.participant_id) return true;
    if (a.user_id && b.user_id) return a.user_id === b.user_id;
    if (a.user_id || b.user_id) return false;
    return !!a.name && a.name === b.name;
  }

  class PlaySession {
    constructor(initial = {}) {
      this.gameId       = initial.gameId || null;
      this.gameSnapshot = initial.gameSnapshot || null; // {id,name,thumbnail_url,image_url,...}
      this.playedAt     = initial.playedAt || new Date().toISOString().slice(0, 10);
      this.players      = initial.players || [];
      // Seats the host has taken OFF this draft — see REMOVED_SEAT_MAX above.
      // Persisted with the roster, because the thing that re-seats them is a
      // lobby read and a refresh does one.
      this.removedSeats = Array.isArray(initial.removedSeats)
        ? initial.removedSeats.slice(-REMOVED_SEAT_MAX)
        : [];
      this.notes        = initial.notes || "";
      this.expansionIds = initial.expansionIds || [];
      this.playMode     = initial.playMode || null;
      // The scoring grid this play is being scored on (migration 018), or null
      // for the plain R1..Rn grid. A SNAPSHOT of the chapter's rows, not a
      // reference to it — see the COMMENT ON boardgamebuddy_plays
      // .scoring_template. Holding a copy on the draft has a second payoff
      // here: an author editing the chapter mid-game cannot move the labels
      // under the host's fingers.
      this.scoringTemplate = initial.scoringTemplate || null;
      // Whether the host has turned the scoring template OFF for this play —
      // the position of the switch on the scoring card's template bar, not the
      // absence of a template. The two are different states and only one of
      // them may be answered by auto-apply: `scoringTemplate === null` alone
      // cannot tell "nothing has been chosen yet" from "the host took it off",
      // and reading it as the first is how a guide reload used to put the grid
      // back on a host who had just removed it. Local to the draft: the server
      // stores the template a play WAS scored on, and a play scored on plain
      // rounds is a null template there, with nothing more to say.
      this.scoringTemplateOff = !!initial.scoringTemplateOff;
      // Whether the host has PICKED the scorepad from the bar's pill row
      // (migration 032), as opposed to it having been derived for them.
      //
      // The two need telling apart for the same reason as the switch above.
      // Deriving is not a one-time act: ticking a replace-mode expansion
      // re-derives the scorepad to that expansion's grid, which is the whole
      // meaning of "replace", and unticking it derives back. A host who has
      // reached for the pills has overruled that, and their choice must survive
      // the next tick — so the pill row writes this, and _recomposeTemplate
      // re-derives only while it is false.
      //
      // Local to the draft, like the switch: the server stores the rows a play
      // WAS scored on and has no use for how they were arrived at.
      this.scoringTemplatePicked = !!initial.scoringTemplatePicked;
      // Where this is being played, ISO 3166-1 alpha-2 (migration 065). Seeded
      // from the device the moment the draft is born rather than read at Save:
      // Settle Up shows it and the host can correct it, so it has to be a real
      // field of the draft, and a resumed draft must not silently re-detect
      // over a correction the host already made. `null` is a legitimate value
      // — see domain/geo.js — and travels all the way to a NULL column.
      //
      // Detection is keyed on the field being ABSENT, not falsy. A host who
      // opened the picker and chose "don't record a country" persists a draft
      // whose countryCode is null; a `||` here would re-detect on the next
      // load and quietly put the country back, which is the one outcome that
      // choice has to be safe from. Only a snapshot predating this field, or a
      // genuinely new draft, has no key at all.
      this.countryCode  = Object.prototype.hasOwnProperty.call(initial, "countryCode")
        ? (initial.countryCode || null)
        : (window.Geo ? window.Geo.countryForPlay() : null);
      this.code         = initial.code || null;
      this.sessionId    = initial.sessionId || null;
      this.hostUserId   = initial.hostUserId || null;
      // Cascade screen the host is currently on. Mirrors the backend
      // `phase` column so a refresh resumes on the same screen.
      this.phase        = initial.phase || "gather";
      this.photoBlob    = null; // in-memory only — never persisted
      this.photoUrl     = initial.photoUrl || null;
      // The pending capture, in three parts, all in-memory only and all
      // deliberately absent from persist(): the compressed copy bound for the
      // bucket, the user's own file at the resolution they shot it (what
      // ui/save-to-photos.js hands back to the camera roll — iOS does not put
      // an in-app capture there by itself), and the object url the preview
      // draws. Declared here rather than springing into being on first select,
      // because clear() and PlayFlowView._clearPhoto both tear all three down.
      this.photoFile       = null;
      this.photoSourceFile = null;
      this.photoPreviewUrl = null;
      // Closed out by clear(). In-memory only, and never read from `initial`:
      // a done draft is never persisted, so a loaded one is always live.
      this._done        = false;
    }

    static load() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return new PlaySession(parsed);
      } catch (_) {
        return null;
      }
    }

    persist() {
      // A closed-out draft never goes back to disk. clear() is not the end of
      // this object's life — the view keeps holding it, and ~30 persist() call
      // sites can still fire against it — so without this, one late write
      // re-creates the key and the Play tab offers to resume a finished game.
      // That is exactly how a saved play used to come back: a poll tick 404s on
      // the finalized session, _healLobby persists to drop the dead code, then
      // _ensureLobbyOpen mints a fresh lobby and persists the new one.
      if (this._done) return;
      const snapshot = {
        gameId: this.gameId,
        gameSnapshot: this.gameSnapshot,
        playedAt: this.playedAt,
        players: this.players,
        removedSeats: this.removedSeats,
        notes: this.notes,
        expansionIds: this.expansionIds,
        playMode: this.playMode,
        scoringTemplate: this.scoringTemplate,
        scoringTemplateOff: this.scoringTemplateOff,
        scoringTemplatePicked: this.scoringTemplatePicked,
        countryCode: this.countryCode,
        code: this.code,
        sessionId: this.sessionId,
        hostUserId: this.hostUserId,
        phase: this.phase,
        photoUrl: this.photoUrl,
      };
      try { localStorage.setItem(LS_KEY, JSON.stringify(snapshot)); } catch (_) {}
    }

    /**
     * Drop the on-disk copy WITHOUT touching the in-memory draft.
     *
     * Save is the one moment the two have to diverge. The host commits, the
     * wrap-up card goes up dismissible, and they can be back on the Play tab
     * before the write lands — where LogPlayView._resumableSession() reads this
     * key and would offer to resume the game they just saved (the draft's phase
     * at Save time is `settle`, not `finalized`). So the disk copy retires at
     * the tap; the in-memory draft lives until the write settles, because a
     * failure still has to leave a complete Settle Up behind the card.
     */
    unpersist() {
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
    }

    clear() {
      this.gameId = null;
      this.gameSnapshot = null;
      this.players = [];
      this.removedSeats = [];
      this.notes = "";
      this.expansionIds = [];
      this.playMode = null;
      this.countryCode = null;
      this.code = null;
      this.sessionId = null;
      this.hostUserId = null;
      // Terminal, not "gather". Two guards read this and both were dead before:
      // LogPlayView._resumableSession()'s `phase !== "finalized"` test (nothing
      // in the client ever wrote that value), and PlayFlowView's Gather-only
      // poll gate — which resetting to "gather" actively re-OPENED, turning the
      // clear into the trigger for the resurrection it was meant to prevent.
      this.phase = "finalized";
      this._done = true;
      this.photoBlob = null;
      this.photoUrl = null;
      if (this.photoPreviewUrl) {
        try { URL.revokeObjectURL(this.photoPreviewUrl); } catch (_) {}
      }
      this.photoFile = null;
      this.photoSourceFile = null;
      this.photoPreviewUrl = null;
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
    }

    isActive() {
      return !!(this.gameId || this.players.length || this.code);
    }

    /**
     * Record that a seat was taken off the roster.
     *
     * Called by the removal itself, not by whatever settles the lobby row: the
     * point is to survive a DELETE that is slow, that fails, or that could not
     * be issued because the row had no id yet. Newest last, capped — a host
     * shuffling a line-up all evening must not grow the persisted draft without
     * bound, and the oldest removal is the one least likely to still be in a
     * lobby bundle.
     *
     * @param {any} seat a row from `players`
     */
    forgetSeat(seat) {
      if (!seat) return;
      const tomb = {
        participant_id: seat.participant_id || null,
        user_id: seat.user_id || null,
        name: _seatName(seat.name),
      };
      // Nothing to match on later — a blank row the host never filled in.
      if (!tomb.participant_id && !tomb.user_id && !tomb.name) return;
      this.removedSeats = this.removedSeats
        .filter((t) => !_sameSeat(t, tomb))
        .concat([tomb])
        .slice(-REMOVED_SEAT_MAX);
    }

    /**
     * Drop the tombstone for a seat that is back on the table.
     *
     * Every add goes through here, so a removal is never permanent: a host who
     * takes a ghost off and then types the same name again has changed their
     * mind, and the poll must be free to hand that row its participant_id.
     *
     * @param {any} seat a row from `players`
     */
    rememberSeat(seat) {
      if (!seat || this.removedSeats.length === 0) return;
      const id = {
        participant_id: seat.participant_id || null,
        user_id: seat.user_id || null,
        name: _seatName(seat.name),
      };
      this.removedSeats = this.removedSeats.filter((t) => !_sameSeat(t, id));
    }

    /**
     * Would seating this lobby participant put back someone the host removed?
     *
     * Asked by PlayFlowView's Gather poll, and only on the branch that would
     * CREATE a local row — a participant that already matches a seat is the
     * ordinary backfill path and has nothing to do with this.
     *
     * @param {{id?: string, user_id?: string|null, display_name?: string}} part
     * @returns {boolean}
     */
    isRemovedParticipant(part) {
      if (!part || this.removedSeats.length === 0) return false;
      const id = {
        participant_id: part.id || null,
        user_id: part.user_id || null,
        name: _seatName(part.display_name),
      };
      return this.removedSeats.some((t) => _sameSeat(t, id));
    }

    /**
     * Has this draft been closed out?
     *
     * Deliberately in-memory only — it is not part of the persisted snapshot,
     * because a done draft is never written, so load() can never see one. Every
     * legitimate re-seed builds a NEW PlaySession (onMount, _startAnotherRound,
     * LogPlayView._anotherRound, JoinPanel), so the flag never outstays the run
     * it belongs to.
     *
     * @returns {boolean}
     */
    isDone() {
      return !!this._done;
    }

    /**
     * Build a fresh-draft seed from a play-history row (profile bundle
     * `recent_plays[]`, or a row from GET /plays) so the same group can play
     * the same game again. Mirrors PlayFlowView._nextRoundSeed(): the game
     * and the roster carry over, the results do not, and no participant_id
     * comes along — those belong to the finished lobby.
     *
     * The play row has no rulebook_url / is_expansion, so callers that can
     * cheaply resolve the game (e.g. a warmed "game.bundle" cache entry) pass
     * it as `gameExtras`; absent it the guide link just stays unset until the
     * host flow loads the game itself.
     */
    static seedFromPlayRow(row, gameExtras = {}) {
      if (!row || !row.game_id) return null;
      const g = gameExtras || {};
      return {
        gameId: row.game_id,
        gameSnapshot: {
          id: row.game_id,
          name: row.game_name || g.name || "",
          thumbnail_url: row.game_thumbnail || g.thumbnail_url || null,
          // Play rows carry only the thumbnail; the full art rides along when
          // the caller could resolve the game (warm "game.bundle"), which is
          // what keeps the wrap-up card sharp on an Another-Round seed.
          image_url: g.image_url || null,
          rulebook_url: g.rulebook_url || null,
          is_expansion: !!g.is_expansion,
        },
        expansionIds: (row.expansions || [])
          .map((e) => e.expansion_game_id)
          .filter(Boolean),
        playMode: row.play_mode || g.play_mode || null,
        players: (row.players || []).map((p) => ({
          name: p.name,
          user_id: p.user_id || null,
          avatar: p.avatar || null,
          is_winner: false,
          score: null,
          // Carried off the saved row now that it persists, so "another round"
          // from a finished play keeps the sides — which is what the in-memory
          // path (PlayFlowView._nextRoundSeed) has always done.
          team: p.team || "",
          initials: null,
        })),
      };
    }

    /**
     * Tag one seat with a team, and settle that side's outcome.
     *
     * A side shares ONE result — PlayFlowView's trophy toggle already crowns or
     * un-crowns a whole tag at once — so the seat and the seats it just joined
     * have to agree on `is_winner` afterwards. They agree by UNION: if either
     * the seat or the side it joins is flagged a winner, all of them are.
     *
     * The direction is the bug this exists to close. This used to overwrite the
     * seat with whatever its teammates said, which on the ordinary order of
     * operations — crown the winners, THEN name the teams — read a side that
     * was still empty and silently cleared the win just recorded. The play
     * saved with nobody flagged and the feed card told the people who won it
     * "We lost". A recorded win is never dropped by typing a team name; an
     * accidental tag can over-crown a side, and the trophy toggle takes that
     * back, where the wipe left nothing to notice.
     *
     * A tag no other seat carries yet says nothing about this one, so a lone
     * seat keeps its own flag untouched. Clearing the tag does the same.
     *
     * Mutates `players` in place (the draft's array is the live one) and
     * returns whether any `is_winner` moved, so the caller can skip a repaint.
     *
     * @param {any[]} players the draft roster
     * @param {number} i the seat being tagged
     * @param {string} value the typed tag
     * @returns {boolean} true when a win flag changed
     */
    static applyTeamTag(players, i, value) {
      const p = players && players[i];
      if (!p) return false;
      p.team = String(value == null ? "" : value).trim();
      if (!p.team) return false;
      const tag = p.team.toLowerCase();
      const side = players.filter(
        (o, j) => j !== i && o && (o.team || "").trim().toLowerCase() === tag
      );
      if (!side.length) return false;
      const won = !!p.is_winner || side.some((o) => !!o.is_winner);
      const changed = !!p.is_winner !== won || side.some((o) => !!o.is_winner !== won);
      if (!changed) return false;
      p.is_winner = won;
      for (const o of side) o.is_winner = won;
      return true;
    }

    /**
     * Give a seat the numbers its new side is already holding.
     *
     * The companion to applyTeamTag, and the same shape of problem. A side
     * scores as ONE column now (widgets/round-score-grid.js#roundGridColumns):
     * the host types once and the write fans out — through
     * window.roundGridSeatsFor, which is what an editable host asks — so every
     * seat on the side carries the number and each one SAVES it as their own
     * score. A seat
     * tagged in afterwards has none of that history — the grid would go on
     * showing the side's cells (an empty seat is not a disagreement, by
     * design) while this seat quietly saved zeroes and dragged the side's own
     * result down with it.
     *
     * Only ever fills BLANKS, and only onto a seat that has no numbers of its
     * own. A seat that was scored before it joined the side is a real
     * disagreement: the grid splits the side back into seats and shows both
     * numbers, which is the honest answer and the one a host can act on. The
     * alternative — overwriting — is the same mistake applyTeamTag's own
     * docstring is a monument to, where naming a team threw away something
     * already recorded.
     *
     * Mutates `players` in place and reports whether anything moved, so the
     * caller can skip a repaint and a live-scores republish.
     *
     * @param {any[]} players the draft roster
     * @param {number} i the seat that was just tagged
     * @returns {boolean} true when this seat took the side's numbers
     */
    static adoptTeamScores(players, i) {
      const p = players && players[i];
      if (!p) return false;
      const tag = String((p.team || "")).trim().toLowerCase();
      if (!tag) return false;
      // Its own numbers, so there is nothing to adopt and no blank to fill.
      const mine = Array.isArray(p.roundScores) ? p.roundScores : [];
      if (mine.some((v) => window.parseRoundScore(v) != null)) return false;
      const side = players.filter(
        (o, j) => j !== i && o && String((o.team || "")).trim().toLowerCase() === tag
      );
      if (!side.length) return false;
      let moved = false;
      const n = Math.max(0, ...players.map((o) => ((o && o.roundScores) || []).length));
      if (!Array.isArray(p.roundScores)) p.roundScores = [];
      for (let r = 0; r < n; r++) {
        let v = null;
        for (const o of side) {
          const cell = (o.roundScores || [])[r];
          if (window.parseRoundScore(cell) != null) { v = cell; break; }
        }
        if (v == null) continue;
        if (p.roundScores[r] === v) continue;
        p.roundScores[r] = v;
        moved = true;
      }
      return moved;
    }

    // Remote lobby helpers ──────────────────────────────────────────────────────

    static async openLobby({ gameId } = {}) {
      const session = await window.api.post("/sessions", { game_id: gameId || null });
      return session;
    }

    /**
     * Start minting a lobby NOW, before the user has navigated. Call from the
     * tap handler; PlayFlowView consumes it in _ensureLobbyOpen().
     *
     * CAUTION: this is a real write. bgb_create_session abandons every other
     * open session this host owns, so never call it while the user has a
     * resumable session — that would close the very lobby they're resuming.
     */
    static prefetchLobby({ gameId = null } = {}) {
      PlaySession.discardPrefetchedLobby();
      const promise = PlaySession.openLobby({ gameId });
      // The consumer may never arrive (user backs out), so own the rejection
      // here — an unhandled one would surface as a console error.
      promise.catch(() => {});
      _prefetch = { promise, gameId, startedAt: Date.now() };
      return promise;
    }

    /**
     * One-shot consume. Returns the in-flight (or settled) promise, or null
     * when there's nothing usable — in which case the caller mints normally.
     * A record past PREFETCH_MAX_AGE_MS is abandoned rather than adopted.
     */
    static takePrefetchedLobby() {
      const rec = _prefetch;
      _prefetch = null;
      if (!rec) return null;
      if (Date.now() - rec.startedAt > PREFETCH_MAX_AGE_MS) {
        _abandonMinted(rec);
        return null;
      }
      return rec.promise;
    }

    /** Drop an unconsumed prefetch and close the lobby it opened. */
    static discardPrefetchedLobby() {
      const rec = _prefetch;
      _prefetch = null;
      if (rec) _abandonMinted(rec);
    }

    static async joinLobby(code, { displayName } = {}) {
      return window.api.post(`/sessions/${code}/join`, {
        display_name: displayName || null,
      });
    }

    static fetchLobby(code) {
      return window.api.get(`/sessions/${code}`);
    }

    /**
     * Register this account as a viewer of `code`, and get the bundle back.
     *
     * Not a join: it never touches the roster, so watching cannot turn into a
     * column on the host's grid or a player on the saved play. What it buys is
     * the grid itself — the live-score table and its Realtime channel are
     * RLS-gated on being the host, seated, OR watching (migration 027), and
     * without a viewer row a spectator reads an empty table and lives on the
     * bundle's baked-in copy plus a faster poll for the whole game.
     *
     * @param {string} code
     * @returns {Promise<Object>} the same session bundle fetchLobby returns
     */
    static watchLobby(code) {
      return window.api.post(`/sessions/${code}/watch`, {});
    }

    /**
     * Adopt a session bundle as THIS device's host draft, and publish it.
     *
     * The host re-entering their own session — from the code box, the joinable
     * list, or the viewer screen they were bounced to while the network was
     * misbehaving — needs the draft rebuilt from the server's row before
     * play-flow opens, or the cascade mints a second lobby over the top of the
     * one they are already hosting. Every caller did this by hand; one copy
     * means the host path cannot drift between them.
     *
     * The caller is responsible for having established that `session` really is
     * ours (`session.host_user_id === me.id`). This function does not check,
     * because the two callers learn it in different ways.
     *
     * @param {Object} session a SessionResponse bundle
     * @returns {Object} the persisted PlaySession
     */
    static adoptHostSession(session) {
      const ps = PlaySession.load() || new PlaySession();
      ps.code = session.code;
      ps.sessionId = session.id;
      ps.hostUserId = session.host_user_id;
      ps.phase = session.phase || "gather";
      if (session.game) {
        ps.gameId = session.game.id;
        ps.gameSnapshot = session.game;
      }
      ps.persist();
      if (window.store) window.store.set("activePlay", ps);
      return ps;
    }

    // Host-only. Pass `gameId: null` to clear the pick.
    static updateLobby(code, { gameId } = {}) {
      return window.api.patch(`/sessions/${code}`, { game_id: gameId || null });
    }

    // Host-only. Adds a buddy (with userId) or a ghost (userId=null) to the
    // backend participants table so other joiners can see them. Without this
    // call, host-typed players live only in the host's localStorage draft and
    // never reach joiners.
    static addParticipant(code, { userId, displayName }) {
      return window.api.post(`/sessions/${code}/participants`, {
        user_id: userId || null,
        display_name: displayName,
      });
    }

    // Host-only. Set the roster's column order — the full ordered id list,
    // front to back. The participants array's order is the scoring grid's
    // column order on every surface (the spectator's mirror builds its grid
    // straight from it), so without this a row the host drags in Gather moves
    // on their own phone only. Gather-only: 409 `roster_locked` after that.
    static reorderParticipants(code, participantIds) {
      return window.api.put(`/sessions/${code}/participants/order`, {
        participant_ids: participantIds,
      });
    }

    // Host-only. Publish the lobby's team setup: how the table is being
    // scored, and the whole {participant_id: tag} map exactly as the host's
    // draft holds it.
    //
    // The team tags are typed on the Gather roster and used to live ONLY in
    // that draft until the play was saved, so the host read a grid banded into
    // sides while every spectator read the same grid with identical columns,
    // and the pairings surfaced only once the game was over. This is what
    // carries them across while it still matters (migration 050).
    //
    // `playMode` rides along rather than taking a call of its own because the
    // two are one fact: a side's seats share ONE cell in the scoring grid, and
    // that merge is gated on the mode — a mirror holding the tags but not the
    // mode would draw a grid the host's own screen is not drawing.
    //
    // Full replacement: a participant the map omits has their tag cleared,
    // which is how a side the host deletes stops banding. Unlike the order
    // write this is NOT Gather-only — naming a side repaints a header, it
    // doesn't renumber a column — so a debounced write that lands before the
    // phase PATCH of a host rolling back to Gather still counts, instead of
    // coming back 409 and being swallowed with the tag.
    static setSessionTeams(code, { playMode, teams } = {}) {
      return window.api.put(`/sessions/${code}/teams`, {
        play_mode: playMode || null,
        teams: teams || {},
      });
    }

    // Host-only. Remove a participant row by id.
    static removeParticipant(code, participantId) {
      return window.api.del(`/sessions/${code}/participants/${participantId}`);
    }

    // Writes the play the lobby was building. Same cache blast radius as
    // Play.create — profile, stats, game bundle, buddies, feed first page —
    // so it routes through the same invalidation instead of leaving every one
    // of them holding a pre-play view.
    static finalizeLobby(code, payload) {
      return window.api.post(`/sessions/${code}/finalize`, payload)
        .then((r) => { if (window.Play) window.Play.invalidateDeps(); return r; });
    }

    // Host-only. Publish the scoring grid the lobby is scored on, so every
    // spectator's mirror labels the same rows. Fire-and-forget at every call
    // site: the host's own grid is already painted from the local draft, and a
    // failed publish costs the spectators their labels for one poll, not the
    // host their scoring.
    static setScoringTemplate(code, template) {
      return window.api.patch(`/sessions/${code}/scoring-template`, {
        template: template || null,
      });
    }

    // Host-only. Move the lobby through gather → play → settle, or abandon.
    static advancePhase(code, phase) {
      return window.api.patch(`/sessions/${code}/phase`, { phase });
    }

    // Joinable sessions for the current viewer (drives the Join chooser).
    static listJoinable() {
      return window.api.get("/sessions/joinable");
    }

    // Build the POST /plays body from this draft. Used both for solo logs and
    // for the host's finalize call (which has the same shape). Each player's
    // `score` is the sum of their roundScores when rounds were tracked;
    // `round_scores` is sent only when more than one round exists so the
    // simple-score path (no grid) leaves the column NULL on the backend.
    toPlayCreate() {
      return {
        game_id: this.gameId,
        played_at: this.playedAt,
        players: this.players.map((p) => ({
          name: p.name,
          is_winner: !!p.is_winner,
          score: rollupScore(p),
          user_id: p.user_id || null,
          round_scores: persistableRounds(p, !!this.scoringTemplate),
          // The side this seat played on (migration 048). Until now the tag
          // settled the side's win flags and was then dropped on the floor, so
          // a team night saved as N seats and no sides — and the play detail
          // had nothing to group by. `null` rather than "" for an untagged
          // seat, or every seat in the app would share one anonymous side.
          team: (p.team || "").trim() || null,
        })),
        notes: this.notes || null,
        photo_url: this.photoUrl || null,
        expansion_ids: this.expansionIds,
        play_mode: this.playMode || null,
        // Rides through the lobby finalize too — that endpoint takes the same
        // PlayCreate body and bgb_finalize_session hands it to bgb_log_play
        // verbatim.
        scoring_template: this.scoringTemplate || null,
        // Absent (not "") when unknown: the backend reads a missing country as
        // "we don't know", and an empty string as a malformed code — a 422 on
        // the Save the host just tapped.
        country_code: this.countryCode || null,
      };
    }
  }

  // Best-effort cleanup of a lobby nobody entered, so it never shows up in a
  // buddy's Join chooser. Belt and braces: even if this fails, the row carries
  // an expires_at and the host's next create abandons it anyway.
  function _abandonMinted(rec) {
    rec.promise
      .then((s) => (s && s.code ? window.api.del(`/sessions/${s.code}`) : null))
      .catch(() => {});
  }

  // A player's recorded total. When rounds were tracked it is the sum of the
  // grid — computed by the same helper the scoring table renders its Total
  // with (widgets/round-score-grid.js), so the number saved to the play is the
  // number the host was looking at when they hit Save.
  function rollupScore(p) {
    const rs = p && p.roundScores;
    // An all-blank grid is "nothing was typed", not "the table scored zero".
    // Rolling it up to 0 is what made a play nobody scored read as a recorded
    // loss — on the feed card and in every win-rate denominator. Such a grid
    // falls through to `score`, which is normally null but carries a
    // deliberate 0 for a co-op loss (play-flow-view's _stampCoopLoss).
    if (Array.isArray(rs) && rs.length > 0 && window.roundGridHasAnyScore(p, rs.length)) {
      return window.roundGridTotal(p, rs.length);
    }
    return p && p.score != null ? p.score : null;
  }

  // Only persist the per-round breakdown when there was more than one round.
  // Single-round / no-round plays stay on the simple-score path and leave the
  // backend column NULL.
  //
  // …UNLESS a scoring template is applied, and then even ONE row is a real
  // breakdown: the template says that row MEANS something. Without the second
  // argument a one-row template would save its labels onto a play with no
  // round_scores to label, and widgets/play-detail-popup.js gates its whole
  // Rounds section on `some(round_scores.length > 1)` — so the play would come
  // back looking as if it had never had a grid at all.
  //
  // The invariant to keep, in both directions: a non-null scoring_template
  // implies non-null round_scores. The popup's gate is widened to match.
  function persistableRounds(p, hasTemplate) {
    const rs = p && p.roundScores;
    if (!Array.isArray(rs) || rs.length === 0) return null;
    if (rs.length <= 1 && !hasTemplate) return null;
    // Cells may be sanitized strings ("-5") incl. a transient "-" — coerce to
    // int, treating empty / lone-minus as null. Negative scores persist fine.
    return rs.map((v) => {
      if (v === "" || v === "-" || v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    });
  }

  window.PlaySession = PlaySession;
})();
