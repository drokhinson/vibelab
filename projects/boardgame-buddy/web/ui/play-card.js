// ui/play-card.js — Polaroid play card rendered in the Feed and Profile.
//
// Two-faced flip card styled like an instant photo: cream surface, soft drop
// shadow, slight tilt, photo at the top in its natural aspect ratio.
//   Front  → photo (with game-thumbnail badge in the bottom-right corner if
//            the user uploaded their own snapshot), then a caption row with
//            the game name on the left and the winner on the right. Front-side
//            notes only render on the single (non-session) variant.
//   Back   → game title + duration, ranked scoreboard with the winner row
//            tinted, optional notes, maximize button (top-right) into the
//            in-place play-detail popup, and a "Tap to flip back" footer.
//
// Clicking the game-name text, the game-thumbnail badge, or the maximize
// button navigates (data-no-flip). Clicking anywhere else on the card flips
// it. State lives in a module-level Map keyed by play_id so flipping
// re-renders only the affected <article> via outerHTML replacement — the
// feed scroll position is preserved.

(function () {
  // Per-play state lives outside the render so re-renders are cheap and
  // scoped: { flipped, hydrated (full PlayResponse), hydrating, error }.
  const cardState = new Map();

  // Photo aspect ratio cache, keyed by image URL. Populated by onPhotoLoad
  // after the image decodes; survives rerenderCard so a card that already
  // settled into is-portrait keeps that classification on subsequent renders.
  const aspectCache = new Map();

  // Registry of the latest card payload seen by `renderPlayCard`, keyed by
  // play_id. `rerenderCard` (called after a flip) looks the card up here so
  // any surface that renders via the shared component — feed, game-detail,
  // future hosts — flips correctly regardless of which store it sits in.
  const cardRegistry = new Map();

  function getState(playId) {
    let s = cardState.get(playId);
    if (!s) {
      s = {
        flipped: false,
        hydrated: null,
        hydrating: false,
        error: null,
        // Cached at first render so rerenderCard (which looks the card up
        // from the raw, ungrouped feed page) can still pick the strip vs
        // single variant after a flip.
        sessionPlayCount: 1,
      };
      cardState.set(playId, s);
    }
    return s;
  }

  function orientFor(ratio) {
    // Square (1:1) treated as landscape so BGG box art and matchstick photos
    // both default to the wider strip-card width.
    return ratio < 0.95 ? "portrait" : "landscape";
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  function renderPlayCard(card) {
    const s = getState(card.play_id);
    // Cache the card payload so rerenderCard (post-flip) can find it
    // regardless of which view rendered it. Without this, surfaces that
    // don't write to window.store.feed (e.g. game-detail's recent_plays
    // reel) silently fail to flip — state toggles but the DOM never paints.
    if (card && card.play_id) cardRegistry.set(card.play_id, card);
    const accent = (card.game && card.game.theme_color) || "var(--polaroid-accent)";
    // Prefer the freshly-passed count, fall back to whatever the first render
    // recorded. rerenderCard re-enters this function with the raw store card
    // (no __sessionPlayCount) so the cached value keeps strip vs single stable.
    if (card.__sessionPlayCount) s.sessionPlayCount = card.__sessionPlayCount;
    const sessionCount = s.sessionPlayCount || 1;
    const variant = sessionCount > 1 ? "strip" : "single";

    // Pick photo source — user-uploaded snapshot wins, otherwise the game's
    // own art so the polaroid always has a hero image at natural aspect.
    const g = card.game || {};
    const photoSrc = card.photo_url || g.image_url || g.thumbnail_url || "";
    const cached = photoSrc ? aspectCache.get(photoSrc) : null;
    const orient = cached ? cached.orient : "landscape";
    const aspect = cached ? cached.ratio : 1;

    const variantClass = variant === "strip"
      ? `play-card--strip is-${orient}`
      : "play-card--single";
    const flippedAttr = s.flipped ? " is-flipped" : "";

    return `
      <article class="play-card ${variantClass}${flippedAttr}"
               data-play-id="${escapeAttr(card.play_id)}"
               style="--game-accent:${escapeAttr(accent)}"
               role="button" tabindex="0"
               aria-expanded="${s.flipped ? "true" : "false"}"
               onclick="window.playCardFlip.handleClick(event, '${escapeAttr(card.play_id)}')"
               onkeydown="window.playCardFlip.handleKey(event, '${escapeAttr(card.play_id)}')">
        <div class="play-card__inner">
          <div class="play-card__front">${renderFront(card, { variant, photoSrc, aspect })}</div>
          <div class="play-card__back">${renderBack(card, s)}</div>
        </div>
      </article>
    `;
  }

  function renderFront(card, { variant, photoSrc, aspect }) {
    const g = card.game || {};
    const me = window.store && window.store.get && window.store.get("user");
    const gameName = escapeHtml(g.name || "Unknown game");
    const gameNav = `event.stopPropagation(); window.router.go('game-detail',{gameId:'${escapeAttr(g.id || "")}',gameName:'${jsStr(g.name || "")}'})`;

    // Caption "winner" block. Three modes:
    //   - cooperative + any winners → "We beat the game" (brass win style)
    //   - cooperative + no winners  → "The game won" (muted, no star)
    //   - competitive               → winner name(s) ✶ score (or just name)
    // Coop renderings don't list players because everyone won/lost together
    // and the joined name list overruns the caption on big tables.
    const winnerBlock = buildWinnerBlock(card, me);

    // The game thumbnail only appears as a corner badge when the user
    // uploaded their own photo — otherwise the game art *is* the hero.
    const hasUserPhoto = !!card.photo_url;
    const gameThumb = g.thumbnail_url || g.image_url || "";
    const statusMap = (window.store && window.store.get && window.store.get("myCollectionMap")) || {};
    const gameStatus = (g.id && statusMap[g.id]) || null;
    // Status pill placement:
    //  - User uploaded a session photo → pin to TOP-right of the photo so
    //    it doesn't pile up against the game-thumbnail badge in the bottom
    //    corner.
    //  - No session photo (game art fills the slot) → keep at bottom-right
    //    as before.
    const statusTopClass = hasUserPhoto ? " is-top" : "";
    const statusOverlayHtml = g.id
      ? `<span class="play-card__status-overlay${statusTopClass}" data-no-flip>${window.renderStatusTag(g.id, gameStatus, { compact: true })}</span>`
      : "";

    // Game thumbnail badge: only appears when the user uploaded their own
    // session photo (otherwise the game image IS the photo slot). The status
    // pill is no longer nested inside the badge — they live as siblings on
    // the photo so the pill stays anchored to its bottom-right home.
    const badgeHtml = (hasUserPhoto && gameThumb)
      ? `<div class="play-card__game-overlay" data-no-flip onclick="${gameNav}">
           <img src="${escapeAttr(gameThumb)}" alt="${escapeAttr(g.name || "")}" loading="lazy" />
         </div>
         ${statusOverlayHtml}`
      : statusOverlayHtml;

    const photoStyle = `--photo-aspect:${aspect}`;
    const photoHtml = photoSrc
      ? `<div class="play-card__photo" style="${photoStyle}">
           <img class="play-card__photo-img"
                src="${escapeAttr(photoSrc)}"
                alt="${escapeAttr(g.name || "")}"
                loading="lazy"
                onload="window.playCardFlip.onPhotoLoad(event, '${escapeAttr(card.play_id)}')" />
           ${badgeHtml}
         </div>`
      : `<div class="play-card__photo" style="${photoStyle}">${statusOverlayHtml}</div>`;

    // Notes live exclusively on the back of the card now — the front stays
    // tight (photo + caption) so cards in a strip line up cleanly.
    //
    // Long winners ("Wolfgang Theresa, britt.michaela, …") get bumped onto
    // their own row below the title where they scroll horizontally inside
    // the polaroid frame. Threshold is text-only; the photo onload pass
    // can later flip the class if the rendered text actually overflows.
    const winnerText = stripTags(winnerBlock);
    const longThreshold = variant === "strip" ? 18 : 28;
    const wrapClass = winnerText.length > longThreshold ? " has-long-meta" : "";

    return `
      ${photoHtml}
      <div class="play-card__caption${wrapClass}">
        <a class="play-card__caption-name" data-no-flip onclick="${gameNav}">${gameName}</a>
        <div class="play-card__caption-meta">${winnerBlock}</div>
      </div>
    `;
  }

  function stripTags(html) {
    return String(html).replace(/<[^>]*>/g, "");
  }

  // Build the "won" caption span. Three buckets:
  //   - all-or-nothing (coop, OR everyone won, OR nobody won) →
  //       any winners → "We won!" / "They won!"     (brass)
  //       no winners  → "We lost" / "They lost"     (grey/italic)
  //   - standard competitive (a single named winner) →
  //       "<You|Name> ✶ <score>" (score omitted if unknown)
  // "We" vs "They" depends on whether the viewer is in the play (logged it
  // OR appears in participants).
  function buildWinnerBlock(card, me) {
    const playMode = card.play_mode || "competitive";
    const winnerCount = countWinners(card.winner_display_name);
    const participantTotal = card.participant_count || 0;
    const everyoneWon = participantTotal > 0 && winnerCount > 0 && winnerCount >= participantTotal;
    const nobodyWon = winnerCount === 0;
    const teamBucket = (playMode === "cooperative") || everyoneWon || nobodyWon;
    const we = viewerInPlay(card, me) ? "We" : "They";

    if (teamBucket) {
      return winnerCount > 0
        ? `<span class="win">${we} won!</span>`
        : `<span class="win-loss">${we} lost</span>`;
    }
    if (!card.winner_display_name) return "";
    const winnerIsSelf = !!(me && me.display_name && card.winner_display_name === me.display_name);
    const winnerName = winnerIsSelf ? "You" : escapeHtml(card.winner_display_name);
    const winnerScore = winnerScoreFor(card);
    return `<span class="win">${winnerName}${winnerScore != null ? ` ✶ <span class="win-score">${escapeHtml(String(winnerScore))}</span>` : ""}</span>`;
  }

  // `winner_display_name` is a comma-joined list of winners (one entry for a
  // single winner, multiple for team / coop wins, null when nobody won).
  // Names normally don't contain commas so a comma-split is reliable enough
  // for the UI bucket selection.
  function countWinners(raw) {
    if (!raw) return 0;
    return String(raw).split(",").map((s) => s.trim()).filter(Boolean).length;
  }

  // True when the viewer's user_id matches the play logger or any visible
  // participant. Used to pick "We" vs "They" in the team-outcome caption.
  function viewerInPlay(card, me) {
    if (!me || !me.id) return false;
    if (card.user && card.user.id === me.id) return true;
    const ps = card.participants || [];
    return ps.some((p) => p && p.user_id === me.id);
  }

  function winnerScoreFor(card) {
    if (!card.winner_display_name) return null;
    const players = card.players || [];
    const winner = players.find((p) => p.is_winner && p.name === card.winner_display_name)
      || players.find((p) => p.is_winner);
    if (!winner) return null;
    return (winner.score != null && winner.score !== "") ? winner.score : null;
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
    const players = p.players || [];
    const me = window.store && window.store.get && window.store.get("user");
    // Maximize opens the play-detail popup in-place — the popup is the
    // sole "open a play" surface now (the standalone /play-detail page was
    // retired). Staying on the current view preserves scroll position and
    // keeps the game-tab layout intact.
    const detailNav = `event.stopPropagation(); window.PlayDetailPopup.show('${escapeAttr(card.play_id)}')`;
    const durationMeta = p.duration_minutes
      ? `${p.duration_minutes} min`
      : (p.played_at ? "" : "");

    // Rank by score descending; players without a score keep their order
    // after the scored rows.
    const ranked = players.slice().sort((a, b) => {
      const sa = a.score == null ? -Infinity : Number(a.score);
      const sb = b.score == null ? -Infinity : Number(b.score);
      return sb - sa;
    });

    const notesBlock = p.notes
      ? `<p class="play-card__back-notes">${escapeHtml(p.notes)}</p>`
      : "";

    return `
      <button class="play-card__maximize" data-no-flip
              aria-label="Open play details"
              title="Open play details"
              onclick="${detailNav}">
        <i data-lucide="maximize-2" class="w-3.5 h-3.5"></i>
      </button>
      <header class="play-card__back-head">
        <span class="play-card__back-title">${escapeHtml(p.game_name || (card.game && card.game.name) || "")}</span>
        ${durationMeta ? `<span class="play-card__back-meta">${escapeHtml(durationMeta)}</span>` : ""}
      </header>

      <ul class="play-card__back-players">
        ${ranked.length === 0
          ? `<li class="play-card__back-empty">No players recorded.</li>`
          : ranked.map((pl) => `
              <li class="play-card__back-player ${pl.is_winner ? "is-winner" : ""}">
                ${renderPlayerRow(pl, me)}
                <span class="play-card__back-player-score">${pl.score != null ? escapeHtml(String(pl.score)) : ""}</span>
              </li>`).join("")}
      </ul>

      ${notesBlock}

      <div class="play-card__back-footer">Tap to flip back</div>
    `;
  }

  // Render a single back-side player row: avatar bubble on the left, name
  // beside it. Registered players get a clickable initials bubble that
  // routes to their profile (own → profile-self, others → profile-other);
  // the bubble is the only navigable surface so tapping the name is inert.
  // Ghost players get a non-clickable bubble with a ghost icon so the row
  // still aligns at the same avatar column.
  function renderPlayerRow(pl, me) {
    const nameHtml = `<span class="play-card__back-player-name">${escapeHtml(pl.name)}</span>`;
    if (!pl.user_id) {
      return `
        <span class="play-card__back-player-avatar is-ghost" aria-hidden="true">
          <i data-lucide="ghost"></i>
        </span>
        ${nameHtml}
      `;
    }
    const route = (me && me.id === pl.user_id)
      ? `window.router.go('profile-self')`
      : `window.router.go('profile-other',{userId:'${escapeAttr(pl.user_id)}'})`;
    const avatarBody = pl.avatar_url
      ? `<img src="${escapeAttr(pl.avatar_url)}" alt="" />`
      : escapeHtml(initialsOf(pl.name));
    return `
      <span class="play-card__back-player-avatar avatar-bubble is-link"
            role="button" tabindex="0" data-no-flip
            aria-label="Open ${escapeAttr(pl.name)}'s profile"
            onclick="event.stopPropagation(); ${route}"
            onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();${route};}">
        ${avatarBody}
      </span>
      ${nameHtml}
    `;
  }

  // Two-letter initials fallback for the avatar bubble. Mirrors the
  // locally-defined helpers in feed-view.js / buddies-view.js — there's no
  // shared module so duplicating here matches the existing convention.
  function initialsOf(name) {
    const parts = String(name || "").trim().split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  }

  // ── Aspect ratio detection ──────────────────────────────────────────────────
  //
  // Detect the photo's natural aspect ratio after decode. We mutate the DOM
  // in place — set the --photo-aspect CSS var on the photo frame and toggle
  // is-portrait / is-landscape on the article — so there's no rerender and
  // no scroll-position jump. Cache the result by URL so subsequent renders
  // (e.g. after a flip) skip the placeholder square entirely.
  function onPhotoLoad(event, playId) {
    const img = event && event.target;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const ratio = w / h;
    const orient = orientFor(ratio);
    const url = img.currentSrc || img.src;
    if (url) {
      const prev = aspectCache.get(url);
      if (!prev || prev.orient !== orient || Math.abs(prev.ratio - ratio) > 0.02) {
        aspectCache.set(url, { ratio, orient });
      }
    }
    const photo = img.closest(".play-card__photo");
    if (photo) photo.style.setProperty("--photo-aspect", ratio.toFixed(3));
    const article = img.closest(".play-card");
    if (article && article.classList.contains("play-card--strip")) {
      article.classList.toggle("is-portrait", orient === "portrait");
      article.classList.toggle("is-landscape", orient === "landscape");
    }
  }

  // ── Single-card re-render (preserves feed scroll) ───────────────────────────
  //
  // The router only toggles `.hidden` on view containers (see domain/view.js)
  // — it never removes old views from the DOM. So the same play_id can appear
  // simultaneously in the feed's hidden `<main>` and the visible game-detail
  // reel. `document.querySelector` would resolve to the feed's hidden card
  // (it comes first in index.html) and the flip would silently paint on an
  // off-screen node. Update every match so duplicates stay in sync — flip
  // state is keyed by play_id, so a card flipped on game-detail also reads as
  // flipped when the user navigates back to feed.
  function rerenderCard(playId) {
    const articles = document.querySelectorAll(
      `article.play-card[data-play-id="${cssEscape(playId)}"]`
    );
    if (!articles.length) return;
    const card = findCardById(playId);
    if (!card) return;
    const html = renderPlayCard(card).trim();
    articles.forEach((article) => {
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      article.replaceWith(tmp.firstElementChild);
    });
    if (window.lucide) window.lucide.createIcons();
  }

  function findCardById(playId) {
    // Prefer the render-time registry — covers every surface that calls
    // renderPlayCard (feed, game-detail's recent_plays reel, future hosts).
    const registered = cardRegistry.get(playId);
    if (registered) return registered;
    // Fallback to the feed page store. Kept so any future code path that
    // mutates the feed cards directly still hits the freshest version.
    const page = window.store && window.store.get && window.store.get("feed");
    if (!page || !page.cards) return null;
    return page.cards.find((c) => c.kind === "play" && c.play_id === playId) || null;
  }

  // ── Flip controller (called from inline onclick handlers) ───────────────────

  const controller = {
    handleClick(event, playId) {
      const t = event.target;
      if (!t) return;
      // Anything in a no-flip subtree handles its own navigation (game-name
      // link, game-thumbnail badge, maximize button, status pill).
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

    onPhotoLoad,
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

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
