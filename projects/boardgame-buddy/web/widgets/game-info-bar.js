// @ts-check
//
// widgets/game-info-bar.js — the Play step's session header strip.
//
// Replaces the standalone "Session code" card on Play (play-flow-view's
// _renderPlay) and the "Now playing" + code card PAIR on the spectator's
// mirror (session-viewer-view's _renderPlay). Both sides now render one
// 54px line carrying the two facts a person needs mid-game: what's on the
// table, and the code to join it.
//
// Gather deliberately keeps _renderInviteCard as-is. There the game chip
// already sits two cards above, and the code is the thing people are still
// acting on, so it earns the 22px display treatment. By Play the code is
// read out once and the game is what you keep checking — hence the swap in
// emphasis, and the strip instead of a card.
//
// Pure-string renderer, same contract as widgets/round-score-grid.js:
// callers embed the returned HTML. The one behaviour it owns is copy, wired
// through the window.GameInfoBar global below so both views share it.

(function () {
  /**
   * @typedef {Object} GameInfoBarGame
   * @property {string} [name]
   * @property {string|null} [thumbnail_url]
   */

  /**
   * @typedef {"ready"|"pending"|"offline"|"failed"} GameInfoBarState
   *   ready   — a live code to show.
   *   pending — the lobby is still minting one (host, first paint).
   *   offline — no lobby was opened, so there is nothing to join.
   *   failed  — the mint failed and nothing is in flight.
   */

  // State copy lives here rather than in the callers: it describes the
  // widget's own slot, and both views would otherwise carry the same two
  // paragraphs. The host is the only side that can reach these states —
  // the spectator got here by code, so it always has one.
  const STATE_COPY = {
    offline: {
      icon: "cloud-off",
      chip: "Offline",
      note: "Saves to this device and uploads next time you're online. No code to share.",
    },
    failed: {
      icon: "wifi-off",
      chip: "No code",
      note: "Couldn't start a live session, so there's nothing to join. Scoring and saving work as normal.",
    },
  };

  /**
   * The strip. Renders in every state, including with no game — the callers
   * gate on a game id before reaching Play, but the spectator's bundle can
   * carry the id before the game object lands.
   *
   * @param {Object} opts
   * @param {GameInfoBarGame|null} [opts.game]  Game to name. Null renders a waiting label.
   * @param {string|null} [opts.code]           Session code, when there is one.
   * @param {GameInfoBarState} [opts.state]     Defaults to "ready".
   * @param {string} [opts.note]                Extra line under the strip (e.g. a replaced code).
   * @param {boolean} [opts.noteAccent]         Render that line in the accent ink.
   * @returns {string}
   */
  function renderGameInfoBar(opts) {
    const o = opts || {};
    const game = o.game || null;
    const state = o.state || "ready";
    const code = state === "ready" ? o.code || null : null;

    const name = game && game.name ? game.name : "Waiting on host to pick a game";
    const thumb = game && game.thumbnail_url
      ? `<img class="cascade-gamebar__thumb" src="${escapeAttr(game.thumbnail_url)}" alt="" />`
      : `<span class="cascade-gamebar__thumb cascade-gamebar__thumb--placeholder">
           <i data-icon="dice-6" class="w-4 h-4"></i>
         </span>`;

    const notes = [];
    const stateCopy = STATE_COPY[state];
    if (stateCopy) notes.push({ text: stateCopy.note, accent: false });
    if (o.note) notes.push({ text: o.note, accent: !!o.noteAccent });

    return `
      <section class="cascade-gamebar cascade-gamebar--${escapeAttr(state)}">
        <div class="cascade-gamebar__row">
          ${thumb}
          <span class="cascade-gamebar__name">${escapeHtml(name)}</span>
          ${renderCodeSlot(state, code)}
        </div>
        ${notes.map((n) => `
          <p class="cascade-gamebar__note ${n.accent ? "is-accent" : ""}">${escapeHtml(n.text)}</p>
        `).join("")}
      </section>
    `;
  }

  /**
   * The right-hand slot. Only the ready state is interactive — there is
   * nothing to copy while the code is still minting or was never made, and a
   * dead button is worse than a plain chip.
   *
   * @param {GameInfoBarState} state
   * @param {string|null} code
   * @returns {string}
   */
  function renderCodeSlot(state, code) {
    const stateCopy = STATE_COPY[state];
    if (stateCopy) {
      return `
        <span class="cascade-gamebar__code cascade-gamebar__code--absent">
          <i data-icon="${escapeAttr(stateCopy.icon)}" class="w-3.5 h-3.5"></i>
          <span class="cascade-gamebar__code-text">${escapeHtml(stateCopy.chip)}</span>
        </span>
      `;
    }
    if (!code) {
      // Minting. Five en-dashes in the same tabular face measure exactly as
      // wide as the five characters they stand in for, so the strip doesn't
      // resize under the reader when the real code lands.
      return `
        <span class="cascade-gamebar__code cascade-gamebar__code--pending">
          <span class="cascade-gamebar__code-text">–––––</span>
          <span class="cascade-gamebar__glyph cascade-gamebar__glyph--spacer"></span>
        </span>
      `;
    }
    // Both glyphs render up front and CSS swaps them on .is-copied, so
    // confirming a tap costs no icon-hydration pass mid-interaction.
    return `
      <button type="button" class="cascade-gamebar__code cascade-gamebar__code--copy"
              onclick="window.GameInfoBar.copy(this, '${escapeAttr(code)}')"
              title="Copy session code"
              aria-label="Copy session code ${escapeAttr(code)}">
        <span class="cascade-gamebar__code-text">${escapeHtml(code)}</span>
        <i data-icon="copy" class="w-3.5 h-3.5 cascade-gamebar__glyph cascade-gamebar__glyph--idle"></i>
        <i data-icon="check" class="w-3.5 h-3.5 cascade-gamebar__glyph cascade-gamebar__glyph--done"></i>
      </button>
    `;
  }

  const GameInfoBar = {
    /**
     * Copy the session code, and say so on the button itself rather than
     * through a toast: the host is mid-round with a scoring grid under their
     * thumb, and a banner over it to confirm a tap they just made is a worse
     * trade than a 1.6s label swap. The toast is kept for the failure path,
     * where the code has to be readable somewhere the user can act on it.
     *
     * @param {HTMLElement} btn
     * @param {string} code
     */
    copy(btn, code) {
      const done = () => {
        if (btn.dataset.copyTimer) clearTimeout(Number(btn.dataset.copyTimer));
        btn.classList.add("is-copied");
        const t = setTimeout(() => {
          btn.classList.remove("is-copied");
          delete btn.dataset.copyTimer;
        }, 1600);
        btn.dataset.copyTimer = String(t);
      };
      // Clipboard writes are refused outside a secure context and on some
      // in-app browsers. Failing silently would leave the host tapping a
      // button that does nothing, so the fallback puts the code somewhere
      // they can still read it off.
      const failed = () => {
        if (window.showToast) window.showToast(`Couldn't copy — the code is ${code}`, "error");
      };
      try {
        navigator.clipboard.writeText(code).then(done, failed);
      } catch (_) {
        failed();
      }
    },
  };

  window.renderGameInfoBar = renderGameInfoBar;
  window.GameInfoBar = GameInfoBar;
})();
