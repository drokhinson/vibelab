// widgets/add-game-modal.js — Search-and-import modal for adding a game to
// Collection or Wishlist. Hosts a GameFinder; picking a game calls
// Collection.add(game.id, status) and dispatches `status-changed` so any
// live grids re-render their pills.
//
// It is no longer the primary add affordance: the spokes' "+ Add" opens the
// Add Games page (views/add-games-view.js), which scrolls the whole BgB
// catalog with a one-tap add/remove per row. This modal survives as that
// page's escape hatch for the one thing a catalog scroll cannot do — reach a
// game BgB has not imported yet — so it opens titled for BoardGameGeek and
// leads with the finder's BGG search.
//
// Reuses the polaroid-popup backdrop + card chrome for visual consistency
// (per .claude/rules/ui-object-design.md §3c) but owns its own
// .add-game-modal* body classes so it doesn't bloat polaroid-popup.js.

// @ts-check

(function () {
  const BACKDROP_ID = "bgb-add-game-modal";

  /**
   * @typedef {Object} AddGameModalOpts
   * @property {"owned"|"wishlist"} status
   * @property {string} [title]
   * @property {string} [hint] Overrides the line above the finder.
   * @property {(game: any, status: string) => void} [onAdded]
   */

  let _previousFocus = null;
  let _finder = null;
  let _escHandler = null;
  // Device-back guard token — see ui/back-guard.js.
  let _back = 0;

  /** @param {AddGameModalOpts} opts */
  function open(opts) {
    if (!opts || (opts.status !== "owned" && opts.status !== "wishlist")) {
      throw new Error("AddGameModal.open: status must be 'owned' or 'wishlist'");
    }
    dismiss(); // singleton — never stack two

    _previousFocus = document.activeElement;
    const title = opts.title || (opts.status === "owned" ? "Add to collection" : "Add to wishlist");

    const root = document.createElement("div");
    root.id = BACKDROP_ID;
    root.className = "polaroid-popup__backdrop";
    root.innerHTML = `
      <div class="polaroid-popup__card polaroid-popup__card--confirm add-game-modal"
           role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" tabindex="-1">
        <button class="polaroid-popup__close" aria-label="Close">
          <i data-icon="x" class="w-4 h-4"></i>
        </button>
        <div class="polaroid-popup__title">${escapeHtml(title)}</div>
        <p class="polaroid-popup__body add-game-modal__hint">
          ${escapeHtml(opts.hint || "Search your BoardgameBuddy library, or import from BoardGameGeek.")}
        </p>
        <div class="add-game-modal__body" data-finder-mount></div>
        <div class="add-game-modal__note" hidden></div>
      </div>
    `;
    root.addEventListener("click", (ev) => {
      if (ev.target === root) dismiss();
    });
    document.body.appendChild(root);
    window.BgbIcons.render(root);
    // The back gesture closes the modal rather than the screen behind it, and
    // dismisses the keyboard first — this modal opens with the finder focused.
    _back = window.BgbBackGuard
      ? window.BgbBackGuard.arm({ root: root, close: dismiss })
      : 0;

    const closeBtn = root.querySelector(".polaroid-popup__close");
    if (closeBtn) closeBtn.addEventListener("click", () => dismiss());

    const noteEl = /** @type {HTMLElement|null} */ (root.querySelector(".add-game-modal__note"));
    const setNote = (text, isError) => {
      if (!noteEl) return;
      noteEl.textContent = text || "";
      noteEl.hidden = !text;
      noteEl.classList.toggle("add-game-modal__note--error", !!isError);
    };

    _finder = new window.GameFinder({
      placeholder: opts.status === "owned" ? "Search to add to collection…" : "Search to add to wishlist…",
      includeRecentlyPlayed: true,
      onPick: async (game) => {
        setNote("", false);
        try {
          await window.Collection.add(game.id, opts.status);
        } catch (e) {
          const msg = (e && e.message) || "Couldn't add — try again.";
          setNote(msg, true);
          // Refuse so the dropdown stays open and the user can pick again.
          return { refuse: true, reason: "Couldn't add — try again." };
        }
        // Patch the cached myCollectionMap so other surfaces see the new
        // pill immediately. Shared with the status sheet and the Add Games
        // page — see Collection.applyLocalStatus.
        window.Collection.applyLocalStatus(game.id, opts.status);
        if (typeof opts.onAdded === "function") {
          try { opts.onAdded(game, opts.status); } catch (_) {}
        }
        dismiss();
      },
      onError: (e) => {
        setNote((e && e.message) || "Something went wrong.", true);
      },
    });
    const mount = /** @type {HTMLElement|null} */ (root.querySelector("[data-finder-mount]"));
    if (mount) _finder.mount(mount);
    // Focus the dialog itself, NOT the finder's input: opening a popup must
    // not pre-select a text field, because that raises the software keyboard
    // over the card the user just opened (.claude/rules/overlays.md §5).
    // Tapping the search box is the opt-in. The card still takes focus so a
    // screen reader reads the modal's label and Tab walks its controls rather
    // than the page behind it; deferred a tick so the browser isn't fighting
    // the open animation for it.
    const card = /** @type {HTMLElement|null} */ (root.querySelector(".add-game-modal"));
    requestAnimationFrame(() => {
      if (card && card.isConnected) card.focus({ preventScroll: true });
    });

    _escHandler = (e) => {
      if (e.key === "Escape") {
        // GameFinder's own Esc handler closes the dropdown first when it's
        // open; this listener only catches the second Esc when focus is on
        // the input but the dropdown is already closed, or when focus is
        // elsewhere in the modal.
        const dd = _finder && document.getElementById(_finder.dropdownId);
        if (dd && !dd.classList.contains("hidden")) return;
        dismiss();
      }
    };
    document.addEventListener("keydown", _escHandler, true);
  }

  function dismiss() {
    if (window.BgbBackGuard) window.BgbBackGuard.release(_back);
    _back = 0;
    if (_finder) { try { _finder.unmount(); } catch (_) {} _finder = null; }
    if (_escHandler) {
      document.removeEventListener("keydown", _escHandler, true);
      _escHandler = null;
    }
    const existing = document.getElementById(BACKDROP_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (_previousFocus && typeof _previousFocus.focus === "function") {
      try { _previousFocus.focus(); } catch (_) {}
    }
    _previousFocus = null;
  }

  window.AddGameModal = { open, dismiss };
})();
