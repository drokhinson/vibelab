// ui/play-card.js — Polaroid play card rendered in the Feed and Profile.
//
// Two-faced flip card styled like an instant photo: cream surface, soft drop
// shadow, photo at the top.
//
// ONE HEIGHT, TWO WIDTHS. The photo frame is a fixed height (--pc-photo-h) in
// both variants, so every card in the app is the same height; orientation picks
// only the WIDTH — .play-card--wide for a landscape image, .play-card--tall for
// a portrait one. The image is never cropped: it is contained in the frame and
// whatever it does not cover is filled by a blurred, dimmed copy of itself
// (.play-card__photo-bg), so a landscape shot gets blur above and below and a
// portrait shot gets blur down each side.
//   Front  → maximize button (top-right, over the photo) into the in-place
//            play-detail popup, the photo, then a two-row caption:
//              title row — game name + an explicit open button
//              meta row  — the winner, on its own above a hairline
//            When the user uploaded their own snapshot the game's box art
//            rides along as a small bottom-right badge at its natural aspect;
//            with no snapshot the box art IS the photo.
//   Back   → game title + duration, ranked scoreboard with the winner row
//            tinted — a registered player's row opens their profile —
//            optional notes, the same maximize button (top-right), and a
//            "Tap to flip back" footer.
//
// Clicking the game-name text, the open button, either maximize button, or a
// scoreboard row for a registered player acts on its own (data-no-flip).
// Clicking anywhere else on the card — the photo and the box-art badge
// included — flips it. State lives in a module-level Map keyed by play_id so
// flipping re-renders only the affected <article> via outerHTML replacement —
// the feed scroll position is preserved.

(function () {
  // Per-play state lives outside the render so re-renders are cheap and
  // scoped: { flipped, hydrated (full PlayResponse), hydrating, error }.
  const cardState = new Map();

  // Orientation cache, keyed by image URL. Populated by onPhotoLoad after the
  // image decodes; survives rerenderCard so a card that already settled into
  // the tall width keeps that classification on subsequent renders.
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
      };
      cardState.set(playId, s);
    }
    return s;
  }

  function orientFor(ratio) {
    // Square (1:1) treated as landscape so a square photo takes the wider tile.
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

    // Pick photo source — user-uploaded snapshot wins, otherwise the game's
    // own art so the polaroid always has a hero image.
    const g = card.game || {};
    const photoSrc = card.photo_url || g.image_url || g.thumbnail_url || "";
    const cached = photoSrc ? aspectCache.get(photoSrc) : null;
    // Before the image decodes we have to guess which width to paint. A play
    // with no snapshot shows box art, which is portrait by construction
    // (~0.75–0.80), so guess tall there and skip the reflow entirely; a real
    // snapshot is more often landscape, so guess wide.
    const orient = cached ? cached.orient : (card.photo_url ? "landscape" : "portrait");

    const variantClass = orient === "portrait" ? "play-card--tall" : "play-card--wide";
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
          <div class="play-card__front">${renderFront(card, { photoSrc })}</div>
          <div class="play-card__back">${renderBack(card, s)}</div>
        </div>
      </article>
    `;
  }

  function renderFront(card, { photoSrc }) {
    const g = card.game || {};
    const me = window.store && window.store.get && window.store.get("user");
    const gameName = escapeHtml(g.name || "Unknown game");
    const gameNav = `event.stopPropagation(); window.router.go('game-detail',{gameId:'${escapeAttr(g.id || "")}',gameName:'${escapeAttr(jsStr(g.name || ""))}'})`;
    // Same expand affordance the back face carries, mirrored onto the front
    // so the play details are one tap away instead of flip-then-tap. The
    // popup fetches the full play itself, so the front needs no hydration.
    const detailNav = `event.stopPropagation(); window.PlayDetailPopup.show('${escapeAttr(card.play_id)}')`;

    // Caption "winner" block. Three modes:
    //   - cooperative + any winners → "We beat the game" (brass win style)
    //   - cooperative + no winners  → "The game won" (muted, no star)
    //   - competitive               → winner name(s) · score (or just name)
    // Coop renderings don't list players because everyone won/lost together
    // and the joined name list overruns the caption on big tables.
    const winnerBlock = buildWinnerBlock(card, me);

    // The game thumbnail only appears as a corner badge when the user
    // uploaded their own photo — otherwise the game art *is* the hero.
    const hasUserPhoto = !!card.photo_url;
    const gameThumb = g.thumbnail_url || g.image_url || "";

    // Box-art badge: only when the user uploaded their own session photo
    // (otherwise the box art IS the photo slot). Fixed height, auto width, so
    // a tall cover stays narrow and a wide one stays short instead of being
    // square-cropped. Deliberately inert — no onclick, no data-no-flip — so
    // the whole photo area flips the card and the ONE way into the game page
    // is the open button in the title row below.
    const badgeHtml = (hasUserPhoto && gameThumb)
      ? `<div class="play-card__game-overlay" aria-hidden="true">
           <img src="${escapeAttr(gameThumb)}" alt="" loading="lazy" />
         </div>`
      : "";

    // The frame is a fixed height in both variants, so the image is CONTAINED
    // in it and never cropped — a landscape shot leaves space above and below,
    // a portrait one leaves space to either side. That space is filled by the
    // same image again, blurred and dimmed, so the card still reads as a
    // photograph rather than as art on a grey plate. Same URL as the
    // foreground, so the browser fetches once.
    //
    // The blurred copy goes through a real <img src> rather than an inline
    // `background-image: url(...)`: escapeAttr neutralises the HTML layer, not
    // the CSS one, and a `)` in a photo URL would break out of the url().
    const photoHtml = photoSrc
      ? `<div class="play-card__photo">
           <img class="play-card__photo-bg"
                src="${escapeAttr(photoSrc)}"
                alt="" aria-hidden="true" loading="lazy" />
           <img class="play-card__photo-img"
                src="${escapeAttr(photoSrc)}"
                alt="${escapeAttr(g.name || "")}"
                loading="lazy"
                onload="window.playCardFlip.onPhotoLoad(event, '${escapeAttr(card.play_id)}')" />
           ${badgeHtml}
         </div>`
      : `<div class="play-card__photo"></div>`;

    // Notes live exclusively on the back of the card — the front stays tight
    // (photo + caption) so cards in a strip line up cleanly.
    //
    // The winner used to share a row with the title and needed a post-paint
    // re-measure to decide whether it fit; it has its own row now, so the
    // layout is static and the title simply ellipsises.
    return `
      <button class="play-card__maximize play-card__maximize--front" type="button" data-no-flip
              aria-label="Open play details"
              title="Open play details"
              onclick="${detailNav}">
        <i data-icon="maximize-2" class="w-3.5 h-3.5"></i>
      </button>
      ${photoHtml}
      <div class="play-card__caption">
        <div class="play-card__title-row">
          <a class="play-card__caption-name" data-no-flip onclick="${gameNav}">${gameName}</a>
          <button class="play-card__open" type="button" data-no-flip
                  aria-label="Open ${gameName}" title="Open ${gameName}"
                  onclick="${gameNav}">
            <i data-icon="arrow-up-right" class="w-4 h-4"></i>
          </button>
        </div>
        <div class="play-card__meta-row">
          <div class="play-card__caption-meta">${winnerBlock}</div>
        </div>
      </div>
    `;
  }

  // Build the "won" caption span. Three buckets:
  //   - all-or-nothing (coop, OR everyone won, OR nobody won) →
  //       any winners → "We won!" / "They won!"     (brass)
  //       no winners  → "We lost" / "They lost"     (grey/italic)
  //   - standard competitive (a single named winner) →
  //       "Won by <You|Name> · <score>" (score omitted if unknown)
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
    // The winner has its own caption row now, so a bare name would read as an
    // unexplained label. The team buckets above already read as sentences and
    // don't take the prefix.
    return `<span class="win"><span class="win-label">Won by</span>${winnerName}${winnerScore != null
    ? `<span class="win-sep" aria-hidden="true"></span><span class="win-score">${escapeHtml(String(winnerScore))}</span>`
    : ""}</span>`;
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
        <i data-icon="maximize-2" class="w-3.5 h-3.5"></i>
      </button>
      <header class="play-card__back-head">
        <span class="play-card__back-title">${escapeHtml(p.game_name || (card.game && card.game.name) || "")}</span>
        ${durationMeta ? `<span class="play-card__back-meta">${escapeHtml(durationMeta)}</span>` : ""}
      </header>

      <ul class="play-card__back-players${ranked.some((pl) => playerAction(pl, p, me)) ? " has-links" : ""}">
        ${ranked.length === 0
          ? `<li class="play-card__back-empty">No players recorded.</li>`
          : ranked.map((pl) => {
              // A registered player's whole row opens their profile; a ghost's
              // opens the claim sheet, with a different trailing icon because
              // it is a different destination. A ghost the viewer cannot
              // possibly be (their own roster, or a play they already sit on)
              // stays inert and un-styled as a link — see BgbPlayerRowAction.
              const act = playerAction(pl, p, me);
              const nav = act ? act.handler : "";
              return `
              <li class="play-card__back-player ${pl.is_winner ? "is-winner" : ""}${act ? " is-link" : ""}${act && act.kind === "claim" ? " play-card__back-player--claim" : ""}"
                  ${act ? `role="button" tabindex="0" data-no-flip
                  aria-label="${escapeAttr(act.ariaLabel)}"
                  onclick="${escapeAttr(nav)}"
                  onkeydown="${escapeAttr(`if(event.key==='Enter'||event.key===' '){event.preventDefault();${nav}}`)}"` : ""}>
                ${renderPlayerRow(pl, me)}
                <span class="play-card__back-player-score">${pl.score != null ? escapeHtml(String(pl.score)) : ""}</span>
                ${act ? `<i data-icon="${escapeAttr(act.icon)}" class="play-card__back-player-go"></i>` : ""}
              </li>`;
            }).join("")}
      </ul>

      ${notesBlock}

      <div class="play-card__back-footer">Tap to flip back</div>
    `;
  }

  // What a scoreboard row does when tapped — a real player's profile, or the
  // claim sheet for a ghost that might be the viewer. The decision lives in
  // ui/player-row-action.js because widgets/play-detail-popup.js draws the
  // same list and used to answer the same question in its own copy of this
  // function (ui-object-design.md §4: extract at instance #2).
  //
  // stopPropagation, inside the returned handler, keeps the click off the
  // article, which would otherwise flip the card out from under the
  // navigation; the row also carries data-no-flip so the flip controller
  // skips it even if a future change lets the event through.
  function playerAction(pl, play, me) {
    return window.BgbPlayerRowAction
      ? window.BgbPlayerRowAction.for(pl, play, me)
      : null;
  }

  // Render the leading half of a back-side player row: badge, then name.
  // Both are purely visual — the navigation lives on the <li> so the whole
  // row is one target (the 24px badge alone was a hard tap on a touch-first
  // surface) and keyboard / aria flow stays on a single element.
  function renderPlayerRow(pl, me) {
    const nameHtml = `<span class="play-card__back-player-name">${escapeHtml(pl.name)}</span>`;
    const badge = window.BgbBadge.render({
      avatar: pl.user_id ? (pl.avatar || null) : null,
      displayName: pl.name,
      size: "sm",
      isMe: !!(me && pl.user_id && me.id === pl.user_id),
      isGhost: !pl.user_id,
      extraClass: "play-card__back-player-avatar",
    });
    return `${badge}${nameHtml}`;
  }

  // ── Aspect ratio detection ──────────────────────────────────────────────────
  //
  // Detect the photo's orientation after decode and swap the article between
  // the wide and tall widths in place — no rerender, no scroll-position jump.
  // The frame's HEIGHT never changes, so this can only ever reflow the card
  // sideways. Cache the verdict by URL so subsequent renders (e.g. after a
  // flip) paint the right width immediately.
  function onPhotoLoad(event, playId) {
    const img = event && event.target;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const orient = orientFor(img.naturalWidth / img.naturalHeight);
    const url = img.currentSrc || img.src;
    if (url) aspectCache.set(url, { orient });
    const article = img.closest(".play-card");
    if (article) {
      article.classList.toggle("play-card--tall", orient === "portrait");
      article.classList.toggle("play-card--wide", orient === "landscape");
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
      const fresh = tmp.firstElementChild;
      article.replaceWith(fresh);
      // Scope the icon pass to the card just patched — a document-wide
      // walk here would re-scan every mounted (hidden) view per flip.
      window.BgbIcons.render(fresh);
    });
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
      // link, maximize button, back-side player badges).
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

  // Used to build a CSS attribute selector — UUIDs are safe but the helper
  // keeps the selector robust if a non-UUID id ever flows through.
  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  window.renderPlayCard = renderPlayCard;
  window.playCardFlip = controller;
})();
