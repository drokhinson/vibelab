// widgets/play-detail-edit.js — the edit half of the play-detail popup.
//
// widgets/play-detail-popup.js owns the modal, the fetch and the read-only
// card. This file owns everything behind the Edit pill: the draft, the form
// that paints it, every handler that mutates it, and the save and delete that
// end it. The two were one 1,444-line file — several times the ~300-line
// guidance in CLAUDE.md, and long past the point where anyone looking for the
// view markup had to scroll through the round-grid maths to reach it.
//
// The seam is the DRAFT, not the state. There is still exactly one popup and
// one `state` bag: this file receives it by reference from the shell's init()
// and repaints through the shell's render(), because view and edit are two
// faces of the same card and a draft held in a second place would only have to
// be synchronised back into the first. What each file owns is the half of
// `state` it writes — the shell sets `play` / `error` / `buddies`, this one
// sets `editing` / `draft` / `saving` / `editError`.
//
// Loaded BEFORE play-detail-popup.js (index.html): the shell reads `handlers`
// off this namespace when it assembles window.PlayDetailPopup, and calls
// init() to hand the context back. Nothing here runs before that.
//
// API — consumed by the shell, never by a view:
//   window.PlayDetailEdit.init(ctx)      — wire the shared context, once
//   window.PlayDetailEdit.renderForm(p)  — the edit form, for renderCard()
//   window.PlayDetailEdit.discardDraft() — drop a pending draft on close
//   window.PlayDetailEdit.handlers       — the inline-onclick handler set

// @ts-check

(function () {
  // The shell's own objects and functions, bound by init() — deliberately not
  // copies. `state` is the same bag the shell renders from, so a draft written
  // here is on screen at the next paint with nothing to synchronise, and
  // render() here is render() there, byte-identity guard and all.
  /** @type {any} */ let state = null;
  /** @type {() => void} */ let render = () => {};
  /** @type {() => void} */ let dismiss = () => {};
  /** @type {() => void} */ let remount = () => {};
  /** @type {() => (HTMLElement|null)} */ let popupRoot = () => null;
  /** @type {(p: any, opts: { editing: boolean }) => string} */
  let renderGameBubble = () => "";
  /** @type {(players: any[], key: string|null, template: any) => boolean} */
  let hasRoundGrid = () => false;
  /** @type {(template: any) => any[]} */ let templateRows = () => [];

  /** @param {any} ctx The shell's shared context — see the shell's init() call. */
  function init(ctx) {
    state = ctx.state;
    render = ctx.render;
    dismiss = ctx.dismiss;
    remount = ctx.remount;
    popupRoot = ctx.root;
    renderGameBubble = ctx.renderGameBubble;
    hasRoundGrid = ctx.hasRoundGrid;
    templateRows = ctx.templateRows;
  }

  // Called from the shell's resetState, which runs on every exit — x, outside
  // tap, Escape, back. Revoking the object URL is the part that matters: a
  // draft dropped with a pending photo still preview-mapped leaks the blob for
  // the life of the document.
  function discardDraft() {
    if (state && state.draft) clearPendingPhoto(state.draft);
  }

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
      const root = popupRoot();
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
      // The game this play is FOR. Editable since the commonest thing wrong
      // with a logged play is the box on the front of it — a wrong edition, a
      // near-namesake, or a pick made in a hurry at the table. Changing it here
      // moves the play whole: the seats, the scores, the notes and the photo
      // are facts about an evening, not about the game they were filed under.
      game_id: p.game_id,
      game_name: p.game_name,
      game_thumbnail: p.game_thumbnail || null,
      notes: p.notes || "",
      // Ranked once, here, for the same reason the expansions below are sorted
      // once: view mode lists these players in Play.rankPlayers order, so a
      // draft built from the raw payload order made tapping Edit visibly
      // reshuffle the roster. Sorting at RENDER time instead would be worse
      // than either — resyncScores and autoSelectWinners rewrite scores on
      // every keystroke, so rows would jump under the user's finger as they
      // typed. The indices the grid and the row handlers address are assigned
      // after this sort and never move again.
      players: window.Play.rankPlayers(p.players).map((pl) => ({
        name: pl.name,
        is_winner: !!pl.is_winner,
        score: pl.score != null ? String(pl.score) : "",
        user_id: pl.user_id || null,
        avatar: pl.avatar || null,
        // Mutable draft copy of the persisted breakdown. Empty array when
        // the play had ≤1 rounds (column is NULL on the backend) so the
        // grid handlers can push into it directly when the author opts in.
        roundScores: Array.isArray(pl.round_scores) ? pl.round_scores.slice() : [],
        // Carried so the save below can put it back. Edit mode offers no way to
        // CHANGE a side yet — the point of holding it is that editing the notes
        // must not erase who played with whom, and PUT /plays/{id} is a full
        // replacement that deletes and re-inserts every seat.
        team: pl.team || "",
      })),
      // The whole refs, not just their ids: the edit form draws these as
      // named chips, so a bare id list would mean holding a second lookup
      // in parallel with the thing the user is actually editing. The save
      // maps back down to ids, which is all PUT /plays/{id} takes.
      // Sorted ONCE, here, rather than at render time: the edit list is a
      // draft the user adds to and removes from, and re-sorting on every paint
      // would move a chip out from under the finger reaching for its ×. Name
      // order matches what view mode shows, so tapping Edit does not reshuffle.
      expansions: (p.expansions || []).slice()
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
        .map((e) => ({
          expansion_game_id: e.expansion_game_id,
          name: e.name,
          color: e.color || null,
        })),
      play_mode: p.play_mode,
      // Carried so the edit grid labels its rows the same way the view grid
      // does. Never edited here, and never sent back: PUT /plays/{id} leaves
      // scoring_template alone when the body omits it, which is exactly what an
      // edit form that doesn't offer the field should do.
      scoring_template: p.scoring_template || null,
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

        ${renderEditExpansions(d)}

        ${hasRoundGrid(d.players, "roundScores", d.scoring_template) ? `
          <section class="play-detail__section">
            <h3 class="play-detail__section-title">
              <i data-icon="layers" class="w-4 h-4"></i> Rounds
            </h3>
            ${window.renderRoundGrid(d.players, "PlayDetailPopup", {
              editable: true,
              playMode: p.play_mode || "competitive",
              // The labels are frozen here on purpose: changing them is a
              // CHAPTER edit, and this play's copy is its own record of how it
              // was scored.
              rowLabels: templateRows(d.scoring_template),
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
                ${hasRoundGrid(d.players, "roundScores", d.scoring_template)
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
          <!-- The same sheet Gather and the play importer open, asking the
               same question of the same list — and deliberately the same
               AFFORDANCE as Gather's, down to the class: one destination gets
               one affordance (.claude/rules/ui-object-design.md §3b), and
               .cascade-add-player already paints from the --polaroid-* family
               this card sets, so it needs no CSS of its own here.

               It replaced a bare text input with a buddy datalist beside it.
               A datalist offers its options only once you start typing, so
               every buddy sat behind a name the user had to remember first;
               aliases had to be templated in as a second <option> per person
               to be typeable at all; and a typo landed silently as a brand-new
               ghost player rather than the account it meant. -->
          <button class="cascade-add-player" type="button" aria-haspopup="dialog"
                  onclick="window.PlayDetailPopup._openPlayerPicker(event)">
            <i data-icon="plus" class="w-4 h-4"></i>
            <span>Add players…</span>
          </button>
          ${hasRoundGrid(d.players, "roundScores", d.scoring_template) ? "" : `
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
          <!-- id, because a surface that restores focus by id cannot find a
               field without one (web-frontend.md, "Async state"). The morph
               normally preserves this node and its caret outright; the id is
               what makes the captureFocus/restoreFocus backstop work on the
               paints that do replace it, such as leaving edit mode. -->
          <textarea id="play-popup-notes" class="textarea textarea-bordered w-full" rows="2"
                    oninput="window.PlayDetailPopup._setDraft('notes', this.value)">${escapeHtml(d.notes)}</textarea>
        </section>

        ${state.editError ? `<div class="alert alert-error m-3">${escapeHtml(state.editError)}</div>` : ""}
      </article>
    `;
  }

  /**
   * The Expansions card in edit mode: one removable chip per expansion, plus
   * an Add row.
   *
   * View mode already lists expansions, so the edit form listing them but
   * refusing to change them was the one card on this surface that read as
   * broken rather than as read-only — "we played that WITH Leaders" is exactly
   * the kind of thing you remember an hour after logging the play.
   *
   * Always rendered, even with nothing on the play: an empty card is what says
   * expansions are a thing you can add here. The chips carry the expansion's
   * own colour dot, the same mark the view list and the feed card use, so one
   * expansion is recognisable across all three at a glance.
   */
  function renderEditExpansions(d) {
    return `
      <section class="play-detail__section">
        <h3 class="play-detail__section-title">
          <i data-icon="puzzle" class="w-4 h-4"></i> Expansions
        </h3>
        ${d.expansions.length ? `
          <ul class="play-detail__edit-expansions">
            ${d.expansions.map((e) => `
              <li class="play-detail__edit-expansion"
                  style="${e.color ? `--exp-color:${escapeAttr(e.color)}` : ""}">
                <span class="play-detail__expansion-dot"></span>
                <span class="play-detail__edit-expansion-name"
                      title="${escapeAttr(e.name || "")}">${escapeHtml(stripBaseGameName(e.name, d.game_name))}</span>
                <button class="btn btn-ghost btn-xs" type="button"
                        aria-label="${escapeAttr("Remove " + (e.name || "this expansion"))}"
                        title="Remove"
                        onclick="window.PlayDetailPopup._removeExpansion('${escapeAttr(e.expansion_game_id)}')">
                  <i data-icon="x" class="w-3.5 h-3.5"></i>
                </button>
              </li>
            `).join("")}
          </ul>
        ` : `<p class="play-detail__edit-expansions-empty">No expansions on this play.</p>`}
        <button class="btn btn-ghost btn-xs play-detail__add-expansion" type="button"
                onclick="window.PlayDetailPopup._openExpansionPicker(event)">
          <i data-icon="plus" class="w-3.5 h-3.5"></i> Add expansions
        </button>
      </section>
    `;
  }


  // ── Edit handlers ─────────────────────────────────────────────────────────
  function setDraft(key, value) {
    if (state.draft) state.draft[key] = value;
  }
  /**
   * Pick a different game for this play. The library search, in the same sheet
   * Gather uses, so "which game?" is asked the same way everywhere.
   *
   * Stacked over the popup rather than dismissing it first, like the alias
   * sheet: there is an unsaved draft behind this, and closing the card to ask
   * one question would throw it away.
   * @param {Event} [event]
   */
  function openGamePicker(event) {
    if (!state.draft) return;
    window.GameSearchSheet.open({
      title: "Which game was this?",
      placeholder: "Search for a game…",
      returnFocus: (event && event.currentTarget) || null,
      onPick: (game) => {
        // Same refusal Gather makes, for the same reason: an expansion is
        // played WITH a base game, so it can't be what a play WAS. The
        // backend refuses it too — this is the half that answers in the row
        // the user tapped instead of at save time.
        if (game && game.is_expansion) {
          return { refuse: true, reason: "Pick a base game — expansions go in the Expansions card below." };
        }
        applyGamePick(game);
      },
      onError: (err) => showToast((err && err.message) || "Search failed", "error"),
    });
  }

  /** @param {any} game A GameFinder result. */
  function applyGamePick(game) {
    const d = state.draft;
    if (!d || !game || !game.id) return;
    if (game.id === d.game_id) return;
    d.game_id = game.id;
    d.game_name = game.name;
    d.game_thumbnail = game.thumbnail_url || null;
    // Inherited from the new game the way a fresh log inherits it (play-flow's
    // _applyGamePick does the same) — a play moved onto a co-op game is a co-op
    // play. NOT falling back to what the play already had: that is the mode of
    // the game being left, and carrying it across is the one answer that is
    // certainly wrong. A search hit with no mode sends null instead, which the
    // backend reads as "inherit from the new game" — same answer, decided by
    // the side that can see the game row.
    d.play_mode = game.play_mode || null;
    // Both of these were recorded against the game being left: an expansion
    // belongs to that game's tree, and the template is a snapshot of one of its
    // scoring chapters. Neither can follow the play across, and the backend
    // drops them on its own side too — clearing them here is what makes the
    // form show the truth before the user saves it rather than after.
    d.expansions = [];
    d.scoring_template = null;
    render();
  }

  /**
   * Add expansions to the draft, from the catalog for the draft's CURRENT
   * game — which is the point of reading d.game_id rather than the stored
   * play's: pivot the game and the picker follows, so the expansions offered
   * are always ones that could actually have been at that table.
   * @param {Event} [event]
   */
  function openExpansionPicker(event) {
    const d = state.draft;
    if (!d || !d.game_id) return;
    window.ExpansionPickerSheet.open({
      baseGameId: d.game_id,
      baseGameName: d.game_name,
      // The sheet's filter is "don't offer what's already picked" — it calls
      // the option ownedIds because its first caller was the collection shelf.
      ownedIds: d.expansions.map((e) => e.expansion_game_id),
      returnFocus: (event && event.currentTarget) || null,
      // One repaint for the whole set, not one per expansion: the sheet is
      // multi-select and hands back everything that was ticked, in tick order.
      onConfirm: (exps) => addExpansions(exps),
    });
  }

  /** @param {any[]} exps ExpansionListItems from the picker, in tick order. */
  function addExpansions(exps) {
    const d = state.draft;
    if (!d || !Array.isArray(exps)) return;
    let added = 0;
    for (const exp of exps) {
      if (!exp || !exp.expansion_game_id) continue;
      if (d.expansions.some((e) => e.expansion_game_id === exp.expansion_game_id)) continue;
      d.expansions.push({
        expansion_game_id: exp.expansion_game_id,
        name: exp.name,
        color: exp.color || null,
      });
      added++;
    }
    if (added) render();
  }

  /** @param {string} expansionGameId */
  function removeExpansion(expansionGameId) {
    const d = state.draft;
    if (!d) return;
    d.expansions = d.expansions.filter((e) => e.expansion_game_id !== expansionGameId);
    render();
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
    // A template's rows render no remove button, but this is a global inline
    // handler a stale paint or the console can still reach — and a hole punched
    // mid-grid leaves every label below it describing the wrong numbers.
    if (r < templateRows(state.draft.scoring_template).length) return;
    for (const p of state.draft.players) p.roundScores.splice(r, 1);
    resyncScores(state.draft.players);
    // When the grid empties out (or drops to a single round), clear the
    // arrays entirely so the save path lands round_scores=NULL again and
    // the "Track per-round scores" affordance re-appears.
    if (!hasRoundGrid(state.draft.players, "roundScores", state.draft.scoring_template)) {
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
  // play-flow-view's competitive-mode behavior, and ONLY that mode: the other
  // two aren't near-enough fits, they are different questions. A co-op table
  // shares one outcome, and a team play's sides don't exist in this popup at
  // all — the team column lives on the Play screen. Running "highest total
  // wins" over either would answer from data it cannot see, uncrowning every
  // winner but one on a play whose author came here to fix a score. There the
  // Won checkbox is the only thing that crowns, which is what it is for.
  function autoSelectWinners() {
    if (!state.draft) return;
    if ((state.draft.play_mode || "competitive") !== "competitive") return;
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

  // What playerTotal is worth SAVING: null when the row was left blank, so an
  // untouched grid does not persist a table of zeroes. The simple-score branch
  // of the save already maps "" to null; this gives the grid branch the same
  // manners. See rollupScore in domain/play-session.js.
  function playerScoreForSave(player, players) {
    const roster = players || (state.draft && state.draft.players) || [];
    const rounds = window.roundGridRoundCount(roster);
    return window.roundGridHasAnyScore(player, rounds)
      ? window.roundGridTotal(player, rounds)
      : null;
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

  // ── Adding players ────────────────────────────────────────────────────────
  //
  // Through widgets/player-picker-sheet.js — multi-select, so a play missing
  // three of the five people at the table is one open, three taps and Add,
  // rather than three rounds of remember-a-name-and-type-it. It stacks over
  // the popup like the game and expansion sheets do (there is an unsaved draft
  // behind this card, and closing it to ask one question would throw the draft
  // away), and Escape while it is up belongs to the sheet — see the shell's
  // hasStackedOverlay().
  //
  // The sheet's contract does the work the old typed input had to do by hand:
  // it paints a private alias but hands back the REAL display name, so the
  // string that reaches play_players.player_display_name — a row every
  // participant in the play can read — is never someone's private nickname for
  // them, and a buddy reached for by their alias can no longer land as a ghost
  // named after it.

  /** Case-folded name key — the roster's own identity test, see seatPlayer. */
  const nameKey = (n) => String(n || "").trim().toLowerCase();

  /**
   * The signed-in user as a picker row, or null when there is no session.
   *
   * GET /play-partners never returns the viewer — it answers "who do you play
   * with?" — so every surface that can seat somebody OTHER than by
   * construction has to prepend this row itself (both importers already do).
   * This one can: a play whose roster the viewer is missing from, either
   * because the row was removed here or because the play was logged without
   * them, had no way to put them back. The sheet was showing every person
   * they have ever played with except the one they were looking for.
   *
   * Named exactly as _ensureSelfIncluded and the importers spell the seeded
   * seat, so the row and the seat it would duplicate can never disagree.
   */
  function viewerCandidate() {
    const me = window.store && window.store.get("user");
    if (!me || !me.id) return null;
    const name = me.display_name || me.username || "";
    if (!name) return null;
    return {
      source: "account",
      user_id: me.id,
      name,
      username: me.username || null,
      avatar: me.avatar || null,
      isViewer: true,
    };
  }

  /**
   * Everyone this play could gain: the viewer themselves, their buddies, the
   * accounts they've shared a table with, and the ghost names from past plays
   * — minus everyone already seated in the draft, which is the sheet's own
   * contract for `candidates` ("everyone addable, already filtered of people
   * in the roster by the caller"). A row it offers that seatPlayer would drop
   * is a row that does nothing when tapped.
   *
   * YOU come first, so the answer to "why am I not on this play?" is the row
   * the sheet opens on rather than something to scroll for.
   *
   * Filtered on BOTH id and name, because the roster mixes the two kinds of
   * seat: an account is already at this table if its id is, and a ghost has no
   * id to match on. The name test also catches the crossing case — a play with
   * a ghost "Marcus" on it must not offer buddy Marcus's account, because
   * seatPlayer dedupes by name and would refuse the seat.
   */
  function playerCandidates() {
    const seated = (state.draft && state.draft.players) || [];
    const seatedIds = new Set(seated.map((p) => p.user_id).filter(Boolean));
    const seatedNames = new Set(seated.map((p) => nameKey(p.name)));
    const me = viewerCandidate();
    const rows = (me ? [me] : []).concat(window.Buddy.toPlayerCandidates(state.partners));
    // Accounts are deduped by id here rather than relying on the bundle's own
    // dedupe, because the viewer row is prepended from the store: a user who
    // somehow also appears in their own partner list would otherwise be
    // offered twice, with only one of the two rows marked "You".
    const seenIds = new Set();
    return rows.filter((c) => {
      if (!c.name || seatedNames.has(nameKey(c.name))) return false;
      if (c.user_id) {
        if (seatedIds.has(c.user_id) || seenIds.has(c.user_id)) return false;
        seenIds.add(c.user_id);
      }
      return true;
    });
  }

  /** How many people lead the list before "everyone else" starts. */
  const SUGGEST_MAX = 6;

  /**
   * The people most likely to be the missing seat, leading the list: whoever
   * the viewer has shared the most tables with, ghost players included.
   *
   * `suggestions` rather than `recent`, deliberately. `recent` REPLACES the
   * list while the search box is empty (see the sheet's _matches()), and the
   * bundle's recent rows are accounts only — so on the one surface where the
   * answer is often a ghost from an old play, every ghost would have sat
   * behind a keystroke, which is the "picker that hides its own escape hatch"
   * anti-pattern in .claude/rules/overlays.md. Suggestions sit ABOVE the full
   * list instead: the likely answers are first and nobody is hidden.
   *
   * Ranked off each candidate's own `plays` (Buddy.toPlayerCandidates folds the
   * bundle's play counts onto both accounts and ghosts) rather than off the
   * recent list, so a ghost name that appears on nine plays leads too.
   *
   * @param {any[]} candidates The list these are drawn from — the same row
   *   objects, so the section is a re-ordering rather than a second copy.
   * @returns {any[]} Empty when splitting the list would not earn its headings.
   */
  function rankedSuggestions(candidates) {
    // A list that already fits on one screen is not worth cutting in two: the
    // headings would label two halves of something readable at a glance.
    if (candidates.length <= SUGGEST_MAX) return [];
    const played = candidates.filter((c) => (c.plays || 0) > 0);
    if (played.length < 2) return [];
    return played
      .slice()
      .sort((a, b) => (b.plays || 0) - (a.plays || 0))
      .slice(0, SUGGEST_MAX);
  }

  /**
   * Open the picker. The partner bundle is normally already in memory — the
   * shell's ensureBuddies() peeks the cache the moment the popup opens, well
   * before anyone can reach Edit — so the sheet paints populated. On a cold
   * cache it opens empty and the refresh behind it calls back through
   * refreshPlayerPicker().
   * @param {Event} [event]
   */
  function openPlayerPicker(event) {
    if (!state.draft) return;
    const seated = state.draft.players;
    const candidates = playerCandidates();
    window.PlayerPickerSheet.open({
      candidates,
      suggestions: rankedSuggestions(candidates),
      // Says what made them suggestions, not that they are suggestions
      // (.claude/rules/web-frontend.md).
      suggestionsLabel: "You play with these people most",
      restLabel: "Everyone else",
      seated: seated.length,
      // The names filtered out of `candidates` above. Without them the guest
      // row cannot see who is already at the table, so a differently-cased
      // spelling of a seated player would be offered back as a new guest —
      // and seatPlayer would then refuse it, silently.
      seatedNames: seated.map((p) => p.name),
      // The same reach Gather has. A play being fixed after the fact is the
      // likeliest place to find a name that belongs to an account nobody has
      // added yet — that is usually WHY it is being fixed — and a guest seat
      // there is the thing this edit exists to undo.
      searchAll: (q) => searchEveryone(q),
      searchAllLabel: "Search all of BoardgameBuddy",
      returnFocus: (event && event.currentTarget) || null,
      onConfirm: (picks) => addPlayers(picks),
    });
  }

  /**
   * Everyone in the app, for a name the partner bundle doesn't hold. The sheet
   * runs it debounced behind its own local filter and drops anyone already
   * listed, so this only has to exclude the seats — which `candidates` is
   * already filtered of, and which seatPlayer would refuse silently.
   * @param {string} q
   */
  async function searchEveryone(q) {
    const rows = await window.ImportPeople.searchEveryone(q);
    const seated = (state.draft && state.draft.players) || [];
    const seatedIds = new Set(seated.map((p) => p.user_id).filter(Boolean));
    const seatedNames = new Set(seated.map((p) => nameKey(p.name)));
    return (rows || []).filter(
      (r) => !seatedIds.has(r.user_id) && !seatedNames.has(nameKey(r.name)));
  }

  /**
   * Fill a picker that opened before the partner bundle landed, from the
   * shell's refresh. Guarded on the sheet being open AND a draft existing:
   * the sheet is a shared singleton, and the only way it is up with an edit
   * draft behind it is that openPlayerPicker put it there.
   */
  function refreshPlayerPicker() {
    if (!state || !state.draft) return;
    if (!window.PlayerPickerSheet || !window.PlayerPickerSheet.isOpen()) return;
    const candidates = playerCandidates();
    window.PlayerPickerSheet.setCandidates(candidates, [], rankedSuggestions(candidates));
  }

  /**
   * Seat everyone ticked, in tick order — and that order matters: the roster
   * array IS the round grid's column order (widgets/round-score-grid.js maps
   * it straight to columns), so ticking Marcus then Priya seats them in that
   * order. One repaint for the whole set, not one per player.
   * @param {any[]} picks
   */
  function addPlayers(picks) {
    if (!state.draft || !Array.isArray(picks)) return;
    let added = 0;
    for (const c of picks) if (seatPlayer(c)) added++;
    if (added) render();
  }

  /**
   * Push one candidate into the draft roster.
   *
   * Deduped by NAME rather than id, because the roster is a mix of accounts
   * and ghosts and a name is the only handle every seat has — and because
   * play_players carries a unique index on it since migration 023, so a second
   * seat under the same name is a save the backend refuses.
   *
   * @param {{name?: string, user_id?: string|null, avatar?: any}} c
   * @returns {boolean} Whether a seat was actually added.
   */
  function seatPlayer(c) {
    const name = String((c && c.name) || "").trim();
    if (!name || !state.draft) return false;
    if (state.draft.players.some((p) => nameKey(p.name) === nameKey(name))) return false;
    // Match the existing rounds shape so the new row aligns with the
    // grid (nulls fill the columns that other players already have). A
    // same-length all-null column changes nobody's total and cannot change the
    // grid's round count, so there is nothing to resync afterwards.
    const existingRounds = window.roundGridRoundCount(state.draft.players);
    state.draft.players.push({
      name,
      is_winner: false,
      score: "",
      user_id: (c && c.user_id) || null,
      avatar: (c && c.avatar) || null,
      roundScores: existingRounds > 0
        ? Array.from({ length: existingRounds }, () => null)
        : [],
    });
    return true;
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
    remount();
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
    const gridActive = hasRoundGrid(
      state.draft.players, "roundScores", state.draft.scoring_template
    );
    // With a template even one row is a real breakdown, and dropping it would
    // leave the play's labels pointing at nothing.
    const minRounds = templateRows(state.draft.scoring_template).length ? 1 : 2;
    // Square the columns up before serializing: `score` is summed over the
    // grid's round count, so `round_scores` has to be that long too or the
    // saved play would carry a total its own breakdown doesn't add up to.
    const gridRounds = gridActive ? normalizeRounds(state.draft.players) : 0;
    const payload = {
      played_at: state.draft.played_at,
      notes: state.draft.notes || null,
      photo_url: photoUrl,
      // Omitted-means-keep on the backend, so sending the draft's id is both
      // the no-op for an untouched game and the whole of a pivot.
      game_id: state.draft.game_id,
      expansion_ids: state.draft.expansions.map((e) => e.expansion_game_id),
      play_mode: state.draft.play_mode || null,
      players: state.draft.players.map((p) => {
        const rs = Array.isArray(p.roundScores) ? p.roundScores : [];
        const round_scores = gridActive && gridRounds >= minRounds
          ? rs.slice(0, gridRounds).map((v) => window.parseRoundScore(v))
          : null;
        const score = gridActive
          ? playerScoreForSave(p, state.draft.players)
          : (p.score === "" || p.score == null ? null : Number(p.score));
        return {
          name: p.name,
          is_winner: !!p.is_winner,
          score,
          user_id: p.user_id || null,
          round_scores,
          team: (p.team || "").trim() || null,
        };
      }),
    };
    try {
      state.play = await window.Play.update(state.play.id, payload);
      if (state.draft) clearPendingPhoto(state.draft);
      state.editing = false;
      state.draft = null;
      // No store.invalidate("feed") here any more. It re-rendered the whole
      // Feed view — resetting its scroll and flipping every open card back
      // over — off a page whose cards had not changed, so it cost the tear-down
      // and showed nothing new. Play.update() now patches the one card that did
      // change and repaints it in place instead.
      //
      // The fresh play rides on the event so listeners patch from it rather
      // than refetching a row the server has just handed us.
      document.dispatchEvent(new CustomEvent("play-changed", {
        detail: { playId: state.play.id, kind: "update", play: state.play },
      }));
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



  window.PlayDetailEdit = {
    init,
    renderForm: renderEdit,
    discardDraft,
    refreshPlayerPicker,
    // Handlers exposed for inline onclick wiring inside the rendered HTML.
    // The shell folds these into window.PlayDetailPopup, which is the name
    // every onclick string and the round-grid widget's host prefix already
    // use — the split is invisible to the markup on purpose.
    handlers: {
      _enterEdit: enterEdit,
      _enterEditWithPhotoPicker: enterEditWithPhotoPicker,
      _cancelEdit: cancelEdit,
      _setDraft: setDraft,
      _setPlayerWinner: setPlayerWinner,
      _setPlayerScore: setPlayerScore,
      _removePlayer: removePlayer,
      _openPlayerPicker: openPlayerPicker,
      _openGamePicker: openGamePicker,
      _openExpansionPicker: openExpansionPicker,
      _removeExpansion: removeExpansion,
      // Round-grid handlers (signatures match play-flow-view so the
      // shared round-score-grid widget can target either host).
      _setRoundScore: setRoundScore,
      _addRound: addRound,
      _removeRoundAt: removeRoundAt,
      _toggleWinner: toggleWinner,
      _initRounds: initRounds,
      _onPhotoSelect: onPhotoSelect,
      _deletePlay: deletePlay,
      _saveEdit: saveEdit,
    },
  };
})();
