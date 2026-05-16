// ui/play-card.js — Strava-style play card rendered in the Feed and Profile.

(function () {
  function formatRelative(iso) {
    if (!iso) return "";
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diff = Math.max(0, now - then);
    const min = Math.round(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.round(hr / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function initials(name) {
    const parts = (name || "").trim().split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  }

  function renderPlayCard(card) {
    const u = card.user || {};
    const g = card.game || {};
    const photo = card.photo_url || g.image_url || g.thumbnail_url || "";
    const accent = g.theme_color || "#C9922A";
    const winnerLine = card.winner_display_name
      ? `<div class="play-card__winner"><i data-lucide="trophy" class="w-3.5 h-3.5"></i> ${escapeHtml(card.winner_display_name)} won</div>`
      : "";
    const participants = card.participant_count
      ? `<span class="play-card__meta-chip"><i data-lucide="users" class="w-3.5 h-3.5"></i> ${card.participant_count}</span>`
      : "";

    return `
      <article class="play-card" style="--game-accent:${accent}">
        <header class="play-card__header" onclick="window.router.go('profile-other',{userId:'${u.id}'})">
          <div class="play-card__avatar">${u.avatar_url
            ? `<img src="${escapeAttr(u.avatar_url)}" alt="" />`
            : initials(u.display_name)
          }</div>
          <div class="play-card__author">
            <div class="play-card__name">${escapeHtml(u.display_name || "Unknown")}</div>
            <div class="play-card__time">${formatRelative(card.created_at)}</div>
          </div>
        </header>
        <div class="play-card__game" onclick="window.router.go('game-detail',{gameId:'${g.id}'})">
          <span class="play-card__game-name">${escapeHtml(g.name || "Unknown game")}</span>
        </div>
        ${photo ? `<div class="play-card__photo"><img src="${escapeAttr(photo)}" alt="" loading="lazy" /></div>` : ""}
        ${winnerLine}
        ${card.notes ? `<p class="play-card__notes">${escapeHtml(card.notes)}</p>` : ""}
        <footer class="play-card__footer">
          ${participants}
          <span class="play-card__meta-chip"><i data-lucide="calendar" class="w-3.5 h-3.5"></i> ${formatPlayedAt(card.played_at)}</span>
        </footer>
      </article>
    `;
  }

  function formatPlayedAt(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  window.renderPlayCard = renderPlayCard;
})();
