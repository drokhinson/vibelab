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
      }
    } catch (e) {
      state.error = (e && e.message) || "Failed to load play";
    } finally {
      state.loading = false;
      render();
    }
  }

  function dismiss() {
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
  }

  // ── Render ────────────────────────────────────────────────────────────────
  // Preserve focus + caret across the innerHTML replace so the edit-form's
  // text inputs don't lose them on every keystroke.
  function render() {
    const root = document.getElementById(BACKDROP_ID);
    if (!root) return;
    const active = document.activeElement;
    const activeId = active && active.id;
    const caret = active && active.selectionStart;

    root.innerHTML = renderCard();
    if (window.lucide) window.lucide.createIcons();

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
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
          <div class="play-detail-popup__loading">${window.buddyLoader({ size: 80 })}</div>
        </div>
      `;
    }
    if (state.error) {
      return `
        <div class="play-detail-popup__card" role="alertdialog" aria-modal="true">
          <button class="play-detail-popup__close" aria-label="Close">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
          <div class="play-detail-popup__error">${escape(state.error)}</div>
        </div>
      `;
    }
    const p = state.play;
    return `
      <div class="play-detail-popup__card" role="dialog" aria-modal="true" aria-label="Play details">
        <div class="play-detail-popup__topbar">
          <span></span>
          <button class="play-detail-popup__close" type="button" aria-label="Close">
            <i data-lucide="x" class="w-4 h-4"></i>
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
            <i data-lucide="trash-2" class="w-4 h-4"></i> Delete
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
            <i data-lucide="pencil" class="w-4 h-4"></i>
            <span>Edit</span>
          </button>
        </div>
      `;
    }
    return "";
  }

  // ── View mode ─────────────────────────────────────────────────────────────
  function renderView(p) {
    const winners = (p.players || []).filter((pl) => pl.is_winner);
    // Players sorted by score descending so the scoreboard reads top-down
    // by rank. Stable for equal scores (Array.sort is stable in modern JS).
    const ranked = (p.players || []).slice().sort((a, b) => {
      const sa = a.score == null ? -Infinity : a.score;
      const sb = b.score == null ? -Infinity : b.score;
      return sb - sa;
    });
    const photoSlot = p.photo_url
      ? `<img class="play-detail-popup__photo" src="${escapeAttr(p.photo_url)}" alt="" />`
      : (p.is_own
          ? `<button class="play-detail-popup__add-photo" type="button"
                     onclick="window.PlayDetailPopup._enterEditWithPhotoPicker()">
              <i data-lucide="image-plus" class="w-6 h-6"></i>
              <span class="play-detail-popup__add-photo-title">Add a photo</span>
              <span class="play-detail-popup__add-photo-hint">Tap to upload</span>
            </button>`
          : "");

    return `
      <article class="play-detail">
        ${photoSlot}

        ${renderGameBubble(p, { editing: false })}

        ${winners.length > 0 ? `
          <section class="play-detail__section">
            <h3 class="play-detail__section-title">
              <i data-lucide="trophy" class="w-4 h-4"></i>
              Winner${winners.length === 1 ? "" : "s"}
            </h3>
            <ul class="play-detail__winners">
              ${winners.map((w) => `
                <li>${escape(w.name)}${w.score != null ? ` <span class="opacity-60">· ${w.score}</span>` : ""}</li>
              `).join("")}
            </ul>
          </section>` : ""}

        <section class="play-detail__section">
          <h3 class="play-detail__section-title">
            <i data-lucide="users" class="w-4 h-4"></i> Players
          </h3>
          ${ranked.length === 0
            ? `<div class="text-sm opacity-60">No players recorded.</div>`
            : `<ul class="play-detail__players">
                ${ranked.map((pl) => `
                  <li class="play-detail__player ${pl.is_winner ? "is-winner" : ""}">
                    <span class="play-detail__player-name">
                      ${pl.is_winner ? `<i data-lucide="trophy" class="w-3.5 h-3.5"></i> ` : ""}
                      ${escape(pl.name)}
                    </span>
                    <span class="play-detail__player-score">${pl.score != null ? pl.score : ""}</span>
                  </li>
                `).join("")}
              </ul>`}
        </section>

        ${(p.expansions || []).length > 0 ? `
          <section class="play-detail__section">
            <h3 class="play-detail__section-title">
              <i data-lucide="puzzle" class="w-4 h-4"></i> Expansions
            </h3>
            <ul class="play-detail__expansions">
              ${(p.expansions || []).map((e) => `
                <li onclick="window.PlayDetailPopup.dismiss();window.router.go('game-detail',{gameId:'${e.expansion_game_id}',gameName:'${jsStr(e.name || "")}'})"
                    style="--exp-color:${e.color || "#C9922A"}">
                  <span class="play-detail__expansion-dot"></span>
                  ${escape(e.name)}
                </li>
              `).join("")}
            </ul>
          </section>` : ""}

        ${p.notes ? `
          <section class="play-detail__section">
            <h3 class="play-detail__section-title">
              <i data-lucide="sticky-note" class="w-4 h-4"></i> Notes
            </h3>
            <p class="play-detail__notes">${escape(p.notes)}</p>
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
              <i data-lucide="camera" class="w-4 h-4"></i> Replace photo
            </label>
          ` : `
            <label class="play-detail__edit-photo-pick">
              <input type="file" accept="image/*" class="hidden play-detail-popup__photo-file"
                     onchange="window.PlayDetailPopup._onPhotoSelect(this.files)" />
              <span class="play-detail__edit-photo-pick-icon">
                <i data-lucide="image-plus" class="w-5 h-5"></i>
              </span>
              <span class="play-detail__edit-photo-pick-body">
                <span class="play-detail__edit-photo-pick-title">Add a photo</span>
                <span class="play-detail__edit-photo-pick-hint">Tap to choose an image</span>
              </span>
            </label>
          `}
        </section>

        ${renderGameBubble(p, { editing: true })}

        <section class="play-detail__section">
          <h3 class="play-detail__section-title">
            <i data-lucide="users" class="w-4 h-4"></i> Players
          </h3>
          <ul class="play-detail__edit-players">
            ${d.players.map((pl, i) => `
              <li class="play-detail__edit-player">
                <span class="play-detail__edit-player-name">${escape(pl.name)}</span>
                <input type="number" class="input input-bordered input-sm play-detail__edit-score"
                       placeholder="Score"
                       value="${escapeAttr(pl.score)}"
                       oninput="window.PlayDetailPopup._setPlayerScore(${i}, this.value)" />
                <label class="play-detail__edit-winner">
                  <input type="checkbox" ${pl.is_winner ? "checked" : ""}
                         onchange="window.PlayDetailPopup._setPlayerWinner(${i}, this.checked)" />
                  Won
                </label>
                <button class="btn btn-ghost btn-xs" title="Remove" type="button"
                        onclick="window.PlayDetailPopup._removePlayer(${i})">
                  <i data-lucide="x" class="w-3.5 h-3.5"></i>
                </button>
              </li>
            `).join("")}
          </ul>
          <div class="play-detail__add-player">
            <input id="play-popup-add-name" class="input input-bordered input-sm w-full"
                   list="play-popup-buddy-list"
                   placeholder="Add player (buddy or free-text)"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();window.PlayDetailPopup._addPlayer();}" />
            <datalist id="play-popup-buddy-list">
              ${state.buddies.map((b) => `<option value="${escapeAttr(b.other_display_name)}">`).join("")}
            </datalist>
            <button class="btn btn-primary btn-sm" type="button"
                    onclick="window.PlayDetailPopup._addPlayer()">Add</button>
          </div>
        </section>

        <section class="play-detail__section">
          <h3 class="play-detail__section-title">
            <i data-lucide="sticky-note" class="w-4 h-4"></i> Notes
          </h3>
          <textarea class="textarea textarea-bordered w-full" rows="2"
                    oninput="window.PlayDetailPopup._setDraft('notes', this.value)">${escape(d.notes)}</textarea>
        </section>

        ${state.editError ? `<div class="alert alert-error m-3">${escape(state.editError)}</div>` : ""}
      </article>
    `;
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
      : `<div class="play-detail__game-when">${formatDate(p.played_at)}</div>`;
    return `
      <div class="play-detail__meta">
        <div class="play-detail__game-row">
          ${p.game_thumbnail
            ? `<img class="play-detail__game-thumb" src="${escapeAttr(p.game_thumbnail)}" alt="" />`
            : ""}
          <div class="play-detail__game-info">
            <div class="play-detail__game-title">
              A game of <span class="play-detail__game-name">${escape(p.game_name)}</span>
            </div>
            ${subline}
          </div>
          ${p.game_id ? `
            <button class="play-detail__game-goto" type="button"
                    aria-label="Go to game detail page"
                    title="Go to game detail page"
                    onclick="${gameNav}">
              <i data-lucide="arrow-up-right" class="w-4 h-4"></i>
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
    render();
  }
  function addPlayer() {
    const input = document.getElementById("play-popup-add-name");
    const name = (input && input.value || "").trim();
    if (!name || !state.draft) return;
    const buddy = (state.buddies || []).find(
      (b) => (b.other_display_name || "").toLowerCase() === name.toLowerCase()
    );
    const dupe = state.draft.players.some(
      (p) => (p.name || "").toLowerCase() === name.toLowerCase()
    );
    if (!dupe) {
      state.draft.players.push({
        name,
        is_winner: false,
        score: "",
        user_id: buddy ? buddy.other_user_id : null,
      });
    }
    if (input) input.value = "";
    render();
  }
  function onPhotoSelect(fileList) {
    const file = fileList && fileList[0];
    if (!file || !state.draft) return;
    // Pre-flight size check — refuse oversized files at the picker so the
    // save flow can never get tripped up by a 413 from /plays/photo. The
    // backend cap is 5 MiB; helpers.js mirrors it.
    const v = window.validatePhotoFile(file);
    if (!v.ok) {
      showToast(v.error, "error");
      const fi = document.querySelector(".play-detail-popup__photo-file");
      if (fi) fi.value = "";
      return;
    }
    clearPendingPhoto(state.draft);
    state.draft.photoFile = file;
    state.draft.photoPreviewUrl = URL.createObjectURL(file);
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

    const payload = {
      played_at: state.draft.played_at,
      notes: state.draft.notes || null,
      photo_url: photoUrl,
      expansion_ids: state.draft.expansion_ids,
      play_mode: state.draft.play_mode || null,
      players: state.draft.players.map((p) => ({
        name: p.name,
        is_winner: !!p.is_winner,
        score: p.score === "" || p.score == null ? null : Number(p.score),
        user_id: p.user_id || null,
      })),
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

  // ── Helpers ───────────────────────────────────────────────────────────────
  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }
  function jsStr(s) {
    // For values interpolated into single-quoted JS strings inside onclick="".
    return String(s ?? "").replace(/['\\]/g, "\\$&").replace(/\n/g, "\\n");
  }
  function formatDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
    _onPhotoSelect: onPhotoSelect,
    _deletePlay: deletePlay,
    _saveEdit: saveEdit,
  };
})();
