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
//            A play with a note also gets a two-line preview of it on a paper
//            plate across the bottom of the photo. It sits INSIDE the fixed
//            photo frame, so it costs the card no height; the badge lifts
//            above it (.has-note) on the one card that carries both.
//   Back   → game title, ranked scoreboard with the winner row tinted — a
//            registered player's row opens their profile — optional notes,
//            and the same maximize button (top-right).
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

  // How much of a note reaches the DOM. This is a PAYLOAD guard, not the
  // visible cut: `boardgamebuddy_plays.notes` is bare TEXT with no constraint
  // and no maxlength on any input, so an AI- or BGG-imported note can run to
  // any length, and a feed page holds twenty of them in a string the browser
  // has to parse. The visible truncation is CSS's two-line clamp — every other
  // clamp in this project is CSS and there is no JS truncator to reuse — and
  // 200 characters is far more than two lines can show at either card width,
  // so the ellipsis the user sees always comes from the stylesheet.
  const NOTE_MAX = 200;

  // The single answer to "does this play have a note", used by BOTH the band
  // and the .has-note class that lifts the box-art badge out of its way. Two
  // near-identical truthiness checks would be free to drift, and the failure
  // would be a badge floating clear of a band that isn't there.
  /** @param {string|null|undefined} notes @returns {string} the text, or "" */
  function noteText(notes) {
    return String(notes == null ? "" : notes).trim().slice(0, NOTE_MAX);
  }

  /** @param {string|null|undefined} notes @returns {string} band markup, or "" */
  function notePreview(notes) {
    const text = noteText(notes);
    if (!text) return "";
    // The inner <span> is load-bearing: -webkit-line-clamp caps the visible
    // lines but does not shrink the box, so a clamp on the padded plate leaves
    // a gap the height of its own bottom padding — through which the tops of a
    // third line's glyphs show below the ellipsis. The span has no padding, so
    // its overflow is clipped exactly on the line boundary.
    return `<p class="play-card__note"><span>${escapeHtml(text)}</span></p>`;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  function renderPlayCard(card) {
    const s = getState(card.play_id);
    // Cache the card payload so rerenderCard (post-flip) can find it
    // regardless of which view rendered it. Without this, surfaces that
    // don't write to window.store.feed (e.g. game-detail's recent_plays
    // reel) silently fail to flip — state toggles but the DOM never paints.
    if (card && card.play_id) cardRegistry.set(card.play_id, card);
    // Migration 015: the card carries the whole play, so hand it to the domain
    // layer. This is the one place every card on every surface passes through,
    // which is why the seeding lives here rather than in each view — and it is
    // a no-op against an RPC that predates the roster, so the fetch-on-flip
    // path below stays correct on an unmigrated database.
    if (window.Play && window.Play.seedFromFeedCard) window.Play.seedFromFeedCard(card);
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
    // State class in the .has-links mould (see renderBack's scoreboard). It
    // exists so the box-art badge can lift clear of the note band: the badge
    // and the band both want the bottom of the photo, and the badge only
    // renders at all when the user uploaded their own snapshot, so this is the
    // one case where they actually collide.
    const notedAttr = noteText(card.notes) ? " has-note" : "";

    // A run of identical imported plays (migration 005) is ONE card standing
    // for many. It is a variant of this component rather than a component of
    // its own (.claude/rules/ui-object-design.md §2): still a Play, still in
    // the session rail beside the ordinary cards. Two things differ.
    //
    // IT DOES NOT FLIP, and so has no back face at all. Tapping opens the run
    // sheet instead, which is the run's back face as well as the one place a
    // run can be acted on: it carries the delete, the note every play in the
    // run shares, and their shared scoreline where there is one. A flip would
    // promise a scorecard belonging to ONE play, and a run has no single play
    // to show one for — its whole claim is that its plays are interchangeable.
    //
    // Losing the flip also fixes the stack art. The edges behind the card
    // could not sit behind it while .play-card__inner was `preserve-3d`,
    // because that makes its own stacking context and z-index below it does
    // nothing — so the edges drew ACROSS the face as crossing borders. With no
    // flip there is no 3D, and they stack the ordinary way.
    const stack = (card.group_count || 1) > 1;

    if (stack) {
      return `
        <article class="play-card ${variantClass} play-card--stack"
                 data-play-id="${escapeAttr(card.play_id)}"
                 style="--game-accent:${escapeAttr(accent)}"
                 role="button" tabindex="0"
                 aria-label="${escapeAttr(`${card.group_count} identical plays`)}"
                 onclick="window.playCardFlip.handleClick(event, '${escapeAttr(card.play_id)}')"
                 onkeydown="window.playCardFlip.handleKey(event, '${escapeAttr(card.play_id)}')">
          <span class="play-card__stack-edge play-card__stack-edge--2" aria-hidden="true"></span>
          <span class="play-card__stack-edge" aria-hidden="true"></span>
          <div class="play-card__inner">
            <div class="play-card__front">${renderStackFront(card)}</div>
          </div>
        </article>
      `;
    }

    return `
      <article class="play-card ${variantClass}${flippedAttr}${notedAttr}"
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

  /**
   * The front of a run card: the count, the game, and the one outcome every
   * play in the run shares. No photo — a photograph of one of 58 identical
   * plays would be claiming to be a specific evening.
   */
  function renderStackFront(card) {
    const g = card.game || {};
    const n = card.group_count || 1;
    const me = window.store && window.store.get && window.store.get("user");
    const gameName = escapeHtml(g.name || "Unknown game");
    const gameNav = escapeAttr(gameDetailJs(g.id, g.name, { stop: true }));
    const thumb = g.thumbnail_url || g.image_url || "";
    return `
      <div class="play-card__photo play-card__photo--stack">
        ${thumb
          ? `<img class="play-card__stack-art" src="${escapeAttr(thumb)}" alt="" loading="lazy" />`
          : ""}
        <div class="play-card__stack-count">
          <span class="play-card__stack-n">${n}</span>
          <span class="play-card__stack-unit">plays</span>
        </div>
      </div>
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
          <div class="play-card__caption-meta">${stackOutcome(card, me, n)}</div>
        </div>
      </div>
    `;
  }

  /**
   * The one sentence a run can honestly make, and it is a SENTENCE: the winner
   * leads. "Won all 58 You" was the ordinary card's "Won by <name>" shape bent
   * around a count, and it read as a label with a name stuck on the end.
   * "You won all 58" is the thing a person would actually say.
   */
  function stackOutcome(card, me, n) {
    // Same rule as the single card: a run that recorded no result says nothing.
    // "No winner recorded" is kept for the run that HAS scores but crowned
    // nobody — there the absence of a winner is itself the fact.
    if (outcomeUnrecorded(card)) return "";
    const winnerCount = countWinners(card.winner_display_name);
    if (winnerCount === 0) return `<span class="win-loss">No winner recorded</span>`;
    const everyoneWon = (card.participant_count || 0) > 0
      && winnerCount >= (card.participant_count || 0);
    if (everyoneWon) {
      const we = viewerInPlay(card, me) ? "We" : "They";
      return `<span class="win">${we} won all ${n}</span>`;
    }
    const isSelf = !!(me && me.display_name && card.winner_display_name === me.display_name);
    const name = isSelf ? "You" : escapeHtml(card.winner_display_name);
    // ONE flex item, not two. .win is inline-flex with a 5px gap, so a bare
    // <span>name</span> followed by text renders as two items with that gap
    // between them — a visibly wider space than the sentence wants.
    return `<span class="win"><span class="win-run"><b>${name}</b> won all ${n}</span></span>`;
  }

  function renderFront(card, { photoSrc }) {
    const g = card.game || {};
    const me = window.store && window.store.get && window.store.get("user");
    const gameName = escapeHtml(g.name || "Unknown game");
    const gameNav = escapeAttr(gameDetailJs(g.id, g.name, { stop: true }));
    // Same expand affordance the back face carries, mirrored onto the front
    // so the play details are one tap away instead of flip-then-tap. The
    // popup fetches the full play itself, so the front needs no hydration.
    const detailNav = `event.stopPropagation(); window.PlayDetailPopup.show('${escapeAttr(card.play_id)}')`;

    // Caption "winner" block. See buildWinnerBlock for the buckets; a play
    // that recorded no result at all renders an empty string here, and
    // .play-card__caption-meta holds its line box open so the card stays the
    // same height as its neighbours.
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

    // The note preview: a strip of paper laid across the bottom of the photo.
    // It lives INSIDE the frame, which is a fixed --pc-photo-h tall, so an
    // absolutely-positioned band cannot change the card's height — that is the
    // whole reason this treatment won over a third caption row, which would
    // have taxed every card in the app for a field most plays don't have.
    const noteHtml = notePreview(card.notes);

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
           ${noteHtml}
         </div>`
      : `<div class="play-card__photo">${noteHtml}</div>`;

    // The band carries no data-no-flip and is not a button or a link, so
    // handleClick lets the tap through and the card flips — tapping a truncated
    // preview to read the rest of it is exactly what it should do, and the
    // back's .play-card__back-notes carries the note unclamped.
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

  // Build the "won" caption span. Four buckets:
  //   - no outcome recorded (nobody won AND nobody scored) → nothing at all
  //   - all-or-nothing (coop, OR everyone won, OR nobody won) →
  //       any winners → "We won!" / "They won!"     (brass)
  //       no winners  → "We lost" / "They lost"     (grey/italic)
  //   - standard competitive (a single named winner) →
  //       "Won by <You|Name> · <score>" (score omitted if unknown)
  // The first bucket has to come first: a play with no result looks exactly
  // like a nobody-won loss from the winner list alone, and only the scores
  // tell them apart.
  // "We" vs "They" depends on whether the viewer is in the play (logged it
  // OR appears in participants).
  function buildWinnerBlock(card, me) {
    // Nobody won and nobody scored: say nothing. This is the case that used to
    // fall through to the nobodyWon branch below and render "We lost" over a
    // play whose result was simply never entered.
    if (outcomeUnrecorded(card)) return "";
    const playMode = card.play_mode || "competitive";
    const winnerCount = countWinners(card.winner_display_name);
    const participantTotal = card.participant_count || 0;
    const everyoneWon = participantTotal > 0 && winnerCount > 0 && winnerCount >= participantTotal;
    const nobodyWon = winnerCount === 0;
    const teamBucket = (playMode === "coop") || everyoneWon || nobodyWon;
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

  // A play whose outcome was never recorded: nobody is flagged a winner AND not
  // one seat carries a score. That is not "we lost" — it is "nobody said", and
  // the card has no business inventing a result for it.
  //
  // The roster is the evidence, so a card built without `players` — a payload
  // predating migration 015, or an adapter that omits it — keeps the old
  // reading rather than guessing from an absence it cannot see.
  function outcomeUnrecorded(card) {
    if (countWinners(card.winner_display_name) > 0) return false;
    const players = card.players;
    if (!Array.isArray(players) || !players.length) return false;
    return !players.some((p) => p && p.score != null && p.score !== "");
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
    // The seed comes first, and it is why there is usually nothing to load.
    // Since migration 015 the feed card carries the full roster with scores
    // and round_scores, so Play.seeded() answers synchronously for any card the
    // feed drew — the back paints in the same frame as the flip. A fetched
    // copy, once it lands, outranks the seed: it is the newer of the two.
    const p = s.hydrated || (window.Play && window.Play.seeded && window.Play.seeded(card.play_id));
    if (!p) {
      // No seed: either an RPC that predates 015, or a surface whose card was
      // built without a roster. Fall back to the fetch and say so.
      if (s.hydrating) return `<div class="play-card__back-loading">Loading play…</div>`;
      if (s.error) return `<div class="play-card__back-error">${escapeHtml(s.error)}</div>`;
      // Rendered while flipped=false and never fetched. A shell, so the back
      // has something behind the front during the rotation.
      return `<div class="play-card__back-loading">…</div>`;
    }
    // A seed that is being refreshed shows the seed, not a spinner — the
    // scoreboard is already on screen and replacing it with "Loading play…"
    // would be a step backwards. An error over a seed is likewise swallowed:
    // there is nothing to tell the user, because they can see the play.
    const players = p.players || [];
    const me = window.store && window.store.get && window.store.get("user");
    // Maximize opens the play-detail popup in-place — the popup is the
    // sole "open a play" surface now (the standalone /play-detail page was
    // retired). Staying on the current view preserves scroll position and
    // keeps the game-tab layout intact.
    const detailNav = `event.stopPropagation(); window.PlayDetailPopup.show('${escapeAttr(card.play_id)}')`;

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
    // Under the viewer's private alias when they set one. Read-only: nothing on
    // a card writes a name, so this is purely what the row SAYS — pl.name is
    // untouched and is still what any edit path would persist.
    const shown = window.Buddy.nameFor(pl.user_id, pl.name);
    const nameHtml = `<span class="play-card__back-player-name">${escapeHtml(shown)}</span>`;
    const badge = window.BgbBadge.render({
      avatar: pl.user_id ? (pl.avatar || null) : null,
      displayName: shown,
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
      // A run card has no back face — it opens its sheet instead. That is also
      // the only place a run can be acted on, since the plays inside it are by
      // definition interchangeable and there is no single one to open.
      const known = cardRegistry.get(playId);
      if (known && (known.group_count || 1) > 1) {
        if (window.PlayRunSheet) window.PlayRunSheet.open(known);
        return;
      }
      const s = getState(playId);
      const next = !s.flipped;
      s.flipped = next;
      // A seeded play needs no fetch at all: the feed already sent the roster,
      // the scores and the rounds (migration 015), so the flip is pure paint.
      // This is the round trip the "Loading play…" panel used to cover, and
      // the second, duplicate one that fired when a user flipped a card and
      // then opened its details.
      const seeded = window.Play && window.Play.seeded && window.Play.seeded(playId);
      if (next && !s.hydrated && !s.hydrating && !seeded) {
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

  /**
   * Fold an accepted play edit into this module's two caches and repaint.
   *
   * Both Maps live for the life of the tab and had no invalidation at all, each
   * with its own consequence:
   *   - `cardState.hydrated` is the full play fetched on flip, and renderBack
   *     prefers it over the seed. Flip, edit, save, flip again and the back
   *     face showed the pre-edit roster and scores, permanently.
   *   - `cardRegistry` is what findCardById prefers over the feed store, so a
   *     stale entry here shadows a corrected page underneath it.
   *
   * rerenderCard then repaints EVERY mounted copy of the card — the router only
   * hides views, so the same play can be on screen in the feed and in a game's
   * recent-plays reel at once — and does it surgically, without the owning view
   * re-rendering and losing its scroll.
   *
   * @param {any} play the PlayResponse the PUT echoed back
   */
  function applyPlayUpdate(play) {
    if (!play || !play.id) return;
    const card = cardRegistry.get(play.id);
    if (card) window.Play.mergeIntoCard(card, play);
    const s = cardState.get(play.id);
    // Only when it was already hydrated: writing it otherwise would arm the
    // back face for a card nobody has flipped, and the seed covers that path.
    if (s && s.hydrated) s.hydrated = play;
    rerenderCard(play.id);
  }

  window.renderPlayCard = renderPlayCard;
  window.playCardFlip = controller;
  window.BgbPlayCard = { applyPlayUpdate };
})();
