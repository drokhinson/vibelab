// views/play-detail-view.js — single play's full record + inline edit.
//
// Renders the photo (if any), game, played-at, expansions used, every
// player's score, the winner crown, and the notes. When `is_own` is true the
// header surfaces an Edit button that flips the body into a form against the
// existing PUT /plays/{id} endpoint.

(function () {
  class PlayDetailView extends window.View {
    constructor() {
      super("play-detail");
      this._play = null;
      this._loading = false;
      this._error = null;
      this._buddies = [];

      this._editing = false;
      this._saving = false;
      this._editError = null;
      this._draft = null;     // working copy while editing
    }

    async onMount()        { await this._load(); }
    async onParamsChange() { await this._load(); }

    async _load() {
      const playId = this.params && this.params.playId;
      if (!playId) {
        this._error = "No play specified";
        this.render();
        return;
      }
      this._loading = true;
      this._error = null;
      this._editing = false;
      this._draft = null;
      this.render();
      try {
        this._play = await window.Play.get(playId);
        // Eagerly load buddies if this is the user's play — keeps the edit
        // form's add-player dropdown immediate. Free for non-own plays.
        if (this._play && this._play.is_own) {
          this._buddies = await window.Buddy.list().catch(() => []);
        } else {
          this._buddies = [];
        }
      } catch (e) {
        this._error = e.message || "Failed to load play";
      } finally {
        this._loading = false;
        this.render();
      }
    }

    render() {
      // Preserve focus + caret across re-renders (the edit form's inputs
      // would otherwise lose them on keystroke).
      const active = document.activeElement;
      const activeId = active && active.id;
      const caret = active && active.selectionStart;

      if (this._error) {
        this.container.innerHTML = `
          <header class="search-topbar">
            <button class="btn btn-ghost btn-sm" onclick="window.router.back('feed')">
              <i data-lucide="arrow-left" class="w-4 h-4"></i>
            </button>
          </header>
          <div class="p-6 alert alert-error">${escape(this._error)}</div>
        `;
        if (window.lucide) window.lucide.createIcons();
        return;
      }
      if (!this._play) {
        this.container.innerHTML = window.buddyLoader({ size: 120 });
        return;
      }

      const p = this._play;
      this.container.innerHTML = `
        <header class="search-topbar">
          <button class="btn btn-ghost btn-sm" onclick="window.router.back('feed')">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="font-display font-semibold text-base play-detail__crumb"
              onclick="window.router.go('game-detail',{gameId:'${p.game_id}',gameName:'${jsStr(p.game_name || '')}'})">
            ${escape(p.game_name)}
          </h2>
          ${p.is_own && !this._editing
            ? `<button class="btn btn-ghost btn-sm" onclick="window.playDetailView._enterEdit()">
                 <i data-lucide="pencil" class="w-4 h-4"></i> Edit
               </button>`
            : `<span></span>`}
        </header>
        ${this._editing ? this._renderEdit(p) : this._renderView(p)}
      `;
      if (window.lucide) window.lucide.createIcons();

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

    // ── Read view ─────────────────────────────────────────────────────────────

    _renderView(p) {
      const winners = (p.players || []).filter((pl) => pl.is_winner);
      return `
        <article class="play-detail">
          ${p.photo_url ? `<img class="play-detail__photo" src="${escapeAttr(p.photo_url)}" alt="" />` : ""}

          <div class="play-detail__meta">
            <div class="play-detail__game-row">
              ${p.game_thumbnail
                ? `<img class="play-detail__game-thumb" src="${escapeAttr(p.game_thumbnail)}" alt="" />`
                : ""}
              <div class="play-detail__game-info">
                <div class="play-detail__game-name">${escape(p.game_name)}</div>
                <div class="play-detail__game-when">${formatDate(p.played_at)}</div>
              </div>
            </div>
            <div class="play-detail__logger">
              Logged by <span class="font-semibold">${escape(p.logged_by_name)}</span>
            </div>
          </div>

          ${winners.length > 0 ? `
            <section class="play-detail__section">
              <h3 class="play-detail__section-title">
                <i data-lucide="trophy" class="w-4 h-4"></i> Winner${winners.length === 1 ? "" : "s"}
              </h3>
              <ul class="play-detail__winners">
                ${winners.map((w) => `<li>${escape(w.name)}${w.score != null ? ` <span class="opacity-60">· ${w.score}</span>` : ""}</li>`).join("")}
              </ul>
            </section>` : ""}

          <section class="play-detail__section">
            <h3 class="play-detail__section-title"><i data-lucide="users" class="w-4 h-4"></i> Players</h3>
            ${(p.players || []).length === 0
              ? `<div class="text-sm opacity-60">No players recorded.</div>`
              : `<ul class="play-detail__players">
                  ${(p.players || []).map((pl) => `
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
              <h3 class="play-detail__section-title"><i data-lucide="puzzle" class="w-4 h-4"></i> Expansions</h3>
              <ul class="play-detail__expansions">
                ${(p.expansions || []).map((e) => `
                  <li onclick="window.router.go('game-detail',{gameId:'${e.expansion_game_id}',gameName:'${jsStr(e.name || '')}'})"
                      style="--exp-color:${e.color || "#C9922A"}">
                    <span class="play-detail__expansion-dot"></span>
                    ${escape(e.name)}
                  </li>
                `).join("")}
              </ul>
            </section>` : ""}

          ${p.notes ? `
            <section class="play-detail__section">
              <h3 class="play-detail__section-title"><i data-lucide="sticky-note" class="w-4 h-4"></i> Notes</h3>
              <p class="play-detail__notes">${escape(p.notes)}</p>
            </section>` : ""}
        </article>
      `;
    }

    // ── Edit form ────────────────────────────────────────────────────────────

    _enterEdit() {
      const p = this._play;
      this._draft = {
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
        // Photo edit state lives on the draft so Cancel discards it cleanly.
        // photoFile is the pending File object; photoPreviewUrl is the
        // browser-side blob: URL we render while the upload hasn't happened
        // yet — revoked in _clearPendingPhoto to avoid leaking.
        photoFile: null,
        photoPreviewUrl: null,
      };
      this._editing = true;
      this._editError = null;
      this.render();
    }

    _cancelEdit() {
      if (this._draft) this._clearPendingPhoto(this._draft);
      this._editing = false;
      this._draft = null;
      this._editError = null;
      this.render();
    }

    _onPhotoSelect(fileList) {
      const file = fileList && fileList[0];
      if (!file || !this._draft) return;
      this._clearPendingPhoto(this._draft);
      this._draft.photoFile = file;
      this._draft.photoPreviewUrl = URL.createObjectURL(file);
      this.render();
    }

    _clearPendingPhoto(draft) {
      if (draft.photoPreviewUrl) {
        try { URL.revokeObjectURL(draft.photoPreviewUrl); } catch (_) {}
      }
      draft.photoFile = null;
      draft.photoPreviewUrl = null;
    }

    _renderEdit(p) {
      const d = this._draft;
      // Photo source resolution: pending new upload (preview blob) wins over
      // the play's stored URL so the user sees their selection immediately.
      const photoUrl = d.photoPreviewUrl || p.photo_url || "";
      return `
        <article class="play-detail play-detail--edit">
          <section class="play-detail__edit-photo">
            ${photoUrl ? `
              <img src="${escapeAttr(photoUrl)}" alt="" />
              <label class="play-detail__edit-photo-replace">
                <input type="file" accept="image/*" class="hidden"
                       onchange="window.playDetailView._onPhotoSelect(this.files)" />
                <i data-lucide="camera" class="w-4 h-4"></i> Replace photo
              </label>
            ` : `
              <label class="play-detail__edit-photo-pick">
                <input type="file" accept="image/*" class="hidden"
                       onchange="window.playDetailView._onPhotoSelect(this.files)" />
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

          <div class="play-detail__meta">
            <div class="play-detail__game-row">
              ${p.game_thumbnail
                ? `<img class="play-detail__game-thumb" src="${escapeAttr(p.game_thumbnail)}" alt="" />`
                : ""}
              <div class="play-detail__game-info">
                <div class="play-detail__game-name">${escape(p.game_name)}</div>
                <input id="play-edit-date" type="date" class="input input-bordered input-sm"
                       value="${escapeAttr(d.played_at)}"
                       onchange="window.playDetailView._setDraft('played_at', this.value)" />
              </div>
            </div>
          </div>

          <section class="play-detail__section">
            <h3 class="play-detail__section-title"><i data-lucide="users" class="w-4 h-4"></i> Players</h3>
            <ul class="play-detail__edit-players">
              ${d.players.map((pl, i) => `
                <li class="play-detail__edit-player">
                  <span class="play-detail__edit-player-name">${escape(pl.name)}</span>
                  <input type="number" class="input input-bordered input-sm play-detail__edit-score"
                         placeholder="Score"
                         value="${escapeAttr(pl.score)}"
                         oninput="window.playDetailView._setPlayerScore(${i}, this.value)" />
                  <label class="play-detail__edit-winner">
                    <input type="checkbox" ${pl.is_winner ? "checked" : ""}
                           onchange="window.playDetailView._setPlayerWinner(${i}, this.checked)" />
                    Won
                  </label>
                  <button class="btn btn-ghost btn-xs" title="Remove"
                          onclick="window.playDetailView._removePlayer(${i})">
                    <i data-lucide="x" class="w-3.5 h-3.5"></i>
                  </button>
                </li>
              `).join("")}
            </ul>
            <div class="play-detail__add-player">
              <input id="play-edit-add-name" class="input input-bordered input-sm w-full"
                     list="play-edit-buddy-list" placeholder="Add player (buddy or free-text)"
                     onkeydown="if(event.key==='Enter'){event.preventDefault();window.playDetailView._addPlayer();}" />
              <datalist id="play-edit-buddy-list">
                ${this._buddies.map((b) => `<option value="${escapeAttr(b.other_display_name)}">`).join("")}
              </datalist>
              <button class="btn btn-primary btn-sm" onclick="window.playDetailView._addPlayer()">Add</button>
            </div>
          </section>

          <section class="play-detail__section">
            <h3 class="play-detail__section-title"><i data-lucide="sticky-note" class="w-4 h-4"></i> Notes</h3>
            <textarea class="textarea textarea-bordered w-full" rows="2"
                      oninput="window.playDetailView._setDraft('notes', this.value)">${escape(d.notes)}</textarea>
          </section>

          ${this._editError ? `<div class="alert alert-error m-3">${escape(this._editError)}</div>` : ""}

          <section class="play-detail__section play-detail__save-row">
            <button class="btn btn-ghost play-detail__delete-btn" ${this._saving ? "disabled" : ""}
                    onclick="window.playDetailView._deletePlay()">
              <i data-lucide="trash-2" class="w-4 h-4"></i> Delete
            </button>
            <button class="btn btn-ghost" onclick="window.playDetailView._cancelEdit()">Cancel</button>
            <button class="btn btn-primary" ${this._saving ? "disabled" : ""}
                    onclick="window.playDetailView._saveEdit()">
              ${this._saving ? "Saving…" : "Save changes"}
            </button>
          </section>
        </article>
      `;
    }

    _setDraft(key, value) {
      if (this._draft) this._draft[key] = value;
    }
    _setPlayerWinner(i, checked) {
      if (this._draft) this._draft.players[i].is_winner = !!checked;
    }
    _setPlayerScore(i, value) {
      if (this._draft) this._draft.players[i].score = value;
    }
    _removePlayer(i) {
      if (!this._draft) return;
      this._draft.players.splice(i, 1);
      this.render();
    }
    _addPlayer() {
      const input = document.getElementById("play-edit-add-name");
      const name = (input && input.value || "").trim();
      if (!name || !this._draft) return;
      const buddy = (this._buddies || []).find(
        (b) => (b.other_display_name || "").toLowerCase() === name.toLowerCase()
      );
      const dupe = this._draft.players.some(
        (p) => (p.name || "").toLowerCase() === name.toLowerCase()
      );
      if (!dupe) {
        this._draft.players.push({
          name,
          is_winner: false,
          score: "",
          user_id: buddy ? buddy.other_user_id : null,
        });
      }
      if (input) input.value = "";
      this.render();
    }

    async _deletePlay() {
      if (!this._play || !this._play.id) return;
      if (!confirm("Delete this play? This can't be undone.")) return;
      this._saving = true;
      this._editError = null;
      this.render();
      try {
        await window.Play.remove(this._play.id);
      } catch (e) {
        this._editError = (e && e.message) || "Failed to delete";
        this._saving = false;
        this.render();
        return;
      }
      // Bust the feed cache so the deleted play disappears the next time the
      // feed paints. Then bounce back to wherever the user came from (feed by
      // default — `router.back` falls back to that if there's no history).
      if (window.store && window.store.invalidate) window.store.invalidate("feed");
      if (this._draft) this._clearPendingPhoto(this._draft);
      window.router.back("feed");
    }

    async _saveEdit() {
      if (!this._draft) return;
      this._saving = true;
      this._editError = null;
      this.render();

      // Photo upload first so the PUT carries the new URL atomically. The
      // /plays/photo endpoint returns { photo_url } pointing at the uploaded
      // blob in storage; we then attach that URL to the play via the regular
      // PlayUpdate payload. Failures bail before the PUT so the play's
      // existing photo isn't accidentally nulled out.
      let photoUrl = this._play.photo_url || null;
      if (this._draft.photoFile) {
        try {
          const fd = new FormData();
          fd.append("file", this._draft.photoFile);
          const resp = await window.api.upload("/plays/photo", fd);
          if (resp && resp.photo_url) photoUrl = resp.photo_url;
        } catch (e) {
          this._editError = (e && e.message) || "Photo upload failed";
          this._saving = false;
          this.render();
          return;
        }
      }

      const payload = {
        played_at: this._draft.played_at,
        notes: this._draft.notes || null,
        photo_url: photoUrl,
        expansion_ids: this._draft.expansion_ids,
        play_mode: this._draft.play_mode || null,
        players: this._draft.players.map((p) => ({
          name: p.name,
          is_winner: !!p.is_winner,
          score: p.score === "" || p.score == null ? null : Number(p.score),
          user_id: p.user_id || null,
        })),
      };
      try {
        this._play = await window.Play.update(this._play.id, payload);
        if (this._draft) this._clearPendingPhoto(this._draft);
        this._editing = false;
        this._draft = null;
        // Bust the feed cache so the updated play shows new data on next view.
        window.store.invalidate("feed");
      } catch (e) {
        this._editError = e.message || "Failed to save";
      } finally {
        this._saving = false;
        this.render();
      }
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }
  function formatDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  window.PlayDetailView = PlayDetailView;
})();
