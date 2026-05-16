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
    }

    async onMount() {
      const existing = window.PlaySession.load();
      this._ps = existing || new window.PlaySession();
      window.store.set("activePlay", this._ps);
      try {
        this._buddies = await window.Buddy.list();
      } catch (_) { this._buddies = []; }
      this.render();
    }

    async onUnmount() {
      this._stopPolling();
    }

    render() {
      const ps = this._ps;
      this.container.innerHTML = `
        <header class="log-play__topbar">
          <button class="btn btn-ghost btn-sm" onclick="history.back()">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
          <h2 class="log-play__title font-display">Log a play</h2>
          <button class="btn btn-ghost btn-sm" onclick="window.logPlayView._reset()">Reset</button>
        </header>

        <div class="log-play__tabs">
          <button class="log-play__tab ${this._mode === "solo" ? "is-active" : ""}" onclick="window.logPlayView._setMode('solo')">Solo log</button>
          <button class="log-play__tab ${this._mode === "lobby" ? "is-active" : ""}" onclick="window.logPlayView._setMode('lobby')">Host a session</button>
          <button class="log-play__tab ${this._mode === "joining" ? "is-active" : ""}" onclick="window.logPlayView._setMode('joining')">Join by code</button>
        </div>

        ${this._mode === "joining" ? this._renderJoiningMode() : this._renderSoloOrLobby()}
        ${this._error ? `<div class="alert alert-error m-3">${escape(this._error)}</div>` : ""}
      `;
      if (window.lucide) window.lucide.createIcons();
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
            ${game.rulebook_url ? `<a href="${escapeAttr(game.rulebook_url)}" target="_blank" rel="noopener" class="log-play__rulebook"><i data-lucide="book-open" class="w-4 h-4"></i> Rulebook</a>` : ""}
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

        <section class="log-play__section">
          <label class="log-play__label">Players</label>
          ${ps.players.length === 0 ? `<p class="text-sm opacity-60 mb-2">No players added yet.</p>` : ""}
          <ul class="log-play__players">
            ${ps.players.map((p, i) => `
              <li class="log-play__player">
                <span class="log-play__player-name">${escape(p.name)}</span>
                <label class="log-play__player-win">
                  <input type="checkbox" ${p.is_winner ? "checked" : ""}
                         onchange="window.logPlayView._toggleWinner(${i}, this.checked)" />
                  Winner
                </label>
                <button class="btn btn-ghost btn-xs" onclick="window.logPlayView._removePlayer(${i})">
                  <i data-lucide="x" class="w-3.5 h-3.5"></i>
                </button>
              </li>
            `).join("")}
          </ul>
          <div class="log-play__player-add">
            <input id="log-play-buddy-input" class="input input-bordered input-sm w-full"
                   list="log-play-buddy-list" placeholder="Add player (buddy or free-text)"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();window.logPlayView._addPlayerFromInput();}" />
            <datalist id="log-play-buddy-list">
              ${this._buddies.map((b) => `<option value="${escapeAttr(b.other_display_name)}" data-user="${b.other_user_id}">`).join("")}
            </datalist>
            <button class="btn btn-primary btn-sm" onclick="window.logPlayView._addPlayerFromInput()">Add</button>
          </div>
        </section>

        ${this._mode === "lobby" ? this._renderLobbyPanel() : ""}

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
        </section>
      `;
    }

    _renderLobbyPanel() {
      if (!this._lobby) {
        return `
          <section class="log-play__section log-play__lobby">
            <button class="btn btn-outline w-full" onclick="window.logPlayView._openLobby()">
              <i data-lucide="qr-code" class="w-4 h-4"></i> Create session code
            </button>
            <p class="text-xs opacity-60 mt-2">Other phones can join with the code and add themselves to the player list.</p>
          </section>
        `;
      }
      const code = this._lobby.code;
      const parts = this._lobby.participants || [];
      return `
        <section class="log-play__section log-play__lobby">
          <div class="log-play__lobby-code">
            <span class="log-play__lobby-label">Session code</span>
            <span class="log-play__lobby-value">${escape(code)}</span>
          </div>
          <p class="text-xs opacity-60 mt-1">${parts.length} ${parts.length === 1 ? "player" : "players"} joined</p>
          <ul class="log-play__lobby-parts">
            ${parts.map((p) => `<li>${escape(p.display_name)}</li>`).join("")}
          </ul>
          <button class="btn btn-ghost btn-xs mt-2" onclick="window.logPlayView._closeLobby()">End session</button>
        </section>
      `;
    }

    _renderJoiningMode() {
      return `
        <section class="log-play__section">
          <label class="log-play__label">Enter the host's code</label>
          <div class="flex gap-2">
            <input id="join-code-input" class="input input-bordered flex-1"
                   placeholder="5-character code"
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
      this._stopPolling();
      this.render();
      if (mode === "lobby" && this._lobby) {
        this._startPolling();
      }
    }

    _pickGame() {
      // Route to search so the user can pick. The detail view's "Log a play"
      // path also lands us here with gameSnapshot pre-set.
      window.router.go("game-search");
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
      const buddy = (this._buddies || []).find((b) => b.other_display_name.toLowerCase() === name.toLowerCase());
      this._ps.players.push({
        name,
        is_winner: false,
        score: null,
        user_id: buddy ? buddy.other_user_id : null,
      });
      input.value = "";
      this._ps.persist();
      this.render();
    }

    _removePlayer(i) {
      this._ps.players.splice(i, 1);
      this._ps.persist();
      this.render();
    }

    _toggleWinner(i, on) {
      this._ps.players[i].is_winner = !!on;
      this._ps.persist();
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
          this._lobby = session;
          // Merge any new participants into the player list (skip dupes).
          const known = new Set(this._ps.players.map((p) => (p.name || "").toLowerCase()));
          for (const part of session.participants || []) {
            const key = (part.display_name || "").toLowerCase();
            if (key && !known.has(key)) {
              this._ps.players.push({
                name: part.display_name,
                is_winner: false,
                score: null,
                user_id: part.user_id || null,
              });
              known.add(key);
            }
          }
          this._ps.persist();
          this.render();
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
      try {
        let play;
        if (this._lobby && this._lobby.code && this._mode === "lobby") {
          play = await window.PlaySession.finalizeLobby(this._lobby.code, payload);
        } else {
          play = await window.Play.create(payload);
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
      window.store.set("activePlay", null);
      this.render();
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }

  window.LogPlayView = LogPlayView;
})();
