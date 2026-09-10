// ui/preview-card.js — the hub card the two profile screens share.
//
// A profile hub is a stack of these: an icon, a title, a count line, a See all
// button, and a body that is a strip of game covers or a list of play rows.
// The hub (views/profile-self-view.js) and another user's profile
// (views/profile-other-view.js) show the same objects on the same card, so
// the markup lives here once (.claude/rules/ui-object-design.md §2). The
// `.preview-card*` CSS family is this component's.

(function () {
  /**
   * The corner badge a hub card wears when something behind it is waiting —
   * buddy requests, ghost link requests, unseen achievements. The number is
   * aria-hidden and the phrase beside it carries the meaning, because "3"
   * alone in a card corner tells a screen reader nothing about what there
   * are three of.
   * @param {number} n
   * @param {string} label
   */
  function countBadge(n, label) {
    if (!n) return "";
    return `
      <span class="preview-card__count">
        <span aria-hidden="true">${n > 99 ? "99+" : n}</span>
        <span class="bgb-vis-hidden">${escapeHtml(label)}</span>
      </span>`;
  }

  /**
   * @param {Object} o
   * @param {string} o.icon          Chrome icon name.
   * @param {string} o.title
   * @param {string} o.sub           Count line beside the title.
   * @param {string} o.body          Pre-rendered HTML.
   * @param {string} [o.route]       View the See all button opens…
   * @param {string} [o.seeAllJs]    …or the raw JS it runs instead.
   * @param {number} [o.badge]       Corner count, 0 for none.
   * @param {string} [o.badgeLabel]  What the count is a count of.
   */
  function render({ icon, title, sub, body, route, seeAllJs, badge = 0, badgeLabel = "" }) {
    const go = seeAllJs || `window.router.go('${jsStr(route)}')`;
    return `
      <section class="preview-card">
        ${countBadge(badge, badgeLabel)}
        <header class="preview-card__head">
          <span class="preview-card__icon"><i data-icon="${escapeAttr(icon)}" class="w-4 h-4"></i></span>
          <h3 class="preview-card__title font-display">${escapeHtml(title)}</h3>
          <span class="preview-card__sub">${escapeHtml(sub)}</span>
          <button class="preview-card__seeall" onclick="${escapeAttr(go)}">
            See all <i data-icon="chevron-right" class="w-3 h-3"></i>
          </button>
        </header>
        <div class="preview-card__body">${body}</div>
      </section>
    `;
  }

  /** One game in the covers strip. @param {{game?: Object, status?: string}} item */
  function cover(item) {
    const g = item.game || {};
    // owned_page carries prev_owned rows while owned_total counts only what
    // is still owned, so a sold game can take a slot in this strip. Dimmed,
    // matching the Collection grid — no stamp, which is unreadable at this
    // size; the title attribute and the spoke behind it carry the detail.
    const parted = item.status === "prev_owned" ? " is-prev-owned" : "";
    return `
      <div class="preview-card__cover${parted}" onclick="${escapeAttr(gameDetailJs(g.id, g.name))}"
           title="${escapeAttr(g.name || "")}">
        ${gameArtImg(g, "card", { alt: g.name || "" })
          || `<div class="preview-card__cover-fallback">${escapeHtml((g.name || "?").slice(0, 14))}</div>`}
      </div>
    `;
  }

  /** One play in the plays list. The "Won" tag is the viewer's own win. */
  function playRow(p) {
    const me = window.store.get("user");
    const winners = (p.players || []).filter((pl) => pl.is_winner);
    // Match on user_id first, fall back to display_name (older plays may not
    // carry user_id on every player row).
    const youWon = winners.some((w) =>
      (w.user_id && me && w.user_id === me.id) ||
      (me && (w.name || "") === (me.display_name || ""))
    );
    const playerCount = (p.players || []).length;
    const gameNav = escapeAttr(gameDetailJs(p.game_id, p.game_name, { stop: true }));
    return `
      <li class="preview-card__play" onclick="window.PlayDetailPopup.show('${escapeAttr(jsStr(p.id))}')">
        ${p.game_thumbnail
          ? `<img class="preview-card__play-thumb" src="${escapeAttr(p.game_thumbnail)}" alt="" onclick="${gameNav}" />`
          : `<div class="preview-card__play-thumb preview-card__play-thumb--placeholder"><i data-icon="dice-6" class="w-4 h-4"></i></div>`}
        <div class="preview-card__play-info">
          <div class="preview-card__play-name">
            ${escapeHtml(p.game_name || "")}
            ${youWon ? `<span class="preview-card__play-won"><i data-icon="trophy" class="w-3 h-3"></i> Won</span>` : ""}
          </div>
          ${playerCount > 0 ? `<div class="preview-card__play-meta">${playerCount} ${playerCount === 1 ? "player" : "players"}</div>` : ""}
        </div>
        <div class="preview-card__play-date">${formatDateShort(p.played_at)}</div>
      </li>
    `;
  }

  window.BgbPreviewCard = { render, cover, playRow, countBadge };
})();
