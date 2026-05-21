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
  // Slow polling complements the Realtime channel — Realtime delivers the
  // 95% case in ~1s; polling is the safety net.
  const POLL_MS = 15000;

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
      try {
        const next = await window.PlaySession.fetchLobby(this._code);
        const changed = this._diff(this._session, next);
        const prevPhase = this._session && this._session.phase;
        this._session = next;
        if (changed) this.render();
        if (next.phase !== prevPhase) this._handlePhaseSideEffects(next);
      } catch (_) {
        // Best-effort; let Realtime handle the bulk of updates.
      }
    }

    _diff(prev, next) {
      if (!prev || !next) return true;
      if (prev.status !== next.status) return true;
      if (prev.phase !== next.phase) return true;
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

    async _subscribePhase() {
      if (!this._session || !this._session.id) return;
      this._phaseOff = await window.SessionPhase.subscribe(
        this._session.id,
        async (phase) => {
          // Patch the cached session in place so render() picks up the new
          // phase without waiting on the slow poll.
          if (this._session) this._session = { ...this._session, phase };
          this.render();
          this._handlePhaseSideEffects(this._session);
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
      this._liveOff = this._liveScores.subscribe(() => this._refreshTotalsCells());
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
          window.router.go("play-detail", { playId: session.finalized_play_id });
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
      const lockPlay = phase === "gather";
      const lockSettle = phase !== "settle" && phase !== "finalized";

      this.container.innerHTML = `
        ${this._renderTopbar(s)}
        <section class="cascade-screen" id="screen-gather">
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
      this._scrollToCurrentPhase(phase);
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
      return `
        <li class="cascade-player cascade-player--read">
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

    _renderViewerScoring(s) {
      const participants = (s.participants || []).filter((p) => p.user_id);
      if (participants.length === 0) {
        return `<section class="cascade-card"><p class="text-sm opacity-70">No authenticated players yet — scores will appear once players join.</p></section>`;
      }
      const me = window.store.get("user");
      const myId = me && me.id;
      // Round count is unknown to the joiner — fall back to the maximum
      // round_index we've seen in live scores so far, defaulting to 1.
      const maxRound = this._liveScores ? this._liveScores.maxRound() : -1;
      const rounds = Math.max(1, maxRound + 1);
      return `
        <section class="cascade-card cascade-card--scoring">
          <label class="cascade-card__label">Scoring</label>
          <p class="text-xs opacity-60 mb-1">You can edit your own column. Other cells are read-only.</p>
          <div class="scoring-table-wrap">
            <table class="scoring-table">
              <thead>
                <tr>
                  <th></th>
                  ${participants.map((p) => `<th class="scoring-head">${escape(initialsOf(p.display_name))}</th>`).join("")}
                </tr>
              </thead>
              <tbody>
                ${Array.from({ length: rounds }).map((_, r) => `
                  <tr>
                    <th class="scoring-round-th"><span class="scoring-round-label">R${r + 1}</span></th>
                    ${participants.map((p) => this._renderViewerCell(p, r, myId)).join("")}
                  </tr>
                `).join("")}
                <tr class="scoring-total-row">
                  <th>Total</th>
                  ${participants.map((p) => `
                    <td><div class="scoring-total-cell">
                      <span class="scoring-total">${this._liveScores ? this._liveScores.totalFor(p.user_id) : 0}</span>
                    </div></td>
                  `).join("")}
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      `;
    }

    _renderViewerCell(participant, roundIndex, myId) {
      const live = this._liveScores ? this._liveScores.getScore(participant.user_id, roundIndex) : null;
      const value = live == null ? "" : String(live);
      const editable = participant.user_id === myId;
      if (editable) {
        return `
          <td>
            <input type="number" inputmode="numeric"
                   class="scoring-cell"
                   data-round="${roundIndex}"
                   value="${escapeAttr(value)}"
                   oninput="window.sessionViewerView._setMyScore(${roundIndex}, this.value)" />
          </td>
        `;
      }
      return `
        <td>
          <span class="scoring-cell scoring-cell--read">${escape(value)}</span>
        </td>
      `;
    }

    _refreshTotalsCells() {
      const totalsRow = this.container.querySelector(".scoring-total-row");
      if (!totalsRow || !this._session) return;
      const participants = (this._session.participants || []).filter((p) => p.user_id);
      totalsRow.innerHTML =
        `<th>Total</th>` +
        participants.map((p) => `
          <td><div class="scoring-total-cell">
            <span class="scoring-total">${this._liveScores ? this._liveScores.totalFor(p.user_id) : 0}</span>
          </div></td>
        `).join("");
      // Refresh read-only cells for other players too.
      const cells = this.container.querySelectorAll(".scoring-cell--read");
      cells.forEach(() => {});  // visual refresh on next render tick
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
