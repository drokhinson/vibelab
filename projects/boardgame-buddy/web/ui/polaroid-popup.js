// ui/polaroid-popup.js — Splash polaroid for non-host joiners when the
// host wraps up. A medium cream card lands in the middle of the screen
// showing the game thumbnail + winner with a close (X) in the top-right.
// Dismiss invalidates the feed cache so the just-saved play card appears
// when the user lands back on the feed.

// @ts-check

(function () {
  const BACKDROP_ID = "bgb-polaroid-popup";

  /**
   * @typedef {Object} PolaroidPopupOptions
   * @property {string}  gameName
   * @property {string=} gameThumbnail
   * @property {string=} winnerName
   * @property {string=} playId — when present, X tap routes to play-detail
   *           instead of the feed. Set by the phase=finalized handler.
   * @property {() => void=} onDismiss — override default feed redirect.
   */

  /** @param {PolaroidPopupOptions} opts */
  function show(opts) {
    dismiss(); // singleton — never stack two
    const root = document.createElement("div");
    root.id = BACKDROP_ID;
    root.className = "polaroid-popup__backdrop";
    root.innerHTML = renderInner(opts);
    root.addEventListener("click", (ev) => {
      // Click on the backdrop (but not on the card) dismisses.
      if (ev.target === root) handleDismiss(opts);
    });
    document.body.appendChild(root);
    if (window.lucide) window.lucide.createIcons({ icons: undefined });
    // Wire the close button + (optional) View play link.
    const closeBtn = root.querySelector(".polaroid-popup__close");
    if (closeBtn) closeBtn.addEventListener("click", () => handleDismiss(opts));
    const viewBtn = root.querySelector(".polaroid-popup__view");
    if (viewBtn) {
      viewBtn.addEventListener("click", () => {
        const pid = viewBtn.getAttribute("data-play-id");
        dismiss();
        if (pid) window.router.go("play-detail", { playId: pid });
      });
    }
  }

  /**
   * Refresh the popup contents in place (e.g. when phase=finalized
   * arrives after settle). Adds a "View play" CTA pointing at the saved
   * play. Safe to call when no popup is open — silently no-ops.
   */
  function update(partial) {
    const root = document.getElementById(BACKDROP_ID);
    if (!root) return;
    // Re-render the card with merged opts. Stash original opts on the
    // backdrop element so we don't lose game/winner on the update.
    const merged = { ...(root.__opts || {}), ...partial };
    root.innerHTML = renderInner(merged);
    root.__opts = merged;
    if (window.lucide) window.lucide.createIcons({ icons: undefined });
    const closeBtn = root.querySelector(".polaroid-popup__close");
    if (closeBtn) closeBtn.addEventListener("click", () => handleDismiss(merged));
    const viewBtn = root.querySelector(".polaroid-popup__view");
    if (viewBtn) {
      viewBtn.addEventListener("click", () => {
        const pid = viewBtn.getAttribute("data-play-id");
        dismiss();
        if (pid) window.router.go("play-detail", { playId: pid });
      });
    }
  }

  function dismiss() {
    const existing = document.getElementById(BACKDROP_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  }

  function handleDismiss(opts) {
    dismiss();
    if (opts && typeof opts.onDismiss === "function") {
      try { opts.onDismiss(); } catch (_) {}
      return;
    }
    try { window.store.invalidate("feed"); } catch (_) {}
    window.router.go("feed");
  }

  function renderInner(opts) {
    const gameName = escape(opts.gameName || "Game over");
    const winner = opts.winnerName
      ? `<div class="polaroid-popup__winner">
           <i data-lucide="trophy" class="w-4 h-4"></i>
           <span>${escape(opts.winnerName)}</span>
         </div>`
      : `<div class="polaroid-popup__winner polaroid-popup__winner--muted">No winner recorded</div>`;
    const photo = opts.gameThumbnail
      ? `<img class="polaroid-popup__photo" src="${escapeAttr(opts.gameThumbnail)}" alt="" />`
      : `<div class="polaroid-popup__photo polaroid-popup__photo--placeholder">
           <i data-lucide="dice-6" class="w-10 h-10"></i>
         </div>`;
    const viewBtn = opts.playId
      ? `<button class="polaroid-popup__view btn btn-ghost btn-sm" data-play-id="${escapeAttr(opts.playId)}">
           <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
           <span>View play</span>
         </button>`
      : "";
    return `
      <div class="polaroid-popup__card" role="dialog" aria-modal="true" aria-label="Game wrapped up">
        <button class="polaroid-popup__close" aria-label="Close">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
        ${photo}
        <div class="polaroid-popup__title">${gameName}</div>
        ${winner}
        ${viewBtn}
      </div>
    `;
  }

  /**
   * Render a small confirm dialog with two buttons. Resolves true when the
   * user picks the destructive action, false on cancel / backdrop click.
   * @param {{title:string, body?:string, confirmLabel?:string, cancelLabel?:string}} opts
   * @returns {Promise<boolean>}
   */
  function confirm({ title, body, confirmLabel = "Discard", cancelLabel = "Keep playing" }) {
    return new Promise((resolve) => {
      dismiss();
      const root = document.createElement("div");
      root.id = BACKDROP_ID;
      root.className = "polaroid-popup__backdrop polaroid-popup__backdrop--confirm";
      root.innerHTML = `
        <div class="polaroid-popup__card polaroid-popup__card--confirm"
             role="alertdialog" aria-modal="true">
          <div class="polaroid-popup__title">${escape(title)}</div>
          ${body ? `<p class="polaroid-popup__body">${escape(body)}</p>` : ""}
          <div class="polaroid-popup__actions">
            <button class="btn btn-ghost btn-sm polaroid-popup__cancel">${escape(cancelLabel)}</button>
            <button class="btn btn-primary btn-sm polaroid-popup__confirm">${escape(confirmLabel)}</button>
          </div>
        </div>
      `;
      root.addEventListener("click", (ev) => {
        if (ev.target === root) { dismiss(); resolve(false); }
      });
      document.body.appendChild(root);
      if (window.lucide) window.lucide.createIcons();
      const cancelBtn = root.querySelector(".polaroid-popup__cancel");
      const confirmBtn = root.querySelector(".polaroid-popup__confirm");
      if (cancelBtn) cancelBtn.addEventListener("click", () => { dismiss(); resolve(false); });
      if (confirmBtn) confirmBtn.addEventListener("click", () => { dismiss(); resolve(true); });
    });
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }

  window.PolaroidPopup = { show, update, dismiss, confirm };
})();
