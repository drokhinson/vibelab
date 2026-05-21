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

(function () {
  class PlayFlowView extends window.View {
    constructor() {
      super("play-flow");
      this._ps = null;
      this._buddies = [];
      this._lobby = null;
      this._expansions = [];
      this._expansionsLoadedFor = null;
      this._expansionsOpen = false;
      this._guideWidget = null;
      this._liveScores = null;
      this._liveOff = null;
      this._error = null;
      this._saving = false;
      this._lobbyPoll = null;
      // Inline game-picker state. _recentGames caches the recently-played
      // seed list for the empty-input dropdown; _gameQueryToken increments
      // on every search so stale responses can be discarded. _gameBggMode
      // tracks whether the dropdown is currently showing BGG fallback hits.
      this._recentGames = null;
      this._gameQueryToken = 0;
      this._gameSearchTimer = null;
      this._gameBggMode = false;
    }

    async onMount() {
      // Sync setup + immediate paint. The persisted draft (game, players,
      // photo) renders without waiting on the network, so the user sees
      // their Gather screen the instant they tap Log. Async work (buddies,
      // expansions, lobby open, live-scores subscribe) folds in via a
      // second render() once it lands.
      const existing = window.PlaySession.load();
      this._ps = existing || new window.PlaySession();
      this._ensureSelfIncluded();
      window.store.set("activePlay", this._ps);

      this.listenDom("chapters-changed", () => {
        if (this._guideWidget) this._guideWidget.refresh();
      });

      this.render();

      const buddyPromise = window.Buddy.list().catch(() => []);
      const expansionsPromise = this._loadExpansionsIfNeeded();
      const lobbyPromise = this._ensureLobbyOpen();
      const [buddies] = await Promise.all([buddyPromise, expansionsPromise, lobbyPromise]);
      this._buddies = buddies;

      this.render();
      // Initial scroll to the live phase's section — render() no longer
      // does this on every paint (the poll-driven re-renders would yank
      // scroll back continuously), so do it here once on mount instead.
      this._scrollToCurrentPhase();
      this._startLobbyPoll();
      await this._startLiveScores();
      if (this._guideWidget) this._guideWidget.refresh();
    }

    async onUnmount() {
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

    async _ensureLobbyOpen() {
      // Already have a valid lobby in the persisted draft? Re-validate via
      // a fetch — if the server abandoned it we open a fresh one.
      if (this._ps.code) {
        try {
          const s = await window.PlaySession.fetchLobby(this._ps.code);
          if (s && s.status === "open" && s.phase && s.phase !== "abandoned") {
            this._lobby = s;
            this._ps.sessionId = s.id;
            this._ps.hostUserId = s.host_user_id;
            this._ps.phase = s.phase;
            this._ps.persist();
            return;
          }
        } catch (_) {
          // Stale — fall through and create a new one.
        }
      }
      try {
        const session = await window.PlaySession.openLobby({ gameId: this._ps.gameId });
        this._lobby = session;
        this._ps.code = session.code;
        this._ps.sessionId = session.id;
        this._ps.hostUserId = session.host_user_id;
        this._ps.phase = session.phase || "gather";
        this._ps.persist();
      } catch (e) {
        this._error = e.message || "Could not start a session";
      }
    }

    _startLobbyPoll() {
      if (this._lobbyPoll || !this._lobby) return;
      this._lobbyPoll = setInterval(async () => {
        if (!this._lobby) return;
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
            const known = new Set(
              this._ps.players.map((p) => (p.name || "").toLowerCase())
            );
            for (const part of nextParts) {
              const key = (part.display_name || "").toLowerCase();
              if (key && !known.has(key)) {
                this._ps.players.push({
                  name: part.display_name,
                  is_winner: false,
                  score: null,
                  user_id: part.user_id || null,
                });
                known.add(key);
                playersChanged = true;
              }
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
        } catch (_) {}
      }, 2000);
    }

    _refreshPlayersList() {
      const ul = this.container.querySelector(".cascade-players");
      if (!ul) return;
      ul.innerHTML = this._ps.players.map((p, i) => this._renderPlayerRow(p, i)).join("");
      if (window.lucide) window.lucide.createIcons();
    }

    _stopLobbyPoll() {
      if (this._lobbyPoll) {
        clearInterval(this._lobbyPoll);
        this._lobbyPoll = null;
      }
    }

    async _startLiveScores() {
      if (this._liveScores || !this._ps.sessionId) return;
      const me = window.store.get("user");
      this._liveScores = new window.LiveScores({
        sessionId: this._ps.sessionId,
        isHost: true,
        currentUserId: me ? me.id : null,
      });
      await this._liveScores.start();
      this._liveOff = this._liveScores.subscribe(() => this._refreshTotalsCells());
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
          ${this._renderContinue("Continue to Play", () => "_advanceToPlay()", { disabled: !this._ps.gameId })}
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
        ${this._error ? `<div class="alert alert-error cascade-error">${escape(this._error)}</div>` : ""}
      `;
      if (window.lucide) window.lucide.createIcons();
      this._mountReferenceGuide();
      // NOTE: do NOT call _scrollToCurrentPhase() here. render() runs every
      // 2s via the lobby poll and on every player edit — yanking the scroll
      // to the top of the active section made long Gather screens feel
      // un-scrollable. _scrollToCurrentPhase() is now only called when the
      // active phase actually changes (onMount, _advancePhase, _phaseBack).
    }

    _renderScreenHeader(title, step, showBack) {
      return `
        <header class="cascade-screen__header">
          ${showBack ? `
            <button class="cascade-back" title="Back"
                    onclick="window.playFlowView._phaseBack('${escapeAttr(title.toLowerCase())}')">
              <i data-lucide="chevron-up" class="w-4 h-4"></i>
            </button>
          ` : `<span class="cascade-back-spacer"></span>`}
          <div class="cascade-screen__header-body">
            <h1 class="cascade-screen__title">${escape(title)}</h1>
            <span class="cascade-screen__step">Step ${step} of 3</span>
          </div>
          <button class="cascade-screen__close" title="End session"
                  onclick="window.playFlowView._abandon()">
            <i data-lucide="x" class="w-4 h-4"></i>
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
            ${escape(label)}
            <i data-lucide="arrow-down" class="w-4 h-4"></i>
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
      // Session code surface. Rendered on Gather AND Play so the host can
      // always read the code aloud / share it (PR #274 allows late joiners
      // as spectators, so the lobby is effectively always "open"). Settle
      // Up drops it — the game is over.
      const code = this._lobby && this._lobby.code;
      return `
        <section class="cascade-card cascade-card--invite">
          <span class="cascade-invite__icon">
            <i data-lucide="qr-code" class="w-4 h-4"></i>
          </span>
          <div class="cascade-invite__body">
            <span class="cascade-invite__title">Session code</span>
            <span class="cascade-invite__code">${escape(code || "— — — — —")}</span>
          </div>
        </section>
      `;
    }

    _renderGather() {
      const ps = this._ps;
      const game = ps.gameSnapshot;
      return `
        ${this._renderInviteCard()}

        <section class="cascade-card">
          <label class="cascade-card__label">Game</label>
          ${game ? this._renderPickedGameChip() : `
            <div class="cascade-game-combo">
              <i data-lucide="search" class="w-4 h-4 cascade-game-combo__icon"></i>
              <input id="play-flow-game-input"
                     class="input input-bordered cascade-game-combo__input"
                     placeholder="Search for a game…"
                     autocomplete="off" autocapitalize="off" autocorrect="off"
                     oninput="window.playFlowView._onGameInput(this.value)"
                     onfocus="window.playFlowView._openGameDropdown()"
                     onblur="window.playFlowView._scheduleCloseGameDropdown()"
                     onkeydown="if(event.key==='Escape'){event.preventDefault();window.playFlowView._closeGameDropdown();}" />
              <ul id="play-flow-game-dropdown" class="cascade-game-dropdown hidden"
                  onmousedown="event.preventDefault()"></ul>
            </div>
          `}
        </section>

        ${this._renderExpansionsPicker()}

        ${this._renderPlayModeSelector()}

        <section class="cascade-card">
          <label class="cascade-card__label">Players</label>
          ${ps.players.length === 0 ? `<p class="text-sm opacity-60 mb-2">No players added yet.</p>` : ""}
          <ul class="cascade-players">
            ${ps.players.map((p, i) => this._renderPlayerRow(p, i)).join("")}
          </ul>
          <div class="cascade-player-add">
            <div class="cascade-buddy-combo">
              <input id="play-flow-buddy-input"
                     class="input input-bordered w-full"
                     placeholder="Add player (buddy or free-text)"
                     autocomplete="off"
                     oninput="window.playFlowView._onBuddyInput(this.value)"
                     onfocus="window.playFlowView._openBuddyDropdown()"
                     onblur="window.playFlowView._scheduleCloseBuddyDropdown()"
                     onkeydown="if(event.key==='Enter'){event.preventDefault();window.playFlowView._addPlayerFromInput();}else if(event.key==='Escape'){window.playFlowView._closeBuddyDropdown();}" />
              <ul id="play-flow-buddy-dropdown" class="cascade-buddy-dropdown hidden"
                  onmousedown="event.preventDefault()"></ul>
            </div>
            <button class="btn btn-primary" onclick="window.playFlowView._addPlayerFromInput()">Add</button>
          </div>
        </section>
      `;
    }

    _renderPlayModeSelector() {
      const mode = this._resolvePlayMode();
      const opt = (id, label, icon) => `
        <button class="play-mode-opt ${mode === id ? "is-active" : ""}"
                onclick="window.playFlowView._setPlayMode('${id}')">
          <i data-lucide="${icon}" class="w-4 h-4"></i>
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
      return `
        <li class="cascade-player">
          <span class="cascade-player__name">${escape(p.name)}</span>
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
            <i data-lucide="x" class="w-3.5 h-3.5"></i>
          </button>
        </li>
      `;
    }

    // ── Play screen ─────────────────────────────────────────────────────────

    _renderPlay() {
      if (!this._ps.gameId) {
        return `<section class="cascade-card"><p class="text-sm opacity-70">Pick a game on the Gather step first.</p></section>`;
      }
      const game = this._ps.gameSnapshot || {};
      const rulebookUrl = game.rulebook_url;
      const rulebookBtn = rulebookUrl
        ? `<a href="${escapeAttr(rulebookUrl)}" target="_blank" rel="noopener"
              class="btn btn-outline btn-sm cascade-rulebook-cta">
             <i data-lucide="book-open" class="w-4 h-4"></i>
             <span>Rulebook</span>
             <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
           </a>`
        : `<button class="btn btn-outline btn-sm cascade-rulebook-cta" disabled
              title="No rulebook available">
             <i data-lucide="book-open" class="w-4 h-4"></i>
             <span>Rulebook</span>
           </button>`;
      return `
        ${this._renderInviteCard()}
        <section class="cascade-card cascade-card--guide">
          <label class="cascade-card__label">Reference guide</label>
          <div class="cascade-rulebook-row">${rulebookBtn}</div>
          <div id="play-flow-guide-mount"></div>
        </section>
        ${this._renderScoringSection()}
      `;
    }

    _renderScoringSection() {
      const ps = this._ps;
      if (ps.players.length === 0) {
        return `<section class="cascade-card"><p class="text-sm opacity-70">Add players on the Gather step.</p></section>`;
      }
      const mode = this._resolvePlayMode();
      const roundCount = Math.max(0, ...ps.players.map((p) => (p.roundScores || []).length));
      const labelFor = (p) => p.initials || computeInitials(p.name);
      return `
        <section class="cascade-card cascade-card--scoring">
          <label class="cascade-card__label">Scoring</label>
          ${mode === "coop" ? this._renderCoopOutcome() : ""}
          <div class="scoring-table-wrap">
            <table class="scoring-table">
              <thead>
                <tr>
                  <th></th>
                  ${ps.players.map((p) => `<th class="scoring-head" title="${escapeAttr(p.name)}">${escape(labelFor(p))}</th>`).join("")}
                </tr>
              </thead>
              <tbody>
                ${Array.from({ length: roundCount }).map((_, r) => `
                  <tr>
                    <th class="scoring-round-th">
                      <span class="scoring-round-label">
                        <button class="scoring-round-remove" title="Remove round"
                                onclick="window.playFlowView._removeRoundAt(${r})">
                          <i data-lucide="x" class="w-3 h-3"></i>
                        </button>
                        R${r + 1}
                      </span>
                    </th>
                    ${ps.players.map((p, i) => `
                      <td>
                        <input type="number" inputmode="numeric"
                               class="scoring-cell"
                               value="${escapeAttr(this._cellValue(p, r))}"
                               oninput="window.playFlowView._setRoundScore(${i}, ${r}, this.value)" />
                      </td>
                    `).join("")}
                  </tr>
                `).join("")}
                <tr class="scoring-total-row">
                  <th>Total</th>
                  ${ps.players.map((p, i) => this._renderTotalsCell(p, i, mode, this._playerTotal(p))).join("")}
                </tr>
              </tbody>
            </table>
          </div>
          <div class="flex gap-2 mt-1">
            <button class="btn btn-ghost btn-xs" onclick="window.playFlowView._addRound()">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i> Round
            </button>
          </div>
        </section>
      `;
    }

    _cellValue(player, roundIndex) {
      // Prefer live-scoring source-of-truth (Realtime) when the player is
      // a real account; fall back to the local roundScores array.
      if (this._liveScores && player.user_id) {
        const live = this._liveScores.getScore(player.user_id, roundIndex);
        if (live != null) return String(live);
      }
      const local = player.roundScores && player.roundScores[roundIndex];
      return local != null ? String(local) : "";
    }

    _playerTotal(player) {
      if (this._liveScores && player.user_id) {
        const live = this._liveScores.totalFor(player.user_id);
        if (live > 0) return live;
      }
      return (player.roundScores || []).reduce((a, b) => a + (Number(b) || 0), 0);
    }

    _renderTotalsCell(p, i, mode, total) {
      if (mode === "coop") {
        return `<td class="${p.is_winner ? "scoring-total-cell--winner" : ""}">
          <div class="scoring-total-cell">
            <span class="scoring-total">${total}</span>
          </div>
        </td>`;
      }
      return `<td class="${p.is_winner ? "scoring-total-cell--winner" : ""}">
        <div class="scoring-total-cell">
          <button class="scoring-winner-btn ${p.is_winner ? "is-winner" : ""}"
                  title="${p.is_winner ? "Winner" : "Mark as winner"}"
                  onclick="window.playFlowView._toggleWinner(${i})">
            <i data-lucide="${p.is_winner ? "trophy" : "circle"}" class="w-4 h-4"></i>
          </button>
          <span class="scoring-total">${total}</span>
        </div>
      </td>`;
    }

    _renderCoopOutcome() {
      const players = this._ps.players;
      const won = players.length > 0 && players.every((p) => p.is_winner);
      return `
        <div class="coop-outcome">
          <button class="coop-outcome-btn ${won ? "is-winner" : ""}"
                  onclick="window.playFlowView._setCoopOutcome(${!won})">
            <i data-lucide="${won ? "trophy" : "circle"}" class="w-4 h-4"></i>
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

        <section class="cascade-card">
          <label class="cascade-card__label">Photo</label>
          ${url ? `
            <div class="cascade-photo">
              <img src="${escapeAttr(url)}" alt="Selected play photo" />
              <button class="btn btn-ghost btn-xs cascade-photo__remove"
                      onclick="window.playFlowView._clearPhoto()">
                <i data-lucide="x" class="w-3.5 h-3.5"></i> Remove
              </button>
            </div>
          ` : `
            <label class="cascade-photo__pick">
              <input type="file" accept="image/*" class="hidden"
                     onchange="window.playFlowView._onPhotoSelect(this.files && this.files[0])" />
              <i data-lucide="camera" class="w-5 h-5"></i>
              <span>Tap to add photo (optional)</span>
            </label>
          `}
        </section>

        <section class="cascade-card">
          <label class="cascade-card__label">Key moments</label>
          <textarea class="textarea textarea-bordered w-full cascade-notes"
                    rows="4"
                    placeholder="A clutch play, a surprise comeback, anything worth remembering."
                    onchange="window.playFlowView._setNotes(this.value)">${escape(this._ps.notes || "")}</textarea>
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
            <i data-lucide="check" class="w-4 h-4"></i>
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
      if (!this._lobby || !this._lobby.code) {
        this._error = "Session not ready yet.";
        this.render();
        return;
      }
      // Optimistic: flip the phase locally and repaint immediately so the
      // user sees the section transition without waiting on the server
      // round-trip. The PATCH happens in the background; on failure we
      // surface the error and roll the phase back. This also keeps the
      // Continue/Wrap-up/back-arrow taps feeling instant on a slow link.
      const prevPhase = this._ps.phase;
      this._ps.phase = next;
      this._ps.persist();
      this.render();
      this._scrollToCurrentPhase();
      try {
        const updated = await window.PlaySession.advancePhase(this._lobby.code, next);
        this._lobby = updated;
        if (updated.phase && updated.phase !== this._ps.phase) {
          // Server overrode (shouldn't normally happen). Sync local view.
          this._ps.phase = updated.phase;
          this._ps.persist();
          this.render();
        }
      } catch (e) {
        this._ps.phase = prevPhase;
        this._ps.persist();
        this._error = e.message || "Could not advance to the next screen";
        this.render();
        this._scrollToCurrentPhase();
      }
    }

    async _abandon() {
      const ok = await window.PolaroidPopup.confirm({
        title: "Discard this play?",
        body: "Players in the lobby will be kicked and any scores so far will be lost. This can't be undone.",
        confirmLabel: "Discard",
        cancelLabel: "Keep playing",
      });
      if (!ok) return;
      // Tear down locally and navigate FIRST so the UI always responds.
      // The server-side abandon is fire-and-forget — a slow or hung PATCH
      // shouldn't strand the user on the gather screen.
      const code = this._lobby && this._lobby.code;
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
            : `<div class="cascade-game-chip__thumb cascade-game-chip__thumb--placeholder"><i data-lucide="dice-6"></i></div>`}
          <div class="cascade-game-chip__name">${escape(game.name)}</div>
          <button class="cascade-game-chip__clear" type="button"
                  title="Change game" aria-label="Clear pick"
                  onclick="window.playFlowView._clearGamePick()">
            <i data-lucide="x" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      `;
    }

    _clearGamePick() {
      const ps = this._ps;
      if (!ps) return;
      ps.gameId = null;
      ps.gameSnapshot = null;
      ps.persist();
      // Push the clear to the lobby so joiners' read-only mirrors drop the
      // game pick alongside the host.
      if (ps.code) {
        window.PlaySession.updateLobby(ps.code, { gameId: null }).catch(() => {});
      }
      // Invalidate any in-flight search; the input is about to come back.
      this._gameQueryToken++;
      this.render();
      // Focus the freshly-rendered search input so the user lands ready to
      // type their next pick — no extra tap to refocus.
      requestAnimationFrame(() => {
        const input = document.getElementById("play-flow-game-input");
        if (input) input.focus();
      });
    }

    // Inline picker. The dropdown is the only DOM that gets mutated as the
    // user types — the <input> node stays put across every render, so the
    // OS caret never moves and focus is preserved.
    _onGameInput(value) {
      clearTimeout(this._gameSearchTimer);
      const q = (value || "").trim();
      // Empty: snap back to the recently-played seed list immediately.
      if (!q) {
        this._gameBggMode = false;
        this._renderGameDropdown("");
        return;
      }
      // Debounce 180ms so a fast typer doesn't fire one query per keystroke.
      this._gameSearchTimer = setTimeout(() => {
        this._gameBggMode = false;
        this._renderGameDropdown(q);
      }, 180);
    }

    async _openGameDropdown() {
      // First focus path: lazy-load the recently-played seed list. Cached
      // for the lifetime of the mount; mostly stable because plays only
      // get added at finalize time.
      if (this._recentGames === null) {
        try {
          this._recentGames = await window.Game.recentlyPlayed(6);
        } catch (_) {
          this._recentGames = [];
        }
      }
      const input = document.getElementById("play-flow-game-input");
      const q = input ? (input.value || "").trim() : "";
      this._renderGameDropdown(q);
    }

    _scheduleCloseGameDropdown() {
      setTimeout(() => this._closeGameDropdown(), 200);
    }

    _closeGameDropdown() {
      const dd = document.getElementById("play-flow-game-dropdown");
      if (dd) {
        dd.classList.add("hidden");
        dd.innerHTML = "";
      }
    }

    async _renderGameDropdown(query) {
      const dd = document.getElementById("play-flow-game-dropdown");
      if (!dd) return;
      const q = (query || "").trim();
      const token = ++this._gameQueryToken;

      // Empty query → recently-played seed list (or hint if none).
      if (!q) {
        const list = this._recentGames || [];
        if (list.length === 0) {
          dd.innerHTML = `<li class="cascade-game-dropdown__hint">Type a game name to search.</li>`;
        } else {
          dd.innerHTML =
            `<li class="cascade-game-dropdown__header">Recently played</li>` +
            list.map((g) => this._renderGameDropdownRow(g)).join("");
        }
        dd.classList.remove("hidden");
        if (window.lucide) window.lucide.createIcons();
        return;
      }

      // Non-empty query → unified search (collection + DB hits).
      dd.innerHTML = `<li class="cascade-game-dropdown__hint">Searching…</li>`;
      dd.classList.remove("hidden");
      let data;
      try {
        data = await window.Game.search(q);
      } catch (_) {
        if (token !== this._gameQueryToken) return;
        dd.innerHTML = `<li class="cascade-game-dropdown__hint">Search failed. Try again.</li>`;
        return;
      }
      if (token !== this._gameQueryToken) return;
      const hits = (data && data.results) || [];
      if (hits.length === 0) {
        // Empty → offer BGG extension.
        dd.innerHTML = `
          <li class="cascade-game-dropdown__hint">No matches in your library.</li>
          <li class="cascade-game-dropdown-item cascade-game-dropdown-item--bgg"
              onclick="window.playFlowView._runBggFromDropdown('${jsStr(q)}')">
            <i data-lucide="search" class="w-4 h-4"></i>
            <span>Search BoardGameGeek for "${escape(q)}"</span>
          </li>`;
        if (window.lucide) window.lucide.createIcons();
        return;
      }
      dd.innerHTML = hits.map((h) => this._renderGameDropdownRow(h.game)).join("");
      if (window.lucide) window.lucide.createIcons();
    }

    _renderGameDropdownRow(game) {
      const meta = [
        game.year_published,
        game.min_players ? `${game.min_players}${game.max_players && game.max_players !== game.min_players ? "–" + game.max_players : ""}P` : null,
        game.playing_time ? `${game.playing_time}m` : null,
      ].filter(Boolean).join(" · ");
      return `
        <li class="cascade-game-dropdown-item"
            onclick="window.playFlowView._pickGameById('${jsStr(game.id)}')">
          ${game.thumbnail_url
            ? `<img class="cascade-game-dropdown-item__thumb" src="${escapeAttr(game.thumbnail_url)}" alt="" loading="lazy" />`
            : `<div class="cascade-game-dropdown-item__thumb cascade-game-dropdown-item__thumb--placeholder"><i data-lucide="dice-6"></i></div>`}
          <div class="cascade-game-dropdown-item__body">
            <div class="cascade-game-dropdown-item__name">${escape(game.name)}</div>
            ${meta ? `<div class="cascade-game-dropdown-item__meta">${escape(meta)}</div>` : ""}
          </div>
        </li>
      `;
    }

    async _runBggFromDropdown(q) {
      const dd = document.getElementById("play-flow-game-dropdown");
      if (!dd) return;
      this._gameBggMode = true;
      const token = ++this._gameQueryToken;
      dd.innerHTML = `<li class="cascade-game-dropdown__hint">Searching BoardGameGeek…</li>`;
      dd.classList.remove("hidden");
      let data;
      try {
        data = await window.Game.search(q, { includeBgg: true });
      } catch (_) {
        if (token !== this._gameQueryToken) return;
        dd.innerHTML = `<li class="cascade-game-dropdown__hint">BoardGameGeek search failed.</li>`;
        return;
      }
      if (token !== this._gameQueryToken) return;
      const bgg = (data && data.bgg_results) || [];
      if (bgg.length === 0) {
        dd.innerHTML = `<li class="cascade-game-dropdown__hint">No BoardGameGeek matches.</li>`;
        return;
      }
      dd.innerHTML =
        `<li class="cascade-game-dropdown__header">From BoardGameGeek</li>` +
        bgg.map((hit) => `
          <li class="cascade-game-dropdown-item cascade-game-dropdown-item--bgg"
              data-bgg-id="${hit.bgg_id}"
              onclick="window.playFlowView._importBggInDropdown(${hit.bgg_id}, '${jsStr(hit.name)}')">
            <div class="cascade-game-dropdown-item__thumb cascade-game-dropdown-item__thumb--placeholder">
              <i data-lucide="dice-6"></i>
            </div>
            <div class="cascade-game-dropdown-item__body">
              <div class="cascade-game-dropdown-item__name">${escape(hit.name)}</div>
              <div class="cascade-game-dropdown-item__meta">
                ${[hit.year_published, hit.is_expansion ? "Expansion" : null].filter(Boolean).join(" · ")}
                ${hit.already_in_db ? " · In library" : ""}
              </div>
            </div>
            <button class="btn btn-ghost btn-xs cascade-game-dropdown-item__action">
              ${hit.already_in_db ? "Pick" : "Import"}
            </button>
          </li>
        `).join("");
      if (window.lucide) window.lucide.createIcons();
    }

    async _importBggInDropdown(bggId, name) {
      const dd = document.getElementById("play-flow-game-dropdown");
      if (!dd) return;
      const row = dd.querySelector(`li[data-bgg-id="${bggId}"]`);
      if (row) {
        const body = row.querySelector(".cascade-game-dropdown-item__body");
        if (body) {
          body.innerHTML = `
            <div class="cascade-game-dropdown-item__name">${escape(name)}</div>
            <div class="cascade-game-dropdown-item__meta">Importing from BoardGameGeek…</div>
          `;
        }
        const action = row.querySelector(".cascade-game-dropdown-item__action");
        if (action) { action.disabled = true; action.textContent = "…"; }
      }
      try {
        const game = await window.Game.importBgg(bggId);
        if (!document.getElementById("play-flow-game-input")) return; // view unmounted mid-import
        if (game && game.is_expansion) {
          if (row) {
            const body = row.querySelector(".cascade-game-dropdown-item__body");
            if (body) {
              body.innerHTML = `
                <div class="cascade-game-dropdown-item__name">${escape(name)}</div>
                <div class="cascade-game-dropdown-item__meta">Pick a base game; expansions attach later.</div>
              `;
            }
            const action = row.querySelector(".cascade-game-dropdown-item__action");
            if (action) action.remove();
          }
          return;
        }
        this._applyGamePick(game);
      } catch (e) {
        if (!document.getElementById("play-flow-game-input")) return;
        if (row) {
          const body = row.querySelector(".cascade-game-dropdown-item__body");
          if (body) {
            body.innerHTML = `
              <div class="cascade-game-dropdown-item__name">${escape(name)}</div>
              <div class="cascade-game-dropdown-item__meta">Import failed. Try again.</div>
            `;
          }
          const action = row.querySelector(".cascade-game-dropdown-item__action");
          if (action) { action.disabled = false; action.textContent = "Retry"; }
        }
      }
    }

    async _pickGameById(gameId) {
      // Look it up in any of the dropdown sources we know about. If the
      // user picked a search hit we may not have it cached locally; in
      // that case fall through to a single GET.
      let game = (this._recentGames || []).find((g) => g.id === gameId);
      if (!game) {
        try {
          game = await window.api.get(`/games/${gameId}`);
        } catch (_) { return; }
      }
      this._applyGamePick(game);
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
      // Push the pick to the lobby so joiners' read-only mirrors swap too.
      if (ps.code) {
        window.PlaySession.updateLobby(ps.code, { gameId: game.id }).catch(() => {});
      }
      // The combo + dropdown disappear once a game is picked — the user
      // changes the pick by tapping the chip's × (which clears state and
      // re-renders the search input). Cancel any in-flight search so a
      // late response can't sneak back into a dropdown that no longer
      // exists, then render the chip and load expansions.
      this._gameQueryToken++;
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
      this.render();
    }

    // ── Players ─────────────────────────────────────────────────────────────

    _addPlayerFromInput() {
      const input = document.getElementById("play-flow-buddy-input");
      const name = (input.value || "").trim();
      if (!name) return;
      const buddy = (this._buddies || []).find(
        (b) => b.other_display_name.toLowerCase() === name.toLowerCase()
      );
      this._addPlayer({ name, user_id: buddy ? buddy.other_user_id : null });
    }

    _addPlayer({ name, user_id }) {
      const exists = this._ps.players.some(
        (p) => (p.name || "").toLowerCase() === (name || "").toLowerCase()
      );
      if (!exists) {
        const currentRounds = Math.max(0, ...this._ps.players.map((p) => (p.roundScores || []).length));
        this._ps.players.push({
          name,
          is_winner: false,
          score: null,
          user_id: user_id || null,
          roundScores: Array(currentRounds).fill(null),
        });
        this._ps.persist();
      }
      this._closeBuddyDropdown();
      this.render();
    }

    _removePlayer(i) {
      this._ps.players.splice(i, 1);
      this._ps.persist();
      this._autoSelectWinners();
      this.render();
    }

    _setInitials(i, value) {
      const p = this._ps.players[i];
      if (!p) return;
      p.initials = String(value || "").replace(/\s+/g, "").slice(0, 3).toUpperCase();
      this._ps.persist();
      const heads = this.container.querySelectorAll(".scoring-head");
      const label = p.initials || computeInitials(p.name);
      if (heads[i]) heads[i].textContent = label;
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
      for (const p of this._ps.players) {
        if (!Array.isArray(p.roundScores)) p.roundScores = [];
        p.roundScores.push(null);
      }
      this._ps.persist();
      this._autoSelectWinners();
      this.render();
    }

    _removeRoundAt(r) {
      let removed = false;
      for (const p of this._ps.players) {
        if (Array.isArray(p.roundScores) && r >= 0 && r < p.roundScores.length) {
          p.roundScores.splice(r, 1);
          removed = true;
        }
      }
      if (removed) {
        this._ps.persist();
        this._autoSelectWinners();
        this.render();
      }
    }

    async _setRoundScore(playerIndex, roundIndex, value) {
      const p = this._ps.players[playerIndex];
      if (!p) return;
      if (!Array.isArray(p.roundScores)) p.roundScores = [];
      p.roundScores[roundIndex] = value === "" ? null : Number(value);
      this._ps.persist();
      // Mirror authed-player edits into the live-scores table so joiners
      // see the host's override. Guest players stay local-only.
      if (this._liveScores && p.user_id) {
        try {
          await this._liveScores.setAnyScore(p.user_id, roundIndex, p.roundScores[roundIndex]);
        } catch (_) {}
      }
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
      if (window.lucide) window.lucide.createIcons();
    }

    _autoSelectWinners() {
      const ps = this._ps;
      if (!ps || !ps.players || ps.players.length === 0) return;
      if (this._resolvePlayMode() === "coop") return;
      const totals = ps.players.map((p) => this._playerTotal(p));
      if (totals.every((t) => t === 0)) return;
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
        ps.players.forEach((p, i) => {
          p.is_winner = groupTotals.get(groupKey(p, i)) === max;
        });
      } else {
        const max = Math.max(...totals);
        ps.players.forEach((p, i) => { p.is_winner = totals[i] === max; });
      }
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
      this.render();
    }

    _setCoopOutcome(won) {
      for (const p of this._ps.players) p.is_winner = !!won;
      this._ps.persist();
      this.render();
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
      const snap = this._ps.gameSnapshot;
      if (snap && snap.is_expansion) {
        this._expansions = [];
        this._expansionsLoadedFor = gameId;
        return;
      }
      try {
        const list = await window.api.get(`/games/${gameId}/expansions`);
        this._expansions = Array.isArray(list) ? list : [];
      } catch (_) {
        this._expansions = [];
      }
      this._expansionsLoadedFor = gameId;
      const valid = new Set(this._expansions.map((e) => e.expansion_game_id));
      const before = (this._ps.expansionIds || []).length;
      this._ps.expansionIds = (this._ps.expansionIds || []).filter((id) => valid.has(id));
      if (this._ps.expansionIds.length !== before) this._ps.persist();
    }

    _renderExpansionsPicker() {
      // Always render the card so hosts know the section exists. When
      // there's nothing to pick (no game yet, the game is itself an
      // expansion, or the game has no expansions), show a greyed-out
      // placeholder with explanatory copy. Once a base game with
      // expansions is selected the card becomes interactive and starts
      // collapsed; the user taps the header to expand the list.
      const snap = this._ps.gameSnapshot;
      let disabledHint = null;
      if (!this._ps.gameId) {
        disabledHint = "Pick a game first to choose expansions.";
      } else if (snap && snap.is_expansion) {
        disabledHint = "This game is itself an expansion.";
      } else if (!this._expansions || this._expansions.length === 0) {
        disabledHint = "No expansions for this game.";
      }
      if (disabledHint) {
        return `
          <section class="cascade-card cascade-card--expansions is-disabled" aria-disabled="true">
            <div class="collapsible-header collapsible-header--static">
              <span class="collapsible-header__title">
                <i data-lucide="puzzle" class="w-4 h-4"></i>
                Expansions
              </span>
              <i data-lucide="chevron-right" class="w-4 h-4 collapsible-header__chev"></i>
            </div>
            <p class="cascade-card__hint">${escape(disabledHint)}</p>
          </section>
        `;
      }
      const open = !!this._expansionsOpen;
      const chevron = open ? "chevron-down" : "chevron-right";
      const selected = (this._ps.expansionIds || []).length;
      return `
        <section class="cascade-card cascade-card--expansions">
          <button class="collapsible-header" aria-expanded="${open}"
                  onclick="window.playFlowView._toggleExpansionsPicker()">
            <span class="collapsible-header__title">
              <i data-lucide="puzzle" class="w-4 h-4"></i>
              Expansions${selected ? ` (${selected} selected)` : ""}
            </span>
            <i data-lucide="${chevron}" class="w-4 h-4 collapsible-header__chev"></i>
          </button>
          ${open ? `
            <ul class="expansion-list cascade-exp-list">
              ${this._expansions.map((e) => this._renderExpansionPickerRow(e)).join("")}
            </ul>
          ` : ""}
        </section>
      `;
    }

    _renderExpansionPickerRow(e) {
      const active = (this._ps.expansionIds || []).includes(e.expansion_game_id);
      return `
        <li class="expansion-list__row cascade-exp-row ${active ? "is-active" : ""}"
            onclick="window.playFlowView._toggleExpansion('${e.expansion_game_id}')"
            style="--exp-color:${e.color || "#C9922A"}">
          <span class="expansion-list__dot"></span>
          ${e.thumbnail_url
            ? `<img src="${escapeAttr(e.thumbnail_url)}" alt="" class="expansion-list__thumb" loading="lazy" />`
            : `<div class="expansion-list__thumb expansion-list__thumb--placeholder"><i data-lucide="dice-6"></i></div>`}
          <div class="expansion-list__body">
            <div class="expansion-list__name">${escape(e.name)}</div>
          </div>
          <span class="cascade-exp-toggle ${active ? "cascade-exp-toggle--on" : ""}">
            <i data-lucide="${active ? "check" : "plus"}" class="w-4 h-4"></i>
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
      this.render();
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
      const gameIds = [this._ps.gameId, ...(this._ps.expansionIds || [])];
      if (this._guideWidget && this._guideWidget._baseGameId !== this._ps.gameId) {
        this._guideWidget = null;
      }
      if (!this._guideWidget) {
        this._guideWidget = new window.ReferenceGuideScroll({
          baseGameId: this._ps.gameId,
          gameIds,
          expansionMeta: meta,
          onAfterMutate: () => this.render(),
          defaultOpen: true,
        });
        this._guideWidget.mount(host);
      } else {
        this._guideWidget.mount(host);
        this._guideWidget.setExpansionMeta(meta);
        this._guideWidget.setGameIds(gameIds);
      }
    }

    // ── Photo ───────────────────────────────────────────────────────────────

    _onPhotoSelect(file) {
      if (!file) return;
      this._clearPhoto({ keepRender: true });
      this._ps.photoFile = file;
      this._ps.photoPreviewUrl = URL.createObjectURL(file);
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

    // ── Buddy combo ────────────────────────────────────────────────────────

    _onBuddyInput(value) {
      this._renderBuddyDropdown(value);
    }

    _openBuddyDropdown() {
      const input = document.getElementById("play-flow-buddy-input");
      this._renderBuddyDropdown(input ? input.value : "");
    }

    _scheduleCloseBuddyDropdown() {
      setTimeout(() => this._closeBuddyDropdown(), 150);
    }

    _closeBuddyDropdown() {
      const dd = document.getElementById("play-flow-buddy-dropdown");
      if (dd) {
        dd.classList.add("hidden");
        dd.innerHTML = "";
      }
    }

    _renderBuddyDropdown(query) {
      const dd = document.getElementById("play-flow-buddy-dropdown");
      if (!dd) return;
      const q = (query || "").trim().toLowerCase();
      const already = new Set(this._ps.players.map((p) => (p.name || "").toLowerCase()));
      const filtered = (this._buddies || [])
        .filter((b) => {
          const name = (b.other_display_name || "").toLowerCase();
          if (already.has(name)) return false;
          if (!q) return true;
          return name.includes(q);
        })
        .slice(0, 8);
      if (filtered.length === 0) {
        dd.classList.add("hidden");
        dd.innerHTML = "";
        return;
      }
      dd.innerHTML = filtered.map((b) => `
        <li class="cascade-buddy-dropdown-item"
            onclick="window.playFlowView._addPlayer({name:'${escapeAttr(b.other_display_name)}', user_id:'${escapeAttr(b.other_user_id)}'})">
          <span class="avatar-bubble avatar-bubble--xs">${escape(initialsOf(b.other_display_name))}</span>
          <span class="cascade-buddy-dropdown-name">${escape(b.other_display_name)}</span>
        </li>
      `).join("");
      dd.classList.remove("hidden");
    }

    // ── Save ───────────────────────────────────────────────────────────────

    async _save() {
      if (!this._ps.gameId) {
        this._error = "Pick a game first.";
        this.render();
        return;
      }
      this._saving = true;
      this.render();
      try {
        if (this._ps.photoFile) {
          try {
            const fd = new FormData();
            fd.append("file", this._ps.photoFile);
            const resp = await window.api.upload("/plays/photo", fd);
            if (resp && resp.photo_url) this._ps.photoUrl = resp.photo_url;
          } catch (e) {
            this._error = "Photo upload failed: " + (e.message || "");
            this._saving = false;
            this.render();
            return;
          }
        }
        const payload = this._ps.toPlayCreate();
        if (this._lobby && this._lobby.code) {
          await window.PlaySession.finalizeLobby(this._lobby.code, payload);
        } else {
          await window.Play.create(payload);
        }
        this._ps.clear();
        window.store.set("activePlay", null);
        window.store.invalidate("feed");
        window.router.go("feed");
      } catch (e) {
        this._error = e.message || "Failed to save";
      } finally {
        this._saving = false;
        this.render();
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

  window.PlayFlowView = PlayFlowView;
})();
