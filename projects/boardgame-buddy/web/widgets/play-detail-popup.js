// widgets/play-detail-popup.js — expanded polaroid modal for a single play.
//
// Replaces the play-detail page route as the "tap-to-expand" surface from
// the polaroid play card. Shows the full play record (photo, scoreboard
// with winners highlighted, notes), supports an edit mode that mirrors
// the play-detail page (date, players, notes, photo upload, delete), and
// lives in-place over whatever view the user came from — no navigation.
//
// This file is the SHELL and the read-only card: the modal, the fetch and
// its race guards, render() and its byte-identity guard, the view-mode
// markup, and the two things a non-owner can do to a play (leave it, rename
// a buddy in it). Everything behind the Edit pill — the draft, the form, the
// write handlers, save and delete — is widgets/play-detail-edit.js, which
// loads first and is wired by the init() call at the bottom of this file.
// One popup, one `state`, two files: together they were 1,444 lines, which is
// several times CLAUDE.md's ~300-line guidance, and view and edit are the one
// seam that splits this card without cutting through a shared concern.
//
// API:
//   window.PlayDetailPopup.show(playId)   — fetch + open the popup
//   window.PlayDetailPopup.dismiss()      — close without saving

// @ts-check

(function () {
  const _modal = new window.BgbModal({
    id: "bgb-play-detail-popup",
    className: "play-detail-popup__backdrop",
    label: "Play details",
    // This card has its own CSS family, so the shell has to be told what its
    // card and × are. Left on the shared `.polaroid-popup__*` defaults, the
    // outside-tap test matched nothing inside this card and every press on it
    // — Edit, Upload photo, Save, a score field — read as a tap outside and
    // closed the popup instead (overlays.md §8a).
    cardSelector: ".play-detail-popup__card",
    closeSelector: ".play-detail-popup__close",
  });

  // Module-scoped singleton state. The popup is a transient sheet and
  // never renders more than once at a time, so a single state bag keeps
  // edit/save/delete plumbing simple.
  const state = {
    playId: null,
    play: null,
    error: null,
    editing: false,
    saving: false,
    editError: null,
    draft: null,        // working copy while editing
    buddies: [],        // buddy datalist for the add-player input
  };

  // The card markup currently painted into the backdrop. render() compares
  // against it and returns without touching the DOM when the new markup is
  // byte-identical, which is the common case for a background revalidation:
  // replacing innerHTML with the same string still tears down and rebuilds
  // every node, and the photo <img> visibly blinks as it does. Cleared
  // wherever the backdrop itself is created or destroyed.
  let _lastHtml = null;

  // The play id whose partner-bundle refresh has already been kicked off.
  // ensureBuddies() is called twice in one open, and without this the second
  // call would fire a duplicate request on a cold cache. A play id rather than
  // a boolean: a popup closed mid-flight can be reopened before the first
  // request settles, and a flag cleared by that stale request's `finally` would
  // let the new open fire a third.
  let _buddiesFor = null;

  /**
   * Fill `state.buddies` for edit mode, off the critical path.
   *
   * Reads the cached partner bundle synchronously — bootstrap seeds it, and it
   * is the same entry the alias and edge-id maps resolve from, so a first paint
   * agrees with a second on every name. The refresh behind it is deliberately
   * NOT awaited: `state.buddies` is read only in edit mode (the add-player
   * datalist, addPlayer, the alias sheet), so nothing on screen waits for it,
   * and the render it triggers is dropped by the byte-identity guard whenever
   * the bundle confirms what is already held — which, the bundle being SWR'd
   * 24h/7d, is almost always.
   *
   * /play-partners rather than /buddies: both return the same BuddyEdgeResponse
   * rows, but only this one is cached, pre-seeded at boot, and already the
   * source of the alias map.
   */
  function ensureBuddies() {
    if (!state.play || !state.play.is_own) return;
    state.buddies = window.Buddy.cachedAccounts();
    const playId = state.playId;
    if (_buddiesFor === playId) return;
    _buddiesFor = playId;
    window.Buddy.allBuddies()
      .then((bundle) => {
        // The popup may have been closed and reopened on another play while
        // this was in the air; writing into the new open's state would put one
        // play's buddies under another's.
        if (state.playId !== playId) return;
        state.buddies = (bundle && bundle.accounts) || [];
        render();
      })
      .catch(() => {});
  }

  async function show(playId) {
    if (!playId) return;
    dismiss();
    // Since migration 015 the feed card carries the whole play, and since 031
    // it carries the scoring template too, so a popup opened from a card the
    // feed drew has its content before it is mounted and never shows a loading
    // state. Play.seeded also falls back to a cached /plays page, which covers
    // the surfaces that draw no feed cards at all — the plays log, the profile
    // preview, notifications, the session viewer.
    //
    // It still revalidates underneath: the seed is a projection of a page that
    // may have been served stale (those caches hold long stale windows on
    // purpose), and this is an EDIT surface. What the seed buys is the first
    // frame, not the fetch.
    //
    // The invariant that makes the revalidation free: a seed carrying the
    // template, agreeing with the server on game_thumbnail and resolving the
    // same aliases produces the same BYTES as the fetched row, so render()
    // drops the confirming paint outright. A seed that genuinely disagrees —
    // someone else edited the play, a page went stale — repaints, which is the
    // point of revalidating at all. Every field the seed and the row could
    // disagree on by construction rather than by fact is a flicker, so keep
    // Play.fromFeedCard honest about the shape it is projecting into.
    //
    // Nothing is awaited between the two paints except the play itself. The
    // buddy list used to be, and it is needed only in edit mode — a whole
    // round trip that bought the first render nothing and delayed the second
    // long enough to read as a flicker rather than as part of the open.
    //
    // There is no `loading` flag any more: it existed only to drive the
    // spinner, the spinner is now gated on having nothing to show, and a flag
    // set in three places and read in none is a trap for the next reader.
    const seed = window.Play.seeded ? window.Play.seeded(playId) : null;
    Object.assign(state, {
      playId,
      play: seed,
      error: null,
      editing: false,
      saving: false,
      editError: null,
      draft: null,
      buddies: [],
    });
    mountBackdrop();
    render();
    ensureBuddies();
    try {
      const fresh = await window.Play.get(playId);
      // Hold the authoritative row. Keyed by id, so this is right whatever the
      // popup has moved on to: a second open of this play in the same session
      // paints once from it and never revalidates into a repaint.
      window.Play.remember(fresh);
      // Every entry point is a tap on a list, so the user can open another play
      // while this is in the air — and `state` is a module-scoped singleton.
      // Writing a resolved row into it without checking which play it belongs
      // to paints one play's details under another's (web-frontend.md, "Async
      // state & race conditions"). The `finally` render below still runs and is
      // correct: it renders whatever the popup is actually showing now.
      if (state.playId !== playId) return;
      // Never clobber an edit in progress. The user can be typing by the time
      // this lands — the popup painted from the seed and opened for business
      // several hundred milliseconds ago — and replacing `play` under an open
      // draft would reset the form to the server's copy mid-keystroke.
      if (!state.editing) state.play = fresh;
      // Asked again because the seed may not have known this play was ours —
      // a cold open with no seed at all starts with `state.play` null.
      ensureBuddies();
    } catch (e) {
      // A failed revalidation over a seed is not an error the user can act on
      // — the play is on screen. Only a cold open with nothing to show gets
      // the error state, and only while it is still the open we failed for.
      if (state.playId === playId && !state.play) {
        state.error = (e && e.message) || "Failed to load play";
      }
    } finally {
      render();
    }
  }

  function dismiss() {
    _modal.close();
    resetState();
  }

  function resetState() {
    _lastHtml = null;
    _buddiesFor = null;
    window.PlayDetailEdit.discardDraft();
    Object.assign(state, {
      playId: null,
      play: null,
      error: null,
      editing: false,
      saving: false,
      editError: null,
      draft: null,
      buddies: [],
    });
  }

  // Every exit — ×, outside tap, Escape, back — discards an edit draft; the
  // shell routes them all through onClose.
  function mountBackdrop() {
    _lastHtml = null;
    _modal.open({ html: "", onClose: resetState, onEscape: hasStackedOverlay });
  }

  // PolaroidPopup.confirm() takes the screen for its own card, which closes
  // ours. Both destructive actions — leave, below, and delete in the edit half
  // — have to put the backdrop back before they can paint their progress into
  // it. Exported to the edit half rather than `_modal` itself: that the shell
  // owns the modal is the whole point of the seam.
  function remount() {
    if (!_modal.isOpen) mountBackdrop();
  }

  /**
   * True while something this card opened sits on top of it — the game search
   * or expansion picker sheet, the alias sheet, the BGG import popup behind
   * the picker.
   *
   * Wired to the shell's onEscape, which is a first-refusal hook: returning
   * true swallows the press. Every overlay registers its OWN capture-phase
   * Escape on `document`, and stopPropagation does not stop a sibling listener
   * on the same node — so an Escape aimed at the sheet ran this card's handler
   * too, closing it and taking an unsaved edit draft with it. Topmost wins:
   * while anything is stacked over us, Escape is theirs.
   *
   * Not a counter of our own opens: the sheets are shared singletons that can
   * close by four routes each, and the DOM is the only account of what is on
   * screen that cannot drift out of step with what actually is.
   */
  function hasStackedOverlay() {
    const mine = _modal.el;
    const stacked = document.querySelectorAll(".bgb-sheet, .bgb-modal");
    for (const el of stacked) if (el !== mine) return true;
    return false;
  }


  // ── Render ────────────────────────────────────────────────────────────────
  //
  // Two guards, in increasing cost, and the card is only ever rebuilt whole on
  // the first paint.
  //
  // Nothing changed at all -> the byte-identity check below returns without
  // building a tree. That is what a revalidation confirming what the popup
  // already showed costs: zero.
  //
  // Something changed -> BgbDomPatch writes only the nodes that differ. The
  // card element itself survives, and with it the photo <img> (no re-decode, no
  // blink), the entrance animation (it does not replay), the scroll offset of
  // .play-detail-popup__scroll, the :active state under a finger mid-press, and
  // the focus and caret of whatever field is being typed into. Before this, one
  // differing byte anywhere cost a full teardown of every node on the card —
  // which a user watching it read as the card reloading a second after it
  // opened.
  function render() {
    const root = _modal.el;
    if (!root) return;
    const html = renderCard();
    if (html === _lastHtml) return;

    const focus = captureFocus();
    const focused = document.activeElement;

    // First paint, or a re-mount after PolaroidPopup.confirm handed us a brand
    // new backdrop: there is nothing to patch against.
    if (_lastHtml === null || !root.firstElementChild) {
      root.innerHTML = html;
      window.BgbIcons.render(root);
    } else {
      window.BgbDomPatch.morph(root, html);
    }
    _lastHtml = html;
    // The × needs no listener of its own: the shell's delegated click owns it
    // via closeSelector, and its onClose is this popup's reset.

    // Only when the patch actually cost us the focus. restoreFocus collapses a
    // selection to a caret, and after a morph the field usually still has both.
    if (document.activeElement !== focused) restoreFocus(focus);
  }

  function renderCard() {
    // Gated on having nothing to show, NOT on `loading`. Since 015 a popup
    // opened from a feed card starts with a seeded play and a request still in
    // flight to revalidate it — the old `state.loading ||` test would have put
    // the spinner over content that was already on screen, which is the exact
    // thing the seed exists to prevent.
    if (!state.play && !state.error) {
      return `
        <div class="play-detail-popup__card" role="dialog" aria-modal="true" aria-busy="true">
          <button class="play-detail-popup__close" aria-label="Close">
            <i data-icon="x" class="w-4 h-4"></i>
          </button>
          <div class="play-detail-popup__loading">${window.buddyLoader({ size: 80 })}</div>
        </div>
      `;
    }
    if (state.error) {
      return `
        <div class="play-detail-popup__card" role="alertdialog" aria-modal="true">
          <button class="play-detail-popup__close" aria-label="Close">
            <i data-icon="x" class="w-4 h-4"></i>
          </button>
          <div class="play-detail-popup__error">${escapeHtml(state.error)}</div>
        </div>
      `;
    }
    const p = state.play;
    return `
      <div class="play-detail-popup__card" role="dialog" aria-modal="true" aria-label="Play details">
        <div class="play-detail-popup__topbar">
          <span></span>
          <button class="play-detail-popup__close" type="button" aria-label="Close">
            <i data-icon="x" class="w-4 h-4"></i>
          </button>
        </div>
        <div class="play-detail-popup__scroll">
          ${state.editing ? window.PlayDetailEdit.renderForm(p) : renderView(p)}
        </div>
        ${renderFooter(p)}
      </div>
    `;
  }

  // Footer is sticky-pinned to the bottom of the popup card. It carries
  // the primary action(s) for the current mode: in edit mode the
  // Delete/Cancel/Save trio; in view mode (own play) a single Edit pill.
  // Other-people's plays drop the footer entirely.
  function renderFooter(p) {
    if (state.editing) {
      return `
        <div class="play-detail-popup__footer">
          <button class="btn btn-ghost play-detail__delete-btn" type="button"
                  ${state.saving ? "disabled" : ""}
                  onclick="window.PlayDetailPopup._deletePlay()">
            <i data-icon="trash-2" class="w-4 h-4"></i> Delete
          </button>
          <button class="btn btn-ghost" type="button"
                  onclick="window.PlayDetailPopup._cancelEdit()">Cancel</button>
          <button class="btn btn-primary" type="button"
                  ${state.saving ? "disabled" : ""}
                  onclick="window.PlayDetailPopup._saveEdit()">
            ${state.saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      `;
    }
    if (p && p.is_own) {
      return `
        <div class="play-detail-popup__footer">
          <button class="play-detail-popup__edit play-detail-popup__edit--full" type="button"
                  onclick="window.PlayDetailPopup._enterEdit()">
            <i data-icon="pencil" class="w-4 h-4"></i>
            <span>Edit</span>
          </button>
        </div>
      `;
    }
    // Non-owner who nonetheless appears as an account player in this play:
    // offer a self-remove ("I didn't play") that ghosts their row out of the
    // log. The owner never sees this branch (they get Edit above); uninvolved
    // viewers appear in no player row so the button stays hidden.
    const me = window.store && window.store.get && window.store.get("user");
    const iAmAPlayer = !!(me && (p.players || []).some((pl) => pl.user_id === me.id));
    if (p && iAmAPlayer) {
      return `
        <div class="play-detail-popup__footer">
          <button class="play-detail-popup__edit play-detail-popup__edit--full play-detail__leave-btn" type="button"
                  ${state.saving ? "disabled" : ""}
                  onclick="window.PlayDetailPopup._leavePlay()">
            <i data-icon="ghost" class="w-4 h-4"></i>
            <span>${state.saving ? "Removing…" : "I didn't play — remove me"}</span>
          </button>
        </div>
      `;
    }
    return "";
  }

  // True when there's a score breakdown worth surfacing. Single-round /
  // no-round plays leave round_scores NULL on the backend and the grid stays
  // hidden — UNLESS the play carries a scoring template (migration 018), in
  // which case even one row is a real breakdown, because the template says that
  // row MEANS something. domain/play-session.js holds up the other end of the
  // invariant: a non-null scoring_template implies non-null round_scores.
  // Used by both view and edit modes.
  function hasRoundGrid(players, key, template) {
    const k = key || "round_scores";
    if (!Array.isArray(players)) return false;
    const min = templateRows(template).length ? 1 : 2;
    return players.some((pl) => Array.isArray(pl[k]) && pl[k].length >= min);
  }

  /**
   * Expansions in name order — the order the feed RPC already sorts them into
   * (migration 031) and the REST row does not, so without this the chips
   * reshuffle when the confirming fetch lands. Same argument as
   * Play.rankPlayers, one list down.
   *
   * @param {any[]} exps
   * @returns {any[]} a sorted copy
   */
  function byName(exps) {
    return (exps || []).slice().sort(
      (a, b) => String(a.name || "").localeCompare(String(b.name || ""))
    );
  }

  /** A play's template rows, or [] — defensive against a row cached pre-018. */
  function templateRows(template) {
    return (template && Array.isArray(template.rows)) ? template.rows : [];
  }

  // What a scoreboard row does when tapped — a real player's profile, or the
  // claim sheet for a ghost that might be the viewer. Shared with
  // ui/play-card.js, which draws the same list; the decision lives in
  // ui/player-row-action.js so the two cannot drift again.
  //
  // dismissFirst is this surface's whole difference: the popup is a
  // body-level overlay, so it stands down before the destination appears.
  // That matters twice as much for the claim branch — stacking a sheet over
  // this popup would give two competing scroll locks and an ambiguous Escape
  // order.
  function playerAction(pl, play, me) {
    return window.BgbPlayerRowAction
      ? window.BgbPlayerRowAction.for(pl, play, me, {
          dismissFirst: "window.PlayDetailPopup.dismiss();",
        })
      : null;
  }


  // ── View mode ─────────────────────────────────────────────────────────────
  function renderView(p) {
    // Score descending, so the scoreboard reads top-down by rank. Via
    // Play.rankPlayers because the ranking has to be a TOTAL order: the feed
    // seed and the row the confirming fetch brings back disagree about the
    // order of tied players, and a sort that leaves that disagreement intact
    // repaints the card for a difference nobody made.
    const ranked = window.Play.rankPlayers(p.players);
    const me = window.store && window.store.get && window.store.get("user");
    const photoSlot = p.photo_url
      ? `<img data-morph-key="photo" class="play-detail-popup__photo" src="${escapeAttr(p.photo_url)}" alt="" />`
      : (p.is_own
          ? `<button data-morph-key="photo" class="play-detail-popup__add-photo" type="button"
                     onclick="window.PlayDetailPopup._enterEditWithPhotoPicker()">
              <i data-icon="image-plus" class="w-6 h-6"></i>
              <span class="play-detail-popup__add-photo-title">Add a photo</span>
              <span class="play-detail-popup__add-photo-hint">Tap to upload</span>
            </button>`
          : "");

    return `
      <article class="play-detail">
        ${renderGameBubble(p, { editing: false })}

        ${(p.expansions || []).length > 0 ? `
          <section data-morph-key="expansions" class="play-detail__section">
            <h3 class="play-detail__section-title">
              <i data-icon="puzzle" class="w-4 h-4"></i> Expansions
            </h3>
            <ul class="play-detail__expansions">
              ${byName(p.expansions).map((e) => `
                <li onclick="${escapeAttr(gameDetailJs(e.expansion_game_id, e.name, { before: "window.PlayDetailPopup.dismiss();" }))}"
                    title="${escapeAttr(e.name || "")}"
                    style="${e.color ? `--exp-color:${escapeAttr(e.color)}` : ""}">
                  <span class="play-detail__expansion-dot"></span>
                  ${escapeHtml(stripBaseGameName(e.name, p.game_name))}
                </li>
              `).join("")}
            </ul>
          </section>` : ""}

        ${photoSlot}

        ${p.notes ? `
          <section data-morph-key="notes" class="play-detail__section">
            <h3 class="play-detail__section-title">
              <i data-icon="sticky-note" class="w-4 h-4"></i> Notes
            </h3>
            <p class="play-detail__notes">${escapeHtml(p.notes)}</p>
          </section>` : ""}

        <section data-morph-key="players" class="play-detail__section">
          <h3 class="play-detail__section-title">
            <i data-icon="users" class="w-4 h-4"></i> Players
          </h3>
          ${ranked.length === 0
            ? `<div class="text-sm opacity-60">No players recorded.</div>`
            : `<ul class="play-detail__players${ranked.some((pl) => playerAction(pl, p, me)) ? " has-links" : ""}">
                ${ranked.map((pl) => {
                  // Registered players' rows open their profile; a ghost's
                  // opens the claim sheet, with its own trailing icon because
                  // it is a different destination. Either way the popup
                  // dismisses first. A ghost the viewer cannot be stays inert.
                  const act = playerAction(pl, p, me);
                  const nav = act ? act.handler : "";
                  // Only an accepted buddy has an edge to hold an alias, so a
                  // ghost or a stranger gets no pencil rather than one whose
                  // save would 404.
                  const aliasEdgeId = window.Buddy.edgeIdFor(pl.user_id);
                  return `
                  <li class="play-detail__player ${pl.is_winner ? "is-winner" : ""}${act ? " is-link" : ""}${act && act.kind === "claim" ? " play-detail__player--claim" : ""}"
                      ${act ? `role="button" tabindex="0"
                      aria-label="${escapeAttr(act.ariaLabel)}"
                      onclick="${escapeAttr(nav)}"
                      onkeydown="${escapeAttr(`if(event.key==='Enter'||event.key===' '){event.preventDefault();${nav}}`)}"` : ""}>
                    <span class="play-detail__player-name">
                      ${window.BgbBadge ? window.BgbBadge.render({
                        avatar: pl.avatar || null,
                        displayName: window.Buddy.nameFor(pl.user_id, pl.name),
                        size: "xs",
                        isGhost: !pl.user_id,
                        isMe: !!(me && pl.user_id === me.id),
                        extraClass: "play-detail__player-badge",
                      }) : ""}
                      <span class="play-detail__player-text">${escapeHtml(window.Buddy.nameFor(pl.user_id, pl.name))}</span>
                      ${pl.is_winner ? `<i data-icon="crown" class="w-3.5 h-3.5 play-detail__player-crown"></i>` : ""}
                      <!-- Inside the name span, not a sibling of it: the row is
                           flex with justify-content:space-between, so a third
                           top-level child would float in the gap between the
                           name and the score instead of sitting with the name
                           it belongs to. -->
                      ${aliasEdgeId ? `
                        <button class="bgb-alias-btn" type="button"
                                aria-label="${escapeAttr("Rename " + pl.name + " for yourself")}"
                                title="Rename just for you"
                                onclick="event.stopPropagation();window.PlayDetailPopup._openAlias('${aliasEdgeId}','${pl.user_id}')">
                          <i data-icon="pencil" class="w-3.5 h-3.5"></i>
                        </button>
                      ` : ""}
                    </span>
                    <span class="play-detail__player-score">${pl.score != null ? pl.score : ""}</span>
                    ${act ? `<i data-icon="${escapeAttr(act.icon)}" class="w-3.5 h-3.5 play-detail__player-go"></i>` : ""}
                  </li>
                `;}).join("")}
              </ul>`}
        </section>

        ${hasRoundGrid(p.players, null, p.scoring_template) ? `
          <section data-morph-key="rounds" class="play-detail__section">
            <h3 class="play-detail__section-title">
              <i data-icon="layers" class="w-4 h-4"></i> Rounds
            </h3>
            <!-- \`ranked\`, not \`p.players\`: the grid's columns and the
                 scoreboard rows immediately above are the same list of people,
                 and drawing one in ranked order and the other in whatever order
                 the payload arrived in made them disagree with each other on
                 screen — as well as re-ordering between the seed and the fetch. -->
            ${window.renderRoundGrid(
              ranked.map((pl) => ({
                name: pl.name,
                is_winner: !!pl.is_winner,
                user_id: pl.user_id || null,
                avatar: pl.avatar || null,
                roundScores: Array.isArray(pl.round_scores) ? pl.round_scores : [],
              })),
              "PlayDetailPopup",
              {
                editable: false,
                playMode: p.play_mode || "competitive",
                rowLabels: templateRows(p.scoring_template),
              }
            )}
          </section>` : ""}
      </article>
    `;
  }

  /**
   * The date line under the game name, plus where it was played when the play
   * carries a country (migration 065).
   *
   * The only surface that shows the country back to the user. It reads as one
   * more fact about the play — "31 Aug 2026 · Germany" — rather than as its
   * own labelled row, because that is the weight it has: a field the app
   * filled in for a count nobody is looking at yet. Every play logged before
   * 060, and every one whose device couldn't resolve a country, simply shows
   * the date it always did.
   *
   * Not editable here. The country is set where it is captured — the Where
   * card on Settle Up — and this popup's edit mode is a full replacement of
   * the play (PUT /plays/{id}) that deliberately omits the field, which the
   * backend reads as "leave it alone".
   */
  function playWhenLine(p) {
    const date = formatDate(p.played_at);
    const code = p && p.country_code;
    const where = code && window.Geo ? window.Geo.countryName(code) : "";
    return where ? `${escapeHtml(date)} · ${escapeHtml(where)}` : escapeHtml(date);
  }

  // Shared game bubble for view + edit mode. The title reads "A game of
  // <name>" with the game name in the polaroid accent (same orange the
  // feed uses for winners).
  //
  // The trailing control is the one thing the two modes don't share, because
  // the bubble means something different in each: in view mode it is a
  // signpost, so the control is the Go-to-game-detail arrow (dismissing the
  // popup before it routes); in edit mode it is a FIELD, so the control opens
  // the library search and the name it shows is the draft's, not the stored
  // play's. Same row either way — the game is where the eye already is when
  // the thought is "that's the wrong box", and a change-game control anywhere
  // else would be a scavenger hunt.
  function renderGameBubble(p, { editing }) {
    const d = state.draft;
    const gameId = editing ? d.game_id : p.game_id;
    const gameName = editing ? d.game_name : p.game_name;
    const thumb = editing ? d.game_thumbnail : p.game_thumbnail;
    const gameNav = escapeAttr(gameDetailJs(p.game_id, p.game_name, {
      stop: true, before: "window.PlayDetailPopup.dismiss();",
    }));
    const subline = editing
      ? `<input id="play-popup-date" type="date" class="input input-bordered input-sm"
                value="${escapeAttr(d.played_at)}"
                onchange="window.PlayDetailPopup._setDraft('played_at', this.value)" />`
      : `<div class="play-detail__game-when">${playWhenLine(p)}</div>`;
    return `
      <div data-morph-key="meta" class="play-detail__meta">
        <div class="play-detail__game-row">
          ${thumb
            ? `<img class="play-detail__game-thumb" src="${escapeAttr(thumb)}" alt="" />`
            : ""}
          <div class="play-detail__game-info">
            <div class="play-detail__game-title">
              A game of <span class="play-detail__game-name">${escapeHtml(gameName)}</span>
            </div>
            ${subline}
          </div>
          ${editing ? `
            <button class="play-detail__game-goto play-detail__game-change" type="button"
                    aria-label="Change the game this play was"
                    title="Change game"
                    onclick="window.PlayDetailPopup._openGamePicker(event)">
              <i data-icon="pencil" class="w-4 h-4"></i>
            </button>
          ` : gameId ? `
            <button class="play-detail__game-goto" type="button"
                    aria-label="Go to game detail page"
                    title="Go to game detail page"
                    onclick="${gameNav}">
              <i data-icon="arrow-up-right" class="w-4 h-4"></i>
            </button>
          ` : ""}
        </div>
        ${editing && d.game_id !== p.game_id ? `
          <p class="play-detail__game-moved">
            <i data-icon="info" class="w-3.5 h-3.5"></i>
            <span>Saving moves this play to
              <strong>${escapeHtml(d.game_name)}</strong>. Everyone at the table
              keeps their score.${gamePivotLosses(p)}</span>
          </p>
        ` : ""}
      </div>
    `;
  }

  // The half of a pivot that isn't carried, named before the user commits to it
  // — and "" when nothing is, which is the common case and deserves no warning
  // at all beyond the move itself.
  //
  // Both losses are the same shape: they were recorded against the game being
  // left. An expansion belongs to that game's tree, and the scoring template is
  // a snapshot of one of its chapters, so neither can follow the play across.
  // The backend drops them on its own side too (_update_play_sync) — this is
  // the sentence that stops it being a surprise. Expansions are the recoverable
  // one: the card below is already offering the NEW game's, so the note points
  // at it rather than leaving the loss looking final.
  //
  // Reads the stored play, not the draft: applyGamePick has already emptied
  // both on the draft, and what the user needs named is what they had.
  function gamePivotLosses(p) {
    const hadExpansions = (p.expansions || []).length > 0;
    const hadTemplate = templateRows(p.scoring_template).length > 0;
    if (!hadExpansions && !hadTemplate) return "";
    const lost = [];
    if (hadExpansions) lost.push("expansions");
    if (hadTemplate) lost.push("scoring rows");
    return ` Its ${lost.join(" and ")} were recorded against `
      + `${escapeHtml(p.game_name)} and have been cleared`
      + (hadExpansions ? " — pick the new game's below." : ".");
  }

  // Non-owner self-remove. Turns the caller's player row into a ghost so the
  // play drops out of their history while the owner keeps it. Mirrors
  // deletePlay's confirm → re-mount → mutate → dismiss shape (that one is the
  // edit half's, in widgets/play-detail-edit.js — this is the view-mode
  // footer's only action, so it stays here with the card it belongs to).
  async function leavePlay() {
    if (!state.play || !state.play.id) return;
    const ok = await window.PolaroidPopup.confirm({
      title: "Remove yourself from this play?",
      body: "You won't appear in this game log anymore. The player who logged it will still see the game with your name.",
      confirmLabel: "Remove me",
      cancelLabel: "Stay",
    });
    if (!ok) return;
    state.saving = true;
    state.editError = null;
    // Re-mount because PolaroidPopup.confirm dismissed our backdrop.
    remount();
    render();
    try {
      await window.Play.leave(state.play.id);
    } catch (e) {
      // View-mode footer has no inline error slot (that's edit-only), so
      // surface the failure through the global toast and re-enable the button.
      showToast((e && e.message) || "Failed to remove you from this play", "error");
      state.saving = false;
      render();
      return;
    }
    if (window.store && window.store.invalidate) window.store.invalidate("feed");
    document.dispatchEvent(new CustomEvent("play-changed", { detail: { playId: state.play.id, kind: "leave" } }));
    showToast("Removed you from this play", "info");
    dismiss();
  }

  /**
   * Rename a buddy from a player row, without leaving the play.
   *
   * The alias lives in the Buddy module's map rather than in this play, so the
   * write touches nothing about the play itself and a re-render is enough to
   * show it. state.buddies is refreshed alongside it when we have one, so
   * reopening the sheet shows the value that was just saved.
   * @param {string} edgeId
   * @param {string} userId
   */
  async function openAlias(edgeId, userId) {
    const seat = ((state.play && state.play.players) || [])
      .find((pl) => pl.user_id === userId);
    const real = (seat && seat.name) || "this buddy";
    window.BuddyAliasSheet.open({
      edgeId,
      displayName: real,
      alias: window.Buddy.aliasFor(userId),
      returnFocus: document.activeElement,
      onSave: async (alias) => {
        const before = window.Buddy.aliasFor(userId);
        const next = (alias || "").trim() || null;
        if (before === next) return;
        const patch = (v) => {
          window.Buddy.rememberAliases([
            { other_user_id: userId, other_alias: v, id: edgeId },
          ]);
          const b = (state.buddies || []).find((x) => x.other_user_id === userId);
          if (b) b.other_alias = v;
          render();
        };
        patch(next);
        try {
          await window.Buddy.setAlias(edgeId, next);
        } catch (e) {
          patch(before);
          if (typeof showToast === "function") {
            showToast((e && e.message) || "Couldn't save that alias", "error");
          }
        }
      },
    });
  }

  // The edit half is a second FILE, not a second module: it mutates this
  // file's `state` and repaints through this render(), because a draft held
  // anywhere else would only have to be synchronised back here. What it gets
  // is what it cannot reach on its own — the state bag, the paint, and the
  // three shell functions its markup shares with view mode.
  window.PlayDetailEdit.init({
    state,
    render,
    dismiss,
    remount,
    root: () => _modal.el,
    renderGameBubble,
    hasRoundGrid,
    templateRows,
  });

  // One namespace, whichever file a handler lives in. Every inline onclick in
  // both halves' markup says `window.PlayDetailPopup._x`, and the shared
  // round-score-grid widget builds its handler names and cell ids off the
  // "PlayDetailPopup" host string — so the split has to be invisible from the
  // markup, and the assembly happens here rather than each file claiming a
  // slice of the same global.
  window.PlayDetailPopup = Object.assign({
    show,
    dismiss,
    // Handlers exposed for inline onclick wiring inside the rendered HTML.
    _openAlias: openAlias,
    _leavePlay: leavePlay,
  }, window.PlayDetailEdit.handlers);
})();
