// views/join-session-view.js — Session select for non-hosts.
//
// Shows a 5-char code input and a list of joinable sessions: ones where
// the viewer is already a participant (rejoin after disconnect) OR where
// the host is one of the viewer's accepted buddies. Polls every 10s so
// new sessions appear without a refresh.

(function () {
  const POLL_MS = 10000;

  class JoinSessionView extends window.View {
    constructor() {
      super("join-session");
      this._sessions = null;
      this._loading = false;
      this._error = null;
      this._joining = false;
      this._joinCode = "";
      this._pollHandle = null;
    }

    async onMount() {
      await this._load();
      this._startPolling();
    }

    async onUnmount() {
      this._stopPolling();
    }

    async _load() {
      this._loading = true;
      this._error = null;
      this.render();
      try {
        const resp = await window.PlaySession.listJoinable();
        this._sessions = (resp && resp.sessions) || [];
      } catch (e) {
        this._error = e.message || "Failed to load active sessions";
        this._sessions = this._sessions || [];
      } finally {
        this._loading = false;
        this.render();
      }
    }

    _startPolling() {
      if (this._pollHandle) return;
      this._pollHandle = setInterval(async () => {
        try {
          const resp = await window.PlaySession.listJoinable();
          const next = (resp && resp.sessions) || [];
          if (this._shouldRerender(next)) {
            this._sessions = next;
            this.render();
          } else {
            this._sessions = next;
          }
        } catch (_) {}
      }, POLL_MS);
    }

    _stopPolling() {
      if (this._pollHandle) {
        clearInterval(this._pollHandle);
        this._pollHandle = null;
      }
    }

    _shouldRerender(next) {
      const prev = this._sessions || [];
      if (prev.length !== next.length) return true;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i].id !== next[i].id) return true;
        if (prev[i].participant_count !== next[i].participant_count) return true;
        if ((prev[i].game && prev[i].game.id) !== (next[i].game && next[i].game.id)) return true;
      }
      return false;
    }

    render() {
      const sessions = this._sessions || [];
      this.container.innerHTML = `
        <header class="cascade-back-row">
          <button class="btn btn-ghost btn-sm" onclick="window.router.back('log-play')">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <h1 class="font-display cascade-back-row__title">Join a game</h1>
          <span></span>
        </header>

        <section class="cascade-card">
          <label class="cascade-card__label">Enter a host's code</label>
          <div class="cascade-join__code-row">
            <input id="join-code-input"
                   class="input input-bordered flex-1 min-w-0 cascade-join__code-input"
                   placeholder="5-character code"
                   maxlength="5"
                   autocapitalize="characters"
                   value="${escapeAttr(this._joinCode)}"
                   oninput="window.joinSessionView._joinCode = this.value.toUpperCase();" />
            <button class="btn btn-primary"
                    ${this._joining ? "disabled" : ""}
                    onclick="window.joinSessionView._joinByCode()">
              ${this._joining ? "Joining…" : "Join"}
            </button>
          </div>
          ${this._error ? `<div class="cascade-card__error">${escape(this._error)}</div>` : ""}
        </section>

        <section class="cascade-join__list-wrap">
          <div class="cascade-join__list-head">
            <h2 class="cascade-join__list-title">Active sessions</h2>
            <button class="cascade-join__refresh"
                    aria-label="Refresh active sessions"
                    title="Refresh"
                    ${this._loading ? "disabled" : ""}
                    onclick="window.joinSessionView._load()">
              <i data-lucide="refresh-cw" class="w-4 h-4 ${this._loading ? "cascade-join__refresh-spin" : ""}"></i>
            </button>
          </div>
          ${this._loading && sessions.length === 0
            ? `<div class="cascade-join__loading">${window.buddyLoader({ size: 64 })}</div>`
            : sessions.length === 0
              ? this._renderEmpty()
              : `<ul class="cascade-join__list">
                   ${sessions.map((s) => this._renderSessionRow(s)).join("")}
                 </ul>`}
        </section>
      `;
      if (window.lucide) window.lucide.createIcons();
    }

    _renderEmpty() {
      return `
        <div class="cascade-join__empty">
          <i data-lucide="moon" class="w-6 h-6"></i>
          <p>No active sessions right now. Enter a code above if a host shared one.</p>
        </div>
      `;
    }

    _renderSessionRow(s) {
      const gameName = s.game ? s.game.name : "Picking a game…";
      const thumb = s.game && s.game.thumbnail_url
        ? `<img src="${escapeAttr(s.game.thumbnail_url)}" alt="" class="cascade-join__row-thumb" />`
        : `<div class="cascade-join__row-thumb cascade-join__row-thumb--placeholder">
             <i data-lucide="dice-6" class="w-4 h-4"></i>
           </div>`;
      const badges = [];
      if (s.is_participant) badges.push(`<span class="cascade-join__badge cascade-join__badge--rejoin">Rejoin</span>`);
      if (s.is_host_buddy && !s.is_participant) badges.push(`<span class="cascade-join__badge">Buddy</span>`);
      // Sessions past Gather are spectator-only — the user lands in the
      // read-only session-viewer and isn't added to the host's player list.
      if (s.phase && s.phase !== "gather") badges.push(`<span class="cascade-join__badge">Spectate</span>`);
      return `
        <li class="cascade-card cascade-join__row"
            onclick="window.joinSessionView._joinSession('${escapeAttr(s.code)}')">
          ${thumb}
          <div class="cascade-join__row-body">
            <div class="cascade-join__row-top">
              <span class="cascade-join__row-host">${escape(s.host_display_name)}</span>
              <span class="cascade-join__row-code">${escape(s.code)}</span>
            </div>
            <div class="cascade-join__row-bottom">
              <span class="cascade-join__row-game">${escape(gameName)}</span>
              <span class="cascade-join__row-count">
                <i data-lucide="users" class="w-3 h-3"></i>
                ${s.participant_count}
              </span>
            </div>
            ${badges.length ? `<div class="cascade-join__row-badges">${badges.join("")}</div>` : ""}
          </div>
        </li>
      `;
    }

    async _joinByCode() {
      const input = document.getElementById("join-code-input");
      const code = ((input && input.value) || this._joinCode || "").trim().toUpperCase();
      if (!code) return;
      await this._joinSession(code);
    }

    async _joinSession(code) {
      if (this._joining) return;
      this._joining = true;
      this._error = null;
      this.render();
      try {
        await window.PlaySession.joinLobby(code);
        // The host re-entering their own session (via code input or the
        // joinable list after a disconnect / cache wipe) should land in
        // host mode, not the read-only viewer. fetchLobby returns the
        // canonical session row including host_user_id.
        const session = await window.PlaySession.fetchLobby(code);
        const me = window.store.get("user");
        if (me && session && session.host_user_id === me.id) {
          const ps = window.PlaySession.load() || new window.PlaySession();
          ps.code = session.code;
          ps.sessionId = session.id;
          ps.hostUserId = session.host_user_id;
          ps.phase = session.phase || "gather";
          if (session.game) {
            ps.gameId = session.game.id;
            ps.gameSnapshot = session.game;
          }
          ps.persist();
          window.store.set("activePlay", ps);
          window.router.go("play-flow");
        } else {
          window.router.go("session-viewer", { code });
        }
      } catch (e) {
        this._error = e.message || "Failed to join";
      } finally {
        this._joining = false;
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

  window.JoinSessionView = JoinSessionView;
})();
