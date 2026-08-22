// ui/game-card.js — Polaroid-style game tile (the canonical reusable game
// component). The "Find a Game" grid on the Host/Join landing is its only
// caller today; other game surfaces use bespoke tiles (see UI_AUDIT.md §5c).

(function () {

  // Polaroid-style game tile for the "Find a Game that fits" grid on the
  // host/join landing. Cream surface + Fraunces caption matching the play
  // cards. clickHandler is the raw JS to run on tap (e.g.
  // "window.logPlayView._pickFromGrid('uuid')"). collectionStatus drives
  // the corner badge (owned / wishlist / played / null → "+" button).
  /**
   * @param {any} game
   * @param {Object} [opts]
   * @param {string} [opts.clickHandler] Raw JS run on tap.
   * @param {string|null} [opts.collectionStatus] owned / wishlist / played / null.
   * @param {boolean} [opts.eager] Load the photo eagerly instead of lazily.
   *   Callers that render a single-viewport grid (the explorer's 3x3) pass
   *   this: a lazy image is not loaded synchronously on insertion, so a
   *   freshly-built card shows an empty photo box for at least one frame even
   *   when the bytes are already in cache. Off by default — long scrolling
   *   lists still want lazy.
   */
  function renderGamePolaroid(game, { clickHandler = "", collectionStatus = null, eager = false } = {}) {
    const img = game.thumbnail_url || game.image_url || "";
    const players = game.min_players
      ? `${game.min_players}${game.max_players && game.max_players !== game.min_players ? "–" + game.max_players : ""}P`
      : "";
    const time = game.playing_time ? `${game.playing_time}m` : "";
    const meta = [players, time].filter(Boolean).join(" · ");
    // Compact status pill in the photo's top-right. Wrapper stops the tap
    // from bubbling to the article (which would jump into Gather). Matches
    // the play-card's status overlay behaviour.
    const statusOverlay = game.id
      ? `<span class="game-polaroid__status" onclick="event.stopPropagation()">${window.renderStatusTag(game.id, collectionStatus, { compact: true })}</span>`
      : "";
    return `
      <article class="game-polaroid"
               role="button" tabindex="0"
               data-game-id="${escapeHtml(game.id || "")}"
               data-status="${escapeHtml(collectionStatus || "")}"
               onclick="${clickHandler}">
        <div class="game-polaroid__photo">
          ${img
            ? `<img class="game-polaroid__photo-img" src="${escapeHtml(img)}" alt=""${eager ? "" : ` loading="lazy"`} />`
            : `<div class="game-polaroid__photo-placeholder"><i data-lucide="dice-6"></i></div>`}
          ${statusOverlay}
        </div>
        <div class="game-polaroid__caption">
          <div class="game-polaroid__name">${escapeHtml(game.name || "Unknown game")}</div>
          ${meta ? `<div class="game-polaroid__meta">${escapeHtml(meta)}</div>` : ""}
        </div>
      </article>
    `;
  }

  window.renderGamePolaroid = renderGamePolaroid;
})();
