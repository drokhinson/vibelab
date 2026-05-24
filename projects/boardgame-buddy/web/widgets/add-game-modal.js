// widgets/add-game-modal.js — Modal for adding a game to Collection or
// Wishlist from the spoke header. Hosts a GameFinder; picking a game calls
// Collection.add(game.id, status) and dispatches `status-changed` so any
// live grids re-render their pills.
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
   * @property {(game: any, status: string) => void} [onAdded]
   */

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  let _previousFocus = null;
  let _finder = null;
  let _escHandler = null;

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
           role="dialog" aria-modal="true" aria-label="${escape(title)}">
        <button class="polaroid-popup__close" aria-label="Close">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
        <div class="polaroid-popup__title">${escape(title)}</div>
        <p class="polaroid-popup__body add-game-modal__hint">
          Search your BoardgameBuddy library, or import from BoardGameGeek.
        </p>
        <div class="add-game-modal__body" data-finder-mount></div>
        <div class="add-game-modal__note" hidden></div>
      </div>
    `;
    root.addEventListener("click", (ev) => {
      if (ev.target === root) dismiss();
    });
    document.body.appendChild(root);
    if (window.lucide) window.lucide.createIcons();

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
        // pill immediately (mirrors ui/status-tag.js _choose).
        const cur = (window.store && window.store.get && window.store.get("myCollectionMap")) || {};
        window.store.set("myCollectionMap", { ...cur, [game.id]: opts.status });
        document.dispatchEvent(new CustomEvent("status-changed", {
          detail: { gameId: game.id, status: opts.status },
        }));
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
    // Defer focus to next tick so the input exists in the DOM and the
    // browser doesn't fight the modal's open animation for focus.
    requestAnimationFrame(() => { if (_finder) _finder.focus(); });

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
