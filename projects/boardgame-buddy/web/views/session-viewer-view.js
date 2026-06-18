// views/session-viewer-view.js — Read-only cascade mirror for joiners.
//
// Mirrors the host's Gather → Play → Settle Up cascade in read-only mode.
// The joiner doesn't see Continue buttons — they auto-scroll forward as
// the host advances the phase via Realtime (SessionPhase channel). During
// the Play phase they can edit ONLY their own scoring column (LiveScores
// channel + RLS), and when the host moves to Settle Up they get a polaroid
// popup announcing the wrap-up.
//
// Polling stays around as a Realtime fallback: every 10–30s we re-fetch
// the lobby so a missed Realtime event doesn't leave the joiner stuck.

(function () {
  // Polling cadence matches the host's lobby poll (play-flow-view.js:124).
  // Realtime covers phase changes and live scores, but participant joins /
  // leaves and the host's roster edits are poll-only, so 2s is the minimum
  // freshness an authenticated joiner can expect for the player list.
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
    }

    async onMount() {
      this._code = this._extractCode(this.params);
      this._popupShown = false;
      if (!this._code) {
        this._error = "No session code provided";
        this.render();
        return;
      }
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

    async _poll() {
      if (!this._code) return;
      // Realtime is the fast path for live scores, but it can drop an event
      // (backgrounded tab, socket hiccup). Re-sync the scores table on every
      // poll tick during Play so a round the host added while Realtime was
      // asleep still surfaces within one tick (≤2s). The refresh _emit()s
      // through _onLiveScoresChange(), which grows the grid if needed.
      if (this._liveScores && this._session && this._session.phase === "play") {
        this._liveScores.refresh();
      }
      try {
        const next = await window.PlaySession.fetchLobby(this._code);
        const prev = this._session;
        const prevPhase = prev && prev.phase;
        const structural = this._structuralDiff(prev, next);
        const participantsOnly = !structural && this._participantsDiff(prev, next);
        this._session = next;
        if (structural) {
          this.render();
        } else if (participantsOnly) {
          // At a 2s cadence we cannot afford a full innerHTML rebuild of the
          // whole cascade on every roster change — it would yank scroll and
          // destroy DOM focus on the joiner's editable score input. Patch
          // just the participant surfaces in place instead.
          this._patchParticipants();
        }
        if (next.phase !== prevPhase) this._handlePhaseSideEffects(next);
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
      // empty-state ↔ populated transitions cleanly (single CSS selector
      // can't catch both shapes) and there's nothing focusable here for the
      // joiner, so a sub-section innerHTML swap has no visible side effects.
      const gatherScreen = this.container.querySelector("#screen-gather");
      if (gatherScreen) {
        gatherScreen.innerHTML = `
          ${this._renderHeaderRow("Gather", 1, "Waiting on the host")}
          ${this._renderGather(s)}
        `;
      }

      // Play screen — re-render the scoring + guide section while preserving
      // the user's focused input + cursor (the scoring table includes the
      // joiner's own editable score column). Re-render the whole Play body
      // because the scoring card's class set varies between the empty state
      // and the populated state, so a single CSS selector isn't reliable.
      const playScreen = this.container.querySelector("#screen-play");
      const phase = s.phase || "gather";
      if (playScreen && (phase === "play" || phase === "settle")) {
        const focused = this.container.querySelector("input.scoring-cell:focus");
        const snap = focused
          ? {
              cell: focused.getAttribute("data-score-cell"),
              selStart: focused.selectionStart,
              selEnd: focused.selectionEnd,
            }
          : null;
        playScreen.innerHTML = `
          ${this._renderHeaderRow("Play", 2, this._headerHint(phase))}
          ${this._renderPlay(s)}
        `;
        this._mountReferenceGuide(s);
        if (snap && snap.cell) {
          const restored = this.container.querySelector(
            `input.scoring-cell[data-score-cell="${snap.cell}"]`
          );
          if (restored) {
            restored.focus();
            try { restored.setSelectionRange(snap.selStart, snap.selEnd); } catch (_) {}
          }
        }
      }

      if (window.lucide) window.lucide.createIcons();
    }

    async _subscribePhase() {
      if (!this._session || !this._session.id) return;
      this._phaseOff = await window.SessionPhase.subscribe(
        this._session.id,
        async (phase) => {
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
      const me = window.store.get("user");
      this._liveScores = new window.LiveScores({
        sessionId: this._session.id,
        isHost: false,
        currentUserId: me ? me.id : null,
      });
      await this._liveScores.start();
      this._liveOff = this._liveScores.subscribe(() => this._onLiveScoresChange());
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
    // doesn't yank scroll). Preserves the joiner's focused score input + caret
    // across the swap, mirroring the snapshot pattern in _patchParticipants.
    _refreshScoringSection() {
      const sec = this.container.querySelector(".cascade-card--scoring");
      if (!sec || !this._session) return;
      const focused = this.container.querySelector("input.scoring-cell:focus");
      const snap = focused
        ? { cell: focused.getAttribute("data-score-cell"), selStart: focused.selectionStart, selEnd: focused.selectionEnd }
        : null;
      sec.outerHTML = this._renderViewerScoring(this._session);
      if (window.lucide) window.lucide.createIcons();
      if (snap && snap.cell) {
        const restored = this.container.querySelector(`input.scoring-cell[data-score-cell="${snap.cell}"]`);
        if (restored) {
          restored.focus();
          try { restored.setSelectionRange(snap.selStart, snap.selEnd); } catch (_) {}
        }
      }
    }

    // Patch every per-round cell value in place from the live-scores overlay,
    // skipping the input the joiner is currently editing (so their caret and
    // in-progress digits survive the Realtime echo). The widget keys cells by
    // data-score-cell="i-r" where i is the column (participant) index.
    _patchScoringCells() {
      if (!this._session) return;
      const focused = this.container.querySelector("input.scoring-cell:focus");
      const participants = this._session.participants || [];
      participants.forEach((p, i) => {
        for (let r = 0; r < this._renderedRounds; r++) {
          const el = this.container.querySelector(`.scoring-table [data-score-cell="${i}-${r}"]`);
          if (!el || el === focused) continue;
          const live = this._liveScores ? this._liveScores.getScore(p.user_id, r) : null;
          const text = live == null ? "" : String(live);
          if (el.tagName === "INPUT") {
            if (el.value !== text) el.value = text;
          } else if (el.textContent !== text) {
            el.textContent = text;
          }
        }
      });
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
        gameThumbnail: game.thumbnail_url || game.image_url || null,
        winnerName: winner,
      });
    }

    _guessWinnerName(session) {
      // The host's grid hasn't been finalized yet (settle isn't finalized),
      // so we don't have a server-side winner. Use the highest live total
      // among authed participants as a best-guess; the popup updates with
      // the real saved play once phase=finalized arrives.
      if (!this._liveScores || !session) return null;
      const parts = session.participants || [];
      let best = null;
      let bestTotal = -Infinity;
      for (const p of parts) {
        if (!p.user_id) continue;
        const t = this._liveScores.totalFor(p.user_id);
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
          ${this._renderTopbar(null)}
          <div class="p-6 alert alert-error">${escape(this._error)}</div>
        `;
        if (window.lucide) window.lucide.createIcons();
        return;
      }
      if (!s) {
        this.container.innerHTML = `
          ${this._renderTopbar(null)}
          ${window.buddyLoader({ size: 96 })}
        `;
        if (window.lucide) window.lucide.createIcons();
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
        ${this._renderTopbar(s)}
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
      if (window.lucide) window.lucide.createIcons();
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

    _renderTopbar(s) {
      const codeLabel = s ? s.code : (this._code || "");
      return `
        <header class="search-topbar">
          <button class="btn btn-ghost btn-sm" onclick="window.router.back('feed')">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="font-display font-semibold text-base play-detail__crumb">
            Session ${escape(codeLabel)}
          </h2>
          <span></span>
        </header>
      `;
    }

    _renderHeaderRow(title, step, hint) {
      return `
        <header class="cascade-screen__header cascade-screen__header--read">
          <span class="cascade-back-spacer"></span>
          <div class="cascade-screen__header-body">
            <h1 class="cascade-screen__title">${escape(title)}</h1>
            <span class="cascade-screen__step">Step ${step} of 3 · ${escape(hint)}</span>
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

    _renderGather(s) {
      const game = s.game || null;
      const participants = s.participants || [];
      const hostId = s.host_user_id;
      const host = participants.find((p) => p.user_id === hostId);
      return `
        <section class="cascade-card">
          ${game ? `
            <div class="cascade-game">
              ${game.thumbnail_url
                ? `<img class="cascade-game__thumb" src="${escapeAttr(game.thumbnail_url)}" alt="" />`
                : `<div class="cascade-game__thumb cascade-game__thumb--placeholder"><i data-lucide="dice-6" class="w-5 h-5"></i></div>`}
              <div>
                <div class="cascade-game__name">${escape(game.name)}</div>
                <div class="cascade-game__sub">${host ? "Hosted by " + escape(host.display_name) : ""}</div>
              </div>
            </div>
          ` : `
            <div class="cascade-game">
              <div class="cascade-game__thumb cascade-game__thumb--placeholder"><i data-lucide="dice-6" class="w-5 h-5"></i></div>
              <div>
                <div class="cascade-game__name">Waiting on host to pick a game</div>
                <div class="cascade-game__sub">${host ? "Hosted by " + escape(host.display_name) : ""}</div>
              </div>
            </div>
          `}
        </section>

        <section class="cascade-card">
          <label class="cascade-card__label">
            <i data-lucide="users" class="w-3.5 h-3.5"></i>
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
          <span class="cascade-player__name">${escape(p.display_name)}</span>
          ${isHost
            ? `<span class="session-viewer__host-tag"><i data-lucide="crown" class="w-3 h-3"></i> Host</span>`
            : ""}
        </li>
      `;
    }

    // ── Section: Play (read-mostly) ─────────────────────────────────────────

    _renderPlay(s) {
      if (!s.game_id) {
        return `<section class="cascade-card"><p class="text-sm opacity-70">Waiting on the host…</p></section>`;
      }
      return `
        <section class="cascade-card cascade-card--guide">
          <label class="cascade-card__label">Your reference guide</label>
          <div id="session-viewer-guide-mount" class="session-viewer__guide-mount"></div>
        </section>

        ${this._renderViewerScoring(s)}
      `;
    }

    // Render the joiner's scoreboard through the SAME shared widget the host
    // uses (widgets/round-score-grid.js) so the grid looks identical — only
    // the joiner's own column is editable; every other column renders greyed
    // out and read-only via the widget's viewer mode. Ghost (guest) players
    // appear too, but their scores aren't synced so their cells stay blank.
    _renderViewerScoring(s) {
      const participants = s.participants || [];
      if (participants.length === 0) {
        return `<section class="cascade-card"><p class="text-sm opacity-70">No players yet — scores will appear once players join.</p></section>`;
      }
      const me = window.store.get("user");
      const myId = me && me.id;
      // Round count is unknown to the joiner — fall back to the maximum
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
        user_id: p.user_id,
        avatar: p.avatar,
        roundScores: [],
      }));
      const grid = window.renderRoundGrid(players, "sessionViewerView", {
        editableColumnId: myId,
        roundCount: rounds,
        showSign: false,
        getCellValue: (p, r) => {
          const v = this._liveScores ? this._liveScores.getScore(p.user_id, r) : null;
          return v == null ? "" : String(v);
        },
        getPlayerTotal: (p) => (this._liveScores ? this._liveScores.totalFor(p.user_id) : 0),
      });
      return `
        <section class="cascade-card cascade-card--scoring">
          <label class="cascade-card__label">Scoring</label>
          ${grid}
        </section>
      `;
    }

    // Patch the per-player totals in place by column index. The totals row is
    // rendered by the shared widget (one .scoring-total span per participant,
    // in order), so we just refresh the numbers without rebuilding the row —
    // keeping the read/grey column classes the widget set on first paint.
    _refreshTotalsCells() {
      if (!this._session) return;
      const totals = this.container.querySelectorAll(".scoring-total-row .scoring-total");
      if (!totals.length) return;
      const participants = this._session.participants || [];
      participants.forEach((p, i) => {
        const span = totals[i];
        if (!span) return;
        const v = this._liveScores ? this._liveScores.totalFor(p.user_id) : 0;
        const text = String(v);
        if (span.textContent !== text) span.textContent = text;
      });
    }

    // The shared grid's editable cell calls window.sessionViewerView._setRoundScore.
    // Only the joiner's own column is editable, so every call maps to "my" score.
    _setRoundScore(playerIndex, roundIndex, value) {
      const clean = window.sanitizeRoundScore(value);
      // The text input doesn't auto-reject stray characters — write the
      // sanitized value back when they differ (e.g. a pasted letter),
      // preserving the caret. Mirrors play-flow-view._setRoundScore.
      const input = this.container.querySelector(`input[data-score-cell="${playerIndex}-${roundIndex}"]`);
      if (input && input.value !== clean) {
        const pos = input.selectionStart;
        input.value = clean;
        try { input.setSelectionRange(pos, pos); } catch (_) {}
      }
      this._setMyScore(roundIndex, clean);
    }

    async _setMyScore(roundIndex, value) {
      if (!this._liveScores) return;
      try {
        await this._liveScores.setMyScore(Number(roundIndex), value);
      } catch (e) {
        this._error = e.message || "Couldn't save score";
        this.render();
      }
    }

    // ── Section: Settle (placeholder until popup appears) ───────────────────

    _renderSettlePlaceholder() {
      return `
        <section class="cascade-card">
          <p class="text-sm opacity-80">
            <i data-lucide="hourglass" class="w-4 h-4 inline align-middle"></i>
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
            <i data-lucide="x-circle" class="w-4 h-4"></i>
            The host ended the session.
          </div>
        `;
        // The cascade no longer has an inner scroll wrapper — drop the
        // banner above the first cascade-screen so it reads at the top.
        const firstScreen = this.container.querySelector(".cascade-screen");
        if (firstScreen) firstScreen.insertAdjacentHTML("beforebegin", banner);
        if (window.lucide) window.lucide.createIcons();
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

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }
  function initialsOf(name) {
    const parts = (name || "").trim().split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  }

  window.SessionViewerView = SessionViewerView;
})();
