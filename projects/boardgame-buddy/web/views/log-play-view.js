// views/log-play-view.js — Host or Join chooser screen.
//
// Replaces the legacy 1057-line single-form Log Play view. Tapping "Log"
// in the bottom nav lands here; the user picks "Host a game" (cascades
// into the three-screen play-flow view) or "Join a game" (lands on the
// session-select screen). When a previously-saved draft exists with a
// non-terminal phase, a resume banner surfaces it at the top.

(function () {
  class LogPlayView extends window.View {
    constructor() {
      super("log-play");
    }

    async onMount() {
      this.render();
    }

    render() {
      const ps = window.PlaySession.load();
      const resumable =
        ps &&
        ps.isActive() &&
        ps.code &&
        ps.phase &&
        ps.phase !== "finalized" &&
        ps.phase !== "abandoned";
      const game = resumable ? ps.gameSnapshot : null;

      this.container.innerHTML = `
        <header class="cascade-chooser__header">
          <h1 class="font-display">Log a play</h1>
        </header>

        ${resumable ? `
          <section class="cascade-chooser__resume">
            <div class="cascade-chooser__resume-body">
              <span class="cascade-chooser__resume-title">Resume hosting?</span>
              <span class="cascade-chooser__resume-meta">
                ${game ? escape(game.name) : "Game in progress"}
                · code ${escape(ps.code)}
              </span>
            </div>
            <div class="cascade-chooser__resume-actions">
              <button class="btn btn-primary btn-sm"
                      onclick="window.logPlayView._resume()">
                Resume
              </button>
              <button class="btn btn-ghost btn-sm"
                      onclick="window.logPlayView._discard()">
                Discard
              </button>
            </div>
          </section>
        ` : ""}

        <div class="cascade-chooser__cards">
          <button class="cascade-chooser__card cascade-chooser__card--host"
                  onclick="window.router.go('play-flow')">
            <span class="cascade-chooser__card-icon">
              <i data-lucide="dice-6" class="w-7 h-7"></i>
            </span>
            <span class="cascade-chooser__card-title">Host a game</span>
            <span class="cascade-chooser__card-body">
              Open a session, gather players, run the scoreboard, and
              wrap up with a photo.
            </span>
          </button>

          <button class="cascade-chooser__card cascade-chooser__card--join"
                  onclick="window.router.go('join-session')">
            <span class="cascade-chooser__card-icon">
              <i data-lucide="qr-code" class="w-7 h-7"></i>
            </span>
            <span class="cascade-chooser__card-title">Join a game</span>
            <span class="cascade-chooser__card-body">
              Enter a 5-character code or pick a buddy's active session.
            </span>
          </button>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
    }

    _resume() {
      window.router.go("play-flow");
    }

    async _discard() {
      const ok = await window.PolaroidPopup.confirm({
        title: "Discard this play?",
        body: "The lobby will close and the in-progress draft will be cleared.",
        confirmLabel: "Discard",
        cancelLabel: "Keep playing",
      });
      if (!ok) return;
      const ps = window.PlaySession.load();
      if (ps && ps.code) {
        // Best-effort: tell the server to abandon the existing session
        // so the lobby doesn't sit open until the 2h expiry kicks in.
        try {
          await window.PlaySession.advancePhase(ps.code, "abandoned");
        } catch (_) {}
      }
      if (ps) ps.clear();
      window.store.set("activePlay", null);
      this.render();
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  window.LogPlayView = LogPlayView;
})();
