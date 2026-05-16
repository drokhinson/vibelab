// domain/status.js — Collection status enum + small UI helpers.

(function () {
  const OWNED    = "owned";
  const WISHLIST = "wishlist";
  const NONE     = "none";

  const LABEL = {
    [OWNED]:    "Owned",
    [WISHLIST]: "Wishlist",
    [NONE]:     "Not in collection",
  };

  const ICON = {
    [OWNED]:    "library-big",
    [WISHLIST]: "star",
    [NONE]:     "circle-plus",
  };

  // Cycle order for the bookmark toggle on a game card / detail. The user
  // taps once to move from NONE → OWNED → WISHLIST → NONE.
  const CYCLE = [NONE, OWNED, WISHLIST];

  class Status {
    static get OWNED()    { return OWNED; }
    static get WISHLIST() { return WISHLIST; }
    static get NONE()     { return NONE; }

    static label(s) { return LABEL[s || NONE] || LABEL[NONE]; }
    static icon(s)  { return ICON[s || NONE] || ICON[NONE]; }

    static next(s) {
      const i = CYCLE.indexOf(s || NONE);
      return CYCLE[(i + 1) % CYCLE.length];
    }

    static badgeHTML(s) {
      if (!s || s === NONE) return "";
      return `<span class="status-badge status-badge--${s}">
        <i data-lucide="${ICON[s]}" class="w-3.5 h-3.5"></i>${LABEL[s]}
      </span>`;
    }
  }

  window.Status = Status;
})();
