// views/session-viewer-view.js — read-only lobby viewer for joiners.
//
// After someone joins via 5-char code we land them here instead of leaving
// them on the join screen. The view polls GET /sessions/{code} every 30s so
// joiners watch participants trickle in. When the host finalizes we auto-
// route to the saved play; when they abandon we surface that and stop polling.

(function () {
  // Two cadences: the joiner cares MOST about seeing the host's game pick
  // as soon as it lands, so we poll fast (5s) while game_id is null. Once
  // the game is set the per-player update rate drops to "someone new might
  // join" — 30s is plenty.
  const POLL_FAST_MS = 5000;
  const POLL_SLOW_MS = 30000;

  class SessionViewerView extends window.View {
    constructor() {
      super("session-viewer");
      this._code = null;
      this._session = null;
      this._loading = false;
      this._error = null;
      this._pollHandle = null;
      this._pollMs = POLL_SLOW_MS;
      this._guideWidget = null;
    }

    async onMount() {
      this._code = this._extractCode(this.params);
      if (!this._code) {
        this._error = "No session code provided";
        this.render();
        return;
      }
      await this._load();
      this._startPolling();
    }

    async onParamsChange() {
      const next = this._extractCode(this.params);
      if (next === this._code) {
        this.render();
        return;
      }
      this._stopPolling();
      this._code = next;
      this._session = null;
      await this._load();
      this._startPolling();
    }

    async onUnmount() {
      this._stopPolling();
      this._guideWidget = null;
    }

    _extractCode(params) {
      const raw = params && params.code;
      return raw ? String(raw).trim().toUpperCase() : null;
    }

    _startPolling() {
      if (this._pollHandle || !this._code) return;
      this._pollMs = this._desiredPollMs();
      this._pollHandle = setInterval(() => this._poll(), this._pollMs);
    }

    _stopPolling() {
      if (this._pollHandle) {
        clearInterval(this._pollHandle);
        this._pollHandle = null;
      }
    }

    _desiredPollMs() {
      const s = this._session;
      return s && s.game_id ? POLL_SLOW_MS : POLL_FAST_MS;
    }

    // Re-arm the interval when the desired cadence changes (e.g. host picks
    // the game and we can downshift to slow polling).
    _retunePolling() {
      if (!this._pollHandle) return;
      const next = this._desiredPollMs();
      if (next === this._pollMs) return;
      clearInterval(this._pollHandle);
      this._pollMs = next;
      this._pollHandle = setInterval(() => this._poll(), next);
    }

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
        this._handleStatusTransition();
      }
    }

    async _poll() {
      if (!this._code) return;
      try {
        const next = await window.PlaySession.fetchLobby(this._code);
        const changed = this._diff(this._session, next);
        this._session = next;
        if (changed) this.render();
        this._handleStatusTransition();
        this._retunePolling();
      } catch (_) {
        // Best-effort; keep the loop alive and let the next tick try again.
      }
    }

    _diff(prev, next) {
      if (!prev || !next) return true;
      if (prev.status !== next.status) return true;
      if (prev.finalized_play_id !== next.finalized_play_id) return true;
      if (prev.game_id !== next.game_id) return true;
      const a = prev.participants || [];
      const b = next.participants || [];
      if (a.length !== b.length) return true;
      for (let i = 0; i < a.length; i++) {
        if (a[i].id !== b[i].id) return true;
        if (a[i].display_name !== b[i].display_name) return true;
      }
      return false;
    }

    // Auto-transition: once the host finalizes, drop the joiner on the saved
    // play. Abandon is surfaced inline so the joiner sees why polling stops.
    _handleStatusTransition() {
      const s = this._session;
      if (!s) return;
      if (s.status === "finalized" && s.finalized_play_id) {
        this._stopPolling();
        window.router.go("play-detail", { playId: s.finalized_play_id });
      } else if (s.status === "abandoned") {
        this._stopPolling();
      }
    }

    render() {
      const s = this._session;

      if (this._error && !s) {
        this.container.innerHTML = `
          ${this._renderHeader(null)}
          <div class="p-6 alert alert-error">${escape(this._error)}</div>
        `;
        if (window.lucide) window.lucide.createIcons();
        return;
      }
      if (!s) {
        this.container.innerHTML = `
          ${this._renderHeader(null)}
          ${window.buddyLoader({ size: 96 })}
        `;
        if (window.lucide) window.lucide.createIcons();
        return;
      }

      const game = s.game || null;
      const participants = s.participants || [];
      const hostId = s.host_user_id;
      const host = participants.find((p) => p.user_id === hostId);

      this.container.innerHTML = `
        ${this._renderHeader(s)}
        <article class="session-viewer">
          ${game ? `
            <div class="play-detail__game-row session-viewer__game">
              ${game.thumbnail_url
                ? `<img class="play-detail__game-thumb" src="${escapeAttr(game.thumbnail_url)}" alt="" />`
                : `<div class="play-detail__game-thumb session-viewer__thumb-placeholder"><i data-lucide="dice-6" class="w-6 h-6"></i></div>`}
              <div class="play-detail__game-info">
                <div class="play-detail__game-name">${escape(game.name || "Game")}</div>
                <div class="play-detail__game-when">${host ? "Hosted by " + escape(host.display_name) : ""}</div>
              </div>
            </div>
          ` : `
            <div class="play-detail__game-row session-viewer__game">
              <div class="play-detail__game-thumb session-viewer__thumb-placeholder">
                <i data-lucide="dice-6" class="w-6 h-6"></i>
              </div>
              <div class="play-detail__game-info">
                <div class="play-detail__game-name">Waiting on host to pick a game</div>
                <div class="play-detail__game-when">${host ? "Hosted by " + escape(host.display_name) : ""}</div>
              </div>
            </div>
          `}

          ${this._renderStatusBanner(s)}

          <section class="play-detail__section">
            <h3 class="play-detail__section-title">
              <i data-lucide="users" class="w-4 h-4"></i>
              Players in lobby (${participants.length})
            </h3>
            ${participants.length === 0
              ? `<div class="text-sm opacity-60">No players yet.</div>`
              : `<ul class="play-detail__players">
                  ${participants.map((p) => this._renderParticipant(p, hostId)).join("")}
                </ul>`}
          </section>

          ${s.game_id ? `
            <section class="play-detail__section">
              <h3 class="play-detail__section-title">
                <i data-lucide="book-open" class="w-4 h-4"></i>
                Your reference guide
              </h3>
              <div id="session-viewer-guide-mount" class="session-viewer__guide-mount"></div>
            </section>
          ` : ""}

          <div class="session-viewer__refresh">
            <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i>
            ${s.game_id
              ? "Auto-refreshes every 30 seconds"
              : "Auto-refreshes every 5 seconds while waiting on the game"}
          </div>
        </article>
      `;
      if (window.lucide) window.lucide.createIcons();
      this._mountReferenceGuide();
    }

    // Joiners see their OWN saved chapters for the host's game — the widget
    // fetches via Chapter.myChapters() against the signed-in user. Each render
    // replaces the container's innerHTML so we re-attach the widget to its
    // new mount node, keeping its in-memory state (open/rolled, search, fetched
    // chapters) across polls. If the game changes (unlikely — set at lobby
    // creation) we rebuild the widget from scratch.
    _mountReferenceGuide() {
      const s = this._session;
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
        });
        this._guideWidget.mount(host);
      } else {
        this._guideWidget.mount(host);
        this._guideWidget.setExpansionMeta(expansionMeta);
      }
    }

    _renderHeader(s) {
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

    _renderStatusBanner(s) {
      if (s.status === "finalized") {
        return `
          <div class="session-viewer__status session-viewer__status--finalized">
            <i data-lucide="check-circle-2" class="w-4 h-4"></i>
            The host saved this play. Opening it now…
          </div>
        `;
      }
      if (s.status === "abandoned") {
        return `
          <div class="session-viewer__status session-viewer__status--abandoned">
            <i data-lucide="x-circle" class="w-4 h-4"></i>
            The host ended the session.
          </div>
        `;
      }
      return `
        <div class="session-viewer__status">
          <i data-lucide="hourglass" class="w-4 h-4"></i>
          Waiting for the host to save the play…
        </div>
      `;
    }

    _renderParticipant(p, hostId) {
      const isHost = p.user_id && p.user_id === hostId;
      return `
        <li class="play-detail__player">
          <span class="play-detail__player-name">
            ${escape(p.display_name)}
          </span>
          ${isHost
            ? `<span class="session-viewer__host-tag"><i data-lucide="crown" class="w-3 h-3"></i> Host</span>`
            : ""}
        </li>
      `;
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }

  window.SessionViewerView = SessionViewerView;
})();
