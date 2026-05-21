// ui/game-card.js — Game tile w/ persistent status badge. Used in search
// results and the (future) collection grid.

(function () {
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function renderGameCard(game, { collectionStatus = null, footer = "" } = {}) {
    const accent = game.theme_color || "#C9922A";
    const badge = collectionStatus
      ? `<div class="game-card__status status-badge status-badge--${collectionStatus}">
           <i data-lucide="${collectionStatus === "owned" ? "library-big" : "star"}" class="w-3.5 h-3.5"></i>${collectionStatus}
         </div>`
      : "";
    const img = game.thumbnail_url || game.image_url || "";
    return `
      <article class="game-card" style="--game-accent:${accent}"
               onclick="window.router.go('game-detail',{gameId:'${game.id}',gameName:'${jsStr(game.name)}'})">
        ${badge}
        <div class="game-card__thumb">
          ${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" />` : `<div class="game-card__thumb-placeholder"><i data-lucide="dice-6"></i></div>`}
        </div>
        <div class="game-card__body">
          <h3 class="game-card__name">${escapeHtml(game.name || "Unknown game")}</h3>
          <div class="game-card__meta">
            ${game.year_published ? `<span>${game.year_published}</span>` : ""}
            ${game.min_players ? `<span>${game.min_players}${game.max_players && game.max_players !== game.min_players ? "–" + game.max_players : ""}P</span>` : ""}
            ${game.playing_time ? `<span>${game.playing_time}m</span>` : ""}
          </div>
        </div>
        ${footer}
      </article>
    `;
  }

  // Polaroid-style game tile for the "Find a Game that fits" grid on the
  // host/join landing. Cream surface + Fraunces caption matching the play
  // cards. clickHandler is the raw JS to run on tap (e.g. "window.logPlayView._pickFromGrid('uuid')").
  function renderGamePolaroid(game, { clickHandler = "" } = {}) {
    const img = game.thumbnail_url || game.image_url || "";
    const players = game.min_players
      ? `${game.min_players}${game.max_players && game.max_players !== game.min_players ? "–" + game.max_players : ""}P`
      : "";
    const time = game.playing_time ? `${game.playing_time}m` : "";
    const meta = [players, time].filter(Boolean).join(" · ");
    return `
      <article class="game-polaroid"
               role="button" tabindex="0"
               onclick="${clickHandler}">
        <div class="game-polaroid__photo">
          ${img
            ? `<img class="game-polaroid__photo-img" src="${escapeHtml(img)}" alt="" loading="lazy" />`
            : `<div class="game-polaroid__photo-placeholder"><i data-lucide="dice-6"></i></div>`}
        </div>
        <div class="game-polaroid__caption">
          <div class="game-polaroid__name">${escapeHtml(game.name || "Unknown game")}</div>
          ${meta ? `<div class="game-polaroid__meta">${escapeHtml(meta)}</div>` : ""}
        </div>
      </article>
    `;
  }

  window.renderGameCard = renderGameCard;
  window.renderGamePolaroid = renderGamePolaroid;
})();
