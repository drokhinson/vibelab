// views/session-viewer-view.js — Read-only cascade mirror for joiners.
//
// Mirrors the host's Gather → Play → Settle Up cascade in read-only mode.
// The joiner doesn't see Continue buttons — they auto-scroll forward as
// the host advances the phase via Realtime (SessionPhase channel). During
// the Play phase they watch the host's scoreboard stream in over the
// LiveScores channel, and when the host moves to Settle Up they get a
// polaroid popup announcing the wrap-up.
//
// Nothing on this screen is editable. Joiners used to own their own column
// in the grid; the host is the only person who scores now (RLS enforces it
// as of migration 053), which is what lets this view be a plain mirror —
// no per-column edit mode, no caret to preserve across a repaint, no write
// path at all.
//
// Polling stays around as a Realtime fallback: every 10–30s we re-fetch
// the lobby so a missed Realtime event doesn't leave the joiner stuck.

(function () {
  // Polling cadence matches the host's lobby poll (play-flow-view.js:124).
  // Realtime covers phase changes and live scores, but participant joins /
  // leaves and the host's roster edits are poll-only, so 2s is the minimum
  // freshness an authenticated joiner can expect for the player list during
  // Gather. During play/settle the poll drops to a Realtime fallback — see
  // the gating at the top of _poll().
  const POLL_MS = 2000;

  class SessionViewerView extends window.View {
    constructor() {
      super("session-viewer");
      this._code = null;
      this._session = null;
      this._loading = false;
      this._error = null;
      this._pollHandle = null;
      this._guideWidget = null;
      this._liveScores = null;
      this._liveOff = null;
      this._phaseOff = null;
      this._popupShown = false;
      // One feed re-pull per session watched — see _handlePhaseSideEffects.
      this._feedRefreshed = false;
      // Poll-gating state: tick counter for the play/settle fallback cadence
      // and the timestamp of the last Realtime event (phase change or live
      // score). While Realtime is flowing, the fallback fetches are skipped.
      this._pollTick = 0;
      this._lastRealtimeAt = 0;
      this._refreshingScores = false;
    }

    async onMount() {
      this._code = this._extractCode(this.params);
      this._popupShown = false;
      this._feedRefreshed = false;
      if (!this._code) {
        this._error = "No session code provided";
        this.render();
        return;
      }
      // The poll skips its ticks while the tab is hidden — fire one
      // immediate catch-up tick when it becomes visible again (only while
      // the poll is armed; finalize/abandon stop it). Auto-removed on
      // unmount via listenDom.
      this.listenDom("visibilitychange", () => {
        if (!document.hidden && this._pollHandle) this._poll(true);
      });
      await this._load();
      this._scrollToCurrentPhase(this._session && this._session.phase);
      this._startPolling();
      await this._subscribePhase();
      await this._maybeStartLiveScores();
    }

    async onParamsChange() {
      const next = this._extractCode(this.params);
      if (next === this._code) {
        this.render();
        return;
      }
      await this._teardown();
      this._code = next;
      this._session = null;
      this._popupShown = false;
      this._feedRefreshed = false;
      await this._load();
      this._scrollToCurrentPhase(this._session && this._session.phase);
      this._startPolling();
      await this._subscribePhase();
      await this._maybeStartLiveScores();
    }

    async onUnmount() {
      await this._teardown();
      if (window.PolaroidPopup) window.PolaroidPopup.dismiss();
    }

    async _teardown() {
      this._stopPolling();
      this._guideWidget = null;
      // Fire-and-forget Realtime cleanup so a stuck channel can't block
      // bottom-nav navigation. removeChannel awaits an unsubscribe ack that
      // may never arrive if the socket never reached READY.
      if (this._phaseOff) {
        const off = this._phaseOff;
        Promise.resolve().then(() => off()).catch(() => {});
      }
      this._phaseOff = null;
      if (this._liveOff) { try { this._liveOff(); } catch (_) {} }
      this._liveOff = null;
      if (this._liveScores) {
        const live = this._liveScores;
        Promise.resolve().then(() => live.stop()).catch(() => {});
      }
      this._liveScores = null;
    }

    _extractCode(params) {
      const raw = params && params.code;
      return raw ? String(raw).trim().toUpperCase() : null;
    }

    // ── Data ────────────────────────────────────────────────────────────────

    async _load() {
      this._loading = true;
      this._error = null;
      this.render();
      try {
        const session = await window.PlaySession.fetchLobby(this._code);
        this._session = session;
      } catch (e) {
        this._error = e.message || "Failed to load session";
      } finally {
        this._loading = false;
        this.render();
        this._handlePhaseSideEffects(this._session);
      }
    }

    _startPolling() {
      if (this._pollHandle || !this._code) return;
      this._pollHandle = setInterval(() => this._poll(), POLL_MS);
    }

    _stopPolling() {
      if (this._pollHandle) {
        clearInterval(this._pollHandle);
        this._pollHandle = null;
      }
    }

    async _poll(catchUp = false) {
      if (!this._code) return;
      // Hidden tab: skip the fetch — the visibilitychange listener (onMount)
      // fires one catch-up tick the moment the tab is visible again.
      if (document.hidden) return;
      const phase = this._session && this._session.phase;
      // Self-heal the live-scores channel. _subscribePhase() starts it when
      // the Realtime phase event lands, but a phase change the poll caught
      // instead (dropped socket, backgrounded tab, a channel that never
      // reached READY) used to leave the spectator on the Play screen with no
      // score channel at all — an empty grid and a frozen 0 total for the
      // rest of the game, because the fallback refresh below is itself gated
      // on _liveScores existing. Starting it here costs one guard per tick
      // and is idempotent.
      if (phase === "play" && !this._liveScores) await this._maybeStartLiveScores();
      if ((phase === "play" || phase === "settle") && !catchUp) {
        // During play/settle, Realtime (phase channel + live scores) carries
        // the updates and the poll is only a fallback: fetch every 5th tick
        // (10s), and only when no Realtime event landed within the last 10s.
        // Gather keeps the full 2s cadence — roster joins/leaves are
        // poll-only.
        //
        // Unless this spectator is on the seeded path: they joined after
        // Gather, so RLS hides the scores table from them and Realtime is
        // silent by construction. The poll IS their live scoring, and
        // standing it down would leave the grid frozen. Every other tick
        // (4s) — still half the Gather cadence.
        const seedOnly = this._liveScores && this._liveScores.isSeedOnly();
        this._pollTick++;
        if (seedOnly && phase === "play") {
          if (this._pollTick % 2 !== 0) return;
        } else {
          if (this._pollTick % 5 !== 0) return;
          if (Date.now() - this._lastRealtimeAt < 10000) return;
        }
      }
      // Realtime is the fast path for live scores, but it can drop an event
      // (backgrounded tab, socket hiccup). On fallback/catch-up ticks,
      // re-sync the scores table so a round the host added while Realtime
      // was asleep still surfaces. The refresh _emit()s through
      // _onLiveScoresChange(), which grows the grid if needed.
      if (this._liveScores && this._session && this._session.phase === "play") {
        this._refreshingScores = true;
        try { await this._liveScores.refresh(); }
        finally { this._refreshingScores = false; }
      }
      try {
        const next = await window.PlaySession.fetchLobby(this._code);
        const prev = this._session;
        const prevPhase = prev && prev.phase;
        const structural = this._structuralDiff(prev, next);
        const participantsOnly = !structural && this._participantsDiff(prev, next);
        this._session = next;
        // Every poll carries a fresh grid snapshot. For a late spectator this
        // is the only thing that moves their scoreboard, which is why the
        // play/settle gating above keeps letting a fetch through for them.
        this._seedLiveScores(next);
        if (structural) {
          this.render();
        } else if (participantsOnly) {
          // At a 2s cadence we cannot afford a full innerHTML rebuild of the
          // whole cascade on every roster change — it would yank scroll and
          // destroy DOM focus on the joiner's editable score input. Patch
          // just the participant surfaces in place instead.
          this._patchParticipants();
        }
        if (next.phase !== prevPhase) {
          this._handlePhaseSideEffects(next);
          // A phase change the poll caught (rather than Realtime) still moves
          // the spectator to the matching section, and still brings the score
          // channel up on the way into Play / down on the way out. The winner
          // popup reads the live totals, so this runs after the side effects
          // above, not before.
          this._scrollToCurrentPhase(next.phase);
          if (next.phase === "play") await this._maybeStartLiveScores();
          else await this._maybeStopLiveScores();
        }
      } catch (_) {
        // Best-effort; let Realtime handle the bulk of updates.
      }
    }

    _structuralDiff(prev, next) {
      if (!prev || !next) return true;
      if (prev.status !== next.status) return true;
      if (prev.phase !== next.phase) return true;
      if (prev.finalized_play_id !== next.finalized_play_id) return true;
      if (prev.game_id !== next.game_id) return true;
      return false;
    }

    _participantsDiff(prev, next) {
      const a = (prev && prev.participants) || [];
      const b = (next && next.participants) || [];
      if (a.length !== b.length) return true;
      for (let i = 0; i < a.length; i++) {
        if (a[i].id !== b[i].id) return true;
        if (a[i].user_id !== b[i].user_id) return true;
        if (a[i].display_name !== b[i].display_name) return true;
        const aa = a[i].avatar || null;
        const bb = b[i].avatar || null;
        if (JSON.stringify(aa) !== JSON.stringify(bb)) return true;
      }
      return false;
    }

    // Patches the participant lists in place — used when the only thing that
    // changed since the last poll is the roster. Avoids the scroll-yank +
    // input-focus loss that a full render() would cause at 2s cadence.
    _patchParticipants() {
      const s = this._session;
      if (!s) return;

      // Lobby (Gather screen) — re-render the whole Gather body. Handles
      // empty-state ↔ populated transitions cleanly (a single CSS selector
      // can't catch both shapes).
      const gatherScreen = this.container.querySelector("#screen-gather");
      if (gatherScreen) {
        gatherScreen.innerHTML = `
          ${this._renderHeaderRow("Gather", 1, "Waiting on the host")}
          ${this._renderGather(s)}
        `;
      }

      // Play screen — re-render the whole Play body, because the scoring
      // card's class set varies between the empty state and the populated
      // state, so a single CSS selector isn't reliable. Nothing here is
      // focusable, so the swap has no visible side effects.
      const playScreen = this.container.querySelector("#screen-play");
      const phase = s.phase || "gather";
      if (playScreen && (phase === "play" || phase === "settle")) {
        playScreen.innerHTML = `
          ${this._renderHeaderRow("Play", 2, this._headerHint(phase))}
          ${this._renderPlay(s)}
        `;
        this._mountReferenceGuide(s);
      }

      this.refreshIcons();
    }

    async _subscribePhase() {
      if (!this._session || !this._session.id) return;
      this._phaseOff = await window.SessionPhase.subscribe(
        this._session.id,
        async (phase) => {
          // Realtime is alive — the poll's play/settle fallback stands down.
          this._lastRealtimeAt = Date.now();
          const prevPhase = this._session && this._session.phase;
          // Patch the cached session in place so render() picks up the new
          // phase without waiting on the slow poll.
          if (this._session) this._session = { ...this._session, phase };
          this.render();
          this._handlePhaseSideEffects(this._session);
          // Scroll the joiner to the new section now that the phase has
          // actually changed (render() no longer does this on every paint).
          if (phase !== prevPhase) this._scrollToCurrentPhase(phase);
          // Lazy-start the live-scores channel when entering Play, lazy-
          // stop when leaving it (we don't need a live socket during Gather).
          if (phase === "play") await this._maybeStartLiveScores();
          if (phase === "settle" || phase === "finalized" || phase === "abandoned") {
            await this._maybeStopLiveScores();
          }
        }
      );
    }

    async _maybeStartLiveScores() {
      if (this._liveScores) return;
      if (!this._session || !this._session.id) return;
      if (this._session.phase !== "play") return;
      this._liveScores = new window.LiveScores({
        sessionId: this._session.id,
        isHost: false,
      });
      // Seed from the bundle we already hold before the channel's own read —
      // for a late spectator (no participant row, table hidden by RLS) it is
      // the only copy of the grid that will ever reach this screen.
      this._seedLiveScores(this._session);
      // Subscribe BEFORE start(). start() backfills the table and _emit()s
      // once when it's done; subscribing afterwards missed that emit, so a
      // spectator who arrived after the host had already scored kept staring
      // at the empty grid its first render painted until some later event
      // (the next host keystroke, or the 10s poll fallback) happened to fire.
      this._liveOff = this._liveScores.subscribe(() => {
        // Realtime is alive — the poll's play/settle fallback stands down.
        // Skip the stamp when the emit came from our own poll-triggered
        // refresh(), which would otherwise defer the next fallback forever.
        if (!this._refreshingScores) this._lastRealtimeAt = Date.now();
        this._onLiveScoresChange();
      });
      await this._liveScores.start();
    }

    // Live-scores tick. If the round count changed (the host added or removed
    // a round), re-render the scoring grid so the new rows appear; otherwise
    // just patch the totals row in place. Splitting these keeps the common
    // case (a score edit) cheap while still growing the grid when needed.
    _onLiveScoresChange() {
      const rounds = this._liveScores ? Math.max(1, this._liveScores.maxRound() + 1) : 1;
      if (rounds !== this._renderedRounds) {
        // Round count changed (host added/removed a round) — rebuild the rows.
        this._refreshScoringSection();
      } else {
        // Common case: a score changed. Patch the per-round cells in place so
        // other players' cells update too (not just the Total), without
        // disturbing the cell the joiner is currently typing in.
        this._patchScoringCells();
        this._refreshTotalsCells();
      }
    }

    // Re-render just the scoring card (cheaper than a full cascade render and
    // doesn't yank scroll).
    _refreshScoringSection() {
      const sec = this.container.querySelector(".cascade-card--scoring");
      if (!sec || !this._session) return;
      sec.outerHTML = this._renderViewerScoring(this._session);
      this.refreshIcons();
    }

    // Patch every per-round cell value in place from the live-scores overlay.
    // The widget keys cells by data-score-cell="i-r" where i is the column
    // (participant) index, so the two stay in step as long as the render and
    // the patch walk the same participants array.
    _patchScoringCells() {
      if (!this._session) return;
      const participants = this._session.participants || [];
      participants.forEach((p, i) => {
        for (let r = 0; r < this._renderedRounds; r++) {
          const el = this.container.querySelector(`.scoring-table [data-score-cell="${i}-${r}"]`);
          if (!el) continue;
          const text = this._cellValue({ participant_id: p.id }, r);
          if (el.textContent !== text) el.textContent = text;
        }
      });
    }

    // Hand the bundle's `scores` array (migration 054) to the live-scores
    // overlay. No-op for a spectator whose own table read works — LiveScores
    // ignores the seed from its first successful read onward.
    _seedLiveScores(session) {
      if (!this._liveScores || !session || !Array.isArray(session.scores)) return;
      // Any emit this triggers is our own poll's doing, not a Realtime event.
      // Flag it the same way the refresh() path does, or the poll's
      // "Realtime is alive, stand down" gate would be fooled by its own tick
      // and halve the only update cadence a late spectator has.
      this._refreshingScores = true;
      try { this._liveScores.seed(session.scores); }
      finally { this._refreshingScores = false; }
    }

    async _maybeStopLiveScores() {
      if (this._liveOff) this._liveOff();
      this._liveOff = null;
      if (this._liveScores) { try { await this._liveScores.stop(); } catch (_) {} }
      this._liveScores = null;
    }

    _handlePhaseSideEffects(session) {
      if (!session) return;
      if (session.status === "finalized" || session.phase === "finalized") {
        // The host's play is on the server now, and it belongs on this
        // viewer's feed too — but nothing on this device wrote it, so their
        // cached first page has no idea. Re-pull it here, behind the wrap-up
        // card, so closing that card lands on a feed that already carries the
        // game they just watched. Fire-and-forget and once only: the poll
        // stops right below, but a late tick must not restart the request.
        if (!this._feedRefreshed && window.Feed) {
          this._feedRefreshed = true;
          window.Feed.refreshFirstPage().catch(() => {});
        }
        // Once the host saves the play, swap the popup (if open) to a
        // "View play" CTA and leave the user on the cascade mirror until
        // they dismiss. If the popup never opened (e.g. they refreshed
        // post-save), route straight to the saved play.
        if (this._popupShown && session.finalized_play_id) {
          if (window.PolaroidPopup) window.PolaroidPopup.update({ playId: session.finalized_play_id });
        } else if (session.finalized_play_id) {
          // The legacy /play-detail page is gone. Pop the saved play
          // in-place; the user stays on the session viewer (or whatever
          // surface they were on) until they close the modal.
          if (window.PlayDetailPopup) window.PlayDetailPopup.show(session.finalized_play_id);
        }
        this._stopPolling();
        return;
      }
      if (session.phase === "settle" && !this._popupShown) {
        this._showWinnerPopup(session);
        this._popupShown = true;
        return;
      }
      if (session.status === "abandoned" || session.phase === "abandoned") {
        if (window.PolaroidPopup) window.PolaroidPopup.dismiss();
        this._stopPolling();
      }
    }

    _showWinnerPopup(session) {
      const game = session.game || {};
      const winner = this._guessWinnerName(session);
      window.PolaroidPopup.show({
        headline: "Well played!",
        gameName: game.name || "Game over",
        game: game,
        winnerName: winner,
      });
    }

    _guessWinnerName(session) {
      // The host's grid hasn't been finalized yet (settle isn't finalized),
      // so we don't have a server-side winner. Use the highest live total as
      // a best-guess; the popup updates with the real saved play once
      // phase=finalized arrives. Guests are in the running now that scores
      // are keyed by participant — skipping them used to hand the win to
      // whoever came second.
      if (!this._liveScores || !session) return null;
      const parts = session.participants || [];
      let best = null;
      let bestTotal = -Infinity;
      for (const p of parts) {
        const t = this._liveScores.totalFor(p.id, this._renderedRounds);
        if (t > bestTotal) {
          bestTotal = t;
          best = p.display_name;
        }
      }
      return best;
    }

    // ── Render ──────────────────────────────────────────────────────────────

    render() {
      const s = this._session;
      if (this._error && !s) {
        this.container.innerHTML = `
          <div class="session-viewer__shell">
            ${this._renderCrumbRow()}
            <div class="alert alert-error">${escapeHtml(this._error)}</div>
          </div>
        `;
        this.refreshIcons();
        return;
      }
      if (!s) {
        this.container.innerHTML = `
          <div class="session-viewer__shell">
            ${this._renderCrumbRow()}
            ${window.buddyLoader({ size: 96 })}
          </div>
        `;
        this.refreshIcons();
        return;
      }

      const phase = s.phase || "gather";
      // Lock every non-active screen to height: 0 (.is-locked) so the cascade
      // snaps to one screen at a time — mirrors the host's PlayFlowView
      // (play-flow-view.js:348-350). Previously only the Play/Settle screens
      // locked, so during Play both Gather (step 1) and Play (step 2) were
      // visible and the joiner scrolled between them.
      const lockGather = phase !== "gather";
      const lockPlay = phase !== "play";
      const lockSettle = phase !== "settle" && phase !== "finalized";

      this.container.innerHTML = `
        <section class="cascade-screen ${lockGather ? "is-locked" : ""}" id="screen-gather">
          ${this._renderHeaderRow("Gather", 1, "Waiting on the host")}
          ${this._renderGather(s)}
        </section>
        <section class="cascade-screen ${lockPlay ? "is-locked" : ""}" id="screen-play">
          ${this._renderHeaderRow("Play", 2, this._headerHint(phase))}
          ${this._renderPlay(s)}
        </section>
        <section class="cascade-screen ${lockSettle ? "is-locked" : ""}" id="screen-settle">
          ${this._renderHeaderRow("Settle Up", 3, "The host is wrapping up")}
          ${this._renderSettlePlaceholder()}
        </section>
      `;
      this.refreshIcons();
      if (phase === "play" || phase === "settle") this._mountReferenceGuide(s);
      // NOTE: do NOT call _scrollToCurrentPhase() here. At a 2s poll cadence
      // a render-time scroll yanks the user back to the top of the section
      // on every tick. Scroll is now invoked explicitly from onMount,
      // onParamsChange, and _subscribePhase when the phase actually changes.
      this._renderStatusBanner(s);
    }

    _headerHint(phase) {
      if (phase === "play") return "Live scoring";
      if (phase === "settle") return "Game wrapping up";
      return "Waiting on the host";
    }

    // Back row for the two states that have no cascade to hang a header on
    // (cold load and hard error). The live cascade puts the same affordance in
    // the screen header's left slot instead — see _renderHeaderRow.
    _renderCrumbRow() {
      const codeLabel = this._code || "";
      return `
        <div class="cascade-back-row">
          <button class="cascade-back" title="Back" onclick="window.router.back('feed')">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="cascade-back-row__title font-display">Session ${escapeHtml(codeLabel)}</h2>
          <span class="cascade-back-spacer"></span>
        </div>
      `;
    }

    // Same three-column grid the host's screen header uses, so the two sides of
    // a session read as the same screen. The host's left slot rolls the phase
    // backwards; the spectator doesn't own the phase, so theirs leaves the
    // session — which is also why this view no longer carries a separate crumb
    // bar above the cascade (the session code has its own card now).
    _renderHeaderRow(title, step, hint) {
      return `
        <header class="cascade-screen__header cascade-screen__header--read">
          <button class="cascade-back" title="Leave session"
                  onclick="window.router.back('feed')">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <div class="cascade-screen__header-body">
            <h1 class="cascade-screen__title">${escapeHtml(title)}</h1>
            <span class="cascade-screen__step">Step ${step} of 3 · ${escapeHtml(hint)}</span>
          </div>
          <span class="cascade-back-spacer"></span>
        </header>
      `;
    }

    _scrollToCurrentPhase(phase) {
      let id = "screen-gather";
      if (phase === "play") id = "screen-play";
      else if (phase === "settle" || phase === "finalized") id = "screen-settle";
      requestAnimationFrame(() => {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    // ── Section: Gather (read-only) ─────────────────────────────────────────

    // The game card, Gather only — it mirrors the host's own Gather step, down
    // to sitting above the session code. Play answers "what are we playing?"
    // with the game-info strip instead, which folds this card and the code card
    // below into one line (widgets/game-info-bar.js).
    _renderGameCard(s) {
      const game = s.game || null;
      const participants = s.participants || [];
      const host = participants.find((p) => p.user_id === s.host_user_id);
      const sub = host ? "Hosted by " + escapeHtml(host.display_name) : "";
      return `
        <section class="cascade-card">
          <label class="cascade-card__label">Game</label>
          <div class="cascade-game">
            ${game && game.thumbnail_url
              ? `<img class="cascade-game__thumb" src="${escapeAttr(game.thumbnail_url)}" alt="" />`
              : `<div class="cascade-game__thumb cascade-game__thumb--placeholder"><i data-icon="dice-6" class="w-5 h-5"></i></div>`}
            <div>
              <div class="cascade-game__name">${game ? escapeHtml(game.name) : "Waiting on host to pick a game"}</div>
              <div class="cascade-game__sub">${sub}</div>
            </div>
          </div>
        </section>
      `;
    }

    // Session code on Gather, in the same card the host reads it off
    // (play-flow-view's _renderInviteCard). The spectator's copy is what lets
    // them pass the code on to somebody else at the table — and it's why the
    // crumb bar that used to carry the code above the cascade is gone. Play
    // carries the code on the game-info strip instead.
    _renderInviteCard(s) {
      const code = (s && s.code) || this._code || null;
      if (!code) return "";
      return `
        <section class="cascade-card cascade-card--invite">
          <span class="cascade-invite__icon">
            <i data-icon="qr-code" class="w-4 h-4"></i>
          </span>
          <div class="cascade-invite__body">
            <span class="cascade-invite__title">Session code</span>
            <span class="cascade-invite__code">${escapeHtml(code)}</span>
          </div>
        </section>
      `;
    }

    /**
     * The Play step's header strip — the same widget the host renders
     * (play-flow-view's _renderGameInfoBar), so both sides of a session read
     * the game and the code off an identical line. On this side it replaces a
     * PAIR of cards: the "Now playing" game card and the session-code card
     * that used to sit under it.
     *
     * The spectator arrived by code, so the host-only offline / minting /
     * mint-failed states can't happen here — the bundle always carries one.
     *
     * @param {any} s Session bundle.
     * @returns {string}
     */
    _renderGameInfoBar(s) {
      return window.renderGameInfoBar({
        game: (s && s.game) || null,
        code: (s && s.code) || this._code || null,
      });
    }

    // Same rulebook CTA the host gets on their Play step (play-flow-view's
    // _renderPlay). The session bundle carries rulebook_url on its game, so
    // there was never a data reason for the spectator to go without it. No
    // rulebook on this game → no row at all, exactly as on the host side.
    _renderRulebookRow(s) {
      const url = s && s.game && s.game.rulebook_url;
      if (!url) return "";
      return `
        <div class="cascade-rulebook-row">
          <a href="${escapeAttr(url)}" target="_blank" rel="noopener"
             class="btn btn-outline btn-sm cascade-rulebook-cta">
            <i data-icon="book-open" class="w-4 h-4"></i>
            <span>Rulebook</span>
            <i data-icon="external-link" class="w-3.5 h-3.5"></i>
          </a>
        </div>
      `;
    }

    _renderGather(s) {
      const participants = s.participants || [];
      const hostId = s.host_user_id;
      return `
        ${this._renderGameCard(s)}

        ${this._renderInviteCard(s)}

        <section class="cascade-card">
          <label class="cascade-card__label">
            <i data-icon="users" class="w-3.5 h-3.5"></i>
            Lobby (${participants.length})
          </label>
          ${participants.length === 0
            ? `<div class="text-sm opacity-60">No players yet.</div>`
            : `<ul class="cascade-players cascade-players--read">
                 ${participants.map((p) => this._renderParticipantRow(p, hostId)).join("")}
               </ul>`}
        </section>
      `;
    }

    _renderParticipantRow(p, hostId) {
      const isHost = p.user_id && p.user_id === hostId;
      const me = window.store.get("user");
      const isMe = !!(p.user_id && me && p.user_id === me.id);
      // Ghosts have no user_id; real users get their customized badge.
      const badge = window.BgbBadge.render({
        avatar: p.avatar,
        displayName: p.display_name,
        size: "sm",
        isGhost: !p.user_id,
        isMe,
      });
      return `
        <li class="cascade-player cascade-player--read">
          ${badge}
          <span class="cascade-player__name">${escapeHtml(p.display_name)}</span>
          ${isHost
            ? `<span class="session-viewer__host-tag"><i data-icon="crown" class="w-3 h-3"></i> Host</span>`
            : ""}
        </li>
      `;
    }

    // ── Section: Play (read-mostly) ─────────────────────────────────────────

    _renderPlay(s) {
      if (!s.game_id) {
        return `<section class="cascade-card"><p class="text-sm opacity-70">Waiting on the host…</p></section>`;
      }
      // Scoring above the reference guide, mirroring the host's Play step
      // (play-flow-view.js _renderPlay) — a spectator is here to watch the
      // grid move, so it comes first and the guide is what they scroll to.
      return `
        ${this._renderGameInfoBar(s)}

        ${this._renderViewerScoring(s)}

        <section class="cascade-card cascade-card--guide">
          <label class="cascade-card__label">Reference guide</label>
          ${this._renderRulebookRow(s)}
          <div id="session-viewer-guide-mount" class="session-viewer__guide-mount"></div>
        </section>
      `;
    }

    // Render the scoreboard through the SAME shared widget the host uses
    // (widgets/round-score-grid.js), in its read-only mode — same columns,
    // same score font, same round labels, same Total row, just without the
    // input chrome and the host's add/remove/winner controls. Guests are in
    // here on equal terms: live scores are keyed by participant rather than
    // by account (migration 053), so a guest's column streams like anyone's.
    _renderViewerScoring(s) {
      const participants = s.participants || [];
      if (participants.length === 0) {
        return `<section class="cascade-card"><p class="text-sm opacity-70">No players yet — scores will appear once players join.</p></section>`;
      }
      // Round count is unknown to the spectator — fall back to the maximum
      // round_index we've seen in live scores so far, defaulting to 1. The
      // host writes a null placeholder row on _addRound (play-flow-view.js)
      // so an empty new round still grows maxRound() here.
      const maxRound = this._liveScores ? this._liveScores.maxRound() : -1;
      const rounds = Math.max(1, maxRound + 1);
      // Remember what we just sized the grid to, so the live-scores callback
      // can tell when the host added/removed a round and re-render the rows.
      this._renderedRounds = rounds;
      // Map participants into the widget's player shape. Cell values + totals
      // come from the live-scores overlay, not local roundScores.
      const players = participants.map((p) => ({
        name: p.display_name,
        participant_id: p.id,
        user_id: p.user_id,
        avatar: p.avatar,
        roundScores: [],
      }));
      const grid = window.renderRoundGrid(players, "sessionViewerView", {
        editable: false,
        roundCount: rounds,
        headerNames: true,
        getCellValue: (p, r) => this._cellValue(p, r),
      });
      return `
        <section class="cascade-card cascade-card--scoring">
          <label class="cascade-card__label">Scoring</label>
          <p class="session-viewer__scoring-hint">View only — the host is keeping score.</p>
          ${grid}
        </section>
      `;
    }

    // The spectator has no local roundScores — every cell it shows comes from
    // the live-scores overlay. One resolver, used by the grid render, the
    // in-place cell patch and the totals patch alike.
    _cellValue(player, roundIndex) {
      const v = this._liveScores
        ? this._liveScores.getScore(player.participant_id, roundIndex)
        : null;
      return v == null ? "" : String(v);
    }

    // Patch the per-player totals in place by column index. The totals row is
    // rendered by the shared widget (one .scoring-total span per participant,
    // in order), so we just refresh the numbers without rebuilding the row —
    // keeping the read/grey column classes the widget set on first paint.
    //
    // Summed through window.roundGridTotal over _renderedRounds — the same
    // helper and the same round range the widget used — so the patched number
    // still equals the cells above it. totalFor() alone would have counted
    // rounds outside the rendered grid.
    _refreshTotalsCells() {
      if (!this._session) return;
      const totals = this.container.querySelectorAll(".scoring-total-row .scoring-total");
      if (!totals.length) return;
      const participants = this._session.participants || [];
      participants.forEach((p, i) => {
        const span = totals[i];
        if (!span) return;
        const v = window.roundGridTotal(
          { participant_id: p.id },
          this._renderedRounds,
          (pl, r) => this._cellValue(pl, r)
        );
        const text = String(v);
        if (span.textContent !== text) span.textContent = text;
      });
    }

    // ── Section: Settle (placeholder until popup appears) ───────────────────

    _renderSettlePlaceholder() {
      return `
        <section class="cascade-card">
          <p class="text-sm opacity-80">
            <i data-icon="hourglass" class="w-4 h-4 inline align-middle"></i>
            The host is wrapping up. Hang tight…
          </p>
        </section>
      `;
    }

    _renderStatusBanner(s) {
      // Surface an inline message at the top of the cascade for terminal
      // states. Most other UI is driven by the popup or phase scrolling.
      if (s.status === "abandoned" || s.phase === "abandoned") {
        const banner = `
          <div class="session-viewer__status session-viewer__status--abandoned">
            <i data-icon="x-circle" class="w-4 h-4"></i>
            The host ended the session.
          </div>
        `;
        // The cascade no longer has an inner scroll wrapper — drop the
        // banner above the first cascade-screen so it reads at the top.
        const firstScreen = this.container.querySelector(".cascade-screen");
        if (firstScreen) firstScreen.insertAdjacentHTML("beforebegin", banner);
        this.refreshIcons();
      }
    }

    _mountReferenceGuide(session) {
      const s = session || this._session;
      if (!s || !s.game_id) {
        this._guideWidget = null;
        return;
      }
      const host = document.getElementById("session-viewer-guide-mount");
      if (!host) return;
      const gameName = (s.game && s.game.name) || "";
      const expansionMeta = { [s.game_id]: { name: gameName, color: null } };
      if (this._guideWidget && this._guideWidget._baseGameId !== s.game_id) {
        this._guideWidget = null;
      }
      if (!this._guideWidget) {
        this._guideWidget = new window.ReferenceGuideScroll({
          baseGameId: s.game_id,
          gameIds: [s.game_id],
          expansionMeta,
          defaultOpen: true,
        });
        this._guideWidget.mount(host);
      } else {
        this._guideWidget.mount(host);
        this._guideWidget.setExpansionMeta(expansionMeta);
      }
    }
  }

  window.SessionViewerView = SessionViewerView;
})();
