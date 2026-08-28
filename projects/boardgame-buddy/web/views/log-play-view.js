// views/log-play-view.js — The Play tab: Host on top, Join on the bottom.
//
// Two halves on a single screen, split by a divider:
//   • Top (Host): "Let's play" heading, an optional "Resume hosting?" banner,
//     an optional "N plays waiting to upload" banner, then three host cards —
//     Host a game / Another Round / Game Explorer. With no connection the
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
      // The upload queue is account-level state and now lives in the global
      // header (ui/outbox-indicator.js), so this view no longer watches it.
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
      const ps = this._resumableSession();
      const resumable = !!ps;
      const game = resumable ? ps.gameSnapshot : null;

      this.container.innerHTML = `
        <header class="cascade-chooser__header">
          <h1 class="font-display">Let's play</h1>
        </header>

        ${resumable ? `
          <section class="lp-stub">
            <div class="lp-stub__top">
              ${game && game.thumbnail_url
                ? `<img class="lp-stub__art" src="${escapeAttr(game.thumbnail_url)}" alt="" loading="lazy" />`
                : ""}
              <div class="lp-stub__body">
                <span class="lp-stub__eyebrow">In progress</span>
                <span class="lp-stub__title">${game ? escapeHtml(game.name) : "Game in progress"}</span>
                <span class="lp-stub__meta">${(ps.players || []).length
                  ? `${(ps.players || []).length} players`
                  : "Lobby open"}</span>
              </div>
              <div class="lp-stub__perf" aria-hidden="true"></div>
              <div class="lp-stub__code">
                <b>${escapeHtml(ps.code)}</b><span>code</span>
              </div>
            </div>
            <div class="lp-stub__actions">
              <button class="btn btn-ghost btn-sm"
                      onclick="window.logPlayView._discard()">
                Discard
              </button>
              <button class="btn btn-primary btn-sm"
                      onclick="window.logPlayView._resume()">
                Resume
              </button>
            </div>
          </section>
        ` : ""}


        <div class="cascade-chooser__cards">${this._renderChooserCards()}</div>

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

    // Hosting is the primary action, "Another round" is a shortcut with real
    // content behind it, and the explorer is browsing. Rendering all three as
    // identical rows asserted they were peers. The lid + ruled-rows split
    // encodes the actual hierarchy.
    _renderChooserCards() {
      const offline = !!(window.BgbNet && window.BgbNet.isOffline());
      return `
        <button class="lp-lid" onclick="window.logPlayView._host()">
          <span class="lp-lid__emboss" aria-hidden="true">
            <img src="assets/sprites/bgb-die.svg" alt="" />
          </span>
          <span class="lp-lid__kicker">${offline ? "Offline" : "Start something"}</span>
          <span class="lp-lid__title">Host a game</span>
          <span class="lp-lid__sub">${offline
            ? "Saves to this device and uploads when you're back online."
            : "Open a session and log a play. Everyone joins with a code."}</span>
        </button>

        <div class="lp-quiet">
          ${this._renderAnotherRoundCard()}
          <button class="lp-quiet__row" onclick="window.router.go('game-explorer')">
            <span class="lp-quiet__body">
              <span class="lp-quiet__title">Game explorer</span>
              <span class="lp-quiet__sub">Browse by players, play time and type.</span>
            </span>
            <span class="lp-quiet__go" aria-hidden="true">&rarr;</span>
          </button>
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
        <button class="lp-quiet__row" onclick="window.logPlayView._anotherRound()">
          ${art
            ? `<img class="lp-quiet__art" src="${escapeHtml(art)}" alt="" loading="lazy" />`
            : ""}
          <span class="lp-quiet__body">
            <span class="lp-quiet__title">Another round</span>
            <span class="lp-quiet__sub">${label ? escapeHtml(label) : "Same game, fresh scores."}</span>
          </span>
          <span class="lp-quiet__go" aria-hidden="true">&rarr;</span>
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
    // empty game slot. Continuing an existing session is what the "Resume
    // hosting?" banner directly above these cards is for — and it is the only
    // thing that does it.
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
     * Repaint just the host cards.
     *
     * Not render(): that rebuilds the whole container via innerHTML, which
     * replaces the JoinPanel's host element and would wipe a half-typed
     * session code every time the network flapped.
     */
    _patchChooserCards() {
      if (!this._mounted) return;
      const el = this.container.querySelector(".cascade-chooser__cards");
      if (!el) { this.render(); return; }
      el.innerHTML = this._renderChooserCards();
      this.refreshIcons(el);
    }

    // Middle host card: replay the last game with the same table. Sits between
    // Host and Game Explorer — a repeat of last night's game is the more
    // likely tap than browsing for a new one. Only rendered when there IS a
    // last play, so a brand-new account sees just Host and Game Explorer,
    // adjacent. The 48px slot carries the game's box art rather than a Lucide
    // glyph; renderGamePolaroid() is deliberately not reused here, it's a full
    // grid tile (big photo + caption + status badge), not an avatar-sized mark.

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

    // ── Resume banner ──────────────────────────────────────────────────────

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
