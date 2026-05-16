// ui/play-card.js — Strava-style play card rendered in the Feed and Profile.
//
// Two-faced card:
//   Front  → "<Username> played <Game>" header (date right-aligned), optional
//            user photo or capped box-art hero, winner chip, notes.
//   Back   → players + scores + expansions for the play. Owners see an Edit
//            button that swaps the back face into an inline form (photo,
//            notes, per-player score + winner toggle).
//
// Clicking the game-name text or any box-art image navigates to the game
// detail page (data-no-flip). Clicking anywhere else on the card flips it.
// State lives in a module-level Map keyed by play_id so flipping or editing
// re-renders only the affected <article> via outerHTML replacement — the
// feed scroll position is preserved.

(function () {
  // Per-play state lives outside the render so re-renders are cheap and
  // scoped: { flipped, hydrated (full PlayResponse), hydrating, error,
  // editing, draft, saving, photoFile, photoPreviewUrl }.
  const cardState = new Map();

  function getState(playId) {
    let s = cardState.get(playId);
    if (!s) {
      s = {
        flipped: false,
        hydrated: null,
        hydrating: false,
        error: null,
        editing: false,
        draft: null,
        saving: false,
        photoFile: null,
        photoPreviewUrl: null,
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
          <div class="play-card__back">${s.editing ? renderEditBack(card, s) : renderReadBack(card, s)}</div>
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

    // Layout split by presence of a user-uploaded photo:
    //   - With user photo: stretched hero + corner box-art badge, with the
    //     winner chip + notes stacked underneath (Strava-style).
    //   - Without: a horizontal row — square box art on the left, winner
    //     chip + notes stacked on the right — so the box art reads as a
    //     thumbnail tied to the play rather than trying to act as a hero.
    let body = "";
    if (hasUserPhoto) {
      body = `
        <div class="play-card__photo">
          <img class="play-card__photo-img" src="${escapeAttr(card.photo_url)}" alt="" loading="lazy" />
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
          </div>
          <div class="play-card__no-photo-meta">
            ${winnerChip}
            ${notesBlock}
          </div>
        </div>
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

  function renderReadBack(card, s) {
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
    const expansions = p.expansions || [];
    // Ghost players (no linked account) are scoped to whoever logged the play
    // — surface that scoping as a "@<host>" handle so two different hosts'
    // free-text "Sean D" entries read as distinct identities, not the same
    // person. Real-account players already carry their own identity in the
    // display name and don't need the attribution.
    const hostHandle = p.logged_by_name ? escapeHtml(p.logged_by_name) : "";
    const me = window.store && window.store.get && window.store.get("user");
    const myName = me && me.display_name ? me.display_name : null;
    const winnerLabel = winners
      .map((w) => (myName && w.name === myName) ? "You" : escapeHtml(w.name))
      .join(", ");
    return `
      <header class="play-card__back-head">
        <span class="play-card__back-title">${escapeHtml(p.game_name || (card.game && card.game.name) || "")}</span>
        <span class="play-card__back-date">${formatPlayedAt(p.played_at)}</span>
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
                <div class="play-card__back-player-info">
                  <span class="play-card__back-player-name">
                    ${pl.is_winner ? `<i data-lucide="trophy" class="w-3.5 h-3.5"></i> ` : ""}
                    ${escapeHtml(pl.name)}
                  </span>
                  ${!pl.user_id && hostHandle
                    ? `<span class="play-card__back-player-handle" title="Custom player logged by ${hostHandle}">@${hostHandle}</span>`
                    : ""}
                </div>
                <span class="play-card__back-player-score">${pl.score != null ? pl.score : ""}</span>
              </li>`).join("")}
      </ul>

      ${expansions.length > 0 ? `
        <div class="play-card__back-expansions">
          ${expansions.map((e) => `
            <span class="play-card__back-exp" data-no-flip
                  style="--exp-color:${escapeAttr(e.color || "#C9922A")}"
                  onclick="event.stopPropagation(); window.router.go('game-detail',{gameId:'${escapeAttr(e.expansion_game_id)}',gameName:'${jsStr(e.name || "")}'})">
              <span class="play-card__back-exp-dot"></span>${escapeHtml(e.name)}
            </span>`).join("")}
        </div>` : ""}

      ${p.notes ? `<p class="play-card__back-notes">${escapeHtml(p.notes)}</p>` : ""}

      ${p.is_own ? `
        <div class="play-card__back-actions">
          <button class="btn btn-ghost btn-sm" data-no-flip
                  onclick="event.stopPropagation(); window.playCardFlip.enterEdit('${escapeAttr(p.id)}')">
            <i data-lucide="pencil" class="w-4 h-4"></i> Edit
          </button>
        </div>` : ""}
    `;
  }

  function renderEditBack(card, s) {
    const p = s.hydrated;
    if (!p || !s.draft) {
      return `<div class="play-card__back-loading">…</div>`;
    }
    const d = s.draft;
    const photoUrl = s.photoPreviewUrl || p.photo_url || "";
    return `
      <header class="play-card__back-head">
        <span class="play-card__back-title">${escapeHtml(p.game_name || "")}</span>
        <span class="play-card__back-date">${formatPlayedAt(p.played_at)}</span>
      </header>

      <div class="play-card__edit-photo">
        ${photoUrl ? `
          <img src="${escapeAttr(photoUrl)}" alt="" />
          <label class="play-card__edit-photo-replace" data-no-flip>
            <input type="file" accept="image/*" class="hidden"
                   onchange="window.playCardFlip.onPhotoSelect('${escapeAttr(p.id)}', this.files)" />
            <i data-lucide="camera" class="w-4 h-4"></i> Replace photo
          </label>
        ` : `
          <label class="play-card__edit-photo-pick" data-no-flip>
            <input type="file" accept="image/*" class="hidden"
                   onchange="window.playCardFlip.onPhotoSelect('${escapeAttr(p.id)}', this.files)" />
            <span class="play-card__edit-photo-pick-icon">
              <i data-lucide="image-plus" class="w-5 h-5"></i>
            </span>
            <span class="play-card__edit-photo-pick-body">
              <span class="play-card__edit-photo-pick-title">Add a photo</span>
              <span class="play-card__edit-photo-pick-hint">Tap to choose an image</span>
            </span>
          </label>
        `}
      </div>

      <ul class="play-card__edit-players">
        ${d.players.map((pl, i) => {
          const ghostHandle = !pl.user_id && p.logged_by_name
            ? `<span class="play-card__back-player-handle">@${escapeHtml(p.logged_by_name)}</span>`
            : "";
          return `
          <li class="play-card__edit-player">
            <div class="play-card__edit-player-info">
              <span class="play-card__edit-player-name">${escapeHtml(pl.name)}</span>
              ${ghostHandle}
            </div>
            <input type="number" class="input input-bordered input-sm play-card__edit-score"
                   placeholder="Score" value="${escapeAttr(pl.score)}"
                   oninput="window.playCardFlip.setScore('${escapeAttr(p.id)}', ${i}, this.value)" />
            <label class="play-card__edit-winner">
              <input type="checkbox" ${pl.is_winner ? "checked" : ""}
                     onchange="window.playCardFlip.setWinner('${escapeAttr(p.id)}', ${i}, this.checked)" />
              Won
            </label>
          </li>`;
        }).join("")}
      </ul>

      <textarea class="textarea textarea-bordered w-full play-card__edit-notes"
                rows="2" placeholder="Notes"
                oninput="window.playCardFlip.setNotes('${escapeAttr(p.id)}', this.value)">${escapeHtml(d.notes)}</textarea>

      ${s.error ? `<div class="play-card__back-error">${escapeHtml(s.error)}</div>` : ""}

      <div class="play-card__back-actions play-card__back-actions--edit">
        <button class="btn btn-ghost btn-sm" data-no-flip
                onclick="event.stopPropagation(); window.playCardFlip.cancelEdit('${escapeAttr(p.id)}')">
          Cancel
        </button>
        <button class="btn btn-primary btn-sm" data-no-flip ${s.saving ? "disabled" : ""}
                onclick="event.stopPropagation(); window.playCardFlip.saveEdit('${escapeAttr(p.id)}')">
          ${s.saving ? "Saving…" : "Save changes"}
        </button>
      </div>
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

  // ── Flip / edit controller (called from inline onclick handlers) ────────────

  const controller = {
    handleClick(event, playId) {
      const t = event.target;
      if (!t) return;
      // Anything in a no-flip subtree handles its own navigation.
      if (t.closest && t.closest("[data-no-flip]")) return;
      // Inputs / textareas / buttons / labels never flip the card so the
      // edit form stays interactive while the article catches everything else.
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
      // While editing, ignore generic flip clicks — only Cancel / Save can
      // leave edit mode so an accidental tap doesn't toss in-progress changes.
      if (s.editing) return;
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

    enterEdit(playId) {
      const s = getState(playId);
      const p = s.hydrated;
      if (!p) return;
      s.editing = true;
      s.error = null;
      s.draft = {
        notes: p.notes || "",
        players: (p.players || []).map((pl) => ({
          name: pl.name,
          is_winner: !!pl.is_winner,
          score: pl.score != null ? String(pl.score) : "",
          user_id: pl.user_id || null,
        })),
      };
      this._clearPendingPhoto(s);
      rerenderCard(playId);
    },

    cancelEdit(playId) {
      const s = getState(playId);
      s.editing = false;
      s.draft = null;
      s.error = null;
      this._clearPendingPhoto(s);
      rerenderCard(playId);
    },

    setNotes(playId, value) {
      const s = getState(playId);
      if (s.draft) s.draft.notes = value;
    },

    setScore(playId, idx, value) {
      const s = getState(playId);
      if (s.draft && s.draft.players[idx]) s.draft.players[idx].score = value;
    },

    setWinner(playId, idx, checked) {
      const s = getState(playId);
      if (s.draft && s.draft.players[idx]) s.draft.players[idx].is_winner = !!checked;
    },

    onPhotoSelect(playId, fileList) {
      const file = fileList && fileList[0];
      if (!file) return;
      const s = getState(playId);
      this._clearPendingPhoto(s);
      s.photoFile = file;
      s.photoPreviewUrl = URL.createObjectURL(file);
      rerenderCard(playId);
    },

    _clearPendingPhoto(s) {
      if (s.photoPreviewUrl) {
        try { URL.revokeObjectURL(s.photoPreviewUrl); } catch (_) {}
      }
      s.photoFile = null;
      s.photoPreviewUrl = null;
    },

    async saveEdit(playId) {
      const s = getState(playId);
      if (!s.draft || !s.hydrated) return;
      s.saving = true;
      s.error = null;
      rerenderCard(playId);

      const p = s.hydrated;
      // Photo upload first so the PUT carries the new URL atomically.
      let photoUrl = p.photo_url || null;
      if (s.photoFile) {
        try {
          const fd = new FormData();
          fd.append("file", s.photoFile);
          const resp = await window.api.upload("/plays/photo", fd);
          if (resp && resp.photo_url) photoUrl = resp.photo_url;
        } catch (e) {
          s.error = (e && e.message) || "Photo upload failed";
          s.saving = false;
          rerenderCard(playId);
          return;
        }
      }

      const payload = {
        played_at: p.played_at,
        notes: s.draft.notes || null,
        photo_url: photoUrl,
        expansion_ids: (p.expansions || []).map((e) => e.expansion_game_id),
        play_mode: p.play_mode || null,
        players: s.draft.players.map((pl) => ({
          name: pl.name,
          is_winner: !!pl.is_winner,
          score: pl.score === "" || pl.score == null ? null : Number(pl.score),
          user_id: pl.user_id || null,
        })),
      };

      try {
        const updated = await window.Play.update(playId, payload);
        s.hydrated = updated;
        s.editing = false;
        s.draft = null;
        s.flipped = false;
        this._clearPendingPhoto(s);
        // Mirror the changes into the feed card so the front face reflects the
        // new winner / photo / notes without a full feed refetch.
        const card = findCardById(playId);
        if (card) {
          card.notes = updated.notes || null;
          card.photo_url = updated.photo_url || null;
          const winner = (updated.players || []).find((pl) => pl.is_winner);
          card.winner_display_name = winner ? winner.name : null;
          card.participant_count = (updated.players || []).length;
        }
        if (window.store && window.store.invalidate) {
          window.store.invalidate("feed");
        }
      } catch (e) {
        s.error = (e && e.message) || "Failed to save";
      } finally {
        s.saving = false;
        rerenderCard(playId);
      }
    },
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

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
