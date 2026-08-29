// ui/game-card.js — the canonical Game tile (.claude/rules/ui-object-design.md §2).
//
// Surfaces differ by `variant`, never by a parallel implementation:
//   "polaroid" (default) — cream tile for the Game Explorer / Find-a-Game grid
//   "rail"               — compact tile for the feed's horizontal rails
// The feed rails used to ship two byte-identical copies of a bespoke
// `.hot-game-tile`; both now come through here.

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
   * @param {"polaroid"|"rail"} [opts.variant] Surface preset. Default "polaroid".
   * @param {string} [opts.meta] Override the derived "3–5P · 60m" meta line
   *   (the rails show play counts or a last-played date instead).
   * @param {string} [opts.badgeHtml] Extra corner badge markup, e.g. the
   *   expansion-count chip. Rendered inside .game-polaroid__photo — it
   *   positions itself absolutely, so anchoring it to the article would put
   *   it over the caption.
   * @param {boolean} [opts.pending] Collection map still loading — the status
   *   tag renders empty rather than guessing "not owned".
   * @param {boolean} [opts.eager] Load the photo eagerly instead of lazily.
   *   Callers that render a single-viewport grid (the explorer's 3x3) pass
   *   this: a lazy image is not loaded synchronously on insertion, so a
   *   freshly-built card shows an empty photo box for at least one frame even
   *   when the bytes are already in cache. Off by default — long scrolling
   *   lists still want lazy.
   */
  function renderGamePolaroid(game, {
    clickHandler = "",
    collectionStatus = null,
    eager = false,
    variant = "polaroid",
    meta: metaOverride = null,
    badgeHtml = "",
    pending = false,
  } = {}) {
    const players = game.min_players
      ? `${game.min_players}${game.max_players && game.max_players !== game.min_players ? "–" + game.max_players : ""}P`
      : "";
    const time = game.playing_time ? `${game.playing_time}m` : "";
    const meta = metaOverride != null ? metaOverride : [players, time].filter(Boolean).join(" · ");
    // Compact status pill in the photo's top-right. Wrapper stops the tap
    // from bubbling to the article (which would jump into Gather). Matches
    // the play-card's status overlay behaviour.
    const statusOverlay = game.id
      ? `<span class="game-polaroid__status" onclick="event.stopPropagation()">${window.renderStatusTag(game.id, collectionStatus, { compact: true, pending, gameName: game.name })}</span>`
      : "";
    return `
      <article class="game-polaroid game-polaroid--${escapeHtml(variant)}"
               role="button" tabindex="0"
               data-game-id="${escapeHtml(game.id || "")}"
               data-game-name="${escapeHtml(game.name || "")}"
               data-status="${escapeHtml(collectionStatus || "")}"
               onclick="${clickHandler}">
        <div class="game-polaroid__photo">
          ${gameArtImg(game, "card", { cls: "game-polaroid__photo-img", eager })
            || `<div class="game-polaroid__photo-placeholder"><i data-icon="dice-6"></i></div>`}
          ${statusOverlay}
          ${badgeHtml}
        </div>
        <div class="game-polaroid__caption">
          <div class="game-polaroid__name"><span class="game-polaroid__name-text">${escapeHtml(game.name || "Unknown game")}</span></div>
          ${meta ? `<div class="game-polaroid__meta">${escapeHtml(meta)}</div>` : ""}
        </div>
      </article>
    `;
  }

  // ── Rail title sweep ───────────────────────────────────────────────────────
  // A rail tile is 112px wide, so plenty of game names don't fit. Rather than
  // truncate them, the title sweeps left and right (styles.css,
  // @keyframes railTitleSweep). Only JS knows how far to sweep, so it measures
  // the overflow and hands the animation two custom properties.
  //
  // Same shape as fitCaption() in ui/play-card.js, for the same two reasons:
  // measure from the un-swept state so the decision is idempotent no matter
  // how often this runs, and re-run on fonts.ready because a measurement taken
  // against the fallback font is wrong.

  let railFitQueued = false;

  function fitRailTitle(el) {
    el.classList.remove("is-sweeping");
    el.style.removeProperty("--sweep-shift");
    el.style.removeProperty("--sweep-dur");
    // Hidden view (the router keeps mounted views in the DOM) — measuring
    // would read 0 and wrongly settle the title. Leave it for the next pass.
    if (!el.clientWidth) return;
    const over = el.scrollWidth - el.clientWidth;
    if (over <= 1) return;
    el.style.setProperty("--sweep-shift", `-${over}px`);
    // ~26px/s each way plus ~3.4s of pauses: a longer title sweeps for longer
    // rather than faster, so the reading speed stays the same on every tile.
    el.style.setProperty("--sweep-dur", `${((over / 26) * 2 + 3.4).toFixed(2)}s`);
    el.classList.add("is-sweeping");
  }

  function scheduleRailTitleFit() {
    if (railFitQueued || typeof requestAnimationFrame !== "function") return;
    railFitQueued = true;
    requestAnimationFrame(() => {
      railFitQueued = false;
      document
        .querySelectorAll(".game-polaroid--rail .game-polaroid__name")
        .forEach(fitRailTitle);
    });
  }

  window.addEventListener("resize", scheduleRailTitleFit);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(scheduleRailTitleFit).catch(() => {});
  }

  window.renderGamePolaroid = renderGamePolaroid;
  window.scheduleRailTitleFit = scheduleRailTitleFit;
})();
