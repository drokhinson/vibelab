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
      this._ghosts = [];
      this._recent = [];
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
      // Counts in-flight participant DELETEs. While > 0 the lobby poll
      // skips its tick — see _startLobbyPoll. Prevents the brief window
      // between optimistic local removal and server confirmation from
      // snapping the player back into the grid via a stale poll.
      this._pendingDeletes = 0;
      // Monotonic token for phase-change PATCHes. After a call's PATCH
      // resolves it only reconciles state if it is still the latest — a
      // stale earlier PATCH resolving after a newer navigation must not yank
      // the phase back (the rapid-tap "jump back to a previous screen" bug).
      this._phaseSeq = 0;
      // Counts in-flight phase PATCHes. While > 0 the lobby poll skips its
      // tick so it can't clobber this._lobby (incl. a stale phase) mid
      // transition. Mirrors _pendingDeletes.
      this._pendingPhase = 0;
      this._buddyInputTimer = null;
      // GameFinder widget instance, lazily constructed in render() when the
      // Gather screen needs the picker. Lives across the 2s lobby-poll
      // re-renders — mount() is idempotent.
      this._gameFinder = null;
    }

    async onMount() {
      // Sync setup + immediate paint. The persisted draft (game, players,
      // photo) renders without waiting on the network, so the user sees
      // their Gather screen the instant they tap Log. Async work (buddies,
      // expansions, lobby open, live-scores subscribe) folds in via a
      // second render() once it lands.
      const existing = window.PlaySession.load();
      this._ps = existing || new window.PlaySession();
      // Deep-link entry: URL was /play/{code}. If the localStorage draft is
      // for a different code (or empty), adopt the URL's code so
      // _ensureLobbyOpen fetches the right lobby. If the current user turns
      // out not to be the host of that lobby, hop to session-viewer.
      const urlCode = this.params && this.params.code;
      if (urlCode && this._ps.code !== urlCode) {
        try {
          const s = await window.PlaySession.fetchLobby(urlCode);
          const me = window.store.get("user");
          if (s && me && s.host_user_id && s.host_user_id !== me.id) {
            window.router.go("session-viewer", { code: urlCode });
            return;
          }
          // Host (or unknown user — fall through to the host path which
          // will re-validate and either resume or open a fresh lobby).
          this._ps.code = urlCode;
          if (s && s.game_id) this._ps.gameId = s.game_id;
          this._ps.persist();
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
      // username search without per-mount round-trips. Tracked on `this`
      // so the buddy dropdown can show a loading state and re-render if
      // the user focuses the input before this lands.
      this._buddyDataReady = false;
      this._buddyPreloadPromise = (async () => {
        let combined;
        try {
          combined = await window.Buddy.allBuddies();
        } catch (_) {
          combined = { accounts: [], ghosts: [], recent: [] };
        }
        this._buddies = combined.accounts || [];
        this._ghosts = combined.ghosts || [];
        this._recent = combined.recent || [];
        this._buddyDataReady = true;
        // If the buddy input is currently focused, refresh the dropdown
        // so recents appear without the user having to refocus.
        const input = document.getElementById("play-flow-buddy-input");
        if (input && document.activeElement === input) {
          this._renderBuddyDropdown(input.value || "");
        }
        return combined;
      })();
      const expansionsPromise = this._loadExpansionsIfNeeded();
      const lobbyPromise = this._ensureLobbyOpen();
      await Promise.all([this._buddyPreloadPromise, expansionsPromise, lobbyPromise]);

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
      if (this._gameFinder) { try { this._gameFinder.unmount(); } catch (_) {} this._gameFinder = null; }
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
            this._syncUrlToCode();
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
          const gone = e && (e.status === 404 || e.status === 410);
          if (!gone) {
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
        const session = await window.PlaySession.openLobby({ gameId: this._ps.gameId });
        this._lobby = session;
        this._ps.code = session.code;
        this._ps.sessionId = session.id;
        this._ps.hostUserId = session.host_user_id;
        this._ps.phase = session.phase || "gather";
        this._ps.persist();
        this._syncUrlToCode();
      } catch (e) {
        this._error = e.message || "Could not start a session";
      }
    }

    // Once we know the lobby code, rewrite the address bar from /play to
    // /play/{code} so a refresh resumes the session (and the URL is
    // shareable). Uses replaceState — we don't want a back-press from the
    // session to land on a /play entry that would re-create a fresh lobby.
    _syncUrlToCode() {
      if (!this._ps || !this._ps.code) return;
      if (window.router && window.router.replaceUrl) {
        window.router.replaceUrl("play-flow", { code: this._ps.code });
      }
    }

    _startLobbyPoll() {
      if (this._lobbyPoll || !this._lobby) return;
      this._lobbyPoll = setInterval(async () => {
        if (!this._lobby) return;
        // Skip the tick while a participant DELETE is in flight — the
        // server still has the row, and the merge logic below would
        // re-add it as a "new" participant.
        if (this._pendingDeletes > 0) return;
        // Skip while a phase change is in flight — the response below would
        // overwrite this._lobby with a row whose phase may not yet reflect
        // the transition the host just kicked off.
        if (this._pendingPhase > 0) return;
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
            for (const part of nextParts) {
              const key = (part.display_name || "").toLowerCase();
              if (!key) continue;
              if (byName.has(key)) {
                // Backfill participant_id onto an existing local row (e.g. one
                // the host added optimistically before the backend round-trip
                // completed) so _removePlayer can issue a DELETE later.
                const existing = this._ps.players[byName.get(key)];
                if (existing && !existing.participant_id) {
                  existing.participant_id = part.id;
                  playersChanged = true;
                }
                continue;
              }
              this._ps.players.push({
                name: part.display_name,
                is_winner: false,
                score: null,
                user_id: part.user_id || null,
                avatar: part.avatar || null,
                participant_id: part.id,
              });
              byName.set(key, this._ps.players.length - 1);
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
          ${this._renderContinue("Continue to Play", () => "_advanceToPlay()", { disabled: !this._ps.gameId || !(this._lobby && this._lobby.code) })}
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
      this._mountGameFinder();
      // NOTE: do NOT call _scrollToCurrentPhase() here. render() runs every
      // 2s via the lobby poll and on every player edit — yanking the scroll
      // to the top of the active section made long Gather screens feel
      // un-scrollable. _scrollToCurrentPhase() is now only called when the
      // active phase actually changes (onMount, _advancePhase, _phaseBack).
    }

    _mountGameFinder() {
      const mount = document.getElementById("play-flow-game-finder-mount");
      if (!mount) {
        // Picker is gone (game picked, or we're not on the gather screen).
        // Tear the widget down so its outside-click handler doesn't leak.
        if (this._gameFinder) { this._gameFinder.unmount(); this._gameFinder = null; }
        return;
      }
      if (!this._gameFinder) {
        this._gameFinder = new window.GameFinder({
          placeholder: "Search for a game…",
          includeRecentlyPlayed: true,
          onPick: (game, ctx) => this._onFinderPick(game, ctx),
        });
      }
      this._gameFinder.mount(mount);
    }

    _onFinderPick(game, ctx) {
      // Mid-session host can only pick base games. Expansions need a base
      // attached on the Gather screen's expansion picker — the refusal
      // returns control to the dropdown with an inline explanation.
      if (ctx && ctx.source === "bgg" && game && game.is_expansion) {
        return { refuse: true, reason: "Pick a base game; expansions attach later." };
      }
      this._applyGamePick(game);
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
      // Prefer the live lobby's code; on first paint after a reopen (cold
      // reload, nav back, or join-session "Reopen" path) the persisted
      // draft already carries the same code, so fall back to it instead
      // of flashing "— — — — —" until _ensureLobbyOpen resolves.
      const code = (this._lobby && this._lobby.code) || (this._ps && this._ps.code) || null;
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
        <section class="cascade-card">
          <label class="cascade-card__label">Game</label>
          ${game ? this._renderPickedGameChip() : `<div id="play-flow-game-finder-mount"></div>`}
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
          ${badge}
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
      // Table markup is delegated to the shared round-grid widget so the
      // play-detail popup paints the same scoreboard. We still own the
      // cascade-card wrapper + co-op outcome bar above it, and supply the
      // live-overlay resolvers so realtime joiner scores still win over
      // the local cache.
      const grid = window.renderRoundGrid(ps.players, "playFlowView", {
        editable: true,
        playMode: mode,
        getCellValue: (p, r) => this._cellValue(p, r),
        getPlayerTotal: (p) => this._playerTotal(p),
      });
      return `
        <section class="cascade-card cascade-card--scoring">
          <label class="cascade-card__label">Scoring</label>
          ${mode === "coop" ? this._renderCoopOutcome() : ""}
          ${grid}
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
      // Token this invocation. If the user navigates again before our PATCH
      // resolves, a newer call bumps _phaseSeq past `seq` and we must NOT
      // reconcile against this (now-stale) response — otherwise an older
      // PATCH resolving last snaps the screen back to its phase.
      const seq = ++this._phaseSeq;
      this._ps.phase = next;
      this._ps.persist();
      this.render();
      this._scrollToCurrentPhase();
      this._pendingPhase++;
      try {
        const updated = await window.PlaySession.advancePhase(this._lobby.code, next);
        if (seq !== this._phaseSeq) return; // a newer phase change owns the state now
        this._lobby = updated;
        if (updated.phase && updated.phase !== this._ps.phase) {
          // Server overrode (shouldn't normally happen). Sync local view.
          this._ps.phase = updated.phase;
          this._ps.persist();
          this.render();
        }
      } catch (e) {
        if (seq !== this._phaseSeq) return; // superseded — let the newer call own state
        this._ps.phase = prevPhase;
        this._ps.persist();
        this._error = e.message || "Could not advance to the next screen";
        this.render();
        this._scrollToCurrentPhase();
      } finally {
        this._pendingPhase--;
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
          <button class="cascade-game-chip__details" type="button"
                  title="View game details" aria-label="View game details"
                  onclick="window.playFlowView._openGameDetails()">
            <i data-lucide="arrow-up-right" class="w-4 h-4"></i>
          </button>
          <button class="cascade-game-chip__clear" type="button"
                  title="Change game" aria-label="Clear pick"
                  onclick="window.playFlowView._clearGamePick()">
            <i data-lucide="x" class="w-3.5 h-3.5"></i>
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
      // game pick alongside the host.
      if (ps.code) {
        window.PlaySession.updateLobby(ps.code, { gameId: null }).catch(() => {});
      }
      this.render();
      // Focus the freshly-mounted finder input so the user lands ready to
      // type their next pick — no extra tap to refocus.
      requestAnimationFrame(() => {
        if (this._gameFinder) this._gameFinder.focus();
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
      if (ps.code) {
        window.PlaySession.updateLobby(ps.code, { gameId: game.id }).catch(() => {});
      }
      // The finder + dropdown unmount once a game is picked — the user
      // changes the pick by tapping the chip's × (which clears state and
      // re-mounts the search input). The widget's unmount() invalidates
      // any in-flight search, so a late response can't sneak in.
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
      // Match the typed name against the unified candidate list (accounts +
      // ghosts). If we find an account match, attach the user_id + avatar so
      // the player goes in as an authed buddy; otherwise it's a ghost row.
      const candidates = this._buddyCandidates();
      const hit = candidates.find((c) => c.name.toLowerCase() === name.toLowerCase());
      this._addPlayer({
        name: hit ? hit.name : name,
        user_id: hit ? hit.user_id : null,
        avatar: hit ? hit.avatar : null,
      });
    }

    _addPlayer({ name, user_id, avatar }) {
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
          avatar: avatar || null,
          roundScores: Array(currentRounds).fill(null),
        });
        this._ps.persist();
        // Sync to the backend participants table so other joiners see this
        // player. Fire-and-forget — _lobbyPoll will reconcile within ~2s and
        // backfill participant_id onto the local row. On hard failure, drop
        // the local row and toast so the host knows nothing was added.
        this._pushParticipantToBackend(name, user_id);
      }
      this._closeBuddyDropdown();
      this.render();
    }

    async _pushParticipantToBackend(name, userId) {
      if (!this._lobby || !this._lobby.code) return;
      try {
        await window.PlaySession.addParticipant(this._lobby.code, {
          userId: userId || null,
          displayName: name,
        });
      } catch (e) {
        // Roll back the optimistic local push so the host's UI doesn't
        // show a phantom row that no joiner can see.
        const idx = this._ps.players.findIndex(
          (p) => (p.name || "").toLowerCase() === (name || "").toLowerCase()
        );
        if (idx >= 0) {
          this._ps.players.splice(idx, 1);
          this._ps.persist();
          this.render();
        }
        if (window.showToast) window.showToast(`Couldn't add ${name}: ${e.message || "network error"}`, "error");
      }
    }

    // Lookup helper used by the buddy autocomplete dropdown: resolves the
    // buddy row from this._buddies (so we keep their avatar) and forwards
    // to _addPlayer.
    _addBuddy(userId) {
      const buddy = (this._buddies || []).find((b) => b.other_user_id === userId);
      if (!buddy) return;
      this._addPlayer({
        name: buddy.other_display_name,
        user_id: buddy.other_user_id,
        avatar: buddy.other_avatar || null,
      });
    }

    // Pick a ghost-buddy from the dropdown — a free-text name the user has
    // logged before, with no account. Goes in as a name-only participant.
    _addGhost(displayName) {
      const name = String(displayName || "").trim();
      if (!name) return;
      this._addPlayer({ name, user_id: null, avatar: null });
    }

    _removePlayer(i) {
      const removed = this._ps.players[i];
      this._ps.players.splice(i, 1);
      this._ps.persist();
      this._autoSelectWinners();
      this.render();
      // If the row had been confirmed by the backend (carries a
      // participant_id from _lobbyPoll), tell the server to drop it too.
      if (removed && removed.participant_id && this._lobby && this._lobby.code) {
        this._pendingDeletes++;
        window.PlaySession.removeParticipant(this._lobby.code, removed.participant_id)
          .catch((e) => {
            if (window.showToast) window.showToast(`Couldn't remove ${removed.name}: ${e.message || "network error"}`, "error");
          })
          .finally(() => { this._pendingDeletes--; });
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

    // ── Buddy combo ────────────────────────────────────────────────────────

    _onBuddyInput(value) {
      // Debounce typing so we don't re-render the dropdown on every keystroke.
      // Mirrors the GameFinder pattern (widgets/game-finder.js).
      if (this._buddyInputTimer) clearTimeout(this._buddyInputTimer);
      this._buddyInputTimer = setTimeout(() => this._renderBuddyDropdown(value), 180);
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

    async _renderBuddyDropdown(query) {
      // If the buddy preload from onMount hasn't landed yet, show a loading
      // hint synchronously, await the preload, then continue with the real
      // render. Bails if the user moved focus elsewhere during the wait.
      if (!this._buddyDataReady) {
        const ddLoading = document.getElementById("play-flow-buddy-dropdown");
        if (ddLoading) {
          ddLoading.innerHTML = `<li class="cascade-buddy-dropdown-header">Loading…</li>`;
          ddLoading.classList.remove("hidden");
        }
        if (this._buddyPreloadPromise) {
          try { await this._buddyPreloadPromise; } catch (_) {}
        }
        const input = document.getElementById("play-flow-buddy-input");
        if (!input || document.activeElement !== input) {
          const ddPost = document.getElementById("play-flow-buddy-dropdown");
          if (ddPost) {
            ddPost.innerHTML = "";
            ddPost.classList.add("hidden");
          }
          return;
        }
        query = input.value || "";
      }
      const dd = document.getElementById("play-flow-buddy-dropdown");
      if (!dd) return;
      const q = (query || "").trim().toLowerCase();
      const candidates = this._buddyCandidates();
      let rows = [];
      let header = "";

      if (!q) {
        // Empty input: surface recently-played-with people. Cross-reference
        // recent (real accounts, ordered by play_count) against the
        // candidates so we keep the unified shape and exclude anyone
        // already in the draft.
        const candidatesByUserId = new Map(
          candidates.filter((c) => c.user_id).map((c) => [c.user_id, c])
        );
        for (const r of (this._recent || [])) {
          const hit = candidatesByUserId.get(r.user_id);
          if (hit) {
            rows.push(hit);
            continue;
          }
          // Recent person who isn't a buddy yet — still useful to surface
          // so the host can add them as a name-only player.
          const already = new Set(this._ps.players.map((p) => (p.name || "").toLowerCase()));
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
        rows = rows.slice(0, 8);
        if (rows.length > 0) header = "Recently played with";
      } else {
        rows = candidates
          .filter((c) => {
            const name = c.name.toLowerCase();
            const username = (c.username || "").toLowerCase();
            return name.includes(q) || (username && username.includes(q));
          })
          .slice(0, 8);
      }

      if (rows.length === 0) {
        dd.classList.add("hidden");
        dd.innerHTML = "";
        return;
      }
      const headerHtml = header
        ? `<li class="cascade-buddy-dropdown-header">${escape(header)}</li>`
        : "";
      dd.innerHTML = headerHtml + rows.map((c) => {
        const handler = c.user_id
          ? `window.playFlowView._addBuddy('${escapeAttr(c.user_id)}')`
          : `window.playFlowView._addGhost('${escapeAttr(c.name)}')`;
        const ghostPill = c.source === "ghost"
          ? `<span class="cascade-buddy-dropdown-pill">ghost</span>`
          : "";
        const subtitle = c.username
          ? `<span class="cascade-buddy-dropdown-sub">@${escape(c.username)}</span>`
          : "";
        const badge = window.BgbBadge.render({
          avatar: c.avatar,
          displayName: c.name,
          size: "xs",
          isGhost: c.source === "ghost",
        });
        return `
          <li class="cascade-buddy-dropdown-item" onclick="${handler}">
            ${badge}
            <span class="cascade-buddy-dropdown-name">${escape(c.name)}</span>
            ${subtitle}
            ${ghostPill}
          </li>
        `;
      }).join("");
      dd.classList.remove("hidden");
      if (window.lucide) window.lucide.createIcons();
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
      // Save-then-photo. Persist the play first so a flaky upload can't
      // strand the user with no record of the game. Photo upload + the
      // follow-up PUT to attach it are best-effort; if either fails the
      // play stays saved and we warn before the wrap-up splash.
      let saved;
      try {
        const payload = this._ps.toPlayCreate();
        if (this._lobby && this._lobby.code) {
          saved = await window.PlaySession.finalizeLobby(this._lobby.code, payload);
        } else {
          saved = await window.Play.create(payload);
        }
      } catch (e) {
        this._error = e.message || "Failed to save";
        this._saving = false;
        this.render();
        return;
      }

      const savedId = (saved && (saved.id || saved.play_id || (saved.play && saved.play.id))) || null;

      // PUT /plays/{id} requires owner. Both solo and lobby-host paths
      // are owned by the current user, so the attach call succeeds.
      // Revisit if joiners ever finalize.
      let photoUploadFailed = false;
      if (this._ps.photoFile) {
        if (!savedId) {
          photoUploadFailed = true;
        } else {
          try {
            const fd = new FormData();
            fd.append("file", this._ps.photoFile);
            const resp = await window.api.upload("/plays/photo", fd);
            const uploadedUrl = resp && resp.photo_url;
            if (uploadedUrl) {
              const createPayload = this._ps.toPlayCreate();
              const { game_id, ...rest } = createPayload;
              await window.Play.update(savedId, { ...rest, photo_url: uploadedUrl });
            } else {
              photoUploadFailed = true;
            }
          } catch (_) {
            photoUploadFailed = true;
          }
        }
      }

      try {
        const game = this._ps.gameSnapshot || {};
        const winner = this._ps.players.find((p) => p.is_winner);
        const popupOpts = {
          headline: "Well played!",
          gameName: game.name || "Game over",
          gameThumbnail: game.thumbnail_url || game.image_url || null,
          winnerName: winner ? winner.name : null,
          playId: savedId,
        };
        this._ps.clear();
        window.store.set("activePlay", null);
        window.store.invalidate("feed");
        // Drop the host-flow caches so the next gather screen sees the new
        // ghost names + updated played-with counts + the just-played game at
        // the top of the recents dropdown. Re-warm in the background so the
        // user returns to instant data without paying for a round-trip on
        // the next host tap.
        if (window.Buddy && window.Buddy.invalidate) window.Buddy.invalidate();
        if (window.Game && window.Game.invalidateRecent) window.Game.invalidateRecent();
        if (window.Buddy && window.Buddy.allBuddies) window.Buddy.allBuddies().catch(() => {});
        if (window.Game && window.Game.recentlyPlayed) window.Game.recentlyPlayed(6).catch(() => {});
        // Surface the warning before the wrap-up popup so the user can't miss it.
        if (photoUploadFailed && window.PolaroidPopup && window.PolaroidPopup.alert) {
          await window.PolaroidPopup.alert({
            title: "Photo couldn't be uploaded",
            body: "Your play was saved without the photo. You can add it later from the play card.",
          });
        }
        // Same wrap-up splash non-host joiners get. Default dismiss handler
        // invalidates the feed cache and routes to /feed.
        if (window.PolaroidPopup) {
          window.PolaroidPopup.show(popupOpts);
        } else {
          window.router.go("feed");
        }
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
