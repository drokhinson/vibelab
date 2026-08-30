// views/play-flow-view.js — Cascading three-screen host flow.
//
// Gather → Play → Settle Up, stacked in a snap-scrolling container. On
// mount we open a session (so others can join via code) and put the host
// in the Gather screen. Continue PATCHes the session's phase to advance
// joiners' read-only mirrors via Realtime, and scrolls down to the next
// screen. The back chevron scrolls up but does NOT walk the phase
// backwards — the host can edit Gather/Play fields after advancing.
//
// Live scoring during Play streams in via LiveScores (Realtime). Save on
// Settle Up uploads the optional photo and calls /sessions/{code}/finalize
// — the backend merges live scoring rows into the play's PlayerEntry list.
//
// OFFLINE (see domain/net.js) this is the same three screens with the whole
// lobby subtracted: no POST /sessions, no code, no 2s poll, no Realtime, no
// phase PATCH, no photo. All of that exists to serve joiners, and there can't
// be any without a server. What's left runs off the localStorage draft and the
// bgbCache seeds bootstrap warmed, and Save hands the play to the outbox
// instead of the API. `_offline` is latched once at mount so the guards can't
// disagree mid-cascade; Save is the one place that re-checks, because a host
// who walked back into signal should get a live write.

(function () {
  // Above this many expansions the Gather picker grows a filter field. Its
  // list is capped at the same number of visible rows (see
  // .cascade-exp-scroll) so a game with dozens of expansions can't push the
  // rest of the Gather cascade off screen.
  const EXPANSION_FILTER_THRESHOLD = 5;

  // How long "Another round?" will hold the new lobby's POST /sessions waiting
  // on the previous round's write to settle — see _startAnotherRound. Bounded
  // because domain/api.js sets no fetch timeout, and a round with no lobby at
  // all is worse than one whose predecessor's spectators saw 'abandoned'.
  const LOBBY_GATE_MAX_WAIT_MS = 8000;

  // How many times the Gather poll will re-push a roster that still hasn't
  // fully landed, before it stops trying. The reconcile runs every 2s for the
  // whole Gather phase, so it needs a floor: a row the server keeps refusing
  // (bgb_add_participant answers display_name_required for a blank name, and
  // will keep answering it) would otherwise be a POST every 2s for as long as
  // the host sits on the screen. The budget resets whenever the pending set
  // changes size — progress, or a newly added player — so a stuck row can't
  // starve the ones that would still land.
  const ROSTER_RECONCILE_MAX = 4;

  // A reorder is a burst of drops, and each one names every participant. Coalesce
  // them: without this a host tidying the line-up fires a round trip per drag,
  // each renumbering the same rows.
  const ORDER_PUSH_DEBOUNCE_MS = 300;

  class PlayFlowView extends window.View {
    constructor() {
      super("play-flow");
      this._ps = null;
      this._buddies = [];
      this._ghosts = [];
      this._recent = [];
      this._lobby = null;
      this._lobbyPromise = null;
      // In-flight lobby heal, so N writes failing at once mint ONE replacement.
      this._healPromise = null;
      // True when _lobby was fabricated from the draft to ride out a blip
      // rather than confirmed by the server. _lobbyReady() re-validates one of
      // these instead of short-circuiting on it.
      this._lobbyProvisional = false;
      // Set when a dead lobby was swapped for a fresh one mid-run, so the
      // invite card can say the code the host already shared is no longer the
      // one to share.
      this._codeReplaced = false;
      this._expansions = [];
      this._expansionsLoadedFor = null;
      this._expansionsOpen = false;
      this._expansionQuery = "";
      this._guideWidget = null;
      this._liveScores = null;
      this._liveOff = null;
      this._error = null;
      this._saving = false;
      this._lobbyPoll = null;
      // Counts in-flight participant DELETEs. While > 0 the lobby poll
      // skips its tick — see _startLobbyPoll. Prevents the brief window
      // between optimistic local removal and server confirmation from
      // snapping the player back into the grid via a stale poll.
      this._pendingDeletes = 0;
      // In-flight roster push, so the three callers that can want one at once
      // (the Gather poll's reconcile, the pre-Play flush, a fresh mint) share
      // a single batch instead of stacking one per tick.
      this._rosterSyncPromise = null;
      // Reconcile budget — see ROSTER_RECONCILE_MAX. _rosterPending is the
      // size of the last pending set, and a change in it refills the budget.
      this._rosterRetries = 0;
      this._rosterPending = 0;
      // Debounce + single-flight for the roster ORDER write. _orderDirty
      // survives an in-flight push so a drop that lands mid-request isn't lost.
      this._orderTimer = null;
      this._orderPromise = null;
      this._orderDirty = false;
      // Monotonic token for phase-change PATCHes. After a call's PATCH
      // resolves it only reconciles state if it is still the latest — a
      // stale earlier PATCH resolving after a newer navigation must not yank
      // the phase back (the rapid-tap "jump back to a previous screen" bug).
      this._phaseSeq = 0;
      // Counts in-flight phase PATCHes. While > 0 the lobby poll skips its
      // tick so it can't clobber this._lobby (incl. a stale phase) mid
      // transition. Mirrors _pendingDeletes.
      this._pendingPhase = 0;
      // GameFinder widget instance, lazily constructed in render() when the
      // Gather screen needs the picker. Lives across the 2s lobby-poll
      // re-renders — mount() is idempotent.
      // Lobby row already fetched by onMount's deep-link host-vs-joiner
      // check. _ensureLobbyOpen consumes (and clears) it so the same code
      // isn't fetched twice back-to-back on a deep-link entry.
      this._prefetchedLobby = null;
      // Latched by _ensureLobbyOpen: this cascade is running with no lobby,
      // no poll and no live scores. See _isOffline().
      this._offline = false;
      // Id of the wrap-up splash this view put up, from PolaroidPopup.show().
      // The background save passes it back to update() so a late response
      // can only repaint its own card.
      this._cardId = null;
      // Monotonic token for save runs, bumped by _resetRunState. Paired with
      // the PlaySession the run's snapshot was built from, it answers "has the
      // host moved on?" — see _isStaleSave. The wrap-up card is dismissible
      // from frame one now, so a write can resolve two screens later.
      this._saveSeq = 0;
      // Resolves when the CURRENT save's write settles — success, failure or
      // queued — and deliberately not when _runSave returns, which is after the
      // best-effort photo attach. Gates the next round's POST /sessions.
      this._savePromise = null;
      // A promise the next _ensureLobbyOpen must wait behind. Set by
      // _startAnotherRound AFTER _resetRunState, which nulls it.
      this._lobbyGate = null;
    }

    async onMount() {
      // Sync setup + immediate paint. The persisted draft (game, players,
      // photo) renders without waiting on the network, so the user sees
      // their Gather screen the instant they tap Log. Async work (buddies,
      // expansions, lobby open, live-scores subscribe) folds in via a
      // second render() once it lands.
      const existing = window.PlaySession.load();
      this._ps = existing || new window.PlaySession();
      // Drop the previous run's lobby unless it still addresses the run we are
      // about to start. This view is a singleton, so without this a finished
      // session's code survives into the next one and _lobbyReady() short-
      // circuits on it forever — see _resetRunState(). After a finalize
      // _ps.code is null, so a stale _lobby can never match and gets dropped;
      // a refresh in place keeps its lobby and pays no extra round trip.
      const keepCode = (this.params && this.params.code) || this._ps.code || null;
      if (!this._lobby || !keepCode || this._lobby.code !== keepCode) {
        this._resetRunState();
      }
      // A participant_id addresses a row in ONE lobby's roster. When the run we
      // are about to start isn't the one those ids were minted against they
      // point at nothing — and _syncRosterToLobby SKIPS anyone already carrying
      // one, so leaving them behind is exactly how a resumed draft ends up in a
      // lobby that holds only the host.
      //
      // Gated on the code changing rather than folded into _resetRunState(),
      // which runs on every plain browser refresh (this._lobby is null on a
      // fresh page load, so its guard above always fires). A host who refreshes
      // mid-Play has ids that are still valid against a roster that is now
      // LOCKED — bgb_add_participant is Gather-only, so nothing could
      // re-acquire them, and every column's live-score write is gated on
      // p.participant_id. Clearing them there would turn a Gather-phase bug
      // into a permanent Play-phase one.
      if (!keepCode || this._ps.code !== keepCode) {
        for (const p of this._ps.players || []) p.participant_id = null;
        this._ps.persist();
      }
      // Deep-link entry: URL was /play/{code}. If the localStorage draft is
      // for a different code (or empty), adopt the URL's code so
      // _ensureLobbyOpen fetches the right lobby. If the current user turns
      // out not to be the host of that lobby, hop to session-viewer.
      // Offline is decided before anything can reach for the network, so the
      // deep-link host-vs-joiner probe below doesn't fire a doomed request and
      // the first render already knows which Gather header to paint.
      this._offline = !!(window.BgbNet && window.BgbNet.isOffline());

      const urlCode = this.params && this.params.code;
      if (urlCode && !this._offline && this._ps.code !== urlCode) {
        try {
          const s = await window.PlaySession.fetchLobby(urlCode);
          const me = window.store.get("user");
          if (s && me && s.host_user_id && s.host_user_id !== me.id) {
            // Bails before _ensureLobbyOpen, so anything a chooser tap minted
            // would never be consumed — close it rather than leak it.
            window.PlaySession.discardPrefetchedLobby();
            window.router.go("session-viewer", { code: urlCode });
            return;
          }
          // Host (or unknown user — fall through to the host path which
          // will re-validate and either resume or open a fresh lobby).
          this._ps.code = urlCode;
          if (s && s.game_id) this._ps.gameId = s.game_id;
          this._ps.persist();
          // Hand the row we just fetched to _ensureLobbyOpen so it doesn't
          // immediately re-fetch the same code.
          this._prefetchedLobby = s || null;
        } catch (_) {
          // Lobby fetch failed — treat as a regular play-flow open and let
          // _ensureLobbyOpen handle the recovery.
          this._ps.code = urlCode;
        }
      }
      this._ensureSelfIncluded();
      window.store.set("activePlay", this._ps);

      this.listenDom("chapters-changed", () => {
        if (this._guideWidget) this._guideWidget.refresh();
      });

      // The lobby poll skips its ticks while the tab is hidden — fire one
      // immediate catch-up tick when it becomes visible again. Auto-removed
      // on unmount via listenDom.
      this.listenDom("visibilitychange", () => {
        if (!document.hidden) this._lobbyPollTick();
      });

      // Synchronously pull the host-flow seeds bootstrap warmed up at login
      // so the first paint already has the player + game picker dropdowns
      // populated. The async preload below still runs to kick SWR's
      // background refresh, but the user never sees an empty dropdown.
      if (window.bgbCache) {
        const seededBuddies = window.bgbCache.get("buddy", "all");
        if (seededBuddies) {
          this._buddies = seededBuddies.accounts || [];
          this._ghosts = seededBuddies.ghosts || [];
          this._recent = seededBuddies.recent || [];
          this._buddyDataReady = true;
        }
      }

      this.render();

      // Preload buddies (accounts), ghosts, and recently-played-with in one
      // cached call. Powers the player picker's empty-state suggestions and
      // username search without per-mount round-trips. Tracked on `this` so a
      // sheet opened before it lands can be filled in place rather than making
      // the host close and re-open it.
      this._buddyDataReady = false;
      this._buddyPreloadPromise = (async () => {
        let combined;
        try {
          combined = await window.Buddy.allBuddies();
        } catch (_) {
          // Keep whatever the synchronous cache seed above already produced
          // rather than replacing it with empties. Offline (or on any blip
          // past the 7d stale window) this is the difference between a player
          // picker that still knows the host's regular group and one that
          // forgets everyone the moment the network does.
          combined = {
            accounts: this._buddies,
            ghosts: this._ghosts,
            recent: this._recent,
          };
        }
        this._buddies = combined.accounts || [];
        this._ghosts = combined.ghosts || [];
        this._recent = combined.recent || [];
        this._buddyDataReady = true;
        // The picker sheet can be open on a cold cache, showing its own
        // "loading" state; hand it the real rows the moment they land rather
        // than making the host close and re-open it.
        if (window.PlayerPickerSheet && window.PlayerPickerSheet.isOpen()) {
          window.PlayerPickerSheet.setCandidates(this._buddyCandidates(), this._recentCandidates());
        }
        return combined;
      })();
      const expansionsPromise = this._loadExpansionsIfNeeded();
      // The session code is the one thing the Gather screen visibly lacks, so
      // it gets its own repaint rather than riding the slowest of the three
      // preloads — a slow buddy fetch used to leave the invite card showing
      // "— — — — —" long after the code had arrived.
      const lobbyPromise = this._lobbyReady().then(() => {
        this.render();
        this._startLobbyPoll();
      });
      await Promise.all([this._buddyPreloadPromise, expansionsPromise, lobbyPromise]);

      this.render();
      // Initial scroll to the live phase's section — render() no longer
      // does this on every paint (the poll-driven re-renders would yank
      // scroll back continuously), so do it here once on mount instead.
      this._scrollToCurrentPhase();
      await this._startLiveScores();
      if (this._guideWidget) this._guideWidget.refresh();
    }

    async onUnmount() {
      // A navigation mid-drag would otherwise leave the clone on document.body
      // and the pointer capture stranded.
      if (window.PlayerReorder) window.PlayerReorder.cancel();
      this._stopLobbyPoll();
      if (this._liveOff) { try { this._liveOff(); } catch (_) {} }
      this._liveOff = null;
      // Fire-and-forget: supabase-js removeChannel awaits an unsubscribe ack
      // that never arrives if the socket never reached READY (e.g. when the
      // migration hasn't been applied yet or RLS denies SELECT). Awaiting it
      // would freeze the bottom-nav navigation.
      if (this._liveScores) {
        const live = this._liveScores;
        Promise.resolve().then(() => live.stop()).catch(() => {});
      }
      this._liveScores = null;
      // Defensive: any pending Discard-confirm dialog should not survive
      // the navigation. PolaroidPopup is a global overlay, so it would
      // otherwise float over the destination view.
      if (window.PolaroidPopup) window.PolaroidPopup.dismiss();
    }

    // ── Lobby + phase ────────────────────────────────────────────────────────

    /**
     * Tear down everything that belonged to the PREVIOUS run of the cascade.
     *
     * This view is a singleton (init.js), so every field on it outlives the
     * session it was set for. `_lobby` in particular used to survive a
     * finalize: the host saved, went back to the Play tab, tapped Host a game,
     * and _lobbyReady() short-circuited on the finished session's code — so
     * _ensureLobbyOpen() never ran, the freshly prefetched lobby was never
     * consumed, and every write went to a session the server had already
     * closed. The invite card showed a code that could not be joined and
     * Continue bounced off a 404.
     *
     * Called from _startAnotherRound (which has always done this inline),
     * conditionally from onMount, and from both terminal branches of _runSave —
     * the run a saved or queued play belongs to is over, and leaving its lobby
     * handles live is what let a finished session mint a replacement for itself.
     */
    _resetRunState() {
      // Live wiring — mirrors onUnmount.
      this._stopLobbyPoll();
      if (this._liveOff) { try { this._liveOff(); } catch (_) {} }
      this._liveOff = null;
      if (this._liveScores) {
        const live = this._liveScores;
        Promise.resolve().then(() => live.stop()).catch(() => {});
      }
      this._liveScores = null;
      this._lobby = null;
      this._lobbyProvisional = false;
      // Drop any in-flight open so _lobbyReady() can't hand the new run a
      // promise that resolves to the old lobby's code.
      this._lobbyPromise = null;
      this._healPromise = null;
      this._prefetchedLobby = null;
      this._cardId = null;
      this._codeReplaced = false;
      if (this._codeReplacedTimer) {
        clearTimeout(this._codeReplacedTimer);
        this._codeReplacedTimer = null;
      }

      // Reset the async guards so an in-flight call from the finished session
      // can't reconcile into the new one.
      this._phaseSeq++;
      this._pendingPhase = 0;
      this._pendingDeletes = 0;
      // _phaseSeq's sibling for the save path: a write that resolves after this
      // must not clear the draft, null activePlay, or re-disable the Save button
      // of the run that replaced it. See _isStaleSave.
      this._saveSeq++;
      // Nulled here so a plain onMount reset can't inherit the previous run's
      // gate; _startAnotherRound deliberately sets it AFTER calling this.
      this._lobbyGate = null;
      // Deliberately NOT clearing participant_id here — see onMount. This runs
      // on every plain browser refresh, where the draft's ids are still good.
      this._rosterSyncPromise = null;
      this._rosterRetries = 0;
      this._rosterPending = 0;
      // A queued order write belongs to the run that queued it — firing it
      // against the next run's lobby would reorder a roster it never saw.
      if (this._orderTimer) { clearTimeout(this._orderTimer); this._orderTimer = null; }
      this._orderPromise = null;
      this._orderDirty = false;
      this._saving = false;
      this._error = null;
    }

    /**
     * Whether this run of the cascade is lobby-less.
     *
     * Latched at mount rather than read live, because every guard downstream
     * has to agree with itself for the whole session: a host who starts
     * offline must not have a poll spring to life the moment a bar of signal
     * appears, half-adopting a lobby that was never minted. Connectivity
     * returning matters at exactly one point — Save — where _runSave asks
     * BgbNet again and posts live if it can.
     */
    _isOffline() {
      return !!this._offline;
    }

    /**
     * The code of a lobby this run actually opened, or null.
     *
     * Deliberately not `_ps.code`: the persisted draft outlives the lobby it
     * was minted against, so offline (or after a lobby was found gone) the
     * draft can still carry a code that no longer addresses anything. Every
     * write to /sessions/{code} keys off this.
     */
    _liveLobbyCode() {
      return (this._lobby && this._lobby.code) || null;
    }

    /**
     * Resolves to this run's lobby code, minting one if we don't have it yet.
     *
     * Single-flight on purpose: now that Continue no longer waits for the code
     * (see render()), _advancePhase can want the lobby at the same moment
     * onMount is already opening it, and a second _ensureLobbyOpen() would POST
     * /sessions twice — minting a lobby whose stale-abandon sweep closes the
     * first one out from under the host.
     *
     * Resolves null when there is no lobby to be had: offline, or the mint
     * failed. That is a normal outcome, not an error — the cascade runs fine
     * without one (see _withLobby).
     *
     * A PROVISIONAL lobby doesn't short-circuit. Those are fabricated from the
     * draft by _ensureLobbyOpen to ride out a blip, and short-circuiting on one
     * latched a code that may since have been closed: the fabrication would
     * outlive the blip and never be re-checked.
     */
    _lobbyReady() {
      const code = this._liveLobbyCode();
      if (code && !this._lobbyProvisional) return Promise.resolve(code);
      if (!this._lobbyPromise) {
        // Captured into a local at chain-construction time: _resetRunState
        // nulls the field, and a chain that read it later would lose the gate
        // its own run was started with. Null on every path but "Another
        // round?", where it holds the mint until the previous round's write has
        // settled — see _startAnotherRound.
        const gate = this._lobbyGate;
        this._lobbyPromise = Promise.resolve(gate)
          .catch(() => {})
          .then(() => this._ensureLobbyOpen())
          .catch(() => {})
          .then(() => {
            this._lobbyPromise = null;
            return this._liveLobbyCode();
          });
      }
      return this._lobbyPromise;
    }

    /**
     * Does this error mean the lobby itself is gone, as opposed to this one
     * write being refused?
     *
     * Only 404 and 410. Every session endpoint gates on `status = 'open'`
     * (bgb_session_gate), so a finalized, abandoned or expired session answers
     * `not_found` → 404 or `expired` → 410 whatever you asked it to do. That is
     * the same test _ensureLobbyOpen has always used.
     *
     * Deliberately NOT the other 4xx, even though they also come from
     * services/_helpers.py's session map. 409 `roster_locked` means the roster
     * froze when Play started and 400 `invalid_transition` means the move
     * itself was wrong — both come from a perfectly healthy lobby, and healing
     * on one would abandon it (bgb_create_session closes the host's other open
     * sessions) to no purpose. Same for err.offline / status 0 and any 5xx:
     * those are blips, and re-minting on a hiccup would kill a live session and
     * hand the table a code nobody has.
     */
    _isLobbyGone(e) {
      const status = e && e.status;
      return status === 404 || status === 410;
    }

    /**
     * Has the host moved on from the run this save belongs to?
     *
     * Two tests, because they catch different things. `snap.ps !== this._ps` is
     * the one that matters: _startAnotherRound installs a brand-new
     * PlaySession, so a late `this._ps.clear()` would wipe the NEXT round's
     * roster and its draft. `snap.seq !== this._saveSeq` covers a reset that
     * happened to reuse an instance (onMount's conditional _resetRunState),
     * where identity alone would still say "current".
     *
     * @param {{ps: any, seq: number}} snap
     */
    _isStaleSave(snap) {
      return snap.ps !== this._ps || snap.seq !== this._saveSeq;
    }

    /**
     * Run a write against this run's lobby code, healing a dead lobby rather
     * than reporting it.
     *
     * The live session is a nice-to-have; recording the play is not. So when
     * the server says the lobby is gone, the answer is a new lobby and a
     * carry-on — never an error the host has to clear before they can keep
     * playing. Resolves the write's result, or null when there was no lobby to
     * write to (offline, mint failed, or the retry also failed).
     *
     * @param {(code: string) => Promise<any>} fn
     */
    async _withLobby(fn) {
      let code = this._liveLobbyCode() || (await this._lobbyReady());
      if (!code) return null;
      try {
        return await fn(code);
      } catch (e) {
        if (!this._isLobbyGone(e)) return null;
      }
      // Definitively gone — heal and try once against the replacement.
      code = await this._healLobby(code);
      if (!code) return null;
      try {
        return await fn(code);
      } catch (_) {
        return null;
      }
    }

    /**
     * Replace a lobby the server has disowned. Resolves the new code, or null.
     *
     * Single-flight, and that is the whole point. _syncRosterToLobby pushes its
     * players with a Promise.all, so a dead lobby fails N writes at the same
     * instant; without this each one would drop the lobby and mint its own
     * replacement, and since bgb_create_session abandons the host's other open
     * sessions, every mint would kill the one before it. The host would end up
     * on a code that had already been abandoned by its own successor.
     */
    _healLobby(deadCode) {
      if (this._healPromise) return this._healPromise;
      this._healPromise = (async () => {
        // Someone else already healed while we were queued behind them.
        const current = this._liveLobbyCode();
        if (current && current !== deadCode) return current;
        // Drop the draft's copy too, so _ensureLobbyOpen takes its create
        // branch instead of re-validating the corpse.
        this._lobby = null;
        this._lobbyProvisional = false;
        this._lobbyPromise = null;
        this._ps.code = null;
        this._ps.sessionId = null;
        this._ps.persist();
        const next = await this._lobbyReady();
        if (next && next !== deadCode) {
          // The code the host may already have read out to the table is dead.
          // Carry the roster and the live wiring over, say so on the invite
          // card, and don't interrupt them for it.
          this._onLobbyReplaced();
          this.render();
        }
        return next;
      })();
      this._healPromise.catch(() => {}).then(() => { this._healPromise = null; });
      return this._healPromise;
    }

    /**
     * A fresh lobby replaced a dead one mid-run. Everything keyed to the old
     * session has to follow it across:
     *
     *   - participant_id on each local player points at the dead lobby's roster
     *     rows, and _syncRosterToLobby skips anyone who already has one — so
     *     without clearing them the new lobby would stay empty and spectators
     *     would see a game with no players.
     *   - the live-scores channel is subscribed to the old session id.
     *
     * The host's own draft is untouched. None of this is load-bearing for the
     * play they are recording; it only restores the live mirror.
     */
    _onLobbyReplaced() {
      this._noteCodeReplaced();
      for (const p of this._ps.players || []) p.participant_id = null;
      // bgb_create_session seats the host, so the replacement's roster already
      // carries their row — adopt it here. _syncRosterToLobby below skips the
      // host by design, and a replacement that happens mid-Play leaves the
      // Gather poll disarmed, so nothing else would ever give the host back an
      // id: their own column would stop streaming for the rest of the game.
      const me = window.store.get("user");
      const mine = me && ((this._lobby && this._lobby.participants) || [])
        .find((part) => part.user_id === me.id);
      if (mine) {
        const self = (this._ps.players || []).find((p) => p.user_id === me.id);
        if (self) self.participant_id = mine.id;
      }
      this._rosterRetries = 0;
      this._rosterPending = 0;
      this._ps.persist();
      // Tear the old channel down now; it is subscribed to a session id that
      // no longer means anything.
      const hadLiveScores = !!this._liveScores;
      if (hadLiveScores) {
        const live = this._liveScores;
        if (this._liveOff) { try { this._liveOff(); } catch (_) {} }
        this._liveOff = null;
        this._liveScores = null;
        Promise.resolve().then(() => live.stop()).catch(() => {});
      }
      // Order matters, and all three steps are best-effort:
      //   1. roster — participants are Gather-only, and the replacement is born
      //      in gather, so this has to land before the phase moves off it;
      //   2. phase — otherwise the new lobby sits in gather while the host
      //      plays, and anyone joining on the new code watches a lobby that
      //      never starts;
      //   3. live scores — RLS only accepts score writes while phase='play',
      //      so re-subscribing before step 2 would have its first mirror
      //      rejected.
      this._syncRosterToLobby()
        .catch(() => {})
        .then(() => this._replayPhaseToLobby())
        .then(() => { if (hadLiveScores) return this._startLiveScores(); })
        .catch(() => {});
    }

    /**
     * Walk a freshly minted lobby up to the phase the host is actually on.
     *
     * A replacement is always born in `gather`, so a lobby minted mid-game
     * would sit there while the host played — and anyone who joined on the new
     * code would land on the Gather mirror watching a lobby that never starts.
     * bgb_advance_phase validates transitions (gather → play → settle), so this
     * steps rather than jumping.
     *
     * Best-effort and sequential: if a step fails the lobby is simply behind,
     * which costs spectators their live view and costs the host nothing.
     */
    async _replayPhaseToLobby() {
      const order = ["gather", "play", "settle"];
      const target = order.indexOf(this._ps.phase);
      if (target <= 0) return;
      const code = this._liveLobbyCode();
      if (!code) return;
      for (let i = 1; i <= target; i++) {
        if (this._liveLobbyCode() !== code) return; // healed again underneath us
        try {
          await window.PlaySession.advancePhase(code, order[i]);
        } catch (_) {
          return;
        }
      }
    }

    // Flag the invite card that the code changed under the host, and clear the
    // flag a few seconds later. Deliberately not a toast or a modal: this can
    // fire while they are typing in the scoring grid.
    _noteCodeReplaced() {
      this._codeReplaced = true;
      if (this._codeReplacedTimer) clearTimeout(this._codeReplacedTimer);
      this._codeReplacedTimer = setTimeout(() => {
        this._codeReplaced = false;
        this._codeReplacedTimer = null;
        const card = this.container && this.container.querySelector(".cascade-invite__replaced");
        if (card) card.remove();
      }, 8000);
    }

    async _ensureLobbyOpen() {
      // A closed-out draft never gets a lobby. This is the last line of defence
      // against the resurrection this change fixes: an in-flight poll tick that
      // 404s on the just-finalized session would otherwise read that as a dead
      // lobby and POST a replacement — a phantom open session that shows up in
      // every buddy's Join chooser for a game that is already saved.
      if (this._ps.isDone()) return;
      // Token the phase the host is on right now. Continue no longer waits for
      // the lobby, so they can be on Play by the time this resolves — and both
      // branches below otherwise adopt the server's phase wholesale, which
      // would yank them back to Gather (a freshly minted lobby is always
      // 'gather'). _advancePhase bumps _phaseSeq before its optimistic paint,
      // so a changed token means exactly "the host moved on, don't touch it";
      // its own PATCH carries the real phase to the server a moment later.
      const phaseSeq = this._phaseSeq;
      // The code we were on before this call, if any. If we end up minting a
      // different one, the host is holding a code that no longer works and
      // everything keyed to the old session has to follow — see
      // _onLobbyReplaced. (_healLobby clears _ps.code before calling in, so
      // this is null on that path and the notice fires there instead of twice.)
      const priorCode = this._ps.code || null;
      // Offline: no lobby, no code, no network. The cascade runs entirely off
      // the localStorage draft and the bgbCache seeds bootstrap warmed, and
      // Save queues to the outbox. Nothing here is a degraded lobby — there
      // are no joiners to serve without a server, so the whole concept is
      // simply absent for this run.
      //
      // Leaves a persisted `code` from an earlier online session untouched:
      // it can't be revalidated offline, and clearing it would lose the host's
      // ability to resume that lobby once they reconnect.
      if (window.BgbNet && window.BgbNet.isOffline()) {
        this._offline = true;
        this._lobby = null;
        return;
      }
      this._offline = false;
      // Already have a valid lobby in the persisted draft? Re-validate via
      // a fetch — if the server abandoned it we open a fresh one.
      if (this._ps.code) {
        // onMount's deep-link path may have just fetched this exact lobby
        // for the host-vs-joiner check — consume that row instead of a
        // second round-trip. One-shot: cleared here so later re-validations
        // (resume, reconnect) still hit the server.
        const pre = this._prefetchedLobby;
        this._prefetchedLobby = null;
        try {
          const s = (pre && pre.code === this._ps.code)
            ? pre
            : await window.PlaySession.fetchLobby(this._ps.code);
          if (s && s.status === "open" && s.phase && s.phase !== "abandoned") {
            this._lobby = s;
            this._lobbyProvisional = false;
            this._ps.sessionId = s.id;
            this._ps.hostUserId = s.host_user_id;
            if (phaseSeq === this._phaseSeq) this._ps.phase = s.phase;
            this._ps.persist();
            this._syncUrlToCode();
            this._reconcileGameToLobby();
            return;
          }
          // Reached the server and it says the lobby is gone/closed — fall
          // through to open a fresh one.
        } catch (e) {
          // Distinguish "lobby is definitively gone" (404/410) from a transient
          // network/server blip (no status, or 5xx) — common right after the
          // phone wakes. On a blip we must NOT mint a new code: that would
          // abandon the real session and force the host to re-navigate. Keep
          // the persisted code, render from the draft, and let the 2s poll
          // (backed by the API's 401 refresh-retry) reconnect.
          if (!this._isLobbyGone(e)) {
            // Provisional: assumed, not confirmed. _lobbyReady() re-validates
            // rather than short-circuiting, so the assumption can't outlive the
            // blip that produced it.
            this._lobbyProvisional = true;
            this._lobby = {
              code: this._ps.code,
              id: this._ps.sessionId,
              host_user_id: this._ps.hostUserId,
              phase: this._ps.phase || "gather",
              status: "open",
              participants: (this._lobby && this._lobby.participants) || [],
            };
            this._syncUrlToCode();
            return;
          }
          // Definitively gone — fall through and create a new one.
        }
      }
      try {
        // The tap handler that sent us here (Host / Another Round / a game
        // tile) already fired POST /sessions, so this usually resolves on the
        // spot. Falls through to a normal mint when there was no prefetch, it
        // aged out, or it failed.
        //
        // No game-id match check on purpose: a lobby minted before the user
        // picked a game is still a good lobby — _reconcileGameToLobby() below
        // exists precisely to push a late pick to the server.
        const pre = window.PlaySession.takePrefetchedLobby();
        let session = null;
        if (pre) { try { session = await pre; } catch (_) { session = null; } }
        if (!session) {
          session = await window.PlaySession.openLobby({ gameId: this._ps.gameId });
        }
        this._lobby = session;
        this._lobbyProvisional = false;
        this._ps.code = session.code;
        this._ps.sessionId = session.id;
        this._ps.hostUserId = session.host_user_id;
        if (phaseSeq === this._phaseSeq) this._ps.phase = session.phase || "gather";
        this._ps.persist();
        this._syncUrlToCode();
        this._reconcileGameToLobby();
        if (priorCode && session.code !== priorCode) {
          this._onLobbyReplaced();
        } else {
          // A lobby minted for a run that ALREADY has a roster. "Another
          // round?" on the Play tab (log-play-view._anotherRound) seeds one
          // straight from the last play, and a resumed draft can carry one
          // too. POST /sessions seats only the host, and nothing here used to
          // push the rest: priorCode is null on a fresh draft, so the
          // _onLobbyReplaced branch above never fired and a six-player game
          // reached spectators as a one-column grid with no scores in it.
          // Fire-and-forget, like every other roster write.
          this._syncRosterToLobby();
        }
      } catch (_) {
        // No lobby this run. That is a degraded live session, not a broken
        // play: the cascade runs off the draft and Save falls back to
        // Play.create for a codeless session. The invite card says so quietly
        // (see _renderInviteCard) — a red alert over the cascade would tell the
        // host something is wrong with the thing they came here to do, and
        // nothing is.
        this._lobby = null;
        this._lobbyProvisional = false;
      }
    }

    // A game can be picked before the lobby exists: onMount mounts the finder
    // (live and pickable) before _ensureLobbyOpen() resolves. That first pick
    // sets _ps.gameId, but _applyGamePick's push was skipped because _ps.code
    // was still null — so the game never reached the server and only the
    // SECOND pick "stuck". Once the lobby is open, push the pending pick so
    // the session row + joiners' mirrors catch up. No-op in the common case
    // where the lobby already carries the picked game (opened WITH a gameId,
    // or nothing picked yet).
    _reconcileGameToLobby() {
      const ps = this._ps;
      if (!ps || !ps.gameId) return;
      if (this._lobby && this._lobby.game_id === ps.gameId) return;
      this._withLobby((code) =>
        window.PlaySession.updateLobby(code, { gameId: ps.gameId })
          .then((r) => { if (this._lobby) this._lobby.game_id = ps.gameId; return r; })
      );
    }

    // Once we know the lobby code, rewrite the address bar from /play to
    // /play/{code} so a refresh resumes the session (and the URL is
    // shareable). Uses replaceState — we don't want a back-press from the
    // session to land on a /play entry that would re-create a fresh lobby.
    //
    // _ensureLobbyOpen() is a plain async chain with no cancellation: if the
    // host bounces to another tab (Feed, Profile, …) while a lobby open/
    // re-validate is still in flight, onUnmount() doesn't abort it — it just
    // resolves later and, without this guard, would silently rewrite the
    // address bar to /play/{code} out from under whatever view the user has
    // since navigated to. A refresh at that point would then reopen this
    // session instead of the screen actually on screen. Gate on _mounted
    // (flipped false by View.unmount()) so only a still-current run touches
    // the URL.
    _syncUrlToCode() {
      if (!this._mounted) return;
      if (!this._ps || !this._ps.code) return;
      if (window.router && window.router.replaceUrl) {
        window.router.replaceUrl("play-flow", { code: this._ps.code });
      }
    }

    _startLobbyPoll() {
      // The poll exists solely to auto-promote joiners into the player list.
      // Offline there is no lobby to read and no joiner to promote, so the
      // interval is never armed — not armed-and-skipping, which would still
      // wake the tab every 2s for nothing.
      if (this._isOffline()) return;
      // Same reasoning, same remedy, for every phase after Gather. Promotion is
      // a Gather-only act: bgb_join_session only writes the participants table
      // while the session is gathering, so someone joining by code during Play
      // or Settle is a spectator who never reaches the host's roster. From
      // Gather onward the host PUSHES (live scores), and there is nothing left
      // to read back. _advancePhase arms and disarms this on the transition.
      if (this._ps.phase !== "gather") return;
      if (this._lobbyPoll || !this._lobby) return;
      this._lobbyPoll = setInterval(() => this._lobbyPollTick(), 2000);
    }

    async _lobbyPollTick() {
      if (!this._lobby) return;
      // Hidden tab: skip the fetch — the visibilitychange listener (onMount)
      // fires one catch-up tick the moment the tab is visible again.
      if (document.hidden) return;
      // Outside Gather there is nothing to promote (see _startLobbyPoll), and
      // the interval is disarmed there anyway. This stays because the
      // visibilitychange catch-up listener in onMount calls this tick DIRECTLY,
      // without going through _startLobbyPoll — so the tick has to defend
      // itself. Without it, a host who saves and then backgrounds and
      // foregrounds the tab fetches a finalized session, reads the 404 as a
      // dead lobby, and mints a replacement for a game that is already saved.
      if (this._ps.phase !== "gather") return;
      // Skip the tick while a participant DELETE is in flight — the
      // server still has the row, and the merge logic below would
      // re-add it as a "new" participant.
      if (this._pendingDeletes > 0) return;
      // Skip while a phase change is in flight — the response below would
      // overwrite this._lobby with a row whose phase may not yet reflect
      // the transition the host just kicked off.
      if (this._pendingPhase > 0) return;
      // A drag owns the DOM order of the player list until it drops. This tick
      // ends in _refreshPlayersList(), which replaces every <li> — including the
      // one under the user's finger. Skipping a tick costs a joiner two seconds
      // of latency; not skipping costs the host their gesture.
      if (window.PlayerReorder && window.PlayerReorder.isDragging()) return;
      // Same for an order write in flight: the bundle below was fetched before
      // it landed, so acting on it would repaint the pre-drag order back in.
      if (this._orderPromise || this._orderDirty) return;
      try {
        const next = await window.PlaySession.fetchLobby(this._lobby.code);
        const prevIds = new Set((this._lobby.participants || []).map((p) => p.id));
        const nextParts = next.participants || [];
        const participantsChanged =
          nextParts.length !== prevIds.size ||
          nextParts.some((p) => !prevIds.has(p.id));
        this._lobby = next;
        let playersChanged = false;
        if (this._ps.phase === "gather") {
          const byName = new Map(
            this._ps.players.map((p, i) => [(p.name || "").toLowerCase(), i])
          );
          // Account players are matched on user_id first. Names are the only
          // handle a guest has, but for someone with an account they're a
          // weaker key than the id we already hold — and participant_id is
          // now what live scoring is mirrored under (migration 053), so a
          // row that fails to acquire one has its column stop streaming to
          // spectators, not just lose its DELETE affordance.
          const byUserId = new Map(
            this._ps.players
              .map((p, i) => [p.user_id, i])
              .filter(([id]) => !!id)
          );
          for (const part of nextParts) {
            const key = (part.display_name || "").toLowerCase();
            const idx = part.user_id != null && byUserId.has(part.user_id)
              ? byUserId.get(part.user_id)
              : (key && byName.has(key) ? byName.get(key) : undefined);
            if (idx !== undefined) {
              // Backfill participant_id onto an existing local row (e.g. one
              // the host added optimistically before the backend round-trip
              // completed) so _removePlayer can issue a DELETE later.
              const existing = this._ps.players[idx];
              if (existing && !existing.participant_id) {
                existing.participant_id = part.id;
                playersChanged = true;
              }
              continue;
            }
            if (!key) continue;
            this._ps.players.push({
              name: part.display_name,
              is_winner: false,
              score: null,
              user_id: part.user_id || null,
              avatar: part.avatar || null,
              participant_id: part.id,
              // Same-length array as everyone else, exactly like _addPlayer.
              // Promoted joiners used to arrive with no roundScores at all,
              // which is how a column ended up showing more cells than its
              // Total counted.
              roundScores: Array(this._maxRoundCount()).fill(null),
            });
            byName.set(key, this._ps.players.length - 1);
            if (part.user_id) byUserId.set(part.user_id, this._ps.players.length - 1);
            playersChanged = true;
          }
          if (playersChanged) this._ps.persist();
        }
        // The poll runs every 2s and used to fire a full render() on any
        // participant change. That rebuilt the cascade DOM via
        // innerHTML, causing a visible repaint pulse and a brief
        // sticky/scroll glitch. Instead, the only thing a poll can
        // change in the host UI is the players list (and only during
        // Gather, when new joiners get auto-promoted to player rows).
        // Patch just that subtree — scroll position survives.
        if (playersChanged) this._refreshPlayersList();
        this._reconcileRosterToLobby();
      } catch (e) {
        // A dead lobby 404s here every 2s. Swallowing that forever left the
        // invite card advertising a code nobody could join for the rest of the
        // game. Drop it so the next lobby write mints a replacement; a blip
        // (offline / 5xx) is still swallowed, because re-minting on one would
        // abandon a session that is merely unreachable.
        if (this._isLobbyGone(e)) {
          const dead = this._liveLobbyCode();
          this._stopLobbyPoll();
          const code = await this._healLobby(dead);
          this.render();
          if (code) this._startLobbyPoll();
        }
      }
    }

    _refreshPlayersList() {
      const ul = this.container.querySelector(".cascade-players");
      if (!ul) return;
      ul.innerHTML = this._ps.players.map((p, i) => this._renderPlayerRow(p, i)).join("");
      this.refreshIcons();
      this._bindPlayerReorder();
    }

    /**
     * (Re)bind the drag-to-reorder gesture to the Gather players list.
     *
     * Called after every paint of that list. render() replaces the whole
     * container, so the <ul> is a new node and binds fresh; _refreshPlayersList
     * only swaps its children, so the delegated machine survives and bind()
     * no-ops on the node's own flag. Exactly one machine per live <ul> either
     * way — which is the point of delegating rather than binding each row.
     */
    _bindPlayerReorder() {
      if (!window.PlayerReorder) return;
      const ul = this.container.querySelector("#screen-gather .cascade-players");
      if (!ul) return;
      window.PlayerReorder.bind(ul, {
        rowSelector: ".cascade-player",
        handleSelector: ".cascade-player__grip",
        onReorder: (from, to) => this._movePlayer(from, to),
      });
    }

    /**
     * Move a player between slots.
     *
     * The players array IS the scoring grid's column order — round-score-grid.js
     * keys every cell, input id and inline handler off the array index — so this
     * splice is the whole of the local reorder. It is also exactly why nothing
     * that patches BY index may run against the stale order: _patchScoringCells,
     * _refreshTotalsCells and _setInitials's heads[i] all address columns
     * positionally. Both index-keyed surfaces are therefore repainted here, not
     * patched. Everything that identifies a player — is_winner, team, initials,
     * roundScores, participant_id — lives on the object and travels with it, and
     * the live-scores overlay is keyed by participant_id rather than by index.
     *
     * from/to are DOM positions the widget read off the live list. A mismatch
     * means something repainted underneath the drag (it shouldn't — the poll is
     * gated on isDragging()); fall back to a full render rather than splice
     * against an array that isn't the one the host was looking at.
     */
    _movePlayer(from, to) {
      const players = this._ps.players || [];
      if (from === to) return;
      if (from < 0 || from >= players.length || to < 0 || to >= players.length) {
        this.render();
        return;
      }
      const [moved] = players.splice(from, 1);
      players.splice(to, 0, moved);
      this._ps.persist();
      this._refreshPlayersList();     // re-bakes every inline handler's index
      this._refreshScoringSection();  // re-bakes every cell id and handler index
      this._pushOrderToLobby();
    }

    /**
     * Mirror the local player order into the lobby roster.
     *
     * Debounced, because a tidy-up is a burst of drops and each write names the
     * whole roster. Best-effort like every other lobby write: losing it costs
     * the spectators a column order, not the host their play. The one moment it
     * is not fire-and-forget is the gather→play advance, where _advancePhase
     * awaits the flush — bgb_reorder_participants is Gather-only.
     *
     * Offline there is no lobby at all, so the order simply stays local; it is
     * pushed by the next drag once a lobby exists.
     */
    _pushOrderToLobby() {
      if (this._isOffline()) return;
      this._orderDirty = true;
      if (this._orderTimer) clearTimeout(this._orderTimer);
      this._orderTimer = setTimeout(() => {
        this._orderTimer = null;
        this._flushOrderToLobby();
      }, ORDER_PUSH_DEBOUNCE_MS);
    }

    _flushOrderToLobby() {
      if (this._orderTimer) { clearTimeout(this._orderTimer); this._orderTimer = null; }
      if (this._orderPromise) return this._orderPromise;
      if (!this._orderDirty || this._isOffline()) return Promise.resolve();
      this._orderDirty = false;
      // Only players that HAVE a roster row can be named. Anyone still waiting
      // on their POST is appended server-side in joined_at order, and the next
      // drag (or the pre-Play flush, which syncs the roster first) places them.
      const ids = (this._ps.players || []).map((p) => p.participant_id).filter(Boolean);
      if (ids.length < 2) return Promise.resolve();
      this._orderPromise = this._withLobby((code) =>
        window.PlaySession.reorderParticipants(code, ids)
      ).then((updated) => {
        if (updated) this._lobby = updated;
        return updated;
      }).finally(() => {
        this._orderPromise = null;
        // A drop landed while the write was in flight — send the newer order.
        if (this._orderDirty) this._flushOrderToLobby();
      });
      return this._orderPromise;
    }

    /**
     * Arm the poll in Gather, disarm it everywhere else.
     *
     * Called from _advancePhase — the one funnel every phase change goes
     * through, forward via Continue and backward via _phaseBack, online and
     * offline alike. _startLobbyPoll no-ops offline and off-Gather on its own,
     * so this is safe to call unconditionally on either branch.
     */
    _syncLobbyPollToPhase() {
      if (this._ps.phase === "gather") this._startLobbyPoll();
      else this._stopLobbyPoll();
    }

    _stopLobbyPoll() {
      if (this._lobbyPoll) {
        clearInterval(this._lobbyPoll);
        this._lobbyPoll = null;
      }
    }

    async _startLiveScores() {
      // Realtime goes browser → Postgres directly (anon key + RLS), so it has
      // its own connection to fail at. Guarded explicitly rather than relying
      // on sessionId being null: a draft resumed from an earlier online
      // session still carries one, and opening a channel for a lobby nobody
      // is in would retry forever in the background.
      if (this._isOffline()) return;
      if (this._liveScores || !this._ps.sessionId) return;
      this._liveScores = new window.LiveScores({
        sessionId: this._ps.sessionId,
        isHost: true,
      });
      await this._liveScores.start();
      this._liveOff = this._liveScores.subscribe(() => this._onLiveScoresChange());
      // Publish the grid the host is actually looking at. start() only read
      // the table; a resumed draft (or a row whose participant_id landed late)
      // can hold cells the table has never seen, and spectators are read-only
      // now, so nobody else would ever fill them in. Fire-and-forget — the
      // host's screen already shows this state.
      this._liveScores.syncGrid(this._ps.players).catch(() => {});
    }

    // A live-scores tick (Realtime echo or poll refresh): patch the per-round
    // cells, re-pick the leader, then repaint the totals. The host is the only
    // writer, so these are normally echoes of the host's own edits; the cell
    // the host is currently editing is skipped so their caret/keystrokes
    // survive the round trip.
    //
    // _autoSelectWinners() belongs HERE, not only at the typing sites. Totals
    // resolve through the live overlay (_resolvedScore), so this tick is the
    // moment a cell's value actually becomes current — every path that changes
    // a number ends up here, and the crown has to be re-derived from the same
    // numbers the totals row is about to show. It used to be re-derived only
    // where the host typed, and always one keystroke before the overlay caught
    // up, so a player who overtook the leader kept showing the old crown until
    // the next keystroke nudged it.
    _onLiveScoresChange() {
      this._patchScoringCells();
      this._autoSelectWinners();
      this._refreshTotalsCells();
    }

    _patchScoringCells() {
      const focused = this.container.querySelector("input.scoring-cell:focus");
      const players = this._ps.players;
      // The grid renders max(roundScores.length) rows for EVERY column, so
      // patch that many cells per player — a per-player length would leave a
      // short column's live cells frozen at whatever they last rendered as.
      const n = this._maxRoundCount();
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        for (let r = 0; r < n; r++) {
          const input = this.container.querySelector(`input[data-score-cell="${i}-${r}"]`);
          if (!input || input === focused) continue;
          const v = this._resolvedScore(p, r);
          const text = v == null ? "" : String(v);
          // Programmatic .value assignment does not fire `oninput`, so the
          // cell's _setRoundScore handler is untouched (no feedback loop).
          if (input.value !== text) input.value = text;
          const wrap = input.closest(".scoring-cell-wrap");
          if (wrap) wrap.classList.toggle("is-neg", text.charAt(0) === "-");
        }
      }
    }

    _ensureSelfIncluded() {
      if (this._ps.players.length > 0) return;
      const me = window.store.get("user");
      if (!me) return;
      this._ps.players.push({
        name: me.display_name,
        is_winner: false,
        score: null,
        user_id: me.id,
        avatar: me.avatar || null,
      });
      this._ps.persist();
    }

    // ── Render shell ────────────────────────────────────────────────────────

    render() {
      const ps = this._ps;
      const phase = ps.phase || "gather";
      // Only the screen matching the live phase is unlocked. The other two
      // collapse to height: 0 (.is-locked), so users can never scroll
      // between sections — navigation is gated to the Continue CTA and the
      // top-left back-arrow (which rolls the phase backwards via the
      // server, see _phaseBack below).
      const lockGather = phase !== "gather";
      const lockPlay   = phase !== "play";
      const lockSettle = phase !== "settle";

      this.container.innerHTML = `
        <section class="cascade-screen ${lockGather ? "is-locked" : ""}" id="screen-gather">
          ${this._renderScreenHeader("Gather", 1, false)}
          ${this._renderGather()}
          ${this._renderContinue("Continue to Play", () => "_advanceToPlay()", {
            // Deliberately NOT gated on the lobby. Minting a code is a
            // multi-second round-trip (Railway → Supabase → bgb_create_session)
            // and nothing on the Play screen needs it, so making the host watch
            // a greyed-out button for it was pure dead time. _advancePhase
            // paints the transition immediately and parks its PATCH on
            // _lobbyReady() instead. A game pick is the only real prerequisite;
            // _advanceToPlay still checks the roster.
            disabled: !this._ps.gameId,
          })}
        </section>

        <section class="cascade-screen ${lockPlay ? "is-locked" : ""}" id="screen-play">
          ${this._renderScreenHeader("Play", 2, true)}
          ${this._renderPlay()}
          ${this._renderContinue("Wrap up", () => "_advanceToSettle()")}
        </section>

        <section class="cascade-screen ${lockSettle ? "is-locked" : ""}" id="screen-settle">
          ${this._renderScreenHeader("Settle Up", 3, true)}
          ${this._renderSettle()}
          ${this._renderSaveCta()}
        </section>
        ${this._error ? `<div class="alert alert-error cascade-error">${escapeHtml(this._error)}</div>` : ""}
      `;
      this.refreshIcons();
      this._mountReferenceGuide();
      this._bindPlayerReorder();
      // NOTE: do NOT call _scrollToCurrentPhase() here. render() runs every
      // 2s via the lobby poll and on every player edit — yanking the scroll
      // to the top of the active section made long Gather screens feel
      // un-scrollable. _scrollToCurrentPhase() is now only called when the
      // active phase actually changes (onMount, _advancePhase, _phaseBack).
    }

    /**
     * The unpicked Game card. Recently-played games are tappable right here —
     * they used to be invisible until the search input took focus, which hid
     * the shortcut for the commonest case behind a gesture — and search itself
     * moves into a sheet (widgets/game-search-sheet.js).
     * @returns {string}
     */
    _renderGameChooser() {
      const recent = this._recentGames();
      const tiles = recent.slice(0, 3).map((g) => `
        <button class="cascade-game-quick" type="button"
                onclick="window.playFlowView._quickPickGame('${jsStr(g.id)}')">
          <span class="cascade-game-quick__art">${gameArtImg(g, "chip", { alt: "" })}</span>
          <span class="cascade-game-quick__n">${escapeHtml(g.name || "")}</span>
        </button>`).join("");
      return `
        ${tiles ? `<div class="cascade-game-quicks">${tiles}</div>` : ""}
        <button class="cascade-game-search" type="button" aria-haspopup="dialog"
                onclick="window.playFlowView._openGameSearch(event)">
          <i data-icon="search" class="w-4 h-4"></i>
          <span>${tiles ? "Search all games…" : "Search for a game…"}</span>
        </button>
      `;
    }

    /**
     * The games behind the quick-pick tiles. Read straight off the cache
     * bootstrap seeds at login (and Game.recentlyPlayed refreshes), so the card
     * paints populated in the tap frame with no round-trip. peek(), not get():
     * a host in a cabin for a weekend should still see their own recents, which
     * is what the 7d stale window is for.
     * @returns {any[]}
     */
    _recentGames() {
      if (!window.bgbCache) return [];
      const rows = window.bgbCache.peek("game.recent", "self");
      return Array.isArray(rows) ? rows.filter((g) => g && g.id && !g.is_expansion) : [];
    }

    /** Tap a quick-pick tile. Same sink as a search result. @param {string} id */
    _quickPickGame(id) {
      const game = this._recentGames().find((g) => g.id === id);
      if (game) this._applyGamePick(game);
    }

    /** @param {Event} [event] */
    _openGameSearch(event) {
      window.GameSearchSheet.open({
        title: "Pick a game",
        returnFocus: (event && event.currentTarget) || null,
        onPick: (game, ctx) => this._onFinderPick(game, ctx),
      });
    }

    _onFinderPick(game, ctx) {
      // A session's main game is always a base game. /search excludes
      // expansions from every source, but the recently-played seed isn't
      // filtered — a host who once logged an expansion as the main game can
      // still surface one — so the guard covers every source, not just BGG.
      // The refusal returns control to the dropdown with an inline reason.
      if (game && game.is_expansion) {
        return { refuse: true, reason: "Pick a base game; expansions attach in the Expansions card." };
      }
      this._applyGamePick(game);
    }

    _renderScreenHeader(title, step, showBack) {
      return `
        <header class="cascade-screen__header">
          ${showBack ? `
            <button class="cascade-back" title="Back"
                    onclick="window.playFlowView._phaseBack('${escapeAttr(title.toLowerCase())}')">
              <i data-icon="chevron-up" class="w-4 h-4"></i>
            </button>
          ` : `<span class="cascade-back-spacer"></span>`}
          <div class="cascade-screen__header-body">
            <h1 class="cascade-screen__title">${escapeHtml(title)}</h1>
            <span class="cascade-screen__step">Step ${step} of 3</span>
          </div>
          <button class="cascade-screen__close" title="End session"
                  onclick="window.playFlowView._abandon()">
            <i data-icon="x" class="w-4 h-4"></i>
          </button>
        </header>
      `;
    }

    _renderContinue(label, handlerExpr, { disabled = false } = {}) {
      const handler = handlerExpr();
      return `
        <div class="cascade-cta-wrap">
          <button class="btn btn-primary cascade-cta"
                  ${disabled ? "disabled" : ""}
                  onclick="window.playFlowView.${handler}">
            ${escapeHtml(label)}
            <i data-icon="arrow-down" class="w-4 h-4"></i>
          </button>
        </div>
      `;
    }

    _scrollToCurrentPhase() {
      const phase = this._ps.phase || "gather";
      let target = "screen-gather";
      if (phase === "play") target = "screen-play";
      else if (phase === "settle") target = "screen-settle";
      // Defer one tick so the new innerHTML is laid out first.
      requestAnimationFrame(() => {
        const el = document.getElementById(target);
        if (el) el.scrollIntoView({ block: "start" });
      });
    }

    // Back-arrow handler. Rolls the live session phase one step backward
    // (Play → Gather, Settle → Play) so the host can re-edit a previous
    // step. Joiners' read-only mirrors track via the same advancePhase
    // PATCH the forward Continue button uses. After the round-trip, scroll
    // to the top of the now-active section.
    async _phaseBack(currentLower) {
      let prev = null;
      if (currentLower === "play") prev = "gather";
      else if (currentLower === "settle up") prev = "play";
      if (!prev) return;
      await this._advancePhase(prev);
    }

    // ── Gather screen ───────────────────────────────────────────────────────

    _renderInviteCard() {
      // Offline the same slot carries the reason there's no code, rather than
      // a placeholder the host would keep waiting on. Nothing to share: no
      // lobby was minted, so there is nothing for another phone to join.
      if (this._isOffline()) {
        return `
          <section class="cascade-card cascade-card--invite cascade-card--offline">
            <span class="cascade-invite__icon">
              <i data-icon="cloud-off" class="w-4 h-4"></i>
            </span>
            <div class="cascade-invite__body">
              <span class="cascade-invite__title">Offline</span>
              <span class="cascade-invite__hint">
                Saves to this device and uploads next time you're online. No code to share.
              </span>
            </div>
          </section>
        `;
      }
      // Session code surface, Gather only. The lobby stays effectively open
      // past Gather (PR #274 admits late joiners as spectators), so the code
      // still has to be readable on Play — but there it rides the game-info
      // strip below rather than a card of its own, because by then the game
      // is the fact worth top billing. Settle Up drops it — the game is over.
      // Prefer the live lobby's code; on first paint after a reopen (cold
      // reload, nav back, or the join panel's "Reopen" path) the persisted
      // draft already carries the same code, so fall back to it instead
      // of flashing "— — — — —" until _ensureLobbyOpen resolves.
      const code = (this._lobby && this._lobby.code) || (this._ps && this._ps.code) || null;
      // No lobby and nothing in flight: the mint failed. Say what that costs —
      // nothing about the play itself — rather than leaving the placeholder
      // pulsing for a code that isn't coming.
      const failed = !code && !this._lobbyPromise;
      if (failed) {
        return `
          <section class="cascade-card cascade-card--invite">
            <span class="cascade-invite__icon">
              <i data-icon="wifi-off" class="w-4 h-4"></i>
            </span>
            <div class="cascade-invite__body">
              <span class="cascade-invite__title">No session code</span>
              <span class="cascade-invite__hint">
                Couldn't start a live session, so there's nothing to join. Scoring and saving work as normal.
              </span>
            </div>
          </section>
        `;
      }
      return `
        <section class="cascade-card cascade-card--invite">
          <span class="cascade-invite__icon">
            <i data-icon="qr-code" class="w-4 h-4"></i>
          </span>
          <div class="cascade-invite__body">
            <span class="cascade-invite__title">Session code</span>
            <span class="cascade-invite__code ${code ? "" : "is-pending"}">${escapeHtml(code || "— — — — —")}</span>
            ${code ? "" : `<span class="cascade-invite__hint">Getting your code…</span>`}
            ${code && this._codeReplaced
              ? `<span class="cascade-invite__hint cascade-invite__replaced">New code — share it again</span>`
              : ""}
          </div>
        </section>
      `;
    }

    _renderGather() {
      const ps = this._ps;
      const game = ps.gameSnapshot;
      return `
        <section class="cascade-card">
          <label class="cascade-card__label">Game</label>
          ${game ? this._renderPickedGameChip() : this._renderGameChooser()}
        </section>

        ${this._renderInviteCard()}

        ${this._renderExpansionsPicker()}

        ${this._renderPlayModeSelector()}

        <section class="cascade-card">
          <label class="cascade-card__label">Players</label>
          ${ps.players.length === 0 ? `<p class="text-sm opacity-60 mb-2">No players added yet.</p>` : ""}
          <ul class="cascade-players">
            ${ps.players.map((p, i) => this._renderPlayerRow(p, i)).join("")}
          </ul>
          <button class="cascade-add-player" type="button" aria-haspopup="dialog"
                  onclick="window.playFlowView._openPlayerPicker(event)">
            <i data-icon="plus" class="w-4 h-4"></i>
            <span>${ps.players.length ? "Add players…" : "Add players to the table…"}</span>
          </button>
        </section>
      `;
    }

    _renderPlayModeSelector() {
      const mode = this._resolvePlayMode();
      const opt = (id, label, icon) => `
        <button class="play-mode-opt ${mode === id ? "is-active" : ""}"
                onclick="window.playFlowView._setPlayMode('${id}')">
          <i data-icon="${icon}" class="w-4 h-4"></i>
          <span>${label}</span>
        </button>`;
      return `
        <section class="cascade-card">
          <label class="cascade-card__label">Game type</label>
          <div class="play-mode-selector">
            ${opt("competitive", "Competitive", "swords")}
            ${opt("team", "Team", "users")}
            ${opt("coop", "Co-op", "handshake")}
          </div>
        </section>
      `;
    }

    _renderPlayerRow(p, i) {
      const isTeamGame = this._isTeamGame();
      const initials = p.initials != null ? p.initials : computeInitials(p.name);
      const me = window.store.get("user");
      const badge = window.BgbBadge.render({
        avatar: p.avatar,
        displayName: p.name,
        size: "sm",
        isGhost: !p.user_id,
        isMe: !!(me && p.user_id === me.id),
      });
      return `
        <li class="cascade-player">
          <button class="cascade-player__grip" type="button" tabindex="-1"
                  aria-label="Reorder ${escapeAttr(p.name)}"
                  title="Hold and drag to reorder">
            <i data-icon="grip-vertical" class="w-4 h-4"></i>
          </button>
          ${badge}
          <span class="cascade-player__name">${escapeHtml(p.name)}</span>
          <input class="cascade-player__init" type="text" maxlength="3"
                 aria-label="Initials"
                 placeholder="${escapeAttr(computeInitials(p.name))}"
                 value="${escapeAttr(initials)}"
                 oninput="window.playFlowView._setInitials(${i}, this.value)" />
          ${isTeamGame ? `
            <input class="cascade-player__team" type="text" maxlength="6"
                   aria-label="Team"
                   placeholder="Team"
                   value="${escapeAttr(p.team || "")}"
                   oninput="window.playFlowView._setTeam(${i}, this.value)" />
          ` : ""}
          <button class="btn btn-ghost btn-xs" title="Remove player"
                  onclick="window.playFlowView._removePlayer(${i})">
            <i data-icon="x" class="w-3.5 h-3.5"></i>
          </button>
        </li>
      `;
    }

    // ── Play screen ─────────────────────────────────────────────────────────

    /**
     * The Play step's header strip: the game being played and the code to
     * join it, on one line. Replaces the standalone invite card there —
     * see widgets/game-info-bar.js for why the two steps diverge.
     *
     * Code resolution matches _renderInviteCard exactly, including the fall
     * back to the persisted draft's code on first paint after a reopen, so
     * the two steps can never disagree about what code this session has.
     *
     * @returns {string}
     */
    _renderGameInfoBar() {
      const game = this._ps.gameSnapshot || null;
      if (this._isOffline()) {
        return window.renderGameInfoBar({ game, state: "offline" });
      }
      const code = (this._lobby && this._lobby.code) || (this._ps && this._ps.code) || null;
      // No code and nothing in flight: the mint failed and isn't retrying.
      if (!code && !this._lobbyPromise) {
        return window.renderGameInfoBar({ game, state: "failed" });
      }
      return window.renderGameInfoBar({
        game,
        code,
        state: code ? "ready" : "pending",
        // Shown for a few seconds after a dead session was swapped for a fresh
        // one: the code the host already read out to the table is no longer
        // the one to share.
        note: code && this._codeReplaced ? "New code — share it again" : "",
        noteAccent: true,
      });
    }

    _renderPlay() {
      if (!this._ps.gameId) {
        return `<section class="cascade-card"><p class="text-sm opacity-70">Pick a game on the Gather step first.</p></section>`;
      }
      const game = this._ps.gameSnapshot || {};
      const rulebookUrl = game.rulebook_url;
      // No rulebook for this game → omit the button (and its row) entirely;
      // the reference scroll below still carries user-authored chapters.
      const rulebookRow = rulebookUrl
        ? `<div class="cascade-rulebook-row">
             <a href="${escapeAttr(rulebookUrl)}" target="_blank" rel="noopener"
                class="btn btn-outline btn-sm cascade-rulebook-cta">
               <i data-icon="book-open" class="w-4 h-4"></i>
               <span>Rulebook</span>
               <i data-icon="external-link" class="w-3.5 h-3.5"></i>
             </a>
           </div>`
        : "";
      // Scoring sits directly under the game-info strip and the reference guide
      // below it: the grid is what the host touches every round, so it stays
      // above the fold, and the guide — a reach-for-it-occasionally reference
      // whose scroll can run long — is what you scroll down to. Same order in
      // the spectator mirror (session-viewer-view.js) and in native
      // (app/src/screens/PlayFlowScreen.js).
      return `
        ${this._renderGameInfoBar()}
        ${this._renderScoringSection()}
        <section class="cascade-card cascade-card--guide">
          <label class="cascade-card__label">Reference guide</label>
          ${rulebookRow}
          <div id="play-flow-guide-mount"></div>
        </section>
      `;
    }

    _renderScoringSection() {
      const ps = this._ps;
      if (ps.players.length === 0) {
        return `<section class="cascade-card"><p class="text-sm opacity-70">Add players on the Gather step.</p></section>`;
      }
      const mode = this._resolvePlayMode();
      // Table markup is delegated to the shared round-grid widget so the
      // play-detail popup paints the same scoreboard. We still own the
      // cascade-card wrapper + co-op outcome bar above it, and supply the
      // live-overlay resolvers so realtime joiner scores still win over
      // the local cache.
      // Every player carries a dense roundScores array of the same length
      // before we render, so the grid's round count, the cells it paints and
      // the totals it sums are all the same size for every column.
      if (this._normalizeRoundArrays()) ps.persist();
      const grid = window.renderRoundGrid(ps.players, "playFlowView", {
        editable: true,
        playMode: mode,
        headerNames: true,
        showSign: window.RoundGridSign.enabled(),
        getCellValue: (p, r) => this._cellValue(p, r),
      });
      return `
        <section class="cascade-card cascade-card--scoring">
          <div class="scoring-section__head">
            <label class="cascade-card__label">Scoring</label>
            ${window.RoundGridSign.renderToggle("playFlowView")}
          </div>
          ${mode === "coop" ? this._renderCoopOutcome() : ""}
          ${grid}
        </section>
      `;
    }

    // Re-render just the scoring section in place (cheaper than a full view
    // render) after a sign-toggle change, restoring focus to a cell if asked.
    _refreshScoringSection(focusCell) {
      const sec = this.container.querySelector(".cascade-card--scoring");
      if (!sec) { this.render(); return; }
      sec.outerHTML = this._renderScoringSection();
      this.refreshIcons();
      if (focusCell) {
        const el = this.container.querySelector(`input[data-score-cell="${focusCell}"]`);
        if (el) {
          el.focus();
          const n = el.value.length;
          try { el.setSelectionRange(n, n); } catch (_) {}
        }
      }
    }

    // Flip the global "± Negative" preference and repaint the grid so cells
    // gain/lose their per-cell sign buttons.
    _toggleSignButtons() {
      window.RoundGridSign.toggle();
      this._refreshScoringSection();
    }

    // Sign button on a single cell: cycle "" → "-" → cleared, or flip an
    // existing value's sign. Repaints the section so the button glyph and
    // negative colouring update, then refocuses the cell for fast entry.
    _toggleRoundSign(playerIndex, roundIndex) {
      const p = this._ps.players[playerIndex];
      if (!p) return;
      if (!Array.isArray(p.roundScores)) p.roundScores = [];
      const cur = p.roundScores[roundIndex] == null ? "" : String(p.roundScores[roundIndex]);
      const next = window.nextSignToggle(cur);
      p.roundScores[roundIndex] = next === "" ? null : next;
      this._normalizeRoundArrays();
      this._ps.persist();
      if (this._liveScores && p.participant_id) {
        this._liveScores
          .setAnyScore(p.participant_id, roundIndex, window.parseRoundScore(next))
          .catch(() => {});
      }
      this._autoSelectWinners();
      this._refreshScoringSection(`${playerIndex}-${roundIndex}`);
    }

    // Resolved score for one (player, round) cell: the live-scoring overlay
    // (Realtime) wins for players with a participant row, else the local
    // roundScores value. Returns number|null. Both the cell renderer and the
    // column total go through this so the displayed cells and the Total can
    // never disagree.
    _resolvedScore(player, roundIndex) {
      if (this._liveScores && player.participant_id) {
        const live = this._liveScores.getScore(player.participant_id, roundIndex);
        if (live != null) return live;
      }
      const local = player.roundScores && player.roundScores[roundIndex];
      return window.parseRoundScore(local);
    }

    _cellValue(player, roundIndex) {
      const v = this._resolvedScore(player, roundIndex);
      return v == null ? "" : String(v);
    }

    // Sum the same per-round resolved values the grid renders, over the same
    // round range, through the same helper the widget itself uses — so the
    // Total is the visible cells added up, by construction.
    //
    // This used to stop at `player.roundScores.length` while the grid rendered
    // `max(length)` rows. A player whose array was short (a joiner promoted by
    // the lobby poll arrived with no array at all) showed six live cells under
    // a total that counted two of them. _normalizeRoundArrays() now keeps the
    // arrays in step as well, but the total no longer depends on it.
    _playerTotal(player) {
      return window.roundGridTotal(
        player,
        this._maxRoundCount(),
        (p, r) => this._cellValue(p, r)
      );
    }

    // Materialize what the grid is showing into the draft: every cell becomes
    // the resolved (live-overlaid) value and `score` becomes the column total.
    // After this, `roundScores` IS the scoreboard, so every downstream sum —
    // toPlayCreate, the saved play, the play-detail popup — reads the same
    // numbers the host saw. Called once on Save.
    _commitResolvedScores() {
      const n = this._maxRoundCount();
      if (n === 0) return;
      this._normalizeRoundArrays();
      for (const p of this._ps.players) {
        for (let r = 0; r < n; r++) {
          const v = this._resolvedScore(p, r);
          p.roundScores[r] = v == null ? null : String(v);
        }
        p.score = this._playerTotal(p);
      }
      this._ps.persist();
    }

    // Delegates to the grid widget's own totals-cell renderer. This used to be
    // a hand-copied duplicate of it, which is how a patched row and a freshly
    // rendered one get to disagree — the same failure mode this change is
    // about, one level up.
    _renderTotalsCell(p, i, mode, total) {
      return window.renderRoundGridTotalsCell(p, i, mode, total, "playFlowView", true);
    }

    _renderCoopOutcome() {
      const players = this._ps.players;
      const won = players.length > 0 && players.every((p) => p.is_winner);
      return `
        <div class="coop-outcome">
          <button class="coop-outcome-btn ${won ? "is-winner" : ""}"
                  onclick="window.playFlowView._setCoopOutcome(${!won})">
            <i data-icon="${won ? "trophy" : "circle"}" class="w-4 h-4"></i>
            <span>${won ? "We won together" : "Mark as won"}</span>
          </button>
          <p class="text-xs opacity-60 mt-1">Co-op: everyone wins or loses together.</p>
        </div>
      `;
    }

    // ── Settle Up screen ────────────────────────────────────────────────────

    _renderSettle() {
      const url = this._ps.photoPreviewUrl || this._ps.photoUrl;
      const ps = this._ps;
      return `
        <section class="cascade-card">
          <label class="cascade-card__label">Date played</label>
          <input type="date" class="input input-bordered w-full"
                 value="${escapeAttr(ps.playedAt)}"
                 onchange="window.playFlowView._setDate(this.value)" />
        </section>

        ${this._renderPhotoCard(url)}

        <section class="cascade-card">
          <label class="cascade-card__label">Key moments</label>
          <textarea class="textarea textarea-bordered w-full cascade-notes"
                    rows="4"
                    placeholder="A clutch play, a surprise comeback, anything worth remembering."
                    onchange="window.playFlowView._setNotes(this.value)">${escapeHtml(this._ps.notes || "")}</textarea>
        </section>
      `;
    }

    /**
     * The Settle Up photo slot.
     *
     * Offline it becomes an explanation instead of a picker. The photo blob is
     * the one part of a play that is deliberately never persisted (see
     * domain/play-session.js) — it lives in memory only, so a queued play
     * can't carry one, and an OS reload of a backgrounded tab would drop it.
     * Offering the picker anyway would let a host attach a photo that quietly
     * never reaches the play they attached it to.
     *
     * @param {string|null} url  existing preview / stored photo URL
     */
    _renderPhotoCard(url) {
      if (this._isOffline()) {
        return `
          <section class="cascade-card cascade-card--offline">
            <label class="cascade-card__label">Photo</label>
            <p class="cascade-card__hint">
              <i data-icon="cloud-off" class="w-4 h-4"></i>
              Photos need a connection. Add one from the play card once this uploads.
            </p>
          </section>
        `;
      }
      return `
        <section class="cascade-card">
          <label class="cascade-card__label">Photo</label>
          ${url ? `
            <div class="cascade-photo">
              <img src="${escapeAttr(url)}" alt="Selected play photo" />
              <button class="btn btn-ghost btn-xs cascade-photo__remove"
                      onclick="window.playFlowView._clearPhoto()">
                <i data-icon="x" class="w-3.5 h-3.5"></i> Remove
              </button>
            </div>
          ` : `
            <label class="cascade-photo__pick">
              <input type="file" accept="image/*" class="hidden"
                     onchange="window.playFlowView._onPhotoSelect(this.files && this.files[0])" />
              <i data-icon="camera" class="w-5 h-5"></i>
              <span>Tap to add photo (optional)</span>
            </label>
          `}
        </section>
      `;
    }

    _renderSaveCta() {
      return `
        <div class="cascade-cta-wrap">
          <button class="btn btn-primary cascade-cta"
                  ${this._saving ? "disabled" : ""}
                  onclick="window.playFlowView._save()">
            ${this._saving ? "Saving…" : "Save play"}
            <i data-icon="check" class="w-4 h-4"></i>
          </button>
        </div>
      `;
    }

    // ── Advance / abandon ───────────────────────────────────────────────────

    async _advanceToPlay() {
      if (!this._ps.gameId) {
        this._error = "Pick a game first.";
        this.render();
        return;
      }
      if (this._ps.players.length === 0) {
        this._error = "Add at least one player.";
        this.render();
        return;
      }
      this._error = null;
      await this._advancePhase("play");
    }

    async _advanceToSettle() {
      this._error = null;
      await this._advancePhase("settle");
    }

    async _advancePhase(next) {
      // Offline the phase is a purely local idea: it decides which screen the
      // cascade shows and where a resume lands, and there are no joiners'
      // mirrors to advance. Still bumps _phaseSeq so a rapid tap sequence
      // resolves the same way it does online.
      if (this._isOffline()) {
        ++this._phaseSeq;
        this._ps.phase = next;
        this._ps.persist();
        this._syncLobbyPollToPhase();
        this.render();
        this._scrollToCurrentPhase();
        return;
      }
      // Flip the phase locally and repaint immediately so the user sees the
      // section transition without waiting on the server. The PATCH happens in
      // the background and never reverses this: the local phase is the truth
      // the host is looking at, and the lobby is a mirror of it.
      // Token this invocation. If the user navigates again before our PATCH
      // resolves, a newer call bumps _phaseSeq past `seq` and we must NOT
      // reconcile against this (now-stale) response — otherwise an older
      // PATCH resolving last snaps the screen back to its phase.
      const seq = ++this._phaseSeq;
      this._ps.phase = next;
      this._ps.persist();
      this._syncLobbyPollToPhase();
      this.render();
      this._scrollToCurrentPhase();
      this._pendingPhase++;
      try {
        // Gather is the only phase bgb_add_participant accepts a roster write
        // in; past it every push comes back 409 roster_locked, which
        // _withLobby swallows without a sound. So the roster has to be
        // complete BEFORE the phase moves, or a player whose row never landed
        // never gets one — and their column stays empty on every spectator's
        // screen for the whole game. The cascade has already flipped locally
        // and repainted above, so this await costs the host nothing on screen.
        if (next === "play") {
          try { await this._syncRosterToLobby(); } catch (_) {}
          // Then the order, in that sequence: the order write names participant
          // ids, and the sync above is what gives a just-pushed player one, so
          // running them the other way round would leave that player appended
          // rather than placed. bgb_reorder_participants is Gather-only too, so
          // a debounced write still sitting in its timer would come back 409.
          try { await this._flushOrderToLobby(); } catch (_) {}
        }
        // The cascade has ALREADY moved — the phase above is local truth and
        // the draft is complete on its own. This PATCH only catches the server
        // (and spectators' read-only mirrors) up, whenever it can.
        //
        // So there is nothing here to roll back. A missing lobby, a dead one,
        // a blip: all three mean the same thing, which is that the live session
        // is behind. _withLobby mints a replacement when the lobby is
        // definitively gone and resolves null when it can't; either way the
        // host keeps playing. Bouncing them back to Gather with "Session not
        // found" — which is what this used to do — blocked the one thing that
        // has to work.
        await this._withLobby(async (code) => {
          // Superseded while we waited for the code. Bail BEFORE the PATCH: a
          // Continue → back → Continue burst issued while the code was in
          // flight would otherwise fire three writes for one state.
          if (seq !== this._phaseSeq) return null;
          const updated = await window.PlaySession.advancePhase(code, next);
          if (seq !== this._phaseSeq) return updated; // a newer change owns the state
          this._lobby = updated;
          this._lobbyProvisional = false;
          if (updated.phase && updated.phase !== this._ps.phase) {
            // Server overrode (shouldn't normally happen). Sync local view.
            this._ps.phase = updated.phase;
            this._ps.persist();
            this.render();
          }
          return updated;
        });
        // Republish the grid under any id the flush above just adopted. It
        // has to happen HERE and not where the id lands: the flush runs while
        // the server is still in 'gather', and the scores table's RLS write
        // policy only accepts the host while phase='play' (migration 053), so
        // an upsert issued any earlier is refused. Without this a column whose
        // roster row arrived at the last moment would start at whatever round
        // the host next types in, and every round before it would read blank
        // on every spectator's screen. Fire-and-forget; a failed PATCH above
        // just means the write is refused again, harmlessly.
        if (next === "play" && this._liveScores) {
          this._liveScores.syncGrid(this._ps.players).catch(() => {});
        }
      } finally {
        this._pendingPhase--;
      }
    }

    async _abandon() {
      const ok = await window.PolaroidPopup.confirm({
        title: "Discard this play?",
        // Offline there is no lobby and nobody to kick — promising otherwise
        // would describe a consequence that can't happen.
        body: this._isOffline()
          ? "Any scores so far will be lost. This can't be undone."
          : "Players in the lobby will be kicked and any scores so far will be lost. This can't be undone.",
        confirmLabel: "Discard",
        cancelLabel: "Keep playing",
      });
      if (!ok) return;
      // Tear down locally and navigate FIRST so the UI always responds.
      // The server-side abandon is fire-and-forget — a slow or hung PATCH
      // shouldn't strand the user on the gather screen.
      const code = this._liveLobbyCode();
      this._ps.clear();
      window.store.set("activePlay", null);
      window.router.go("log-play");
      if (code) {
        window.PlaySession.advancePhase(code, "abandoned").catch(() => {});
      }
    }

    // ── Game pick + form fields ─────────────────────────────────────────────

    _renderPickedGameChip() {
      const game = this._ps && this._ps.gameSnapshot;
      if (!game) return "";
      return `
        <div class="cascade-game-chip">
          ${game.thumbnail_url
            ? `<img class="cascade-game-chip__thumb" src="${escapeAttr(game.thumbnail_url)}" alt="" />`
            : `<div class="cascade-game-chip__thumb cascade-game-chip__thumb--placeholder"><i data-icon="dice-6"></i></div>`}
          <div class="cascade-game-chip__name">${escapeHtml(game.name)}</div>
          <button class="cascade-game-chip__details" type="button"
                  title="View game details" aria-label="View game details"
                  onclick="window.playFlowView._openGameDetails()">
            <i data-icon="arrow-up-right" class="w-4 h-4"></i>
          </button>
          <button class="cascade-game-chip__clear" type="button"
                  title="Change game" aria-label="Clear pick"
                  onclick="window.playFlowView._clearGamePick()">
            <i data-icon="x" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      `;
    }

    _openGameDetails() {
      const ps = this._ps;
      if (!ps || !ps.gameId) return;
      window.router.go("game-detail", {
        gameId: ps.gameId,
        gameName: (ps.gameSnapshot || {}).name || "",
      });
    }

    _clearGamePick() {
      const ps = this._ps;
      if (!ps) return;
      ps.gameId = null;
      ps.gameSnapshot = null;
      ps.persist();
      // Push the clear to the lobby so joiners' read-only mirrors drop the
      // game pick alongside the host. Keyed off the live lobby rather than
      // ps.code: a draft resumed offline still carries the code of a lobby
      // this run never opened, and pushing to it would be a doomed request
      // against a session with nobody in it.
      this._withLobby((code) => window.PlaySession.updateLobby(code, { gameId: null }));
      this.render();
      // Clearing the pick is the start of choosing another one, so land on the
      // chooser rather than making the host hunt for it — but on the card, not
      // in the search sheet: their next game is usually one of the quick picks
      // now sitting right there.
      requestAnimationFrame(() => {
        const el = this.container && this.container.querySelector(".cascade-game-search");
        if (el) /** @type {HTMLElement} */ (el).focus({ preventScroll: true });
      });
    }

    _applyGamePick(game) {
      if (!game || !game.id) return;
      const ps = this._ps;
      ps.gameId = game.id;
      ps.gameSnapshot = {
        id: game.id,
        name: game.name,
        thumbnail_url: game.thumbnail_url,
        rulebook_url: game.rulebook_url,
        is_expansion: !!game.is_expansion,
      };
      ps.playMode = game.play_mode || ps.playMode || null;
      ps.persist();
      window.store.set("activePlay", ps);
      // Warm the reference-guide cache for the new pick (base game only).
      window.Chapter.prefetchMyChapters(game.id);
      // Push the pick to the lobby so joiners' read-only mirrors swap too.
      // Live lobby only — see _clearGamePick for why not ps.code.
      this._withLobby((code) => window.PlaySession.updateLobby(code, { gameId: game.id }));
      // The user changes the pick by tapping the chip's ×, which clears state
      // and brings the chooser back. The search sheet unmounts its finder on
      // close, and unmount() invalidates any in-flight search, so a late
      // response can't sneak in behind a pick.
      this.render();
      this._loadExpansionsIfNeeded().then(() => {
        this.render();
        if (this._guideWidget) this._guideWidget.refresh();
      });
    }

    _setDate(value) {
      this._ps.playedAt = value;
      this._ps.persist();
    }

    _setNotes(value) {
      this._ps.notes = value;
      this._ps.persist();
    }

    _resolvePlayMode() {
      const ps = this._ps;
      if (ps.playMode) return ps.playMode;
      const g = ps.gameSnapshot;
      if (g && g.play_mode) return g.play_mode;
      return "competitive";
    }

    _isTeamGame() {
      return this._resolvePlayMode() === "team";
    }

    _setPlayMode(mode) {
      if (!["competitive", "team", "coop"].includes(mode)) return;
      this._ps.playMode = mode;
      this._ps.persist();
      this._autoSelectWinners();
      // Patch the three surfaces the mode actually touches instead of
      // rebuilding the full cascade: the selector's active pill, the Gather
      // player rows (team column appears in team mode), and the scoring
      // section (coop outcome bar + winner buttons + grid shape).
      const selector = this.container.querySelector(".play-mode-selector");
      const card = selector && selector.closest(".cascade-card");
      if (card) {
        card.outerHTML = this._renderPlayModeSelector();
        this.refreshIcons(
          this.container.querySelector(".play-mode-selector")
        );
      }
      this._refreshPlayersList();
      this._refreshScoringSection();
    }

    // ── Players ─────────────────────────────────────────────────────────────

    /**
     * @param {{name: string, user_id: string|null, avatar: string|null}} row
     * @param {{defer?: boolean}} [opts] `defer` skips the repaint — set it when
     *   seating several players at once so the screen paints once, not N times.
     */
    _addPlayer({ name, user_id, avatar }, opts = {}) {
      const exists = this._ps.players.some(
        (p) => (p.name || "").toLowerCase() === (name || "").toLowerCase()
      );
      if (!exists) {
        const currentRounds = this._maxRoundCount();
        const row = {
          name,
          is_winner: false,
          score: null,
          user_id: user_id || null,
          avatar: avatar || null,
          roundScores: Array(currentRounds).fill(null),
        };
        this._ps.players.push(row);
        this._ps.persist();
        // Sync to the backend participants table so spectators see this
        // player. Fire-and-forget, and handed the row itself so the response's
        // participant_id lands on it without waiting for the poll.
        this._pushParticipantToBackend(row);
      }
      if (!opts.defer) this.render();
    }

    // Mirror a player the host just added into the lobby roster.
    //
    // The local row is NOT rolled back when this fails. A player the host typed
    // is part of the play they are recording; the roster row only exists so
    // spectators can see them. Deleting someone out of the host's own roster
    // because a lobby write 404'd — which is what this used to do, with a toast
    // blaming the session — took a failure in the nice-to-have and spent it on
    // the must-have. _withLobby re-mints a dead lobby and retries, and
    // _syncRosterToLobby re-pushes the roster whenever a new lobby is opened.
    async _pushParticipantToBackend(player) {
      const bundle = await this._withLobby((code) =>
        window.PlaySession.addParticipant(code, {
          userId: player.user_id || null,
          displayName: player.name,
        })
      );
      if (bundle) this._adoptParticipantId(player, bundle);
    }

    /**
     * Take the participant id the server just seated for one local row.
     *
     * POST /participants answers with the whole session bundle, so the row is
     * already in hand — waiting up to 2s for _lobbyPollTick to match it back
     * by name is 2s in which every cell the host types for this player is
     * dropped by the participant_id guard in _setRoundScore.
     *
     * Matched on the same keys the poll uses: user_id for an account, a
     * case-insensitive display name for a guest (their only handle).
     */
    _adoptParticipantId(player, bundle) {
      if (!player || player.participant_id) return;
      const parts = (bundle && bundle.participants) || [];
      const key = (player.name || "").toLowerCase();
      const hit = parts.find((part) => (player.user_id
        ? part.user_id === player.user_id
        : !part.user_id && (part.display_name || "").toLowerCase() === key));
      if (!hit) return;
      player.participant_id = hit.id;
      this._ps.persist();
    }

    // Lookup helper used by the buddy autocomplete dropdown: resolves the
    // buddy row from this._buddies (so we keep their avatar) and forwards
    // to _addPlayer.
    _removePlayer(i) {
      const removed = this._ps.players[i];
      this._ps.players.splice(i, 1);
      this._ps.persist();
      this._autoSelectWinners();
      this.render();
      // If the row had been confirmed by the backend (carries a
      // participant_id from _lobbyPoll), tell the server to drop it too. No
      // toast on failure: the player is already gone from the host's roster and
      // therefore from the play, which is what the tap meant. A stale name left
      // in a spectator's lobby list isn't worth interrupting the host over.
      if (removed && removed.participant_id) {
        this._pendingDeletes++;
        this._withLobby((code) =>
          window.PlaySession.removeParticipant(code, removed.participant_id)
        ).finally(() => { this._pendingDeletes--; });
      }
    }

    _setInitials(i, value) {
      const p = this._ps.players[i];
      if (!p) return;
      p.initials = String(value || "").replace(/\s+/g, "").slice(0, 3).toUpperCase();
      this._ps.persist();
      // Patch the badge's initials text in place — full re-render would
      // yank focus out of the initials input mid-typing.
      const heads = this.container.querySelectorAll(".scoring-head");
      const label = p.initials || computeInitials(p.name);
      const span = heads[i] && heads[i].querySelector(".user-badge__initials");
      if (span) span.textContent = label;
    }

    _setTeam(i, value) {
      const ps = this._ps;
      const p = ps.players[i];
      if (!p) return;
      p.team = String(value || "").trim();
      if (p.team) {
        const tag = p.team.toLowerCase();
        const teammateWon = ps.players.some(
          (o, j) => j !== i && (o.team || "").trim().toLowerCase() === tag && o.is_winner
        );
        if (teammateWon !== p.is_winner) {
          p.is_winner = teammateWon;
          this._ps.persist();
          this._autoSelectWinners();
          this.render();
          return;
        }
      }
      ps.persist();
      this._autoSelectWinners();
    }

    // ── Scoring rounds ──────────────────────────────────────────────────────

    _addRound() {
      this._normalizeRoundArrays();
      for (const p of this._ps.players) p.roundScores.push(null);
      this._ps.persist();
      this._autoSelectWinners();
      // Surface the new (still empty) round to spectators. Their grid is sized
      // from the highest round_index seen in live scores, so without a row an
      // empty round is invisible to them. Write a null placeholder on the
      // first player who has a participant row; the Realtime echo grows
      // maxRound() everywhere.
      if (this._liveScores) {
        const anchor = this._ps.players.find((p) => p.participant_id);
        const newIndex = this._maxRoundCount() - 1;
        if (anchor && newIndex >= 0) {
          this._liveScores
            .setAnyScore(anchor.participant_id, newIndex, null)
            .catch(() => {});
        }
      }
      this.render();
    }

    // Highest roundScores length across players — the authoritative round
    // count, and exactly the number of rows the grid renders.
    _maxRoundCount() {
      return window.roundGridRoundCount(this._ps.players);
    }

    // Give every player a dense roundScores array of exactly _maxRoundCount()
    // entries. Three paths used to leave columns at different lengths — the
    // lobby poll pushing a promoted joiner with no array, _setRoundScore
    // writing a sparse index into a short one, and _removeRoundAt skipping
    // players whose array didn't reach the removed round — and every one of
    // them showed up as a column whose cells and Total disagreed.
    _normalizeRoundArrays() {
      const players = (this._ps && this._ps.players) || [];
      const n = this._maxRoundCount();
      let changed = false;
      for (const p of players) {
        if (!Array.isArray(p.roundScores)) {
          p.roundScores = [];
          changed = true;
        }
        for (let r = 0; r < n; r++) {
          // `in` (not == null) so an existing null stays null and only real
          // holes — including a sparse array's — get filled.
          if (!(r in p.roundScores)) {
            p.roundScores[r] = null;
            changed = true;
          }
        }
      }
      return changed;
    }

    _removeRoundAt(r) {
      const n = this._maxRoundCount();
      if (!(r >= 0 && r < n)) return;
      this._normalizeRoundArrays();
      for (const p of this._ps.players) p.roundScores.splice(r, 1);
      this._ps.persist();
      // Live rows are keyed by round_index, so deleting index r on its own
      // would leave every later round one slot too high: each cell below the
      // removed row would render the round above it, and the Total with it.
      // removeRoundAt shifts the tail down to match the splice above.
      //
      // Shift before re-picking the winner, for the same reason _setRoundScore
      // mirrors before repainting: totals resolve through the overlay, so a
      // crown derived from the un-shifted one is derived from the wrong grid.
      // (The shift and its emit are synchronous; only the delete behind them
      // is async.)
      if (this._liveScores) this._liveScores.removeRoundAt(r).catch(() => {});
      this._autoSelectWinners();
      this.render();
    }

    _setRoundScore(playerIndex, roundIndex, value) {
      const p = this._ps.players[playerIndex];
      if (!p) return;
      if (!Array.isArray(p.roundScores)) p.roundScores = [];
      // Keep cells as sanitized strings so a leading "-" survives; store null
      // for an empty cell. A lone "-" is kept until digits arrive.
      const clean = window.sanitizeRoundScore(value);
      p.roundScores[roundIndex] = clean === "" ? null : clean;
      this._normalizeRoundArrays();
      // The text input doesn't auto-reject stray characters the way type=number
      // did — write the sanitized value back when they differ (e.g. a pasted
      // letter), preserving the caret.
      const input = this.container.querySelector(`input[data-score-cell="${playerIndex}-${roundIndex}"]`);
      if (input && input.value !== clean) {
        const pos = input.selectionStart;
        input.value = clean;
        try { input.setSelectionRange(pos, pos); } catch (_) {}
      }
      this._ps.persist();
      // Mirror the edit into the live-scores table so spectators see it. Keyed
      // by participant, not by user, so a GUEST's column streams too — under
      // host-only scoring nobody else can fill one in, and a permanently blank
      // column on the spectator's grid is just a hole in the scoreboard.
      //
      // This has to run BEFORE the repaint below, and it does not wait on the
      // network to do so: setAnyScore applies the value to the overlay and
      // emits synchronously, and only the upsert behind it is async. Ordering
      // it after the repaint is what made the crown lag. Totals and winners
      // both resolve through _resolvedScore, which prefers the overlay, so
      // repainting first read the digit typed BEFORE this one — the totals row
      // got a second, corrected pass from the emit, but the winner did not and
      // stayed a keystroke behind.
      if (this._liveScores && p.participant_id) {
        try {
          this._liveScores
            .setAnyScore(p.participant_id, roundIndex, window.parseRoundScore(clean))
            .catch(() => {});
        } catch (_) {}
      }
      // Never wait on the network to repaint. This method is an oninput
      // handler: awaiting the live-scores upsert before refreshing meant that
      // on a flaky connection (or with the request simply hung) the cell showed
      // the digit the host had just typed while the Total below it still showed
      // the sum from before it — the "sometimes the maths is wrong" report.
      // The write above is fire-and-forget; the Realtime echo reconciles later.
      this._autoSelectWinners();
      this._refreshTotalsCells();
    }

    _refreshTotalsCells() {
      const totalsRow = this.container.querySelector(".scoring-total-row");
      if (!totalsRow) return;
      const mode = this._resolvePlayMode();
      totalsRow.innerHTML =
        `<th>Total</th>` +
        this._ps.players
          .map((pl, i) => this._renderTotalsCell(pl, i, mode, this._playerTotal(pl)))
          .join("");
      this.refreshIcons();
    }

    // Re-derive the crown from the totals the grid is showing. Called from
    // _onLiveScoresChange, so it runs on every change to a number rather than
    // only where one is typed.
    //
    // Persists only when the answer actually moved: on a live-scores tick this
    // is usually the echo of an edit whose winner we already settled, and a
    // localStorage write per Realtime event is a cost with nothing to show for
    // it.
    _autoSelectWinners() {
      const ps = this._ps;
      if (!ps || !ps.players || ps.players.length === 0) return;
      if (this._resolvePlayMode() === "coop") return;
      const totals = ps.players.map((p) => this._playerTotal(p));
      // An untouched grid is every column on zero. Crowning the whole table
      // there would be noise, not a result — leave it to the first real score.
      if (totals.every((t) => t === 0)) return;
      let next;
      if (this._resolvePlayMode() === "team") {
        const groupKey = (p, i) => {
          const tag = (p.team || "").trim().toLowerCase();
          return tag || `__solo_${i}`;
        };
        const groupTotals = new Map();
        ps.players.forEach((p, i) => {
          const key = groupKey(p, i);
          groupTotals.set(key, (groupTotals.get(key) || 0) + totals[i]);
        });
        const max = Math.max(...groupTotals.values());
        next = ps.players.map((p, i) => groupTotals.get(groupKey(p, i)) === max);
      } else {
        const max = Math.max(...totals);
        next = totals.map((t) => t === max);
      }
      if (ps.players.every((p, i) => !!p.is_winner === next[i])) return;
      ps.players.forEach((p, i) => { p.is_winner = next[i]; });
      ps.persist();
    }

    _toggleWinner(i) {
      const ps = this._ps;
      const p = ps.players[i];
      if (!p) return;
      const next = !p.is_winner;
      const mode = this._resolvePlayMode();
      if (mode === "coop") {
        for (const other of ps.players) other.is_winner = next;
      } else if (mode === "team" && p.team && p.team.trim()) {
        const tag = p.team.trim().toLowerCase();
        for (const other of ps.players) {
          if ((other.team || "").trim().toLowerCase() === tag) other.is_winner = next;
        }
      } else {
        p.is_winner = next;
      }
      ps.persist();
      // Winner state only surfaces in the totals row (trophy buttons +
      // winner-cell highlight) — patch it in place instead of rebuilding
      // the full three-screen cascade.
      this._refreshTotalsCells();
    }

    _setCoopOutcome(won) {
      for (const p of this._ps.players) p.is_winner = !!won;
      this._ps.persist();
      // Patch in place: swap the outcome button group and refresh the
      // winner highlight on the totals row — no full cascade rebuild.
      const outcome = this.container.querySelector(".coop-outcome");
      if (outcome) {
        outcome.outerHTML = this._renderCoopOutcome();
        this.refreshIcons(this.container.querySelector(".coop-outcome"));
      }
      this._refreshTotalsCells();
    }

    // ── Expansions ──────────────────────────────────────────────────────────

    async _loadExpansionsIfNeeded() {
      const gameId = this._ps && this._ps.gameId;
      if (!gameId) {
        this._expansions = [];
        this._expansionsLoadedFor = null;
        return;
      }
      if (this._expansionsLoadedFor === gameId) return;
      // A different game means a different list — a filter typed for the
      // previous pick would silently hide everything.
      this._expansionQuery = "";
      const snap = this._ps.gameSnapshot;
      if (snap && snap.is_expansion) {
        this._expansions = [];
        this._expansionsLoadedFor = gameId;
        return;
      }
      // `authoritative` gates the prune below. The list is only trustworthy
      // enough to delete the host's picks against when it came from the
      // server — bootstrap warms game.bundle for owned games only, so a cache
      // read that finds nothing means "not warmed", not "no expansions".
      let authoritative = false;
      if (this._isOffline()) {
        // bgb_game_detail_bundle carries the same ExpansionListItem[] the
        // endpoint returns, and Bootstrap.warmGameBundles() has it for every
        // owned game — enough to run the picker with no server.
        const bundle = window.bgbCache && window.bgbCache.peek("game.bundle", gameId);
        this._expansions = (bundle && Array.isArray(bundle.expansions)) ? bundle.expansions : [];
      } else {
        try {
          const list = await window.api.get(`/games/${gameId}/expansions`);
          this._expansions = Array.isArray(list) ? list : [];
          authoritative = true;
        } catch (_) {
          this._expansions = [];
        }
      }
      this._expansionsLoadedFor = gameId;
      // Drop picks the game no longer offers — but ONLY against a list we
      // actually fetched. This used to run unconditionally, so any blip on
      // the expansions request silently wiped every expansion the host had
      // ticked: the catch set the list to [], and the filter then removed
      // everything for not being in it.
      if (!authoritative) return;
      const valid = new Set(this._expansions.map((e) => e.expansion_game_id));
      const before = (this._ps.expansionIds || []).length;
      this._ps.expansionIds = (this._ps.expansionIds || []).filter((id) => valid.has(id));
      if (this._ps.expansionIds.length !== before) this._ps.persist();
    }

    _renderExpansionsPicker() {
      // Always render the card so hosts know the section exists. It stays
      // greyed out only while importing genuinely can't work — no game
      // picked yet, or the picked game is itself an expansion. A base game
      // with zero imported expansions is still interactive: expansions are
      // hidden from search, so this card is the only place to pull one in.
      const snap = this._ps.gameSnapshot;
      let disabledHint = null;
      if (!this._ps.gameId) {
        disabledHint = "Pick a game first to choose expansions.";
      } else if (snap && snap.is_expansion) {
        disabledHint = "This game is itself an expansion.";
      }
      if (disabledHint) {
        return `
          <section class="cascade-card cascade-card--expansions is-disabled" aria-disabled="true">
            <div class="collapsible-header collapsible-header--static">
              <span class="collapsible-header__title">
                <i data-icon="puzzle" class="w-4 h-4"></i>
                Expansions
              </span>
              <i data-icon="chevron-right" class="w-4 h-4 collapsible-header__chev"></i>
            </div>
            <p class="cascade-card__hint">${escapeHtml(disabledHint)}</p>
          </section>
        `;
      }
      const list = this._expansions || [];
      const open = !!this._expansionsOpen;
      const chevron = open ? "chevron-down" : "chevron-right";
      const baseName = (snap && snap.name) || "";
      // Carcassonne alone has dozens. Past the threshold the list caps at
      // five visible rows and scrolls, with a filter above it; Import sits
      // below the scroll box so it never drifts out of reach mid-list.
      const showFilter = list.length > EXPANSION_FILTER_THRESHOLD;
      return `
        <section class="cascade-card cascade-card--expansions">
          <button class="collapsible-header" aria-expanded="${open}"
                  onclick="window.playFlowView._toggleExpansionsPicker()">
            <span class="collapsible-header__title">
              <i data-icon="puzzle" class="w-4 h-4"></i>
              <span class="cascade-exp-title">${this._expansionsHeaderLabel()}</span>
            </span>
            <i data-icon="${chevron}" class="w-4 h-4 collapsible-header__chev"></i>
          </button>
          ${open ? `
            ${showFilter ? this._renderExpansionFilter() : ""}
            <div class="cascade-exp-scroll">
              <ul class="expansion-list cascade-exp-list" id="cascade-exp-list">
                ${this._renderExpansionRows(list, baseName)}
              </ul>
            </div>
            <div class="cascade-exp-actions">
              <button type="button" class="btn btn-sm expansion-import-btn"
                      onclick="window.playFlowView._openImportExpansions()">
                <i data-icon="plus" class="w-4 h-4"></i> Import expansions
              </button>
            </div>
          ` : ""}
        </section>
      `;
    }

    _renderExpansionFilter() {
      const q = this._expansionQuery || "";
      return `
        <div class="game-finder cascade-exp-filter">
          <i data-icon="search" class="w-4 h-4 game-finder__icon"></i>
          <input type="text" id="cascade-exp-filter-input"
                 class="input input-bordered game-finder__input cascade-exp-filter__input"
                 placeholder="Filter expansions…" aria-label="Filter expansions by name"
                 value="${escapeAttr(q)}"
                 autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
                 oninput="window.playFlowView._onExpansionFilterInput(this.value)" />
          <button type="button" class="field-clear-btn" aria-label="Clear filter" ${q ? "" : "hidden"}
                  onclick="window.playFlowView._clearExpansionFilter()">
            <i data-icon="x" class="w-4 h-4"></i>
          </button>
        </div>
      `;
    }

    /** Rows for the current filter, or the right hint when there are none. */
    _renderExpansionRows(list, baseName) {
      if (!list.length) {
        return `<li class="cascade-card__hint">No expansions in BoardgameBuddy yet.</li>`;
      }
      const q = (this._expansionQuery || "").trim();
      const visible = q
        ? list.filter((e) => this._expansionMatches(e, q, baseName))
        : list;
      if (!visible.length) {
        return `<li class="cascade-card__hint">No expansion matches “${escapeHtml(q)}”.</li>`;
      }
      return visible.map((e) => this._renderExpansionPickerRow(e, baseName)).join("");
    }

    /** Match the displayed (base-name-stripped) label or the stored full name,
     *  so typing the base game's name still hits — same rule the import popup
     *  uses for its own filter. */
    _expansionMatches(e, q, baseName) {
      const needle = q.toLowerCase();
      const full = String(e.name || "");
      return stripBaseGameName(full, baseName).toLowerCase().includes(needle)
        || full.toLowerCase().includes(needle);
    }

    // Filtering is local to the already-loaded list, so this patches just the
    // row host — a full render() would rebuild the input and drop focus and
    // the caret mid-keystroke.
    _onExpansionFilterInput(value) {
      this._expansionQuery = value || "";
      const host = document.getElementById("cascade-exp-list");
      if (host) {
        const snap = this._ps.gameSnapshot;
        host.innerHTML = this._renderExpansionRows(
          this._expansions || [], (snap && snap.name) || "",
        );
        this.refreshIcons(host);
      }
      const clear = document.querySelector(".cascade-exp-filter .field-clear-btn");
      if (clear) clear.hidden = !this._expansionQuery;
    }

    _clearExpansionFilter() {
      const input = /** @type {HTMLInputElement|null} */ (
        document.getElementById("cascade-exp-filter-input")
      );
      if (input) { input.value = ""; input.focus(); }
      this._onExpansionFilterInput("");
    }

    _openImportExpansions() {
      const gameId = this._ps && this._ps.gameId;
      if (!gameId) return;
      const snap = this._ps.gameSnapshot || {};
      window.ImportExpansionsModal.open({
        gameId,
        gameName: snap.name || "",
        // Mirrors _applyGamePick's refresh tail: re-pull the linked list so
        // the new expansion is immediately togglable, and let the in-play
        // guide widget pick up its chapter pool.
        onImported: async () => {
          this._expansionsLoadedFor = null;
          await this._loadExpansionsIfNeeded();
          this.render();
          if (this._guideWidget) this._guideWidget.refresh();
        },
      });
    }

    _renderExpansionPickerRow(e, baseName) {
      const active = (this._ps.expansionIds || []).includes(e.expansion_game_id);
      // The picked game's chip sits right above this list, so the rows drop
      // the base game's name and show only what each expansion adds.
      const label = stripBaseGameName(e.name, baseName);
      return `
        <li class="expansion-list__row cascade-exp-row ${active ? "is-active" : ""}"
            data-exp-id="${escapeAttr(e.expansion_game_id)}"
            onclick="window.playFlowView._toggleExpansion('${e.expansion_game_id}')"
            title="${escapeAttr(e.name || "")}"
            style="--exp-color:${e.color || "#C9922A"}">
          <span class="expansion-list__dot"></span>
          ${e.thumbnail_url
            ? `<img src="${escapeAttr(e.thumbnail_url)}" alt="" class="expansion-list__thumb" loading="lazy" />`
            : `<div class="expansion-list__thumb expansion-list__thumb--placeholder"><i data-icon="dice-6"></i></div>`}
          <div class="expansion-list__body">
            <div class="expansion-list__name">${escapeHtml(label)}</div>
          </div>
          <span class="cascade-exp-toggle ${active ? "cascade-exp-toggle--on" : ""}">
            <i data-icon="${active ? "check" : "plus"}" class="w-4 h-4"></i>
          </span>
        </li>
      `;
    }

    _toggleExpansionsPicker() {
      this._expansionsOpen = !this._expansionsOpen;
      this.render();
    }

    _toggleExpansion(expansionGameId) {
      const ids = (this._ps.expansionIds || []).slice();
      const idx = ids.indexOf(expansionGameId);
      if (idx >= 0) ids.splice(idx, 1);
      else ids.push(expansionGameId);
      this._ps.expansionIds = ids;
      this._ps.persist();
      // A full render() would rebuild .cascade-exp-scroll and reset its
      // scrollTop, bouncing the user back to the top of a long expansion list
      // after every tap. Same reasoning as _onExpansionFilterInput above:
      // patch only what a toggle actually changes.
      this._refreshExpansionRow(expansionGameId);
      this._refreshExpansionCount();
      // The guide lives in the (locked) Play screen but reads expansionIds,
      // so keep it in sync — render() used to do this for us.
      this._mountReferenceGuide();
    }

    /** Swap one row in place. Row height is fixed, so the scroll box can't move. */
    _refreshExpansionRow(expansionGameId) {
      const host = document.getElementById("cascade-exp-list");
      if (!host) return;
      const sel = `[data-exp-id="${CSS.escape(expansionGameId)}"]`;
      const row = host.querySelector(sel);
      const e = (this._expansions || []).find(
        (x) => x.expansion_game_id === expansionGameId,
      );
      if (!row || !e) return;
      const snap = this._ps.gameSnapshot;
      row.outerHTML = this._renderExpansionPickerRow(e, (snap && snap.name) || "");
      const next = host.querySelector(sel);
      if (next) this.refreshIcons(next);
    }

    // The whole label lives in one span (not just the count) because
    // .collapsible-header__title is an inline-flex with a gap — splitting the
    // text in two would make the count its own flex item and widen the space
    // before it.
    _expansionsHeaderLabel() {
      const n = (this._ps.expansionIds || []).length;
      return `Expansions${n ? ` (${n} selected)` : ""}`;
    }

    _refreshExpansionCount() {
      const el = this.container.querySelector(".cascade-exp-title");
      if (el) el.textContent = this._expansionsHeaderLabel();
    }

    // ── Reference guide ─────────────────────────────────────────────────────

    _buildExpansionMetaMap() {
      const meta = {};
      const snap = this._ps.gameSnapshot;
      meta[this._ps.gameId] = { name: snap ? snap.name : "", color: null };
      for (const e of (this._expansions || [])) {
        meta[e.expansion_game_id] = { name: e.name, color: e.color || null };
      }
      return meta;
    }

    _mountReferenceGuide() {
      if (!this._ps.gameId) {
        this._guideWidget = null;
        return;
      }
      const host = document.getElementById("play-flow-guide-mount");
      if (!host) return;
      const meta = this._buildExpansionMetaMap();
      const gameImage = (this._ps.gameSnapshot || {}).thumbnail_url || null;
      const gameIds = [this._ps.gameId, ...(this._ps.expansionIds || [])];
      if (this._guideWidget && this._guideWidget._baseGameId !== this._ps.gameId) {
        this._guideWidget = null;
      }
      if (!this._guideWidget) {
        this._guideWidget = new window.ReferenceGuideScroll({
          baseGameId: this._ps.gameId,
          gameIds,
          expansionMeta: meta,
          gameImage,
          onAfterMutate: () => this.render(),
          defaultOpen: true,
        });
        this._guideWidget.mount(host);
      } else {
        this._guideWidget.mount(host);
        this._guideWidget.setExpansionMeta(meta);
        this._guideWidget.setGameImage(gameImage);
        this._guideWidget.setGameIds(gameIds);
      }
    }

    // ── Photo ───────────────────────────────────────────────────────────────

    async _onPhotoSelect(file) {
      if (!file) return;
      // Auto-compress large photos client-side so the save flow can never
      // hit the 5 MiB backend cap. Also normalizes HEIC from iOS Safari to
      // JPEG so the MIME whitelist accepts it. Backend constants mirrored
      // in helpers.js — keep them in sync if the server limit ever changes.
      const v = await window.preparePhotoForUpload(file);
      if (!v.ok) {
        showToast(v.error, "error");
        const fi = this.container && this.container.querySelector('input[type="file"]');
        if (fi) fi.value = "";
        return;
      }
      if (v.compressed) {
        showToast(
          `Photo compressed from ${(v.originalSize / 1048576).toFixed(1)} MB to ${(v.compressedSize / 1048576).toFixed(1)} MB`,
          "info"
        );
      }
      this._clearPhoto({ keepRender: true });
      this._ps.photoFile = v.file;
      this._ps.photoPreviewUrl = URL.createObjectURL(v.file);
      this.render();
    }

    _clearPhoto({ keepRender = false } = {}) {
      if (this._ps.photoPreviewUrl) {
        try { URL.revokeObjectURL(this._ps.photoPreviewUrl); } catch (_) {}
      }
      this._ps.photoFile = null;
      this._ps.photoPreviewUrl = null;
      if (!keepRender) this.render();
    }

    // ── Player picker ──────────────────────────────────────────────────────
    //
    // The roster is edited through widgets/player-picker-sheet.js. It replaced
    // an inline combo whose dropdown was position:absolute inside the Players
    // card — the lowest card on Gather — so ui/dropdown-fit.js had to squeeze
    // it to a ~132px keyhole over the docked Continue CTA once a few players
    // were seated. The sheet is position:fixed and sized off --bgb-vv-h, so
    // there is no fit pass, no flip, and no z-index race with the CTA bar.

    // Unified candidate list for the player picker: accounts (accepted
    // buddies, with avatar + username) + ghosts (free-text names from past
    // plays). Names already in the current draft are excluded. Account rows
    // win over ghost rows when both share a name.
    _buddyCandidates() {
      const already = new Set(this._ps.players.map((p) => (p.name || "").toLowerCase()));
      const seen = new Set();
      const out = [];
      for (const b of (this._buddies || [])) {
        const name = b.other_display_name || "";
        const key = name.toLowerCase();
        if (!name || already.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push({
          source: "account",
          user_id: b.other_user_id,
          name,
          username: b.other_username || null,
          avatar: b.other_avatar || null,
        });
      }
      for (const g of (this._ghosts || [])) {
        const name = g.display_name || "";
        const key = name.toLowerCase();
        if (!name || already.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push({
          source: "ghost",
          user_id: null,
          name,
          username: null,
          avatar: null,
        });
      }
      return out;
    }

    /**
     * The empty-query list: people the host has actually played with, most
     * frequent first (the server orders `recent` by play count). Cross-
     * referenced against the candidates so the unified shape is kept and
     * anyone already seated is excluded; a recent who isn't a buddy yet still
     * shows, as a name-only add.
     * @returns {any[]}
     */
    _recentCandidates() {
      const candidates = this._buddyCandidates();
      const byUserId = new Map(candidates.filter((c) => c.user_id).map((c) => [c.user_id, c]));
      const already = new Set(this._ps.players.map((p) => (p.name || "").toLowerCase()));
      const rows = [];
      for (const r of (this._recent || [])) {
        const hit = byUserId.get(r.user_id);
        if (hit) { rows.push(hit); continue; }
        if (!already.has((r.display_name || "").toLowerCase())) {
          rows.push({
            source: "account",
            user_id: r.user_id,
            name: r.display_name,
            username: null,
            avatar: r.avatar || null,
          });
        }
      }
      return rows;
    }

    /**
     * Open the picker. The buddy list is normally already in memory — bootstrap
     * seeds `buddy:all` at login and onMount reads it synchronously — so the
     * sheet paints populated. On a cold cache it opens empty and the preload's
     * `setCandidates` fills it in place.
     * @param {Event} [event]
     */
    _openPlayerPicker(event) {
      window.PlayerPickerSheet.open({
        candidates: this._buddyCandidates(),
        recent: this._recentCandidates(),
        seated: this._ps.players.length,
        returnFocus: (event && event.currentTarget) || null,
        onConfirm: (picks) => this._addPlayers(picks),
      });
    }

    /**
     * Seat everyone the host ticked, in tick order — that order becomes the
     * roster order and therefore the scoring grid's column order. One repaint
     * for the whole set, not one per player.
     * @param {any[]} picks
     */
    _addPlayers(picks) {
      for (const c of picks) {
        this._addPlayer({ name: c.name, user_id: c.user_id || null, avatar: c.avatar || null },
                        { defer: true });
      }
      this.render();
      // render() replaced the trigger the sheet handed focus back to, so a
      // keyboard user would be left on <body>. Only when focus actually fell
      // through — never steal it from wherever the user has moved on to.
      if (document.activeElement === document.body && this.container) {
        const trigger = this.container.querySelector(".cascade-add-player");
        if (trigger) trigger.focus({ preventScroll: true });
      }
    }

    // ── Save ───────────────────────────────────────────────────────────────

    // Card first, write behind it — and the card does not wait on the write.
    // "Another round?" and the corner X are live in the same frame as the tap,
    // because the upload queue makes delivery of a finished play guaranteed:
    // if the write fails, the play goes to the outbox and the header indicator
    // owns it from there. Nothing is left for the host to watch, so the card
    // carries no save state at all.
    _save() {
      if (!this._ps.gameId) {
        this._error = "Pick a game first.";
        this.render();
        return;
      }
      if (this._saving) return;

      // Fold the live overlay into the draft before the payload is built.
      // toPlayCreate() sums roundScores, and a joiner's own cells only ever
      // lived in the live-scores table — without this the play was recorded
      // with those rounds blank, so the saved score didn't match the grid the
      // host had just been looking at.
      this._commitResolvedScores();

      const payload = this._ps.toPlayCreate();
      // One key per finished play, minted here and carried by every attempt —
      // the live finalize/create AND any later outbox flush. Without it, a POST
      // that landed but lost its response would be re-sent by the queue as a
      // second play. bgb_log_play (migration 048) short-circuits a key it has
      // already stored, and bgb_finalize_session calls it, so both write paths
      // inherit the guard.
      payload.client_key = window.Outbox.newClientKey();

      // Snapshot everything the write and the next round need BEFORE the
      // draft is cleared (on success) or recycled (Another round?), and
      // before _startAnotherRound nulls out _ps.code / this._lobby.
      const snap = {
        payload,
        lobbyCode: this._liveLobbyCode(),
        photoFile: this._ps.photoFile || null,
        // Carried on the snapshot, not re-read from _ps at write time: a
        // Retry can fire after the draft has been recycled, and the outbox
        // entry's card would then be labelled with the wrong game.
        gameSnapshot: this._ps.gameSnapshot || null,
        // The run this save belongs to. Every post-write touch of VIEW state is
        // gated on these — the card is dismissible from frame one, so the host
        // can be two screens away by the time the write resolves.
        ps: this._ps,
        seq: this._saveSeq,
      };
      const game = this._ps.gameSnapshot || {};
      const winner = this._ps.players.find((p) => p.is_winner);
      const seed = this._nextRoundSeed();

      this._saving = true;
      this._error = null;
      this.render();

      // Retire the DISK copy of the draft at the tap. The card no longer holds
      // the host here, so they can reach the Play tab before the write lands —
      // where _resumableSession() would offer to resume the game they just
      // saved. _ps stays intact in memory: a failed save still has to leave a
      // complete Settle Up behind the card, and that path re-persists.
      this._ps.unpersist();
      window.store.set("activePlay", null);

      // Resolved by _runSave the instant the write settles — before the photo
      // attach, which is best-effort and must not hold the next round's lobby.
      let settleWrite;
      this._savePromise = new Promise((res) => { settleWrite = res; });

      if (!window.PolaroidPopup) {
        // No splash available — fall back to the old blocking shape.
        this._runSave(snap, settleWrite).then(() => window.router.go("feed"));
        return;
      }
      // Same wrap-up splash non-host joiners get, plus the host-only "Another
      // round?" CTA. No `saving` — see the note above _save: with it unset the
      // card renders that CTA and its corner X immediately. `onRetry` is passed
      // anyway; it only renders once `error` is set, which now happens on the
      // single unrecoverable path in _runSave (the queue write itself failing).
      this._cardId = window.PolaroidPopup.show({
        headline: "Well played!",
        gameName: game.name || "Game over",
        gameThumbnail: game.thumbnail_url || game.image_url || null,
        winnerName: winner ? winner.name : null,
        onAnotherRound: () => this._startAnotherRound(seed),
        // Re-arms the write gate, so a "Another round?" tapped during a retry
        // waits on that attempt rather than on the one that already settled.
        onRetry: () => {
          let settleRetry;
          this._savePromise = new Promise((res) => { settleRetry = res; });
          this._runSave(snap, settleRetry);
        },
      });
      // Read back off the snapshot rather than this._cardId at write time:
      // _resetRunState nulls the field, and update()'s guard treats a null id
      // as "any card", so a stale run could repaint a later card.
      snap.cardId = this._cardId;
      // Deliberately not awaited — the card is already up.
      this._runSave(snap, settleWrite);
    }

    /**
     * Persist the play behind the wrap-up card. Save-then-photo: the play
     * lands first so a flaky upload can't strand the user with no record of
     * the game. Photo upload + the follow-up PUT to attach it are
     * best-effort; if either fails the play stays saved and the card carries
     * a warning line.
     *
     * A failed write is not the host's problem to solve: it goes to the upload
     * queue, carrying the same client_key the live attempt used, so a request
     * that actually landed can't be written twice. The one exception is the
     * queue write itself failing — see the error branch.
     *
     * @param {{payload: Object, lobbyCode: string|null, photoFile: File|null,
     *          gameSnapshot: Object|null, ps: any, seq: number,
     *          cardId?: number, uploadPromise?: Promise<any>|null}} snap
     *   The same object across a Retry — `uploadPromise` is memoized onto it
     *   so a retry doesn't re-push photo bytes that already landed.
     * @param {(() => void)=} onWriteSettled  Resolves _save's write gate.
     */
    async _runSave(snap, onWriteSettled) {
      // Only claim the Save CTA if this run still owns the view. A Retry can
      // only fire from a card that is still up, but a stale re-entry must never
      // re-disable the NEXT round's Save button.
      if (!this._isStaleSave(snap)) this._saving = true;
      const popup = window.PolaroidPopup;
      // Every update below is scoped to the card this run started on, so a
      // slow request can never repaint a card (or dialog) that replaced it.
      const cardId = snap.cardId;

      // Start the upload alongside the save rather than after it. On mobile
      // upstream the photo bytes are the largest single chunk of wall clock,
      // and nothing about them has to wait on the play row — only the
      // attach does. If the save then fails we simply never attach it; the
      // orphan blob in the bucket is cheap.
      //
      // Cached on the snapshot so a Retry re-uses bytes already uploaded
      // rather than pushing the whole photo a second time. Cleared on
      // failure, so a Retry does get a fresh attempt at a failed upload.
      if (snap.photoFile && !snap.uploadPromise) {
        const fd = new FormData();
        fd.append("file", snap.photoFile);
        snap.uploadPromise = window.api.upload("/plays/photo", fd)
          .catch(() => { snap.uploadPromise = null; return null; });
      }
      const uploadPromise = snap.uploadPromise || null;

      let saved;
      let queued = false;
      // Asked fresh rather than read off the latched `_offline`: a host who
      // ran the whole cascade offline may have walked back into signal by the
      // time they tap Save, and a live write is strictly better than a queued
      // one. This is the single point in the flow where reconnecting matters.
      const offlineNow = !!(window.BgbNet && window.BgbNet.isOffline());
      try {
        if (offlineNow) {
          this._queuePlay(snap);
          queued = true;
        } else {
          // Finalizing through the lobby is the nice path — it marks the
          // session finished so spectators get their wrap-up card. But the play
          // itself doesn't need a lobby, and a dead code must not cost the host
          // their game: fall back to a plain Play.create, which records exactly
          // the same play. (No _withLobby here — re-minting a session just to
          // finalize it would be theatre.)
          if (snap.lobbyCode) {
            try {
              saved = await window.PlaySession.finalizeLobby(snap.lobbyCode, snap.payload);
            } catch (e) {
              if (!this._isLobbyGone(e)) throw e;
              saved = await window.Play.create(snap.payload);
            }
          } else {
            saved = await window.Play.create(snap.payload);
          }
        }
      } catch (e) {
        // Every failure goes to the queue, not just a network one. The card is
        // dismissible, so there is no longer a surface guaranteed to be there
        // to carry a Retry — and no draft behind it to fall back to once the
        // host has started another round. The queue is that surface: the play
        // is recorded, the header indicator says so, and the flush is safe
        // because snap.payload.client_key is the key the live write already
        // carried — if that request actually landed and only its response was
        // lost, the server returns the original play rather than a second.
        //
        // A terminal 4xx is queued too. It parks as `failed` and shows up in
        // the uploads dialog for the host to look at, which beats vanishing.
        if (!queued) {
          try {
            this._queuePlay(snap);
            queued = true;
          } catch (_) {
            // The queue write itself failed — localStorage full or unavailable.
            // This is the one genuinely unrecoverable outcome in the flow, so
            // it gets a modal the host cannot miss rather than a line on a card
            // they may already have closed.
            const msg = (e && e.message) || "Failed to save";
            if (!this._isStaleSave(snap)) {
              // Still their current draft: put it back on disk and drop them on
              // Settle Up, where Save can be tapped again.
              this._saving = false;
              this._error = msg;
              snap.ps.persist();
              window.store.set("activePlay", snap.ps);
              this.render();
            }
            if (popup) {
              popup.alert({
                title: "Couldn't save this play",
                body: "There's no room left on this device to hold it. Free up "
                  + "some space and try again — the game is still on the Settle "
                  + "Up screen.",
              });
            }
            return;
          }
        }
      } finally {
        // Every exit from the write passes through here — including the early
        // return above, whose value waits on this. The next round's POST
        // /sessions gates on it and nothing else: gating on _runSave's return
        // would make it wait on the photo attach too.
        if (onWriteSettled) onWriteSettled();
      }

      // Queued, not saved: there is no server row, so nothing downstream that
      // reads one applies. The draft is still cleared — the play is safely on
      // disk in the outbox and leaving the draft behind would offer the host a
      // "Resume hosting?" banner for a game they already finished.
      if (queued) {
        if (!this._isStaleSave(snap)) {
          this._saving = false;
          // Wipes the in-memory draft; the disk copy went at the tap, and
          // clear() removing an already-absent key is fine. Skipped when stale,
          // where this._ps is the NEXT round's session — clearing that would
          // empty the roster the host is looking at right now.
          //
          // _resetRunState() first, for the same staleness reason: the run this
          // save belongs to is over, so its lobby handles and live wiring have
          // to go before the draft does. Leaving _lobby set is what let the
          // visibilitychange catch-up tick keep firing against a finished
          // session — see _lobbyPollTick's phase guard.
          //
          // It bumps _saveSeq, which is half of _isStaleSave. That is both safe
          // and correct here: this branch returns below, the saved branch is
          // mutually exclusive with it, and neither is followed by another
          // staleness test (_attachPhoto works off savedId/cardId locals). The
          // bump says "this run is over", which is precisely what just happened.
          this._resetRunState();
          this._ps.clear();
          window.store.set("activePlay", null);
        }
        if (popup) {
          // A photo picked while still online can't ride along: the blob is
          // never persisted, so the queue has no way to hold it. Say so rather
          // than letting it disappear between the tap and the upload.
          //
          // Two wordings, because there are two ways to land here: the host was
          // offline at the tap, or the write failed on its way out. "Next time
          // you're online" is a lie in the second case. No-ops when the card is
          // gone — the header indicator is the surface then.
          const when = offlineNow ? "it uploads next time you're online" : "it'll upload shortly";
          popup.update({
            error: null,
            warning: snap.photoFile
              ? `Saved on this device — ${when}. The photo wasn't kept; add one from the play card afterwards.`
              : `Saved on this device — ${when}.`,
          }, cardId);
        }
        return;
      }

      const savedId = (saved && (saved.id || saved.play_id || (saved.play && saved.play.id))) || null;

      // Seed the Play tab's "Another Round" card from the row we just saved,
      // so it's correct the instant the host lands back there — no refetch.
      // Order matters: both Play.create and PlaySession.finalizeLobby chain
      // their cache invalidation BEFORE resolving, so this write lands after
      // it. If that invalidation ever moves to a .finally() or fires in
      // parallel, it will race this write and blank the card.
      if (saved && window.Play && window.Play.rememberLastPlay) {
        window.Play.rememberLastPlay(saved.play || saved);
      }

      // The draft has done its job — but only if it is still THIS run's draft.
      // When the host tapped "Another round?" before the write landed, _ps is
      // the new session: clearing it would empty the roster they are looking at
      // and delete the draft that backs it. Everything else below is
      // account-level (it describes the play that just landed, which is true on
      // whatever screen the host has reached), so it runs either way.
      //
      // Note we do NOT render() here: the card covers the view, and every exit
      // from it (X, Another round?) paints on its own.
      if (!this._isStaleSave(snap)) {
        this._saving = false;
        // Release the run before the draft — see the queued branch above.
        this._resetRunState();
        this._ps.clear();
        window.store.set("activePlay", null);
      }
      // Re-pull the feed's first page NOW, behind the still-up wrap-up card,
      // so the X lands on a feed that already contains this play.
      // store.invalidate("feed") used to sit here and did nothing for this —
      // it only re-fires subscribers with the unchanged value. Fire-and-forget:
      // if the host taps through before it settles, Feed.fetchPage() joins the
      // same in-flight request via bgbCache's single-flight map.
      if (window.Feed) window.Feed.refreshFirstPage().catch(() => {});
      // Drop the host-flow caches so the next gather screen sees the new
      // ghost names + updated played-with counts + the just-played game at
      // the top of the recents dropdown. Re-warm in the background so the
      // user returns to instant data without paying for a round-trip on
      // the next host tap.
      if (window.Buddy && window.Buddy.invalidate) window.Buddy.invalidate();
      if (window.Game && window.Game.invalidateRecent) window.Game.invalidateRecent();
      if (window.Buddy && window.Buddy.allBuddies) window.Buddy.allBuddies().catch(() => {});
      if (window.Game && window.Game.recentlyPlayed) window.Game.recentlyPlayed(6).catch(() => {});

      // Clear a prior attempt's error line. The card was never blocked on this
      // write, so there is nothing to unblock — this only matters after the
      // localStorage-full path put an error on it and a Retry then succeeded.
      //
      // Deliberately no `playId` — the saved card is one CTA, "Another
      // round?", and the corner X out to the feed. The play is one tap away
      // on that feed, so a "View play" button only crowded the wrap-up. (The
      // joiner splash in session-viewer still sets playId; that card has no
      // other affordance.)
      if (popup) popup.update({ error: null }, cardId);

      if (uploadPromise) await this._attachPhoto(uploadPromise, savedId, cardId);
    }

    /**
     * Hand a finished play to the outbox instead of the server.
     *
     * Throws when the queue write fails (localStorage full or unavailable) —
     * the caller MUST let that surface. A silent failure here is the one
     * genuinely unrecoverable outcome in this flow: the host is told their
     * game is saved, the draft is cleared, and the record exists nowhere.
     *
     * @param {{payload: Object}} snap
     */
    _queuePlay(snap) {
      window.Outbox.enqueue(snap.payload, snap.gameSnapshot || null);
      // Seed the Play tab's "Another Round" card the same way a live save
      // does. Built from the payload rather than a server row — there isn't
      // one yet — and shaped to match `recent_plays[]`, which is what
      // seedFromPlayRow() and the card both read. The next successful
      // bootstrap overwrites it with the real row.
      const game = snap.gameSnapshot || {};
      if (window.Play && window.Play.rememberLastPlay && snap.payload.game_id) {
        window.Play.rememberLastPlay({
          game_id: snap.payload.game_id,
          game_name: game.name || "",
          game_thumbnail: game.thumbnail_url || null,
          play_mode: snap.payload.play_mode || null,
          players: snap.payload.players || [],
          expansions: (snap.payload.expansion_ids || []).map((id) => ({
            expansion_game_id: id,
          })),
        });
      }
    }

    /**
     * Land the already-in-flight photo upload on the saved play. Runs after
     * the card has unblocked, so it only ever touches the card again to warn
     * that the photo didn't make it — and only while the card is still up
     * (PolaroidPopup.update no-ops once it's dismissed).
     *
     * PATCH /plays/{id}/photo writes the one column. The old path re-sent the
     * whole play through PUT /plays/{id}, which full-replaces the nested
     * lists — twelve round trips, and every player row destroyed and
     * recreated, to set a URL.
     */
    async _attachPhoto(uploadPromise, savedId, cardId) {
      let ok = false;
      try {
        const resp = await uploadPromise;
        const uploadedUrl = resp && resp.photo_url;
        if (uploadedUrl && savedId) {
          await window.Play.attachPhoto(savedId, uploadedUrl);
          ok = true;
        }
      } catch (_) {
        ok = false;
      }
      if (!ok && window.PolaroidPopup) {
        window.PolaroidPopup.update({
          warning: "Saved without the photo — you can add it later from the play card.",
        }, cardId);
      }
    }

    // ── Another round ──────────────────────────────────────────────────────

    /**
     * Plain snapshot of everything that carries into a follow-up game with
     * the same group. Deliberately drops per-play results (`is_winner`,
     * `score`, `roundScores`) and `participant_id` — the latter belongs to
     * the finished session's lobby rows, and reusing it would make
     * _removePlayer issue a DELETE against the wrong session.
     */
    _nextRoundSeed() {
      const ps = this._ps;
      return {
        gameId: ps.gameId,
        gameSnapshot: ps.gameSnapshot,
        expansionIds: [...(ps.expansionIds || [])],
        playMode: ps.playMode,
        players: (ps.players || []).map((p) => ({
          name: p.name,
          is_winner: false,
          score: null,
          user_id: p.user_id || null,
          avatar: p.avatar || null,
          team: p.team || "",
          initials: p.initials || null,
        })),
      };
    }

    /**
     * Start a fresh session pre-seeded with the same game, expansions, play
     * mode and roster, landing on Gather so the host can still tweak the
     * line-up (and joiners get a window to re-join under the new code).
     *
     * Restarts in place rather than via router.go("play-flow"): the host is
     * already mounted on this view, and View.mount() short-circuits on
     * _mounted, so onMount would never re-run.
     */
    async _startAnotherRound(seed) {
      if (window.PolaroidPopup) window.PolaroidPopup.dismiss();

      // Read before the teardown, so the gate below doesn't depend on which
      // fields _resetRunState happens to null.
      const priorWrite = this._savePromise;

      // Re-latch connectivity for the new run. _offline otherwise carries over
      // from the session that just finished, and a stale `true` would make
      // _advancePhase skip its PATCH for a host who walked back into signal
      // between rounds.
      this._offline = !!(window.BgbNet && window.BgbNet.isOffline());

      this._resetRunState();
      this._expansionsOpen = false;

      // POST /sessions runs bgb_create_session, which abandons every OTHER open
      // session this host owns. The finalize for the round being left may still
      // be in flight — the wrap-up card no longer waits for it — so minting now
      // could close the lobby that finalize is about to write to. The play
      // itself survives (_runSave falls back to Play.create on the 404/410 via
      // _isLobbyGone), but every spectator's mirror would end on 'abandoned'
      // instead of the finalized wrap-up card.
      //
      // So the MINT waits for that write to settle. The repaint does not:
      // everything from here to the render() below is synchronous, so the host
      // gets the prefilled Gather screen in this frame and only the invite code
      // arrives late. _lobbyReady() consumes the gate.
      //
      // Bounded, because domain/api.js sets no fetch timeout: after
      // LOBBY_GATE_MAX_WAIT_MS the mint goes ahead and we accept the old
      // behaviour rather than leave the round with no lobby at all.
      //
      // Skipped offline: the request can only fail, and _ensureLobbyOpen will
      // discard the record rather than consume it — leaving prefetchLobby's
      // single slot holding a rejected promise for the next real host tap.
      //
      // Set AFTER _resetRunState, which nulls _lobbyGate so a plain onMount
      // reset can't inherit a previous run's.
      this._lobbyGate = this._offline ? null : Promise.race([
        Promise.resolve(priorWrite).catch(() => {}),
        new Promise((r) => setTimeout(r, LOBBY_GATE_MAX_WAIT_MS)),
      ]).then(() => {
        // Fired here rather than before the teardown so the POST starts the
        // moment the previous write is out of the way — still overlapping the
        // roster sync and live-scores wiring that follow.
        window.PlaySession.prefetchLobby({ gameId: seed.gameId });
      });

      const ps = new window.PlaySession({
        gameId: seed.gameId,
        gameSnapshot: seed.gameSnapshot,
        expansionIds: seed.expansionIds,
        playMode: seed.playMode,
        players: seed.players.map((p) => ({ ...p })),
        phase: "gather",
      });
      this._ps = ps;
      // Safety net for a roster the host had emptied down to nothing.
      this._ensureSelfIncluded();
      ps.persist();
      window.store.set("activePlay", ps);

      // Paint the prefilled Gather screen before any network work.
      this.render();
      this._scrollToCurrentPhase();

      // _ps.code is null, so this takes the create branch: POST /sessions
      // with the game already attached, then replaces the URL with the new
      // /play/{code}.
      await this._lobbyReady();
      // Repaint and arm the poll the moment the code exists. The roster sync
      // below is deliberately NOT awaited: it is one POST per carried-over
      // player, and making the invite card wait on all of them held the screen
      // stale for round-trips it never needed. Each _pushParticipantToBackend
      // is best-effort, and the poll backfills participant_id within ~2s —
      // the same fire-and-forget contract _addPlayer uses.
      this.render();
      this._startLobbyPoll();
      this._syncRosterToLobby();
      await this._startLiveScores();
      if (this._guideWidget) this._guideWidget.refresh();
    }

    /**
     * Push the carried-over roster into a freshly opened lobby. POST
     * /sessions seats only the host, so everyone else needs an explicit
     * participant row before joiners can see them. Parallel — rosters are a
     * handful of rows — and each push is best-effort by design: a roster row
     * that doesn't land costs spectators a name, not the host their play.
     */
    _syncRosterToLobby() {
      // Single-flight. Three callers can want this at once — the Gather poll
      // every 2s, _advancePhase on the way into Play, and a fresh mint — and
      // without the gate a slow POST would have another full batch stacked on
      // top of it every tick, leaving bgb_add_participant's server-side dedup
      // to do the de-duplicating this loop should be doing itself.
      if (this._rosterSyncPromise) return this._rosterSyncPromise;
      this._rosterSyncPromise = (async () => {
        // Awaits the code rather than bailing on a missing _lobby: the whole
        // point is to run on the fresh-mint path, where the caller is ahead of
        // _ensureLobbyOpen.
        const code = await this._lobbyReady();
        if (!code) return;
        const me = window.store.get("user");
        const meId = me ? me.id : null;
        const pending = (this._ps.players || []).filter(
          (p) => !p.participant_id && !(meId && p.user_id === meId)
        );
        if (pending.length === 0) return;
        await Promise.all(pending.map((p) => this._pushParticipantToBackend(p)));
      })();
      this._rosterSyncPromise
        .catch(() => {})
        .then(() => { this._rosterSyncPromise = null; });
      return this._rosterSyncPromise;
    }

    /**
     * Re-push any local player the lobby doesn't know about yet.
     *
     * The roster's twin of _reconcileGameToLobby: a cheap, idempotent catch-up
     * that rides the Gather poll so the roster heals itself instead of
     * depending on every individual write having landed. It has to, because
     * _withLobby swallows everything that isn't a definitive 404/410 — one
     * dropped POST used to cost that player their column for the entire game,
     * since live scores are keyed by participant_id and the host's cells for a
     * row without one are never mirrored anywhere.
     *
     * bgb_add_participant dedups server-side, so a push that races the poll's
     * own backfill is a no-op rather than a second row.
     */
    _reconcileRosterToLobby() {
      if (this._isOffline()) return;
      const me = window.store.get("user");
      const meId = me ? me.id : null;
      const pending = (this._ps.players || []).filter(
        (p) => !p.participant_id && !(meId && p.user_id === meId)
      ).length;
      if (pending === 0) {
        this._rosterRetries = 0;
        this._rosterPending = 0;
        return;
      }
      // Fresh budget whenever the pending set changes size: a push that landed
      // (or a player the host just added) is progress, and progress means this
      // is converging rather than looping.
      if (pending !== this._rosterPending) {
        this._rosterPending = pending;
        this._rosterRetries = 0;
      }
      if (this._rosterRetries >= ROSTER_RECONCILE_MAX) return;
      this._rosterRetries++;
      this._syncRosterToLobby();
    }
  }

  function initialsOf(name) {
    const parts = (name || "").trim().split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  }

  window.PlayFlowView = PlayFlowView;
})();
