// widgets/play-detail-popup.js — expanded polaroid modal for a single play.
//
// Replaces the play-detail page route as the "tap-to-expand" surface from
// the polaroid play card. Shows the full play record (photo, scoreboard
// with winners highlighted, notes), supports an edit mode that mirrors
// the play-detail page (date, players, notes, photo upload, delete), and
// lives in-place over whatever view the user came from — no navigation.
//
// API:
//   window.PlayDetailPopup.show(playId)   — fetch + open the popup
//   window.PlayDetailPopup.dismiss()      — close without saving

// @ts-check

(function () {
  const BACKDROP_ID = "bgb-play-detail-popup";

  // Module-scoped singleton state. The popup is a transient sheet and
  // never renders more than once at a time, so a single state bag keeps
  // edit/save/delete plumbing simple.
  const state = {
    playId: null,
    play: null,
    loading: false,
    error: null,
    editing: false,
    saving: false,
    editError: null,
    draft: null,        // working copy while editing
    buddies: [],        // buddy datalist for the add-player input
  };

  // Device-back guard token — see ui/back-guard.js.
  let _back = 0;

  async function show(playId) {
    if (!playId) return;
    dismiss();
    Object.assign(state, {
      playId,
      play: null,
      loading: true,
      error: null,
      editing: false,
      saving: false,
      editError: null,
      draft: null,
      buddies: [],
    });
    mountBackdrop();
    render();
    try {
      state.play = await window.Play.get(playId);
      if (state.play && state.play.is_own) {
        // Buddy list powers the add-player datalist in edit mode. Free
        // lookup — list is small and cached server-side.
        state.buddies = await window.Buddy.list().catch(() => []);
        // Seed the session alias map off our own read, so a popup opened on a
        // cold boot renders aliases without waiting for the partner bundle.
        window.Buddy.rememberAliases(state.buddies);
      }
    } catch (e) {
      state.error = (e && e.message) || "Failed to load play";
    } finally {
      state.loading = false;
      render();
    }
  }

  function dismiss() {
    if (window.BgbBackGuard) window.BgbBackGuard.release(_back);
    _back = 0;
    const existing = document.getElementById(BACKDROP_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
    if (state.draft) clearPendingPhoto(state.draft);
    Object.assign(state, {
      playId: null,
      play: null,
      loading: false,
      error: null,
      editing: false,
      saving: false,
      editError: null,
      draft: null,
      buddies: [],
    });
  }

  function mountBackdrop() {
    const root = document.createElement("div");
    root.id = BACKDROP_ID;
    root.className = "polaroid-popup__backdrop play-detail-popup__backdrop";
    root.addEventListener("click", (ev) => {
      if (ev.target === root) dismiss();
    });
    document.body.appendChild(root);
    // Back closes the card, not the screen it was opened from — the same exit
    // the corner X takes (ui/back-guard.js). In edit mode that discards the
    // draft, which is what the X does too.
    _back = window.BgbBackGuard
      ? window.BgbBackGuard.arm({ root: root, close: dismiss })
      : 0;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  // Preserve focus + caret across the innerHTML replace so the edit-form's
  // text inputs don't lose them on every keystroke.
  function render() {
    const root = document.getElementById(BACKDROP_ID);
    if (!root) return;
    const active = document.activeElement;
    const activeId = active && active.id;
    // Reads as null on <input type=number> (the flat Score field) — that type
    // doesn't support selection, so the `caret != null` guard below skips the
    // restore for it. Only setSelectionRange throws there, and it is already
    // wrapped.
    const caret = active && active.selectionStart;

    root.innerHTML = renderCard();
    window.BgbIcons.render(root);

    const closeBtn = root.querySelector(".play-detail-popup__close");
    if (closeBtn) closeBtn.addEventListener("click", dismiss);

    if (activeId) {
      const el = document.getElementById(activeId);
      if (el && el.focus) {
        el.focus();
        if (caret != null && el.setSelectionRange) {
          try { el.setSelectionRange(caret, caret); } catch (_) {}
        }
      }
    }
  }

  function renderCard() {
    if (state.loading || (!state.play && !state.error)) {
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
          ${state.editing ? renderEdit(p) : renderView(p)}
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
        <div class="play-detail-popup__footer play-detail-popup__footer--edit">
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

  // True when there's a multi-round score breakdown worth surfacing —
  // single-round / no-round plays leave round_scores NULL on the backend
  // and the grid stays hidden. Used by both view and edit modes.
  function hasRoundGrid(players, key) {
    const k = key || "round_scores";
    return Array.isArray(players)
      && players.some((pl) => Array.isArray(pl[k]) && pl[k].length > 1);
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
    // Players sorted by score descending so the scoreboard reads top-down
    // by rank. Stable for equal scores (Array.sort is stable in modern JS).
    const ranked = (p.players || []).slice().sort((a, b) => {
      const sa = a.score == null ? -Infinity : a.score;
      const sb = b.score == null ? -Infinity : b.score;
      return sb - sa;
    });
    const me = window.store && window.store.get && window.store.get("user");
    const photoSlot = p.photo_url
      ? `<img class="play-detail-popup__photo" src="${escapeAttr(p.photo_url)}" alt="" />`
      : (p.is_own
          ? `<button class="play-detail-popup__add-photo" type="button"
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
          <section class="play-detail__section">
            <h3 class="play-detail__section-title">
              <i data-icon="puzzle" class="w-4 h-4"></i> Expansions
            </h3>
            <ul class="play-detail__expansions">
              ${(p.expansions || []).map((e) => `
                <li onclick="window.PlayDetailPopup.dismiss();window.router.go('game-detail',{gameId:'${e.expansion_game_id}',gameName:'${jsStr(e.name || "")}'})"
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
          <section class="play-detail__section">
            <h3 class="play-detail__section-title">
              <i data-icon="sticky-note" class="w-4 h-4"></i> Notes
            </h3>
            <p class="play-detail__notes">${escapeHtml(p.notes)}</p>
          </section>` : ""}

        <section class="play-detail__section">
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

        ${hasRoundGrid(p.players) ? `
          <section class="play-detail__section play-detail__section--rounds">
            <h3 class="play-detail__section-title">
              <i data-icon="layers" class="w-4 h-4"></i> Rounds
            </h3>
            ${window.renderRoundGrid(
              (p.players || []).map((pl) => ({
                name: pl.name,
                is_winner: !!pl.is_winner,
                user_id: pl.user_id || null,
                avatar: pl.avatar || null,
                roundScores: Array.isArray(pl.round_scores) ? pl.round_scores : [],
              })),
              "PlayDetailPopup",
              { editable: false, playMode: p.play_mode || "competitive" }
            )}
          </section>` : ""}
      </article>
    `;
  }

  // ── Edit mode ─────────────────────────────────────────────────────────────
  function enterEdit() {
    if (!state.play) return;
    state.draft = freshDraft(state.play);
    state.editing = true;
    state.editError = null;
    render();
  }

  // Same as enterEdit but also pops the file picker the next paint. Used
  // by the "Add a photo" affordance in view mode so a single tap takes
  // the user straight to choosing a file.
  function enterEditWithPhotoPicker() {
    enterEdit();
    setTimeout(() => {
      const root = document.getElementById(BACKDROP_ID);
      const fileInput = root && root.querySelector(".play-detail-popup__photo-file");
      if (fileInput && fileInput.click) fileInput.click();
    }, 0);
  }

  function cancelEdit() {
    if (state.draft) clearPendingPhoto(state.draft);
    state.editing = false;
    state.draft = null;
    state.editError = null;
    render();
  }

  function freshDraft(p) {
    return {
      played_at: p.played_at,
      notes: p.notes || "",
      players: (p.players || []).map((pl) => ({
        name: pl.name,
        is_winner: !!pl.is_winner,
        score: pl.score != null ? String(pl.score) : "",
        user_id: pl.user_id || null,
        avatar: pl.avatar || null,
        // Mutable draft copy of the persisted breakdown. Empty array when
        // the play had ≤1 rounds (column is NULL on the backend) so the
        // grid handlers can push into it directly when the author opts in.
        roundScores: Array.isArray(pl.round_scores) ? pl.round_scores.slice() : [],
      })),
      expansion_ids: (p.expansions || []).map((e) => e.expansion_game_id),
      play_mode: p.play_mode,
      photoFile: null,
      photoPreviewUrl: null,
    };
  }

  function clearPendingPhoto(draft) {
    if (draft.photoPreviewUrl) {
      try { URL.revokeObjectURL(draft.photoPreviewUrl); } catch (_) {}
    }
    draft.photoFile = null;
    draft.photoPreviewUrl = null;
  }

  function renderEdit(p) {
    const d = state.draft;
    const photoUrl = d.photoPreviewUrl || p.photo_url || "";
    return `
      <article class="play-detail play-detail--edit">
        <section class="play-detail__edit-photo">
          ${photoUrl ? `
            <img src="${escapeAttr(photoUrl)}" alt="" />
            <label class="play-detail__edit-photo-replace">
              <input type="file" accept="image/*" class="hidden play-detail-popup__photo-file"
                     onchange="window.PlayDetailPopup._onPhotoSelect(this.files)" />
              <i data-icon="camera" class="w-4 h-4"></i> Replace photo
            </label>
          ` : `
            <label class="play-detail__edit-photo-pick">
              <input type="file" accept="image/*" class="hidden play-detail-popup__photo-file"
                     onchange="window.PlayDetailPopup._onPhotoSelect(this.files)" />
              <span class="play-detail__edit-photo-pick-icon">
                <i data-icon="image-plus" class="w-5 h-5"></i>
              </span>
              <span class="play-detail__edit-photo-pick-body">
                <span class="play-detail__edit-photo-pick-title">Add a photo</span>
                <span class="play-detail__edit-photo-pick-hint">Tap to choose an image</span>
              </span>
            </label>
          `}
        </section>

        ${renderGameBubble(p, { editing: true })}

        ${hasRoundGrid(d.players, "roundScores") ? `
          <section class="play-detail__section play-detail__section--rounds">
            <div class="scoring-section__head">
              <h3 class="play-detail__section-title">
                <i data-icon="layers" class="w-4 h-4"></i> Rounds
              </h3>
              ${window.RoundGridSign.renderToggle("PlayDetailPopup")}
            </div>
            ${window.renderRoundGrid(d.players, "PlayDetailPopup", {
              editable: true,
              playMode: p.play_mode || "competitive",
              showSign: window.RoundGridSign.enabled(),
            })}
          </section>
        ` : ""}

        <section class="play-detail__section">
          <h3 class="play-detail__section-title">
            <i data-icon="users" class="w-4 h-4"></i> Players
          </h3>
          <ul class="play-detail__edit-players">
            ${d.players.map((pl, i) => `
              <li class="play-detail__edit-player">
                <span class="play-detail__edit-player-name">${escapeHtml(window.Buddy.nameFor(pl.user_id, pl.name))}</span>
                ${hasRoundGrid(d.players, "roundScores")
                  ? `<span class="play-detail__edit-score-readout">${escapeHtml(playerTotal(pl, d.players))}</span>`
                  : `<input type="number" class="input input-bordered input-sm play-detail__edit-score"
                            id="play-popup-score-${i}"
                            placeholder="Score"
                            value="${escapeAttr(pl.score)}"
                            oninput="window.PlayDetailPopup._setPlayerScore(${i}, this.value)" />`}
                <label class="play-detail__edit-winner">
                  <input type="checkbox" ${pl.is_winner ? "checked" : ""}
                         onchange="window.PlayDetailPopup._setPlayerWinner(${i}, this.checked)" />
                  Won
                </label>
                <button class="btn btn-ghost btn-xs" title="Remove" type="button"
                        onclick="window.PlayDetailPopup._removePlayer(${i})">
                  <i data-icon="x" class="w-3.5 h-3.5"></i>
                </button>
              </li>
            `).join("")}
          </ul>
          <div class="play-detail__add-player">
            <input id="play-popup-add-name" class="input input-bordered input-sm w-full"
                   list="play-popup-buddy-list"
                   placeholder="Add player (buddy or free-text)"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();window.PlayDetailPopup._addPlayer();}" />
            <!-- Both spellings, deliberately: a datalist option value is
                 literally what lands in the input, and someone who set an alias
                 may type either it or the real name. addPlayer() below resolves
                 both to the same account and stores the REAL name. -->
            <datalist id="play-popup-buddy-list">
              ${state.buddies.flatMap((b) => [
                `<option value="${escapeAttr(b.other_display_name)}">`,
                b.other_alias ? `<option value="${escapeAttr(b.other_alias)}">` : "",
              ]).join("")}
            </datalist>
            <button class="btn btn-primary btn-sm" type="button"
                    onclick="window.PlayDetailPopup._addPlayer()">Add</button>
          </div>
          ${hasRoundGrid(d.players, "roundScores") ? "" : `
            <button class="btn btn-ghost btn-xs play-detail__init-rounds" type="button"
                    onclick="window.PlayDetailPopup._initRounds()">
              <i data-icon="layers" class="w-3.5 h-3.5"></i> Track per-round scores
            </button>
          `}
        </section>

        <section class="play-detail__section">
          <h3 class="play-detail__section-title">
            <i data-icon="sticky-note" class="w-4 h-4"></i> Notes
          </h3>
          <textarea class="textarea textarea-bordered w-full" rows="2"
                    oninput="window.PlayDetailPopup._setDraft('notes', this.value)">${escapeHtml(d.notes)}</textarea>
        </section>

        ${state.editError ? `<div class="alert alert-error m-3">${escapeHtml(state.editError)}</div>` : ""}
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
  // feed uses for winners), and the right side hosts a Go-to-game-detail
  // arrow that dismisses the popup before routing.
  function renderGameBubble(p, { editing }) {
    const gameNav = `event.stopPropagation();
      window.PlayDetailPopup.dismiss();
      window.router.go('game-detail',{gameId:'${jsStr(p.game_id || "")}',gameName:'${jsStr(p.game_name || "")}'})`;
    const subline = editing
      ? `<input id="play-popup-date" type="date" class="input input-bordered input-sm"
                value="${escapeAttr(state.draft.played_at)}"
                onchange="window.PlayDetailPopup._setDraft('played_at', this.value)" />`
      : `<div class="play-detail__game-when">${playWhenLine(p)}</div>`;
    return `
      <div class="play-detail__meta">
        <div class="play-detail__game-row">
          ${p.game_thumbnail
            ? `<img class="play-detail__game-thumb" src="${escapeAttr(p.game_thumbnail)}" alt="" />`
            : ""}
          <div class="play-detail__game-info">
            <div class="play-detail__game-title">
              A game of <span class="play-detail__game-name">${escapeHtml(p.game_name)}</span>
            </div>
            ${subline}
          </div>
          ${p.game_id ? `
            <button class="play-detail__game-goto" type="button"
                    aria-label="Go to game detail page"
                    title="Go to game detail page"
                    onclick="${gameNav}">
              <i data-icon="arrow-up-right" class="w-4 h-4"></i>
            </button>
          ` : ""}
        </div>
      </div>
    `;
  }

  // ── Edit handlers ─────────────────────────────────────────────────────────
  function setDraft(key, value) {
    if (state.draft) state.draft[key] = value;
  }
  function setPlayerWinner(i, checked) {
    if (state.draft) state.draft.players[i].is_winner = !!checked;
  }
  function setPlayerScore(i, value) {
    if (state.draft) state.draft.players[i].score = value;
  }
  function removePlayer(i) {
    if (!state.draft) return;
    state.draft.players.splice(i, 1);
    // Dropping the player who had the longest column shrinks the grid, so the
    // remaining totals are over a different number of rounds now.
    resyncScores(state.draft.players);
    render();
  }

  // ── Round-grid handlers (mirror play-flow-view's signatures so the
  // shared round-score-grid widget can target either host). ────────────────
  function setRoundScore(i, r, value) {
    if (!state.draft) return;
    const player = state.draft.players[i];
    if (!player) return;
    if (!Array.isArray(player.roundScores)) player.roundScores = [];
    // Sanitized string ("-5") so a leading minus survives; null for empty.
    const clean = window.sanitizeRoundScore(value);
    player.roundScores[r] = clean === "" ? null : clean;
    resyncScores(state.draft.players);
    autoSelectWinners();
    render();
  }
  // Per-cell +/− button: cycle "" → "-" → cleared, or flip the sign.
  function toggleRoundSign(i, r) {
    if (!state.draft) return;
    const player = state.draft.players[i];
    if (!player) return;
    if (!Array.isArray(player.roundScores)) player.roundScores = [];
    const cur = player.roundScores[r] == null ? "" : String(player.roundScores[r]);
    const next = window.nextSignToggle(cur);
    player.roundScores[r] = next === "" ? null : next;
    resyncScores(state.draft.players);
    autoSelectWinners();
    render();
    const el = document.getElementById(`rg-PlayDetailPopup-${i}-${r}`);
    if (el && el.focus) el.focus();
  }
  // Header pill: flip the global "± Negative" preference and repaint.
  function toggleSignButtons() {
    window.RoundGridSign.toggle();
    render();
  }
  function addRound() {
    if (!state.draft) return;
    normalizeRounds(state.draft.players);
    for (const p of state.draft.players) p.roundScores.push(null);
    resyncScores(state.draft.players);
    render();
  }
  function removeRoundAt(r) {
    if (!state.draft) return;
    // Normalize first so the splice lands on every column. Skipping the ones
    // whose array didn't reach `r` is what let the columns drift to different
    // lengths in the first place.
    const n = normalizeRounds(state.draft.players);
    if (!(r >= 0 && r < n)) return;
    for (const p of state.draft.players) p.roundScores.splice(r, 1);
    resyncScores(state.draft.players);
    // When the grid empties out (or drops to a single round), clear the
    // arrays entirely so the save path lands round_scores=NULL again and
    // the "Track per-round scores" affordance re-appears.
    if (!hasRoundGrid(state.draft.players, "roundScores")) {
      for (const p of state.draft.players) p.roundScores = [];
    }
    render();
  }
  function toggleWinner(i) {
    if (!state.draft) return;
    const player = state.draft.players[i];
    if (!player) return;
    player.is_winner = !player.is_winner;
    render();
  }
  function initRounds() {
    if (!state.draft) return;
    // Seed two rounds so the grid trips the >1 gate immediately. Single
    // rounds would render the grid here but stay unpersisted on save —
    // confusing — so we skip straight to 2.
    for (const p of state.draft.players) {
      const existing = Array.isArray(p.roundScores) ? p.roundScores.slice() : [];
      // Carry the existing single-score forward as round 1 so the author
      // doesn't lose data when opting in.
      const initial = existing.length === 1
        ? existing[0]
        : (p.score === "" || p.score == null ? null : Number(p.score));
      p.roundScores = [initial, null];
    }
    resyncScores(state.draft.players);
    render();
  }

  // Auto-pick winners as the player with the highest round-sum. Mirrors
  // play-flow-view's competitive-mode behavior; team / co-op semantics
  // aren't expressible from the popup so we keep it simple. Authors can
  // still toggle winners manually via the trophy / Won checkbox.
  function autoSelectWinners() {
    if (!state.draft) return;
    const totals = state.draft.players.map((p) => playerTotal(p, state.draft.players));
    if (totals.every((t) => t === 0)) return;
    const max = Math.max(...totals);
    state.draft.players.forEach((p, i) => { p.is_winner = totals[i] === max; });
  }

  // A player's total, summed over the grid's round count — NOT over that
  // player's own array length. The grid renders max(length) rows for every
  // column, so a short array must count its missing rounds as blanks rather
  // than silently shortening the sum. Delegates to the widget's helper so the
  // readout beside a player's name and the Total under their column are the
  // same number, computed once.
  function playerTotal(player, players) {
    const roster = players || (state.draft && state.draft.players) || [];
    return window.roundGridTotal(player, window.roundGridRoundCount(roster));
  }

  // Pad every player's roundScores out to the grid's round count so an edit
  // can't leave the columns at different lengths. Mirrors play-flow-view's
  // _normalizeRoundArrays.
  function normalizeRounds(players) {
    const n = window.roundGridRoundCount(players);
    for (const p of players) {
      if (!Array.isArray(p.roundScores)) p.roundScores = [];
      for (let r = 0; r < n; r++) {
        if (!(r in p.roundScores)) p.roundScores[r] = null;
      }
    }
    return n;
  }

  // Re-derive every player's `score` from their rounds. Called after any
  // structural change to the grid (add/remove round, add/remove player), so
  // `score` never survives as a stale total from a previous shape.
  //
  // No-ops when there is no grid: on the simple-score path `score` is what the
  // author typed, and zeroing it out because there are no rounds to add up
  // would be its own kind of wrong maths.
  function resyncScores(players) {
    const n = normalizeRounds(players);
    if (n === 0) return n;
    for (const p of players) p.score = String(playerTotal(p, players));
    return n;
  }

  function addPlayer() {
    const input = document.getElementById("play-popup-add-name");
    const name = (input && input.value || "").trim();
    if (!name || !state.draft) return;
    // Match either spelling — the datalist offers both, and someone who set an
    // alias will reach for it before the real name.
    const lower = name.toLowerCase();
    const buddy = (state.buddies || []).find(
      (b) => (b.other_display_name || "").toLowerCase() === lower
          || (b.other_alias || "").toLowerCase() === lower
    );
    // THE name that gets stored. Always the real one: this string becomes
    // play_players.player_display_name (play_routes.py), a row every
    // participant in the play can read, so a private alias must never reach it
    // — and a typed alias that fell through as free text would create a GHOST
    // player named after it, detached from the account it actually meant.
    const storedName = buddy ? buddy.other_display_name : name;
    const dupe = state.draft.players.some(
      (p) => (p.name || "").toLowerCase() === storedName.toLowerCase()
    );
    if (!dupe) {
      // Match the existing rounds shape so the new row aligns with the
      // grid (nulls fill the columns that other players already have).
      const existingRounds = window.roundGridRoundCount(state.draft.players);
      state.draft.players.push({
        name: storedName,
        is_winner: false,
        score: "",
        user_id: buddy ? buddy.other_user_id : null,
        avatar: buddy ? (buddy.other_avatar || null) : null,
        roundScores: existingRounds > 0
          ? Array.from({ length: existingRounds }, () => null)
          : [],
      });
    }
    if (input) input.value = "";
    render();
  }
  async function onPhotoSelect(fileList) {
    const file = fileList && fileList[0];
    if (!file || !state.draft) return;
    // Auto-compress large photos so the save flow can never get tripped up
    // by a 413 from /plays/photo. Also normalizes HEIC from iOS Safari to
    // JPEG. The backend cap is 5 MiB; helpers.js mirrors it.
    const v = await window.preparePhotoForUpload(file);
    if (!v.ok) {
      showToast(v.error, "error");
      const fi = document.querySelector(".play-detail-popup__photo-file");
      if (fi) fi.value = "";
      return;
    }
    if (!state.draft) return;
    if (v.compressed) {
      showToast(
        `Photo compressed from ${(v.originalSize / 1048576).toFixed(1)} MB to ${(v.compressedSize / 1048576).toFixed(1)} MB`,
        "info"
      );
    }
    clearPendingPhoto(state.draft);
    state.draft.photoFile = v.file;
    state.draft.photoPreviewUrl = URL.createObjectURL(v.file);
    render();
  }

  async function deletePlay() {
    if (!state.play || !state.play.id) return;
    const ok = await window.PolaroidPopup.confirm({
      title: "Delete this play?",
      body: "This can't be undone.",
      confirmLabel: "Delete",
      cancelLabel: "Keep play",
    });
    if (!ok) return;
    state.saving = true;
    state.editError = null;
    // Re-mount because PolaroidPopup.confirm dismissed our backdrop.
    if (!document.getElementById(BACKDROP_ID)) mountBackdrop();
    render();
    try {
      await window.Play.remove(state.play.id);
    } catch (e) {
      state.editError = (e && e.message) || "Failed to delete";
      state.saving = false;
      render();
      return;
    }
    if (window.store && window.store.invalidate) window.store.invalidate("feed");
    document.dispatchEvent(new CustomEvent("play-changed", { detail: { playId: state.play.id, kind: "delete" } }));
    dismiss();
  }

  // Non-owner self-remove. Turns the caller's player row into a ghost so the
  // play drops out of their history while the owner keeps it. Mirrors
  // deletePlay's confirm → re-mount → mutate → dismiss shape.
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
    if (!document.getElementById(BACKDROP_ID)) mountBackdrop();
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

  async function saveEdit() {
    if (!state.draft) return;
    state.saving = true;
    state.editError = null;
    render();

    // Upload photo first so the PUT carries the new URL. On failure,
    // keep the existing photo_url and proceed with the rest of the edits
    // — a transient upload error shouldn't drop the user's other
    // changes. The fallback warning fires after save() so the user
    // can't navigate away unaware.
    let photoUrl = state.play.photo_url || null;
    let photoUploadFailed = false;
    if (state.draft.photoFile) {
      try {
        const fd = new FormData();
        fd.append("file", state.draft.photoFile);
        const resp = await window.api.upload("/plays/photo", fd);
        if (resp && resp.photo_url) photoUrl = resp.photo_url;
      } catch (_) {
        photoUploadFailed = true;
      }
    }

    // Persist the per-round breakdown only when the grid was actually
    // populated with more than one round — single / no-round plays
    // round-trip as round_scores=NULL so the simple-score path stays
    // clean. When the grid IS active, each player's final `score` is
    // derived from the sum of their rounds, ignoring any stale value
    // left over from before the author opted into rounds.
    const gridActive = hasRoundGrid(state.draft.players, "roundScores");
    // Square the columns up before serializing: `score` is summed over the
    // grid's round count, so `round_scores` has to be that long too or the
    // saved play would carry a total its own breakdown doesn't add up to.
    const gridRounds = gridActive ? normalizeRounds(state.draft.players) : 0;
    const payload = {
      played_at: state.draft.played_at,
      notes: state.draft.notes || null,
      photo_url: photoUrl,
      expansion_ids: state.draft.expansion_ids,
      play_mode: state.draft.play_mode || null,
      players: state.draft.players.map((p) => {
        const rs = Array.isArray(p.roundScores) ? p.roundScores : [];
        const round_scores = gridActive && gridRounds > 1
          ? rs.slice(0, gridRounds).map((v) => window.parseRoundScore(v))
          : null;
        const score = gridActive
          ? playerTotal(p, state.draft.players)
          : (p.score === "" || p.score == null ? null : Number(p.score));
        return {
          name: p.name,
          is_winner: !!p.is_winner,
          score,
          user_id: p.user_id || null,
          round_scores,
        };
      }),
    };
    try {
      state.play = await window.Play.update(state.play.id, payload);
      if (state.draft) clearPendingPhoto(state.draft);
      state.editing = false;
      state.draft = null;
      if (window.store && window.store.invalidate) window.store.invalidate("feed");
      document.dispatchEvent(new CustomEvent("play-changed", { detail: { playId: state.play.id, kind: "update" } }));
    } catch (e) {
      state.editError = (e && e.message) || "Failed to save";
    } finally {
      state.saving = false;
      render();
    }
    // Blocking alert AFTER the save resolves so the user has to
    // acknowledge that their photo didn't upload before anything else.
    if (photoUploadFailed && window.PolaroidPopup && window.PolaroidPopup.alert) {
      await window.PolaroidPopup.alert({
        title: "Photo couldn't be uploaded",
        body: "Your play was saved without the new photo. You can add it later from the play card.",
      });
    }
  }

  function formatDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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

  window.PlayDetailPopup = {
    show,
    dismiss,
    // Handlers exposed for inline onclick wiring inside the rendered HTML.
    _enterEdit: enterEdit,
    _enterEditWithPhotoPicker: enterEditWithPhotoPicker,
    _cancelEdit: cancelEdit,
    _setDraft: setDraft,
    _setPlayerWinner: setPlayerWinner,
    _setPlayerScore: setPlayerScore,
    _removePlayer: removePlayer,
    _addPlayer: addPlayer,
    _openAlias: openAlias,
    // Round-grid handlers (signatures match play-flow-view so the
    // shared round-score-grid widget can target either host).
    _setRoundScore: setRoundScore,
    _toggleRoundSign: toggleRoundSign,
    _toggleSignButtons: toggleSignButtons,
    _addRound: addRound,
    _removeRoundAt: removeRoundAt,
    _toggleWinner: toggleWinner,
    _initRounds: initRounds,
    _onPhotoSelect: onPhotoSelect,
    _deletePlay: deletePlay,
    _leavePlay: leavePlay,
    _saveEdit: saveEdit,
  };
})();
