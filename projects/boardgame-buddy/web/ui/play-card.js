// ui/play-card.js — Strava-style play card rendered in the Feed and Profile.
//
// Two-faced card:
//   Front  → "<Username> played <Game>" header (date right-aligned), optional
//            user photo or capped box-art row, winner chip, notes.
//   Back   → read-only: game title, winners line, players + scores, plus a
//            maximize button (top-right corner) that opens the full
//            play-detail page. Notes and expansions live on the front and
//            the play-detail page; all editing happens on the play-detail
//            page.
//
// Clicking the game-name text, any box-art image, or the maximize button
// navigates (data-no-flip). Clicking anywhere else on the card flips it.
// State lives in a module-level Map keyed by play_id so flipping re-renders
// only the affected <article> via outerHTML replacement — the feed scroll
// position is preserved.

(function () {
  // Per-play state lives outside the render so re-renders are cheap and
  // scoped: { flipped, hydrated (full PlayResponse), hydrating, error }.
  const cardState = new Map();

  function getState(playId) {
    let s = cardState.get(playId);
    if (!s) {
      s = {
        flipped: false,
        hydrated: null,
        hydrating: false,
        error: null,
      };
      cardState.set(playId, s);
    }
    return s;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  function renderPlayCard(card) {
    const s = getState(card.play_id);
    const accent = (card.game && card.game.theme_color) || "#C9922A";
    const flippedAttr = s.flipped ? " is-flipped" : "";
    return `
      <article class="play-card${flippedAttr}"
               data-play-id="${escapeAttr(card.play_id)}"
               style="--game-accent:${escapeAttr(accent)}"
               role="button" tabindex="0"
               aria-expanded="${s.flipped ? "true" : "false"}"
               onclick="window.playCardFlip.handleClick(event, '${escapeAttr(card.play_id)}')"
               onkeydown="window.playCardFlip.handleKey(event, '${escapeAttr(card.play_id)}')">
        <div class="play-card__inner">
          <div class="play-card__front">${renderFront(card)}</div>
          <div class="play-card__back">${renderBack(card, s)}</div>
        </div>
      </article>
    `;
  }

  function renderFront(card) {
    const u = card.user || {};
    const g = card.game || {};
    const me = window.store && window.store.get && window.store.get("user");
    // Self-attribution: when the play's logger is the current user, swap the
    // display name for "You" so the feed reads "You played Catan" instead of
    // echoing your own name back. Winner attribution uses the same trick —
    // matched by display name since the feed payload doesn't carry the
    // winner's user_id.
    const isSelf = !!(me && u.id && me.id === u.id);
    const userName = isSelf ? "You" : escapeHtml(u.display_name || "Unknown");
    const gameName = escapeHtml(g.name || "Unknown game");
    const hasUserPhoto = !!card.photo_url;
    const gameThumb = g.thumbnail_url || g.image_url || "";
    const gameNav = `event.stopPropagation(); window.router.go('game-detail',{gameId:'${escapeAttr(g.id || "")}',gameName:'${jsStr(g.name || "")}'})`;

    const winnerIsSelf = !!(me && me.display_name && card.winner_display_name === me.display_name);
    const winnerChip = card.winner_display_name
      ? `<span class="play-card__meta-chip play-card__meta-chip--winner">
           <i data-lucide="trophy" class="w-3.5 h-3.5"></i> ${winnerIsSelf ? "You" : escapeHtml(card.winner_display_name)} won
         </span>`
      : "";
    const notesBlock = card.notes ? `<p class="play-card__notes">${escapeHtml(card.notes)}</p>` : "";

    // Status overlay reads the viewer's collection map straight from the
    // store so it stays in sync without threading state through the feed.
    // The status picker patches the same map on mutation (see status-tag.js),
    // so a tap → pick cycle reflects in the card immediately.
    const statusMap = (window.store && window.store.get && window.store.get("myCollectionMap")) || {};
    const gameStatus = (g.id && statusMap[g.id]) || null;
    const statusOverlay = g.id
      ? `<span class="play-card__status-overlay" data-no-flip>${window.renderStatusTag(g.id, gameStatus, { compact: true })}</span>`
      : "";

    // Layout split by presence of a user-uploaded photo:
    //   - With user photo: stretched hero + corner box-art badge, with the
    //     winner chip then notes stacked underneath.
    //   - Without: a horizontal row — square box art on the left, winner
    //     chip on the right — then notes at full width below, matching the
    //     with-photo flow (photo → winner → notes).
    let body = "";
    if (hasUserPhoto) {
      body = `
        <div class="play-card__photo">
          <img class="play-card__photo-img" src="${escapeAttr(card.photo_url)}" alt="" loading="lazy" />
          ${statusOverlay}
          ${gameThumb ? `
            <div class="play-card__game-overlay" data-no-flip onclick="${gameNav}">
              <img src="${escapeAttr(gameThumb)}" alt="${escapeAttr(g.name || "")}" loading="lazy" />
            </div>` : ""}
        </div>
        ${winnerChip ? `<div class="play-card__meta-row">${winnerChip}</div>` : ""}
        ${notesBlock}
      `;
    } else if (gameThumb) {
      body = `
        <div class="play-card__no-photo-row">
          <div class="play-card__box" data-no-flip onclick="${gameNav}">
            <img src="${escapeAttr(gameThumb)}" alt="${escapeAttr(g.name || "")}" loading="lazy" />
            ${statusOverlay}
          </div>
          <div class="play-card__no-photo-meta">
            ${winnerChip}
          </div>
        </div>
        ${notesBlock}
      `;
    } else {
      // No photo and no box art — show whatever meta we have on its own.
      body = `
        ${winnerChip ? `<div class="play-card__meta-row">${winnerChip}</div>` : ""}
        ${notesBlock}
      `;
    }

    return `
      <header class="play-card__header">
        <div class="play-card__title">
          <span class="play-card__user-name">${userName}</span>
          <span class="play-card__title-verb">played</span>
          <a class="play-card__game-link" data-no-flip onclick="${gameNav}">${gameName}</a>
        </div>
        <div class="play-card__time">${formatPlayedAt(card.played_at)}</div>
      </header>
      ${body}
    `;
  }

  function renderBack(card, s) {
    if (s.hydrating) {
      return `<div class="play-card__back-loading">Loading play…</div>`;
    }
    if (s.error && !s.hydrated) {
      return `<div class="play-card__back-error">${escapeHtml(s.error)}</div>`;
    }
    const p = s.hydrated;
    if (!p) {
      // Not hydrated yet (e.g. card rendered while flipped=false). Show a
      // shell so the back has something behind the front during the rotation.
      return `<div class="play-card__back-loading">…</div>`;
    }
    const winners = (p.players || []).filter((pl) => pl.is_winner);
    const players = p.players || [];
    const me = window.store && window.store.get && window.store.get("user");
    const myName = me && me.display_name ? me.display_name : null;
    const winnerLabel = winners
      .map((w) => (myName && w.name === myName) ? "You" : escapeHtml(w.name))
      .join(", ");
    const detailNav = `event.stopPropagation(); window.router.go('play-detail',{playId:'${escapeAttr(card.play_id)}'})`;
    return `
      <button class="play-card__maximize" data-no-flip
              aria-label="Open play details"
              title="Open play details"
              onclick="${detailNav}">
        <i data-lucide="maximize-2" class="w-3.5 h-3.5"></i>
      </button>
      <header class="play-card__back-head">
        <span class="play-card__back-title">${escapeHtml(p.game_name || (card.game && card.game.name) || "")}</span>
      </header>

      ${winners.length > 0 ? `
        <div class="play-card__back-winners">
          <i data-lucide="trophy" class="w-3.5 h-3.5"></i>
          ${winnerLabel} won
        </div>` : ""}

      <ul class="play-card__back-players">
        ${players.length === 0
          ? `<li class="play-card__back-empty">No players recorded.</li>`
          : players.map((pl) => `
              <li class="play-card__back-player ${pl.is_winner ? "is-winner" : ""}">
                <span class="play-card__back-player-name">
                  ${pl.is_winner ? `<i data-lucide="trophy" class="w-3.5 h-3.5"></i> ` : ""}
                  ${escapeHtml(pl.name)}
                </span>
                <span class="play-card__back-player-score">${pl.score != null ? pl.score : ""}</span>
              </li>`).join("")}
      </ul>
    `;
  }

  // ── Single-card re-render (preserves feed scroll) ───────────────────────────

  function rerenderCard(playId) {
    const article = document.querySelector(
      `article.play-card[data-play-id="${cssEscape(playId)}"]`
    );
    if (!article) return;
    const card = findCardById(playId);
    if (!card) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = renderPlayCard(card).trim();
    const replacement = tmp.firstElementChild;
    article.replaceWith(replacement);
    if (window.lucide) window.lucide.createIcons();
  }

  function findCardById(playId) {
    const page = window.store && window.store.get && window.store.get("feed");
    if (!page || !page.cards) return null;
    return page.cards.find((c) => c.kind === "play" && c.play_id === playId);
  }

  // ── Flip controller (called from inline onclick handlers) ───────────────────

  const controller = {
    handleClick(event, playId) {
      const t = event.target;
      if (!t) return;
      // Anything in a no-flip subtree handles its own navigation (game-name
      // link, box-art, maximize button).
      if (t.closest && t.closest("[data-no-flip]")) return;
      // Buttons / form controls / links never flip the card.
      if (t.closest && t.closest("input, textarea, button, label, select")) return;
      if (t.closest && t.closest("a")) return;
      this.toggle(playId);
    },

    handleKey(event, playId) {
      if (event.key !== "Enter" && event.key !== " ") return;
      // Only handle when the article itself is focused, not a nested control.
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      this.toggle(playId);
    },

    async toggle(playId) {
      const s = getState(playId);
      const next = !s.flipped;
      s.flipped = next;
      if (next && !s.hydrated && !s.hydrating) {
        s.hydrating = true;
        s.error = null;
        rerenderCard(playId);
        try {
          s.hydrated = await window.Play.get(playId);
        } catch (e) {
          s.error = (e && e.message) || "Failed to load play details";
        } finally {
          s.hydrating = false;
          rerenderCard(playId);
        }
        return;
      }
      rerenderCard(playId);
    },
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

  function formatPlayedAt(iso) {
    if (!iso) return "";
    // played_at is a "YYYY-MM-DD" date — parse the parts in local time so the
    // Today/Yesterday comparison doesn't drift across the UTC date line (a
    // raw `new Date("2026-05-17")` parses as UTC midnight, which can read
    // as the previous day in negative-offset timezones).
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    const d = m
      ? new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))
      : new Date(iso);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const sameDay = (a, b) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
    if (sameDay(d, today)) return "Today";
    if (sameDay(d, yesterday)) return "Yesterday";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // For values interpolated into single-quoted JS strings inside onclick="".
  function jsStr(s) {
    return String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  // Used to build a CSS attribute selector — UUIDs are safe but the helper
  // keeps the selector robust if a non-UUID id ever flows through.
  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  window.renderPlayCard = renderPlayCard;
  window.playCardFlip = controller;
})();
