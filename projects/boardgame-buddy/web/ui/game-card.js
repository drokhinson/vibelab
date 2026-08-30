// ui/game-card.js — the canonical Game tile (.claude/rules/ui-object-design.md §2).
//
// Surfaces differ by `variant`, never by a parallel implementation:
//   "polaroid" (default) — cream tile for the Game Explorer / Find-a-Game grid
//   "rail"               — compact tile for the feed's horizontal rails
//   "row"                — horizontal list row for the Collection spoke's
//                          Expansions tree (same markup, different axis)
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
   * @param {"polaroid"|"rail"|"row"} [opts.variant] Surface preset. Default "polaroid".
   * @param {boolean} [opts.showStatus] Render the corner status pill. The
   *   Expansions tree turns this off: every row there is owned by definition,
   *   so the pill would be a column of identical badges.
   * @param {boolean} [opts.interactive] Whether the tile is itself a tap
   *   target. Off for a tile nested inside another interactive element — the
   *   tree's group headers are disclosure buttons, and a role="button" tile
   *   inside a <button> is invalid. Default true.
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
  // ── The corner chip: one writer, three callers ────────────────────────────
  //
  // Three code paths paint the same .game-polaroid__status host — this file on
  // the initial render, feed-view's _syncStatusPills and game-explorer-view's
  // _syncCardStatus on a `status-changed` repaint. All three used to spell the
  // renderStatusTag opts out by hand, which is instance #3 of five lines that
  // silently drift apart (.claude/rules/ui-object-design.md §4). The opts are
  // written once here, and the repaint itself is a function rather than a
  // recipe, so a fourth surface can't invent a fourth spelling.

  /** @returns {string} */
  function statusHtml(game, collectionStatus, pending) {
    return window.renderStatusTag(game && game.id, collectionStatus || null, {
      corner: true,
      pending: !!pending,
      gameName: (game && game.name) || "",
    });
  }

  /**
   * Patch a MOUNTED .game-polaroid's corner chip in place, keeping data-status
   * in step and re-hydrating the glyph. A no-op when nothing changed — the diff
   * guard moved here from game-explorer-view so the feed gets it too.
   *
   * Re-running the icon pass is not optional: the chip is written as
   * `<i data-icon>` and stays an empty <i> until BgbIcons hydrates it
   * (.claude/rules/mobile-web.md §4).
   *
   * @param {Element} tile A .game-polaroid — it carries data-game-id/-name.
   * @param {(string|null)} status
   * @returns {boolean} Whether the DOM actually changed.
   */
  function syncGamePolaroidStatus(tile, status) {
    if (!tile) return false;
    const next = status || "";
    if (tile.getAttribute("data-status") === next) return false;
    tile.setAttribute("data-status", next);
    const host = tile.querySelector(".game-polaroid__status");
    if (!host) return false;
    host.innerHTML = statusHtml(
      { id: tile.getAttribute("data-game-id") || "", name: tile.getAttribute("data-game-name") || "" },
      status || null,
      false
    );
    if (window.BgbIcons) window.BgbIcons.render(host);
    return true;
  }

  function renderGamePolaroid(game, {
    clickHandler = "",
    collectionStatus = null,
    eager = false,
    variant = "polaroid",
    meta: metaOverride = null,
    badgeHtml = "",
    pending = false,
    showStatus = true,
    interactive = true,
  } = {}) {
    const players = game.min_players
      ? `${game.min_players}${game.max_players && game.max_players !== game.min_players ? "–" + game.max_players : ""}P`
      : "";
    const time = game.playing_time ? `${game.playing_time}m` : "";
    const meta = metaOverride != null ? metaOverride : [players, time].filter(Boolean).join(" · ");
    // Corner status chip in the photo's top-right. Wrapper stops the tap
    // from bubbling to the article (which would jump into Gather). Matches
    // the play-card's status overlay behaviour.
    const statusOverlay = (game.id && showStatus)
      ? `<span class="game-polaroid__status" onclick="event.stopPropagation()">${statusHtml(game, collectionStatus, pending)}</span>`
      : "";
    return `
      <article class="game-polaroid game-polaroid--${escapeHtml(variant)}"
               ${interactive ? `role="button" tabindex="0"` : ""}
               data-game-id="${escapeHtml(game.id || "")}"
               data-game-name="${escapeHtml(game.name || "")}"
               data-status="${escapeHtml(collectionStatus || "")}"
               ${interactive ? `onclick="${clickHandler}"` : ""}>
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
  window.syncGamePolaroidStatus = syncGamePolaroidStatus;
  window.scheduleRailTitleFit = scheduleRailTitleFit;
})();
