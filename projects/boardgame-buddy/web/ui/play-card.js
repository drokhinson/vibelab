// ui/play-card.js — Strava-style play card rendered in the Feed and Profile.

(function () {
  function initials(name) {
    const parts = (name || "").trim().split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  }

  function renderPlayCard(card) {
    const u = card.user || {};
    const g = card.game || {};
    const accent = g.theme_color || "#C9922A";
    const hasUserPhoto = !!card.photo_url;
    const gameThumb = g.thumbnail_url || g.image_url || "";

    // Winners + players collapse into a single dot-separated meta row so the
    // card carries them on one line instead of two stacked.
    const winnerChip = card.winner_display_name
      ? `<span class="play-card__meta-chip play-card__meta-chip--winner">
           <i data-lucide="trophy" class="w-3.5 h-3.5"></i> ${escapeHtml(card.winner_display_name)} won
         </span>`
      : "";
    const playersChip = card.participant_count
      ? `<span class="play-card__meta-chip">
           <i data-lucide="users" class="w-3.5 h-3.5"></i> ${card.participant_count} ${card.participant_count === 1 ? "player" : "players"}
         </span>`
      : "";
    const metaRow = (winnerChip || playersChip)
      ? `<div class="play-card__meta-row">${winnerChip}${playersChip}</div>`
      : "";

    // When the play has a user-uploaded photo, render the box-art thumbnail
    // as a small overlay in the bottom-right corner (Strava-style "map" badge).
    // When there's no photo, fall back to a plain box-art hero so the card
    // always has a visual anchor.
    let media = "";
    if (hasUserPhoto) {
      media = `
        <div class="play-card__photo" onclick="window.router.go('game-detail',{gameId:'${g.id}',gameName:'${jsStr(g.name || '')}'})">
          <img class="play-card__photo-img" src="${escapeAttr(card.photo_url)}" alt="" loading="lazy" />
          ${gameThumb ? `
            <div class="play-card__game-overlay">
              <img src="${escapeAttr(gameThumb)}" alt="${escapeAttr(g.name || "")}" loading="lazy" />
            </div>` : ""}
        </div>
      `;
    } else if (gameThumb) {
      media = `
        <div class="play-card__photo play-card__photo--game-only" onclick="window.router.go('game-detail',{gameId:'${g.id}',gameName:'${jsStr(g.name || '')}'})">
          <img class="play-card__photo-img" src="${escapeAttr(gameThumb)}" alt="" loading="lazy" />
        </div>
      `;
    }

    // Title structure: avatar dot, then a single sentence
    //   "<Username> played <Game name>"
    // smaller than the old display-font headline, with the play date on
    // the line below. The username links to the user's profile, the game
    // name links to the game detail.
    const userName = escapeHtml(u.display_name || "Unknown");
    const gameName = escapeHtml(g.name || "Unknown game");
    return `
      <article class="play-card" style="--game-accent:${accent}">
        <header class="play-card__header">
          <div class="play-card__avatar"
               onclick="window.router.go('profile-other',{userId:'${u.id}'})">
            ${u.avatar_url
              ? `<img src="${escapeAttr(u.avatar_url)}" alt="" />`
              : initials(u.display_name)}
          </div>
          <div class="play-card__author">
            <div class="play-card__title">
              <a class="play-card__user-link"
                 onclick="window.router.go('profile-other',{userId:'${u.id}'})">${userName}</a>
              <span class="play-card__title-verb">played</span>
              <a class="play-card__game-link"
                 onclick="window.router.go('game-detail',{gameId:'${g.id}',gameName:'${jsStr(g.name || '')}'})">${gameName}</a>
            </div>
            <div class="play-card__time">${formatPlayedAt(card.played_at)}</div>
          </div>
        </header>
        ${media}
        ${metaRow}
        ${card.notes ? `<p class="play-card__notes">${escapeHtml(card.notes)}</p>` : ""}
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
