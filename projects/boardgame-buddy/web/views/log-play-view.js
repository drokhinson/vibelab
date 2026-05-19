// views/log-play-view.js — log a play (solo or short-code lobby).
//
// Two modes selectable at the top:
//   - "Solo" (default): pick game, add players, save.
//   - "From another phone": create a code + show the participant list as
//     other phones join via POST /sessions/{code}/join.

(function () {
  class LogPlayView extends window.View {
    constructor() {
      super("log-play");
      this._mode = "solo"; // 'solo' | 'lobby' | 'joining'
      this._buddies = [];
      this._lobby = null;     // SessionResponse when hosting
      this._joinCode = "";
      this._error = null;
      this._saving = false;
      this._pollHandle = null;
      // Expansions picker state. _expansionsLoadedFor caches the game id so
      // we only re-fetch when the picked game changes; _expansionsOpen is
      // false by default so the section starts collapsed.
      this._expansions = [];
      this._expansionsLoadedFor = null;
      this._expansionsOpen = false;
      // ReferenceGuideScroll widget instance; recreated when the picked game
      // changes (handled inside _mountReferenceGuide via the baseGameId check).
      this._guideWidget = null;
    }

    async onMount() {
      const existing = window.PlaySession.load();
      this._ps = existing || new window.PlaySession();
      this._ensureSelfIncluded();
      window.store.set("activePlay", this._ps);
      // When a chapter is added/removed from inside the reference-guide-add
      // view, the in-play scroll needs to re-fetch so the new chapter shows
      // up in the merged guide.
      this.listenDom("chapters-changed", () => {
        if (this._guideWidget) this._guideWidget.refresh();
      });
      const buddyPromise = window.Buddy.list().catch(() => []);
      const expansionsPromise = this._loadExpansionsIfNeeded();
      const [buddies] = await Promise.all([buddyPromise, expansionsPromise]);
      this._buddies = buddies;
      this.render();
      // The view persists across mounts (init.js builds a single instance),
      // so a widget created during a previous mount still has its cached
      // chapter list. The chapters-changed listener is torn down during the
      // intermediate trip to reference-guide-add, so the in-play scroll has
      // to re-fetch on re-entry to surface any chapters the user just added.
      if (this._guideWidget) this._guideWidget.refresh();
    }

    async _loadExpansionsIfNeeded() {
      const gameId = this._ps && this._ps.gameId;
      if (!gameId) {
        this._expansions = [];
        this._expansionsLoadedFor = null;
        return;
      }
      if (this._expansionsLoadedFor === gameId) return;
      // Expansions don't have sub-expansions — skip the round-trip.
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
      // Prune any persisted expansionIds that aren't in this game's expansion
      // list — stale selections from a previously-picked game would otherwise
      // ride along into the new session.
      const valid = new Set(this._expansions.map((e) => e.expansion_game_id));
      const before = (this._ps.expansionIds || []).length;
      this._ps.expansionIds = (this._ps.expansionIds || []).filter((id) => valid.has(id));
      if (this._ps.expansionIds.length !== before) this._ps.persist();
    }

    _ensureSelfIncluded() {
      // The logger needs a play_players row so their wins / play counts /
      // played-with leaderboards include them. Only auto-add when the draft
      // has no players yet — never overwrite an existing list the user
      // already touched.
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

    async onUnmount() {
      this._stopPolling();
    }

    render() {
      const ps = this._ps;
      // The "Log a play" header used to sit above the mode tabs; removed
      // because the active tab ("Log a play" / "Join by code") already
      // labels the screen and the duplicate stacked title ate vertical
      // space on a mobile-first layout.
      this.container.innerHTML = `
        <div class="log-play__tabs">
          <button class="log-play__tab ${this._mode !== "joining" ? "is-active" : ""}" onclick="window.logPlayView._setMode('solo')">Log a play</button>
          <button class="log-play__tab ${this._mode === "joining" ? "is-active" : ""}" onclick="window.logPlayView._setMode('joining')">Join by code</button>
        </div>

        ${this._mode === "joining" ? this._renderJoiningMode() : this._renderSoloOrLobby()}
        ${this._error ? `<div class="alert alert-error m-3">${escape(this._error)}</div>` : ""}
      `;
      if (window.lucide) window.lucide.createIcons();
      this._mountReferenceGuide();
    }

    _renderSoloOrLobby() {
      const ps = this._ps;
      const game = ps.gameSnapshot;
      return `
        <section class="log-play__section">
          <label class="log-play__label">Game</label>
          ${game ? `
            <div class="log-play__game">
              ${game.thumbnail_url ? `<img src="${game.thumbnail_url}" alt="" />` : ""}
              <div class="log-play__game-name">${escape(game.name)}</div>
              <button class="btn btn-ghost btn-sm" onclick="window.logPlayView._pickGame()">Change</button>
            </div>
          ` : `
            <button class="btn btn-outline w-full" onclick="window.logPlayView._pickGame()">
              <i data-lucide="search" class="w-4 h-4"></i> Pick a game
            </button>
          `}
        </section>

        <section class="log-play__section">
          <label class="log-play__label">When</label>
          <input type="date" class="input input-bordered w-full" value="${escapeAttr(ps.playedAt)}"
                 onchange="window.logPlayView._setDate(this.value)" />
        </section>

        ${this._renderPlayModeSelector()}

        <section class="log-play__section">
          <div class="log-play__players-head">
            <label class="log-play__label">Players</label>
            ${this._renderSessionChip()}
          </div>
          ${ps.players.length === 0 ? `<p class="text-sm opacity-60 mb-2">No players added yet.</p>` : ""}
          <ul class="log-play__players">
            ${ps.players.map((p, i) => this._renderPlayerRow(p, i)).join("")}
          </ul>
          <div class="log-play__player-add">
            <div class="log-play__buddy-combo">
              <input id="log-play-buddy-input"
                     class="input input-bordered input-sm w-full"
                     placeholder="Add player (buddy or free-text)"
                     autocomplete="off"
                     oninput="window.logPlayView._onBuddyInput(this.value)"
                     onfocus="window.logPlayView._openBuddyDropdown()"
                     onblur="window.logPlayView._scheduleCloseBuddyDropdown()"
                     onkeydown="if(event.key==='Enter'){event.preventDefault();window.logPlayView._addPlayerFromInput();}else if(event.key==='Escape'){window.logPlayView._closeBuddyDropdown();}" />
              <ul id="log-play-buddy-dropdown" class="log-play__buddy-dropdown hidden"
                  onmousedown="event.preventDefault()"></ul>
            </div>
            <button class="btn btn-primary btn-sm" onclick="window.logPlayView._addPlayerFromInput()">Add</button>
          </div>
        </section>

        ${this._renderExpansionsPicker()}
        ${this._renderScoringSection()}
        ${this._renderReferenceGuideSection()}
        ${this._renderPhotoSection()}

        <section class="log-play__section">
          <label class="log-play__label">Notes</label>
          <textarea class="textarea textarea-bordered w-full" rows="2"
                    onchange="window.logPlayView._setNotes(this.value)">${escape(ps.notes)}</textarea>
        </section>

        <section class="log-play__section log-play__save">
          <button class="btn btn-primary w-full" ${this._saving ? "disabled" : ""}
                  onclick="window.logPlayView._save()">
            ${this._saving ? "Saving…" : "Save play"}
          </button>
          <button class="btn btn-ghost btn-sm w-full mt-2" onclick="window.logPlayView._reset()">
            Reset
          </button>
        </section>
      `;
    }

    _renderSessionChip() {
      // Inline session-code control lives alongside the Players label.
      // - No active lobby → tiny "+ Code" button to spin one up.
      // - Active lobby   → compact pill with the code + an × to end. The
      //   poll loop merges joining players straight into the players list,
      //   so there's no separate participants display to clutter the panel.
      if (!this._lobby) {
        return `
          <button class="session-chip session-chip--add" title="Create a code others can join with"
                  onclick="window.logPlayView._openLobby()">
            <i data-lucide="qr-code" class="w-3 h-3"></i>
            <span>Session code</span>
          </button>
        `;
      }
      return `
        <span class="session-chip session-chip--active" title="Players can join with this code">
          <i data-lucide="qr-code" class="w-3 h-3"></i>
          <span class="session-chip__code">${escape(this._lobby.code)}</span>
          <button class="session-chip__end" title="End session"
                  onclick="window.logPlayView._closeLobby()">
            <i data-lucide="x" class="w-3 h-3"></i>
          </button>
        </span>
      `;
    }

    _renderPlayerRow(p, i) {
      const isTeamGame = this._isTeamGame();
      const initials = p.initials != null ? p.initials : computeInitials(p.name);
      return `
        <li class="log-play__player">
          <span class="log-play__player-name">${escape(p.name)}</span>
          <input class="log-play__player-init" type="text" maxlength="3"
                 aria-label="Initials"
                 placeholder="${escapeAttr(computeInitials(p.name))}"
                 value="${escapeAttr(initials)}"
                 oninput="window.logPlayView._setInitials(${i}, this.value)" />
          ${isTeamGame ? `
            <input class="log-play__player-team" type="text" maxlength="6"
                   aria-label="Team"
                   placeholder="Team"
                   value="${escapeAttr(p.team || '')}"
                   oninput="window.logPlayView._setTeam(${i}, this.value)" />
          ` : ''}
          <button class="btn btn-ghost btn-xs" title="Remove player"
                  onclick="window.logPlayView._removePlayer(${i})">
            <i data-lucide="x" class="w-3.5 h-3.5"></i>
          </button>
        </li>
      `;
    }

    _resolvePlayMode() {
      const ps = this._ps;
      if (ps.playMode) return ps.playMode;
      const g = ps.gameSnapshot;
      if (g && g.play_mode) return g.play_mode;
      return 'competitive';
    }

    _isTeamGame() {
      return this._resolvePlayMode() === 'team';
    }

    _renderPlayModeSelector() {
      const mode = this._resolvePlayMode();
      const opt = (id, label, icon) => `
        <button class="play-mode-opt ${mode === id ? 'is-active' : ''}"
                onclick="window.logPlayView._setPlayMode('${id}')">
          <i data-lucide="${icon}" class="w-4 h-4"></i>
          <span>${label}</span>
        </button>`;
      return `
        <section class="log-play__section">
          <label class="log-play__label">Game type</label>
          <div class="play-mode-selector">
            ${opt('competitive', 'Competitive', 'swords')}
            ${opt('team', 'Team', 'users')}
            ${opt('coop', 'Co-op', 'handshake')}
          </div>
        </section>
      `;
    }

    _setPlayMode(mode) {
      if (!['competitive', 'team', 'coop'].includes(mode)) return;
      this._ps.playMode = mode;
      // Switching modes can invalidate the current winner state. Don't auto-
      // clear: the user might have a partial setup we'd rather preserve, and
      // re-clicking the trophy is one tap. Just re-render so the UI swaps.
      this._ps.persist();
      this.render();
    }

    _renderScoringSection() {
      const ps = this._ps;
      if (ps.players.length === 0) return "";
      const mode = this._resolvePlayMode();
      const roundCount = Math.max(0, ...ps.players.map((p) => (p.roundScores || []).length));
      const playerTotal = (p) => (p.roundScores || []).reduce((a, b) => a + (Number(b) || 0), 0);
      const labelFor = (p) => p.initials || computeInitials(p.name);
      // Table is visible from the start — the totals row carries the trophy
      // buttons (competitive / team) or a shared outcome banner (co-op) so
      // the winner state is reachable without entering any scores. Round
      // rows are added on demand and removable individually via the X
      // beside each round label.
      return `
        <section class="log-play__section">
          <label class="log-play__label">Scoring</label>
          ${mode === 'coop' ? this._renderCoopOutcome() : ''}
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
                                onclick="window.logPlayView._removeRoundAt(${r})">
                          <i data-lucide="x" class="w-3 h-3"></i>
                        </button>
                        R${r + 1}
                      </span>
                    </th>
                    ${ps.players.map((p, i) => `
                      <td>
                        <input type="number" inputmode="numeric"
                               class="scoring-cell"
                               value="${escapeAttr((p.roundScores && p.roundScores[r] != null) ? String(p.roundScores[r]) : "")}"
                               oninput="window.logPlayView._setRoundScore(${i}, ${r}, this.value)" />
                      </td>
                    `).join("")}
                  </tr>
                `).join("")}
                <tr class="scoring-total-row">
                  <th>Total</th>
                  ${ps.players.map((p, i) => this._renderTotalsCell(p, i, mode, playerTotal(p))).join("")}
                </tr>
              </tbody>
            </table>
          </div>
          <div class="flex gap-2 mt-1">
            <button class="btn btn-ghost btn-xs" onclick="window.logPlayView._addRound()">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i> Round
            </button>
          </div>
        </section>
      `;
    }

    _renderTotalsCell(p, i, mode, total) {
      // Co-op uses the shared-outcome control above the table — totals row
      // here just carries the per-player score. Competitive + Team keep the
      // per-player trophy; Team syncs teammates on toggle.
      if (mode === 'coop') {
        return `<td class="${p.is_winner ? 'scoring-total-cell--winner' : ''}">
          <div class="scoring-total-cell">
            <span class="scoring-total">${total}</span>
          </div>
        </td>`;
      }
      return `<td class="${p.is_winner ? 'scoring-total-cell--winner' : ''}">
        <div class="scoring-total-cell">
          <button class="scoring-winner-btn ${p.is_winner ? 'is-winner' : ''}"
                  title="${p.is_winner ? 'Winner' : 'Mark as winner'}"
                  onclick="window.logPlayView._toggleWinner(${i})">
            <i data-lucide="${p.is_winner ? 'trophy' : 'circle'}" class="w-4 h-4"></i>
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
          <button class="coop-outcome-btn ${won ? 'is-winner' : ''}"
                  onclick="window.logPlayView._setCoopOutcome(${!won})">
            <i data-lucide="${won ? 'trophy' : 'circle'}" class="w-4 h-4"></i>
            <span>${won ? 'We won together' : 'Mark as won'}</span>
          </button>
          <p class="text-xs opacity-60 mt-1">Co-op: everyone wins or loses together.</p>
        </div>
      `;
    }

    _setCoopOutcome(won) {
      for (const p of this._ps.players) p.is_winner = !!won;
      this._ps.persist();
      this.render();
    }

    // ── Expansions picker ────────────────────────────────────────────────────
    // Collapsed by default; only renders when a base game is picked AND that
    // game has expansion rows. Toggling rows mutates ps.expansionIds, which
    // also drives which chapters appear in the reference-guide widget below.
    _renderExpansionsPicker() {
      if (!this._ps.gameId) return "";
      const snap = this._ps.gameSnapshot;
      if (snap && snap.is_expansion) return "";
      if (!this._expansions || this._expansions.length === 0) return "";

      const open = !!this._expansionsOpen;
      const chevron = open ? "chevron-down" : "chevron-right";
      const selected = (this._ps.expansionIds || []).length;
      return `
        <section class="log-play__section log-play__section--expansions">
          <button class="collapsible-header" aria-expanded="${open}"
                  onclick="window.logPlayView._toggleExpansionsPicker()">
            <span class="collapsible-header__title">
              <i data-lucide="puzzle" class="w-4 h-4"></i>
              Expansions${selected ? ` (${selected} selected)` : ""}
            </span>
            <i data-lucide="${chevron}" class="w-4 h-4 collapsible-header__chev"></i>
          </button>
          ${open ? `
            <ul class="expansion-list log-play__exp-list">
              ${this._expansions.map((e) => this._renderExpansionPickerRow(e)).join("")}
            </ul>
          ` : ""}
        </section>
      `;
    }

    _renderExpansionPickerRow(e) {
      const active = (this._ps.expansionIds || []).includes(e.expansion_game_id);
      return `
        <li class="expansion-list__row log-play__exp-row ${active ? "is-active" : ""}"
            onclick="window.logPlayView._toggleExpansion('${e.expansion_game_id}')"
            style="--exp-color:${e.color || "#C9922A"}">
          <span class="expansion-list__dot"></span>
          ${e.thumbnail_url
            ? `<img src="${escapeAttr(e.thumbnail_url)}" alt="" class="expansion-list__thumb" loading="lazy" />`
            : `<div class="expansion-list__thumb expansion-list__thumb--placeholder"><i data-lucide="dice-6"></i></div>`}
          <div class="expansion-list__body">
            <div class="expansion-list__name">${escape(e.name)}</div>
          </div>
          <span class="log-play__exp-toggle ${active ? "log-play__exp-toggle--on" : ""}">
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

    // ── Reference guide section ──────────────────────────────────────────────
    _renderReferenceGuideSection() {
      if (!this._ps.gameId) return "";
      const game = this._ps.gameSnapshot || {};
      const rulebookUrl = game.rulebook_url;
      const rulebookBtn = rulebookUrl
        ? `<a href="${escapeAttr(rulebookUrl)}" target="_blank" rel="noopener"
              class="btn btn-outline btn-sm log-play__rulebook-cta">
             <i data-lucide="book-open" class="w-4 h-4"></i>
             <span>Rulebook</span>
             <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
           </a>`
        : `<button class="btn btn-outline btn-sm log-play__rulebook-cta" disabled
              title="No rulebook available">
             <i data-lucide="book-open" class="w-4 h-4"></i>
             <span>Rulebook</span>
           </button>`;
      return `
        <section class="log-play__section log-play__section--guide">
          <label class="log-play__label">Reference guide</label>
          <div class="log-play__rulebook-row">${rulebookBtn}</div>
          <div id="log-play-guide-mount"></div>
        </section>
      `;
    }

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
        // No game picked yet — clear stale widget so we re-fetch cleanly when
        // a game is picked on the next render.
        this._guideWidget = null;
        return;
      }
      const host = document.getElementById("log-play-guide-mount");
      if (!host) return;
      const meta = this._buildExpansionMetaMap();
      const gameIds = [this._ps.gameId, ...(this._ps.expansionIds || [])];

      // Recreate the widget if the user picked a different base game — keeping
      // the prior widget would reuse cached chapters from the old game.
      if (this._guideWidget && this._guideWidget._baseGameId !== this._ps.gameId) {
        this._guideWidget = null;
      }
      if (!this._guideWidget) {
        this._guideWidget = new window.ReferenceGuideScroll({
          baseGameId: this._ps.gameId,
          gameIds,
          expansionMeta: meta,
          onAfterMutate: () => this.render(),
        });
        this._guideWidget.mount(host);
      } else {
        // Attach to the new container first so the loading-state re-render
        // triggered by setGameIds writes into the visible DOM, not the old
        // (now-detached) mount point.
        this._guideWidget.mount(host);
        this._guideWidget.setExpansionMeta(meta);
        this._guideWidget.setGameIds(gameIds);
      }
    }

    _renderPhotoSection() {
      const url = this._ps.photoPreviewUrl;
      return `
        <section class="log-play__section">
          <label class="log-play__label">Photo</label>
          ${url ? `
            <div class="log-play__photo">
              <img src="${url}" alt="Selected play photo" />
              <button class="btn btn-ghost btn-xs log-play__photo-remove" onclick="window.logPlayView._clearPhoto()">
                <i data-lucide="x" class="w-3.5 h-3.5"></i> Remove
              </button>
            </div>
          ` : `
            <label class="log-play__photo-pick">
              <input type="file" accept="image/*" class="hidden"
                     onchange="window.logPlayView._onPhotoSelect(this.files && this.files[0])" />
              <i data-lucide="camera" class="w-5 h-5"></i>
              <span>Click to add photo</span>
            </label>
          `}
        </section>
      `;
    }

    _renderJoiningMode() {
      return `
        <section class="log-play__section">
          <label class="log-play__label">Enter the host's code</label>
          <div class="flex gap-2">
            <input id="join-code-input" class="input input-bordered flex-1 min-w-0"
                   placeholder="5-character code"
                   maxlength="5"
                   autocapitalize="characters"
                   value="${escapeAttr(this._joinCode)}"
                   onchange="window.logPlayView._joinCode = this.value.toUpperCase();" />
            <button class="btn btn-primary" onclick="window.logPlayView._joinByCode()">Join</button>
          </div>
        </section>
      `;
    }

    _setMode(mode) {
      this._mode = mode;
      this._error = null;
      // Polling lives with the lobby itself now, not the tab. Switching
      // tabs doesn't end the session — the host can flip to "Join by code"
      // and back without losing participants.
      this.render();
    }

    _pickGame() {
      // Route to search in "pick-for-play" mode so clicking a result returns
      // to this view with the game pre-selected (instead of opening the
      // game-detail page).
      window.router.go("game-search", { mode: "pick-for-play" });
    }

    _setDate(value) {
      this._ps.playedAt = value;
      this._ps.persist();
    }

    _setNotes(value) {
      this._ps.notes = value;
      this._ps.persist();
    }

    _addPlayerFromInput() {
      const input = document.getElementById("log-play-buddy-input");
      const name = (input.value || "").trim();
      if (!name) return;
      // If the typed name matches a buddy exactly, treat it as that buddy
      // (carries user_id). Otherwise it's a free-text ghost player.
      const buddy = (this._buddies || []).find(
        (b) => b.other_display_name.toLowerCase() === name.toLowerCase()
      );
      this._addPlayer({
        name,
        user_id: buddy ? buddy.other_user_id : null,
      });
    }

    _addPlayer({ name, user_id }) {
      // Skip dupes (case-insensitive) so picking a buddy who's already in the
      // list is a no-op rather than stacking duplicates.
      const exists = this._ps.players.some(
        (p) => (p.name || "").toLowerCase() === (name || "").toLowerCase()
      );
      if (!exists) {
        // New player slots into the existing scoring-table grid — pad their
        // roundScores so column lengths match the current number of rounds.
        const currentRounds = Math.max(0, ...this._ps.players.map((p) => (p.roundScores || []).length));
        const roundScores = Array(currentRounds).fill(null);
        this._ps.players.push({
          name,
          is_winner: false,
          score: null,
          user_id: user_id || null,
          roundScores,
        });
        this._ps.persist();
      }
      this._closeBuddyDropdown();
      this.render();
    }

    // ── Scoring rounds ────────────────────────────────────────────────────────

    _addRound() {
      for (const p of this._ps.players) {
        if (!Array.isArray(p.roundScores)) p.roundScores = [];
        p.roundScores.push(null);
      }
      this._ps.persist();
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
        this.render();
      }
    }

    _setInitials(i, value) {
      const p = this._ps.players[i];
      if (!p) return;
      // Uppercase + strip whitespace so the table header stays compact.
      p.initials = String(value || "").replace(/\s+/g, "").slice(0, 3).toUpperCase();
      this._ps.persist();
      // Patch only the matching column header so the input keeps focus.
      const heads = this.container.querySelectorAll(".scoring-head");
      const label = p.initials || computeInitials(p.name);
      if (heads[i]) heads[i].textContent = label;
    }

    _setTeam(i, value) {
      const ps = this._ps;
      const p = ps.players[i];
      if (!p) return;
      p.team = String(value || "").trim();
      // If any existing teammate is already marked winner, inherit it so the
      // table doesn't show a mismatched team. Skip when team is empty.
      if (p.team) {
        const tag = p.team.toLowerCase();
        const teammateWon = ps.players.some(
          (o, j) => j !== i && (o.team || '').trim().toLowerCase() === tag && o.is_winner
        );
        if (teammateWon !== p.is_winner) {
          p.is_winner = teammateWon;
          this._ps.persist();
          this.render();
          return;
        }
      }
      ps.persist();
    }

    _setRoundScore(playerIndex, roundIndex, value) {
      const p = this._ps.players[playerIndex];
      if (!p) return;
      if (!Array.isArray(p.roundScores)) p.roundScores = [];
      // Allow blanks (treated as 0 in the total) so partially-scored rounds
      // don't force a 0 into the cell.
      p.roundScores[roundIndex] = value === "" ? null : Number(value);
      this._ps.persist();
      // Update only the total cell so the input doesn't lose focus on each
      // keystroke — find the cell via its column index.
      const totals = this.container.querySelectorAll(".scoring-total");
      const total = (p.roundScores || []).reduce((a, b) => a + (Number(b) || 0), 0);
      if (totals[playerIndex]) totals[playerIndex].textContent = String(total);
    }

    // ── Photo ────────────────────────────────────────────────────────────────

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

    // ── Custom buddy dropdown (replaces native <datalist>) ──────────────────
    //
    // The native datalist only fills the input on pick; the user still had to
    // press Add. This custom dropdown adds the buddy directly on click.

    _onBuddyInput(value) {
      // Live filter — repaint the dropdown only (not the whole view) so the
      // input keeps focus and the caret position survives.
      this._renderBuddyDropdown(value);
    }

    _openBuddyDropdown() {
      const input = document.getElementById("log-play-buddy-input");
      this._renderBuddyDropdown(input ? input.value : "");
    }

    _scheduleCloseBuddyDropdown() {
      // Defer so an onclick on a row in the dropdown still fires (blur runs
      // before click without the delay).
      setTimeout(() => this._closeBuddyDropdown(), 150);
    }

    _closeBuddyDropdown() {
      const dd = document.getElementById("log-play-buddy-dropdown");
      if (dd) {
        dd.classList.add("hidden");
        dd.innerHTML = "";
      }
    }

    _renderBuddyDropdown(query) {
      const dd = document.getElementById("log-play-buddy-dropdown");
      if (!dd) return;
      const q = (query || "").trim().toLowerCase();
      const already = new Set(
        this._ps.players.map((p) => (p.name || "").toLowerCase())
      );
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
        <li class="log-play__buddy-dropdown-item"
            onclick="window.logPlayView._addPlayer({name:'${escapeAttr(b.other_display_name)}', user_id:'${escapeAttr(b.other_user_id)}'})">
          <span class="avatar-bubble avatar-bubble--xs">${escape(initialsOf(b.other_display_name))}</span>
          <span class="log-play__buddy-dropdown-name">${escape(b.other_display_name)}</span>
        </li>
      `).join("");
      dd.classList.remove("hidden");
    }

    _removePlayer(i) {
      this._ps.players.splice(i, 1);
      this._ps.persist();
      this.render();
    }

    _toggleWinner(i) {
      const ps = this._ps;
      const p = ps.players[i];
      if (!p) return;
      const next = !p.is_winner;
      const mode = this._resolvePlayMode();
      if (mode === 'coop') {
        // Coop: everyone wins or loses together.
        for (const other of ps.players) other.is_winner = next;
      } else if (mode === 'team' && p.team && p.team.trim()) {
        // Team: teammates win together. Players without a team value stay
        // individual (toggling them only flips themselves).
        const tag = p.team.trim().toLowerCase();
        for (const other of ps.players) {
          if ((other.team || '').trim().toLowerCase() === tag) other.is_winner = next;
        }
      } else {
        p.is_winner = next;
      }
      ps.persist();
      this.render();
    }

    async _openLobby() {
      try {
        this._lobby = await window.PlaySession.openLobby({ gameId: this._ps.gameId });
        this._ps.code = this._lobby.code;
        this._ps.sessionId = this._lobby.id;
        this._ps.hostUserId = this._lobby.host_user_id;
        this._ps.persist();
        this.render();
        this._startPolling();
      } catch (e) {
        this._error = e.message || "Failed to open session";
        this.render();
      }
    }

    async _closeLobby() {
      if (!this._lobby) return;
      try { await window.PlaySession.abandonLobby(this._lobby.code); } catch (_) {}
      this._stopPolling();
      this._lobby = null;
      this._ps.code = null;
      this._ps.sessionId = null;
      this._ps.persist();
      this.render();
    }

    _startPolling() {
      if (this._pollHandle || !this._lobby) return;
      this._pollHandle = setInterval(async () => {
        try {
          const session = await window.PlaySession.fetchLobby(this._lobby.code);
          // Diff before touching state — the lobby refreshes every 2s and
          // most polls return the same participants. Re-rendering on every
          // tick made the whole view innerHTML-swap, which read as a blink.
          const prevIds = new Set(
            (this._lobby.participants || []).map((p) => p.id)
          );
          const nextParts = session.participants || [];
          let participantsChanged =
            nextParts.length !== prevIds.size ||
            nextParts.some((p) => !prevIds.has(p.id));

          this._lobby = session;

          // Merge any new participants into the player list (skip dupes).
          const known = new Set(
            this._ps.players.map((p) => (p.name || "").toLowerCase())
          );
          let playersChanged = false;
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
          if (participantsChanged || playersChanged) this.render();
        } catch (_) {}
      }, 2000);
    }

    _stopPolling() {
      if (this._pollHandle) {
        clearInterval(this._pollHandle);
        this._pollHandle = null;
      }
    }

    async _joinByCode() {
      const input = document.getElementById("join-code-input");
      const code = (input.value || this._joinCode || "").trim().toUpperCase();
      if (!code) return;
      try {
        await window.PlaySession.joinLobby(code);
        this._error = null;
        alert(`Joined session ${code}. The host will save the play.`);
      } catch (e) {
        this._error = e.message || "Failed to join";
        this.render();
      }
    }

    async _save() {
      if (!this._ps.gameId) {
        this._error = "Pick a game first.";
        this.render();
        return;
      }
      this._saving = true;
      this.render();
      const payload = this._ps.toPlayCreate();
      const photoFile = this._ps.photoFile;
      try {
        let play;
        if (this._lobby && this._lobby.code) {
          // Active session — finalize through the lobby so the server can
          // close it out atomically with the play creation.
          play = await window.PlaySession.finalizeLobby(this._lobby.code, payload);
        } else {
          play = await window.Play.create(payload);
        }
        // The photo upload endpoint requires a play_id, so it has to run AFTER
        // create. If the upload errors we surface it but keep the play that
        // was already saved — the user can add the photo via Edit later.
        if (photoFile && play && play.id) {
          try {
            const fd = new FormData();
            fd.append("file", photoFile);
            await window.api.upload(`/plays/${play.id}/photo`, fd);
          } catch (e) {
            this._error = "Play saved, but the photo upload failed: " + (e.message || "");
            this._saving = false;
            this.render();
            return;
          }
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

    _reset() {
      this._ps.clear();
      this._lobby = null;
      this._error = null;
      this._stopPolling();
      this._expansions = [];
      this._expansionsLoadedFor = null;
      this._expansionsOpen = false;
      this._guideWidget = null;
      this._ensureSelfIncluded();
      window.store.set("activePlay", this._ps);
      this.render();
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

  window.LogPlayView = LogPlayView;
})();
