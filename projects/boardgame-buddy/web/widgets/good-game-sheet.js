// @ts-check
// widgets/good-game-sheet.js — who said good game to a night.
//
// Opened by pressing and holding the handshake on a feed session header
// (views/feed-view.js), or by tapping it when it is only a tally. Each row
// is a person; tapping one closes the sheet and opens their profile.
//
// The feed payload carries at most 8 reactors per play (the RPC caps them),
// while the count is exact. A night with more reactors than rows ends with an
// "and N more" line rather than pretending the list is complete.
//
// Its class is named in the theme re-point list in styles.css; a body-level
// sheet lands outside the screen that opened it (.claude/rules/theming.md §8).

(function () {
  /**
   * @typedef {Object} GoodGameReactor
   * @property {string} user_id
   * @property {string|null} [display_name]
   * @property {any} [avatar]
   */

  /**
   * @typedef {Object} GoodGameSheetOpts
   * @property {number} count                  The exact reaction total.
   * @property {GoodGameReactor[]} reactors    Who, newest first; may be fewer than count.
   * @property {string|null} viewerId
   * @property {Element|null} [returnFocus]
   */

  const sheet = new window.BgbBottomSheet({
    id: "bgb-good-game-sheet",
    className: "gg-sheet",
    label: "Who said good game",
  });

  /** @param {GoodGameReactor} r @param {string|null} viewerId */
  function row(r, viewerId) {
    const isMe = !!viewerId && r.user_id === viewerId;
    const name = isMe
      ? "You"
      : window.Buddy.nameFor(r.user_id, r.display_name) || "Someone";
    const me = isMe && window.store && window.store.get && window.store.get("user");
    const badge = window.BgbBadge.render({
      avatar: r.avatar || (me && me.avatar) || window.Buddy.avatarFor(r.user_id),
      // The real name, so the viewer's own badge carries their initials
      // rather than "YO".
      displayName: isMe ? (r.display_name || name) : name,
      size: "sm",
      isMe,
    });
    return `
      <button type="button" class="bgb-sheet__opt gg-sheet__row"
              data-user-id="${escapeAttr(r.user_id)}">
        ${badge}
        <span class="bgb-sheet__opt-label">${escapeHtml(name)}</span>
        <i data-icon="chevron-right" class="w-4 h-4"></i>
      </button>
    `;
  }

  /** @param {GoodGameSheetOpts} opts */
  function render(opts) {
    // The viewer leads, as in every other name list in the app.
    const people = [...opts.reactors].sort((a, b) =>
      Number(b.user_id === opts.viewerId) - Number(a.user_id === opts.viewerId));
    const more = Math.max(0, opts.count - people.length);
    return `
      <div class="bgb-sheet__panel gg-sheet__panel" tabindex="-1">
        <div class="bgb-sheet__grip" aria-hidden="true"></div>
        <h3 class="bgb-sheet__title">Good game</h3>
        <p class="bgb-sheet__sub">${opts.count} ${opts.count === 1 ? "person" : "people"} said good game</p>
        <div class="bgb-sheet__list">
          ${people.map((r) => row(r, opts.viewerId)).join("")}
          ${more ? `<p class="gg-sheet__more">and ${more} more</p>` : ""}
        </div>
        <button type="button" class="bgb-sheet__cancel" data-action="close">Close</button>
      </div>
    `;
  }

  window.BgbGoodGameSheet = {
    /** @param {GoodGameSheetOpts} opts */
    open(opts) {
      if (!opts.count) return;
      sheet.open({
        html: render(opts),
        returnFocus: opts.returnFocus || null,
        onClick(e) {
          const btn = /** @type {HTMLElement|null} */ (e.target.closest("[data-user-id]"));
          if (!btn) return;
          const userId = btn.dataset.userId;
          sheet.close();
          if (opts.viewerId && userId === opts.viewerId) window.router.go("profile-self");
          else window.router.go("profile-other", { userId });
        },
        onOpen(root) {
          const first = /** @type {HTMLElement|null} */ (root.querySelector(".gg-sheet__row"));
          (first || /** @type {HTMLElement|null} */ (root.querySelector(".bgb-sheet__panel")))?.focus();
        },
      });
    },
  };
})();
