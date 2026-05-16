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

  window.renderGameCard = renderGameCard;
})();
