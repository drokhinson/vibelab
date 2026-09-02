// views/log-play-view.js — The Play tab: Host on top, Join on the bottom.
//
// Two halves on a single screen, split by a divider:
//   • Top (Host): "Let's play" heading, then one list of option cards —
//     the session in progress (when there is one), Host a game, Another
//     Round, Game Explorer. They are all the same .lp-opt component; the
//     only difference between them is surface weight. With no connection the
//     cards stay exactly where they are and only their copy changes: offline
//     is detected, never chosen, so there is nothing here to opt into.
//   • Bottom (Join): the JoinPanel widget — a 5-char code input and the list
//     of active sessions the user can join or spectate.
//
// Game browsing lives on its own screen now (views/game-explorer-view.js,
// /games); the Game Explorer card is the way in, and picking a game there
// lands the user on Gather with it prefilled.
//
// Routes here from the bottom-nav Play tab, the wrap-up polaroid after a save,
// the feed's empty state, and the host flow when a play is discarded.

(function () {
  class LogPlayView extends window.View {
    constructor() {
      super("log-play");
      // Most recent play (own or participated), from the profile bundle.
      // Backs the "Another Round" chooser card; null hides that card.
      this._lastPlay = null;
    }

    // Everything the first paint needs, read synchronously from cache.
    _hydrateFromCache() {
      this._lastPlay = this._cachedLastPlay();
    }

    // View.mount() calls this synchronously before onMount(), so the whole
    // screen — resume banner, host cards, join panel — is up in the tap frame.
    // Nothing here waits on the network; the join list paints its own loader.
    renderLoading() {
      this._hydrateFromCache();
      this.render();
    }

    async onMount() {
      // renderLoading() already painted from cache one frame ago (it runs
      // synchronously just before this). Re-hydrating is idempotent and covers
      // the case where that call threw.
      this._hydrateFromCache();
      // Signal dropping (or returning) changes which host cards make sense.
      // The upload queue is account-level state and lives in Settings' Pending
      // uploads section, with the gear's dot as its signal, so this view no
      // longer watches it.
      // View.listen auto-unsubscribes on unmount.
      this.listen("offline", () => {
        this._patchChooserCards();
        // The Join half is a widget, so it can't subscribe for itself.
        window.joinPanel.syncOffline();
      });
      this._refreshLastPlay();
    }

    async onUnmount() {
      // Stops the joinable-sessions poll — it must not keep running once the
      // user is off the Play tab.
      window.joinPanel.unmount();
    }

    // The persisted draft, but only when it's still worth resuming (open
    // lobby, not finalized/abandoned). Drives the resume banner, and gates
    // the overwrite confirm in _anotherRound().
    _resumableSession() {
      const ps = window.PlaySession.load();
      const ok =
        ps &&
        ps.isActive() &&
        ps.code &&
        ps.phase &&
        ps.phase !== "finalized" &&
        ps.phase !== "abandoned";
      return ok ? ps : null;
    }

    render() {
      this.container.innerHTML = `
        <header class="cascade-chooser__header">
          <h1 class="font-display">Let's play</h1>
        </header>

        <div class="lp-opts">${this._renderChooserCards()}</div>

        <hr class="lp-divider" />

        <section class="lp-join-section">
          <h2 class="lp-section-title font-display">Join a game</h2>
          <div id="lp-join-mount"></div>
        </section>
      `;
      this.refreshIcons();
      // innerHTML above replaced the panel's host element, so hand it the new
      // one. JoinPanel keeps its session list and any typed code across the
      // swap, and only the first mount starts the poll.
      window.joinPanel.mount(this.container.querySelector("#lp-join-mount"));
    }

    // Everything the screen offers is one .lp-opt card — same box, same 44px
    // mark slot, same type scale. Hosting is still the primary action and the
    // live session still stands apart, but that is carried by surface weight
    // (--host's amber wash, --live's terracotta) rather than by three
    // different components. See the .lp-opt block in styles.css.
    _renderChooserCards() {
      const offline = !!(window.BgbNet && window.BgbNet.isOffline());
      return `
        ${this._renderResumeCard()}

        <button class="lp-opt lp-opt--host" onclick="window.logPlayView._host()">
          <span class="lp-opt__emboss" aria-hidden="true">
            <img src="assets/sprites/bgb-die.svg" alt="" />
          </span>
          <span class="lp-opt__mark lp-opt__mark--icon" aria-hidden="true">
            <i data-icon="dice-6" class="w-6 h-6"></i>
          </span>
          <span class="lp-opt__body">
            <span class="lp-opt__title">Host a game</span>
            <span class="lp-opt__sub">${offline
              ? "Saves to this device and uploads when you're back online."
              : "Open a session — everyone joins with a code."}</span>
          </span>
        </button>

        ${this._renderAnotherRoundCard()}

        <button class="lp-opt" onclick="window.router.go('game-explorer')">
          <span class="lp-opt__mark lp-opt__mark--icon" aria-hidden="true">
            <i data-icon="search" class="w-5 h-5"></i>
          </span>
          <span class="lp-opt__body">
            <span class="lp-opt__title">Game explorer</span>
            <span class="lp-opt__sub">Browse by players, play time and type.</span>
          </span>
        </button>
      `;
    }

    // The session in progress. Unlike its siblings this card is not a
    // navigation — it carries two real buttons — so the row itself is inert
    // and Discard / Resume are the only tap targets.
    //
    // The code rides in the meta line rather than its own ticket column. That
    // column (plus the perforation and the notches pinned to it) is exactly
    // what used to push Discard and Resume onto a detached second row; with
    // it gone, both actions fit on the game's own line.
    _renderResumeCard() {
      const ps = this._resumableSession();
      if (!ps) return "";
      const game = ps.gameSnapshot;
      const players = (ps.players || []).length;
      // The word "code" would push this line past the ~117px the sub gets once
      // both buttons share the row. The mono/tracked treatment says it for us
      // — same as the join list's own bare session codes.
      const meta = [
        players ? `${players} players` : "Lobby open",
        ps.code ? `<b class="lp-opt__code">${escapeHtml(ps.code)}</b>` : "",
      ].filter(Boolean).join(" · ");
      return `
        <div class="lp-opt lp-opt--live">
          ${game && game.thumbnail_url
            ? `<img class="lp-opt__mark" src="${escapeAttr(game.thumbnail_url)}" alt="" loading="lazy" />`
            : `<span class="lp-opt__mark lp-opt__mark--icon" aria-hidden="true">
                 <i data-icon="dice-6" class="w-5 h-5"></i>
               </span>`}
          <span class="lp-opt__body">
            <span class="lp-opt__eyebrow">In progress</span>
            <span class="lp-opt__title">${game ? escapeHtml(game.name) : "Game in progress"}</span>
            <span class="lp-opt__sub">${meta}</span>
          </span>
          <span class="lp-opt__actions">
            <button class="lp-opt__discard" onclick="window.logPlayView._discard()">Discard</button>
            <button class="lp-opt__resume" onclick="window.logPlayView._resume()">Resume</button>
          </span>
        </div>
      `;
    }

    _renderAnotherRoundCard() {
      const p = this._lastPlay;
      if (!p || !p.game_id) return "";
      const names = (p.players || []).map((x) => x.name).filter(Boolean);
      const art = p.game_thumbnail;
      const label = [p.game_name, names.join(", ")].filter(Boolean).join(" · ");
      return `
        <button class="lp-opt" onclick="window.logPlayView._anotherRound()">
          ${art
            ? `<img class="lp-opt__mark" src="${escapeAttr(art)}" alt="" loading="lazy" />`
            : `<span class="lp-opt__mark lp-opt__mark--icon" aria-hidden="true">
                 <i data-icon="rotate-ccw" class="w-5 h-5"></i>
               </span>`}
          <span class="lp-opt__body">
            <span class="lp-opt__title">Another round</span>
            <span class="lp-opt__sub">${label ? escapeHtml(label) : "Same game, fresh scores."}</span>
          </span>
        </button>
      `;
    }

    // ── Host ───────────────────────────────────────────────────────────────

    // Kick POST /sessions here rather than letting PlayFlowView.onMount do it,
    // so the round trip overlaps the navigation and first paint instead of
    // following them. By the time Gather renders, the code is usually already
    // in hand.
    //
    // "Host a game" is a NEW game, always: fresh draft, fresh session code,
    // empty game slot. Continuing an existing session is what the in-progress
    // card directly above this one is for — and it is the only thing that
    // does it.
    //
    // This used to skip the clear whenever a resumable draft existed, so a host
    // who tapped Host with one lying around silently landed back in the old
    // session, code and all. The guard was there because bgb_create_session
    // abandons every other open session this host owns, and minting here would
    // close the lobby the banner was offering. That is now the intended
    // outcome: starting a new play ends the previous one, the same way
    // "Another Round" already abandons deliberately.
    //
    // The empty game slot is deliberate too — a stale draft from an earlier
    // explorer pick must not silently decide tonight's game. Picking a game is
    // the Game Explorer card's job.
    _host() {
      const stale = window.PlaySession.load();
      if (stale) stale.clear();
      window.store.set("activePlay", null);
      // Offline the mint can only fail, and failing isn't the worst of it:
      // prefetchLobby parks its promise in a single module-level slot that
      // PlayFlowView never consumes offline, so the rejected record would
      // still be sitting there for the next real host tap to adopt.
      if (!(window.BgbNet && window.BgbNet.isOffline())) {
        window.PlaySession.prefetchLobby({ gameId: null });
      }
      window.router.go("play-flow");
    }

    // ── Another Round ──────────────────────────────────────────────────────

    _recentPlayFrom(bundle) {
      const plays = bundle && bundle.recent_plays;
      return (Array.isArray(plays) && plays[0]) || null;
    }

    // Sync source of truth for the Another Round card. The `play.last` seed is
    // written by bootstrap, by every profile-bundle fetch, and by the host
    // flow the instant a play saves — so it survives the profile bundle being
    // invalidated after a save and being expired after 60s, which is what used
    // to make the card arrive late. The bundle peek is the bridge for a
    // session that started before the seed existed.
    _cachedLastPlay() {
      const seed = (window.Play && window.Play.cachedLastPlay)
        ? window.Play.cachedLastPlay()
        : null;
      return seed || this._recentPlayFrom(window.Profile.cachedBundle());
    }

    // SWR refresh behind the sync peek in onMount. Only re-renders when the
    // top play actually changed, so the usual cache hit costs nothing.
    async _refreshLastPlay() {
      let next = null;
      try {
        next = this._recentPlayFrom(await window.Profile.bundle());
      } catch (_) {
        return;
      }
      const before = this._lastPlay && this._lastPlay.id;
      if ((next && next.id) === before) return;
      this._lastPlay = next;
      // Fire-and-forget, so it can land after the user has navigated away —
      // don't paint into a container this view no longer owns. onMount's
      // sync peek picks the refreshed value up on the next visit.
      if (!this._mounted) return;
      this._patchChooserCards();
    }

    // Repaint just the three host cards. render() rebuilds the entire
    // container via innerHTML, so using it here would tear down and re-mount
    // the join panel below (and blow away a half-typed code) the moment a late
    // last-play landed. With the seed in place this path is rare; when it does
    // run, nothing outside the card row moves.
    /**
     * Repaint just the option list — resume card included, since it now lives
     * in the same list. Re-reading _resumableSession() is a localStorage hit,
     * so this stays cheap.
     *
     * Not render(): that rebuilds the whole container via innerHTML, which
     * replaces the JoinPanel's host element and would wipe a half-typed
     * session code every time the network flapped.
     */
    _patchChooserCards() {
      if (!this._mounted) return;
      const el = this.container.querySelector(".lp-opts");
      if (!el) { this.render(); return; }
      el.innerHTML = this._renderChooserCards();
      this.refreshIcons(el);
    }

    // Sits between Host and Game Explorer — a repeat of last night's game is
    // the more likely tap than browsing for a new one. Only rendered when
    // there IS a last play, so a brand-new account sees just Host and Game
    // Explorer, adjacent. The 44px mark carries the game's box art;
    // renderGamePolaroid() is deliberately not reused here, it's a full grid
    // tile (big photo + caption + status badge), not an avatar-sized mark.

    // Stages the previous game + roster into a fresh draft and drops the
    // user on Gather, exactly like the wrap-up card's "Another round?".
    // Same staging contract as the explorer's grid pick: PlayFlowView.onMount()
    // reads PlaySession.load() from localStorage, so persist() before
    // navigating.
    async _anotherRound() {
      const p = this._lastPlay;
      if (!p) return;

      // A new round replaces the persisted draft, so an in-progress session
      // has to be closed out deliberately — same gate and same remote
      // abandon as _discard().
      const open = this._resumableSession();
      if (open) {
        const ok = await window.PolaroidPopup.confirm({
          title: "Start a new round?",
          body: "Your session in progress will be abandoned and its lobby closed.",
          confirmLabel: "Start new round",
          cancelLabel: "Keep playing",
        });
        if (!ok) return;
        if (open.code) {
          try {
            await window.PlaySession.advancePhase(open.code, "abandoned");
          } catch (_) {}
        }
        open.clear();
      }

      // rulebook_url / is_expansion aren't on a play row. Bootstrap warms the
      // game bundle for owned games, so this is usually a free sync hit; when
      // it misses the guide link just resolves later in the host flow.
      const cached = window.bgbCache && window.bgbCache.get("game.bundle", p.game_id);
      const seed = window.PlaySession.seedFromPlayRow(p, (cached && cached.game) || {});
      if (!seed) return;

      const ps = new window.PlaySession({ ...seed, phase: "gather" });
      ps.persist();
      window.store.set("activePlay", ps);
      // Same reference-guide warm-up the explorer's picker does.
      window.Chapter.prefetchMyChapters(ps.gameId);
      // Mint the lobby now, overlapping it with the navigation. Deliberately
      // below the confirm + abandon above: a user who chose "Keep playing"
      // must never have a session minted behind their back. Skipped offline
      // for the same reason as _host().
      if (!(window.BgbNet && window.BgbNet.isOffline())) {
        window.PlaySession.prefetchLobby({ gameId: ps.gameId });
      }
      window.router.go("play-flow");
    }

    // ── In-progress card ───────────────────────────────────────────────────

    _resume() {
      window.router.go("play-flow");
    }

    async _discard() {
      const ok = await window.PolaroidPopup.confirm({
        title: "Discard this play?",
        body: "The lobby will close and the in-progress draft will be cleared.",
        confirmLabel: "Discard",
        cancelLabel: "Keep playing",
      });
      if (!ok) return;
      const ps = window.PlaySession.load();
      if (ps && ps.code) {
        try {
          await window.PlaySession.advancePhase(ps.code, "abandoned");
        } catch (_) {}
      }
      if (ps) ps.clear();
      window.store.set("activePlay", null);
      this.render();
    }
  }

  window.LogPlayView = LogPlayView;
})();
