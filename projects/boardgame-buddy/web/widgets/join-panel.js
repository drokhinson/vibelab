// widgets/join-panel.js — Join-a-session panel (code entry + active sessions).
//
// The bottom half of the Play tab. Shows a 5-char code input and a list of
// joinable sessions: ones where the viewer is already a participant (rejoin
// after a disconnect) OR where the host is one of the viewer's accepted
// buddies. Polls every 10s so new sessions appear without a refresh.
//
// Lifted out of the old views/join-session-view.js when Join moved from a
// standalone /join screen onto the Play tab. It's a widget rather than a view
// because it shares a screen with the host chooser: it owns a host element and
// repaints only that, so a poll tick never rebuilds the cards above it or
// wipes a half-typed code (see .claude/rules/web-frontend.md, "re-render
// surgically, not the whole screen").
//
// Used by:
//   - views/log-play-view.js (Play tab, Join section)
//
// Single instance, hoisted to window.joinPanel in init.js so the inline
// onclick handlers below can find it.

(function () {
  const POLL_MS = 10000;

  class JoinPanel {
    constructor() {
      this._host = null;
      this._sessions = null;
      this._loading = false;
      this._error = null;
      this._joining = false;
      this._joinCode = "";
      this._pollHandle = null;
      // Shared by _load and _pollTick: whichever request was sent last wins.
      this._loadSeq = 0;
      this._onVisibility = () => {
        if (!document.hidden) this._pollTick();
      };
    }

    // Mount into `hostEl` and start polling. Idempotent for the same element
    // so a caller re-render that left the host in place doesn't restart the
    // poll; the Play tab's full render() replaces the host, in which case we
    // repaint into the new one while keeping session list + typed code.
    mount(hostEl) {
      if (!hostEl) return;
      if (this._host === hostEl) {
        this.render();
        return;
      }
      const first = this._host == null;
      this._host = hostEl;
      this.render();
      if (!first) return;
      // The poll skips its ticks while the tab is hidden — fire one immediate
      // catch-up tick when it becomes visible again.
      document.addEventListener("visibilitychange", this._onVisibility);
      this._load();
      this._startPolling();
    }

    unmount() {
      this._stopPolling();
      document.removeEventListener("visibilitychange", this._onVisibility);
      this._host = null;
    }

    async _load() {
      // No connectivity pre-check. The request is made, and whatever comes
      // back is reported in the card's own error slot — which is where a
      // failure to list sessions belongs, right under the thing that lists
      // them. api.js fails instantly rather than after the 15s deadline when
      // the link is already known dead, so this costs no wait.
      this._loading = true;
      this._error = null;
      this.render();
      const seq = ++this._loadSeq;
      try {
        const resp = await window.PlaySession.listJoinable();
        if (seq !== this._loadSeq) return;
        this._sessions = (resp && resp.sessions) || [];
      } catch (e) {
        if (seq !== this._loadSeq) return;
        // The raw "You appear to be offline." is true but reads as a fault
        // report; said in the list's own slot it can name what is missing.
        this._error = isOfflineError(e)
          ? "You're offline — active sessions need a connection."
          : (e.message || "Failed to load active sessions");
        this._sessions = this._sessions || [];
      } finally {
        if (seq === this._loadSeq) {
          this._loading = false;
          this.render();
        }
      }
    }

    _startPolling() {
      if (this._pollHandle) return;
      this._pollHandle = setInterval(() => this._pollTick(), POLL_MS);
    }

    async _pollTick() {
      // Not on screen, or hidden tab: skip the fetch — the visibilitychange
      // listener fires one catch-up tick the moment the tab is visible again.
      if (!this._host || document.hidden) return;
      // Offline the poll can only fail. Skipping the tick (rather than letting
      // it throw six times a minute) also keeps BgbNet's failure counter
      // measuring real user-driven requests instead of its own background noise.
      if (window.BgbNet && window.BgbNet.isOffline()) return;
      const seq = ++this._loadSeq;
      try {
        const resp = await window.PlaySession.listJoinable();
        if (seq !== this._loadSeq) return;
        const next = (resp && resp.sessions) || [];
        if (this._shouldRerender(next)) {
          this._sessions = next;
          this.render();
        } else {
          this._sessions = next;
        }
      } catch (_) {}
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
      const el = this._host;
      if (!el) return;
      const sessions = this._sessions || [];
      // A poll tick can land mid-typing.
      const focus = captureFocus();

      // Renders identically whether or not there is a connection. Joining does
      // need one — the lobby lives on the server and the code is its address —
      // but a disabled field is a worse way to say that than letting the tap
      // through and answering it: it leaves the user guessing whether the app
      // is broken, and it was wrong every time the latch was stale.
      el.innerHTML = `
        <section class="cascade-card">
          <label class="cascade-card__label">Enter a host's code</label>
          <div class="cascade-join__code-row">
            <input id="join-code-input"
                   class="input input-bordered flex-1 min-w-0 cascade-join__code-input"
                   placeholder="5-character code"
                   maxlength="5"
                   autocapitalize="characters"
                   value="${escapeAttr(this._joinCode)}"
                   oninput="window.joinPanel._joinCode = this.value.toUpperCase();" />
            <button class="btn btn-primary"
                    ${this._joining ? "disabled" : ""}
                    onclick="window.joinPanel._joinByCode()">
              ${this._joining ? "Joining…" : "Join"}
            </button>
          </div>
          ${this._error ? `<div class="cascade-card__error">${escapeHtml(this._error)}</div>` : ""}
        </section>

        <section class="cascade-join__list-wrap">
          <div class="cascade-join__list-head">
            <h3 class="cascade-join__list-title">Active sessions</h3>
            <button class="cascade-join__refresh"
                    aria-label="Refresh active sessions"
                    title="Refresh"
                    ${this._loading ? "disabled" : ""}
                    onclick="window.joinPanel._load()">
              <i data-icon="refresh-cw" class="w-4 h-4 ${this._loading ? "cascade-join__refresh-spin" : ""}"></i>
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
      window.BgbIcons.render(el);

      restoreFocus(focus);
    }

    _renderEmpty() {
      return `
        <div class="cascade-join__empty">
          <i data-icon="moon" class="w-6 h-6"></i>
          <p>No active sessions right now. Enter a code above if a host shared one.</p>
        </div>
      `;
    }

    _renderSessionRow(s) {
      const gameName = s.game ? s.game.name : "Picking a game…";
      const thumb = s.game && s.game.thumbnail_url
        ? `<img src="${escapeAttr(s.game.thumbnail_url)}" alt="" class="cascade-join__row-thumb" />`
        : `<div class="cascade-join__row-thumb cascade-join__row-thumb--placeholder">
             <i data-icon="dice-6" class="w-4 h-4"></i>
           </div>`;
      // Sessions past Gather are spectator-only — the user lands in the
      // read-only session-viewer and isn't added to the host's player list.
      const spectate = s.phase && s.phase !== "gather";
      const badges = [];
      if (s.is_participant) badges.push(`<span class="cascade-join__badge cascade-join__badge--rejoin">Rejoin</span>`);
      if (s.is_host_buddy && !s.is_participant) badges.push(`<span class="cascade-join__badge">Buddy</span>`);
      return `
        <li class="cascade-card cascade-join__row"
            onclick="window.joinPanel._joinSession('${escapeAttr(s.code)}')">
          ${thumb}
          <div class="cascade-join__row-body">
            <div class="cascade-join__row-top">
              <span class="cascade-join__row-host">${escapeHtml(s.host_display_name)}</span>
              <span class="cascade-join__row-code">${escapeHtml(s.code)}</span>
            </div>
            <div class="cascade-join__row-bottom">
              <span>${escapeHtml(gameName)}</span>
              <span class="cascade-join__row-count">
                <i data-icon="users" class="w-3 h-3"></i>
                ${s.participant_count}
              </span>
            </div>
            ${badges.length ? `<div class="cascade-join__row-badges">${badges.join("")}</div>` : ""}
          </div>
          <button type="button" class="btn btn-primary cascade-join__row-action"
                  onclick="event.stopPropagation(); window.joinPanel._joinSession('${escapeAttr(s.code)}')">
            ${spectate ? "Spectate" : "Join"}
          </button>
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
        // Offline is not this card's error to show inline: the code the user
        // typed is fine, and "You appear to be offline" printed under the
        // field reads as a complaint about the code. It goes to the app's
        // toast, like every other action that turns out to need the network.
        // Anything the SERVER said ("No such session") stays inline, beside
        // the field it is actually about.
        if (isOfflineError(e)) notifyRequestError(e, "joining a game");
        else this._error = e.message || "Failed to join";
      } finally {
        this._joining = false;
        this.render();
      }
    }
  }

  window.JoinPanel = JoinPanel;
})();
