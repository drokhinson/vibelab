// guide.js — Chunk-based quick reference guides
//
// Data model:
//   Chunk (MyGuideChunkResponse): { id, game_id, chunk_type, chunk_type_label,
//     chunk_type_icon, chunk_type_order, title, layout, content, created_by,
//     created_by_name, updated_at, is_hidden, user_display_order }
//   Anon users see the full chunk library grouped by type (no hide/reorder).
//   Signed-in users see chunks with per-user is_hidden and user_display_order.
//
// Gestures (mobile-first, works with pointer/mouse too):
//   swipe right → edit (creator or admin; toast if blocked)
//   swipe left  → hide the chunk from the guide
//   long-press  → enter reorder mode; drag card to reposition

// ── Markdown renderer (shared with legacy guide) ─────────────────────────────

function renderMarkdown(text) {
  if (!text) return "";

  // Extract GitHub-style pipe tables before line-level replacements clobber
  // newlines. Header row, --- separator row, then one or more body rows.
  text = text.replace(
    /^\|(.+)\|[ \t]*\n\|([ :\-|]+)\|[ \t]*\n((?:\|.*\|[ \t]*\n?)+)/gm,
    (_m, header, _sep, body) => {
      const ths = header.split("|").map(s => s.trim()).filter(Boolean)
        .map(c => `<th>${c}</th>`).join("");
      const rows = body.trim().split("\n").map(line => {
        const cells = line.replace(/^\||\|$/g, "").split("|").map(s => s.trim());
        return `<tr>${cells.map(c => `<td>${c}</td>`).join("")}</tr>`;
      }).join("");
      return `<div class="overflow-x-auto my-2"><table class="table table-xs table-zebra guide-table"><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table></div>`;
    }
  );

  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^### (.+)$/gm, '<h4 class="font-bold mt-3 mb-1">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="font-bold text-base mt-3 mb-1">$1</h3>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li class="ml-4 list-decimal">$2</li>')
    .replace(/\n\n/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

function escapeAttr(s) {
  return String(s || "").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Permissions ──────────────────────────────────────────────────────────────

function canEditChunk(chunk) {
  if (!currentUser) return false;
  if (currentUser.is_admin) return true;
  return chunk.created_by === currentUser.user_id;
}

// ── Sorting ──────────────────────────────────────────────────────────────────

function sortVisibleChunks(chunks) {
  // user_display_order wins when set; otherwise fall back to chunk type order
  // (bumped way up so user-ordered rows always sort ahead of unordered ones)
  // then title as a stable tiebreak.
  return chunks.slice().sort((a, b) => {
    const aHas = a.user_display_order !== null && a.user_display_order !== undefined;
    const bHas = b.user_display_order !== null && b.user_display_order !== undefined;
    if (aHas && bHas) return a.user_display_order - b.user_display_order;
    if (aHas) return -1;
    if (bHas) return 1;
    const typeDiff = (a.chunk_type_order || 0) - (b.chunk_type_order || 0);
    if (typeDiff !== 0) return typeDiff;
    return (a.title || "").localeCompare(b.title || "");
  });
}

// ── Guide loading ────────────────────────────────────────────────────────────

async function loadGuide(gameId) {
  const container = document.getElementById("guide-content");
  try {
    let all;
    if (session) {
      all = await apiFetch(`/games/${gameId}/my-guide`);
    } else {
      // Anon users: library chunks with no per-user metadata.
      all = await apiFetch(`/games/${gameId}/chunks`);
    }
    currentGuideChunks = sortVisibleChunks(all.filter(c => !c.is_hidden));
    hiddenChunks = all.filter(c => c.is_hidden);
    renderGuide();
    renderGuideToolbar();
  } catch (err) {
    currentGuideChunks = [];
    hiddenChunks = [];
    container.innerHTML = `<p class="text-error text-sm">${err.message}</p>`;
  }
}

function renderGuide() {
  const container = document.getElementById("guide-content");
  const rulebookHost = document.getElementById("rulebook-section");
  const chunks = currentGuideChunks;

  const rulebookChunks = chunks.filter(c => c.chunk_type === "rulebook");
  const otherChunks = chunks.filter(c => c.chunk_type !== "rulebook");

  // Rulebook gets its own section above Quick Reference.
  if (rulebookHost) {
    if (rulebookChunks.length) {
      rulebookHost.className = "mb-4 space-y-2";
      rulebookHost.innerHTML = rulebookChunks.map(c => `
        <a href="${escapeAttr(c.content.trim())}" target="_blank" rel="noopener"
           class="rulebook-card">
          <i data-lucide="file-text" class="w-5 h-5"></i>
          <div class="rulebook-card__text">
            <div class="rulebook-card__title">${c.title || "Rulebook"}</div>
            <div class="rulebook-card__sub">Open official rulebook</div>
          </div>
          <i data-lucide="external-link" class="w-4 h-4 opacity-60"></i>
        </a>
      `).join("");
    } else {
      rulebookHost.className = "";
      rulebookHost.innerHTML = "";
    }
  }

  if (!otherChunks.length) {
    container.innerHTML = `
      <div class="text-center py-4 text-base-content/50">
        <p class="text-sm">No guide chunks yet.</p>
        ${session ? '<button class="btn btn-sm btn-outline mt-2" onclick="openChunkEditor()">Add the first chunk</button>' : ""}
      </div>`;
    lucide.createIcons();
    return;
  }

  const allowGestures = !!session;

  container.innerHTML = `
    <div id="guide-chunk-list" class="space-y-3 ${guideReorderMode ? "reorder-mode" : ""}">
      ${otherChunks.map((c, i) => {
        const icon = c.chunk_type_icon || "sticky-note";
        const label = c.chunk_type_label || c.chunk_type;
        const editable = canEditChunk(c);
        return `
          <div class="swipe-row" data-chunk-id="${c.id}" data-chunk-index="${i}"
               data-can-edit="${editable ? "1" : "0"}">
            <div class="swipe-action swipe-action--hide">
              <i data-lucide="eye-off" class="w-5 h-5"></i>
              <span>Hide</span>
            </div>
            <div class="swipe-action swipe-action--edit">
              <i data-lucide="pencil" class="w-5 h-5"></i>
              <span>Edit</span>
            </div>
            <div class="collapse collapse-arrow scroll-chunk swipe-target">
              <input type="checkbox" />
              <div class="collapse-title font-medium text-sm flex items-center justify-between gap-2">
                <span class="flex items-center gap-1">
                  <i data-lucide="grip-vertical" class="w-3 h-3 reorder-handle"></i>
                  <i data-lucide="${icon}" class="w-4 h-4"></i>
                  <span class="badge badge-sm">${label}</span>
                  <span>${c.title}</span>
                </span>
                ${c.created_by_name ? `<span class="text-xs opacity-60">by ${c.created_by_name}</span>` : ""}
              </div>
              <div class="collapse-content text-sm leading-relaxed guide-text">${renderMarkdown(c.content)}</div>
            </div>
          </div>`;
      }).join("")}
    </div>`;
  lucide.createIcons();

  if (allowGestures) {
    container.querySelectorAll(".swipe-row").forEach(attachChunkGestures);
  }
}

function renderGuideToolbar() {
  const host = document.getElementById("guide-toolbar");
  if (!host) return;
  if (!session) { host.innerHTML = ""; return; }
  const hiddenCount = hiddenChunks.length;
  host.innerHTML = `
    <div class="flex items-center gap-2 flex-wrap">
      <button class="btn btn-xs btn-outline" onclick="openChunkEditor()">
        <i data-lucide="plus" class="w-3 h-3"></i> New chunk
      </button>
      <button class="btn btn-xs btn-ghost ${hiddenCount ? "" : "btn-disabled"}"
              onclick="openHiddenChunksPanel()">
        <i data-lucide="eye-off" class="w-3 h-3"></i> Hidden (${hiddenCount})
      </button>
      ${guideReorderMode ? `
        <button class="btn btn-xs btn-primary" onclick="exitReorderMode()">
          <i data-lucide="check" class="w-3 h-3"></i> Done reordering
        </button>` : `
        <span class="text-xs opacity-60">Swipe ↔ or press &amp; hold</span>`}
    </div>`;
  lucide.createIcons();
}

// ── Chunk type lookup (cached) ───────────────────────────────────────────────

async function loadChunkTypes() {
  if (chunkTypeCache) return chunkTypeCache;
  chunkTypeCache = await apiFetch("/chunk-types");
  return chunkTypeCache;
}

// ── Gesture layer (swipe + long-press reorder) ───────────────────────────────

const SWIPE_ACTIVATE_PX = 8;   // horizontal threshold before we claim the gesture
const SWIPE_COMMIT_FRAC = 0.35; // fraction of row width that commits the action
const LONG_PRESS_MS = 450;

function attachChunkGestures(row) {
  const target = row.querySelector(".swipe-target");
  if (!target) return;

  let startX = null;
  let startY = null;
  let isSwipe = false;
  let isLongPressDrag = false;
  let holdTimer = null;
  let pointerId = null;

  const clearHold = () => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  };

  const resetVisual = () => {
    target.style.cssText = "transform: translateX(0); transition: transform 200ms ease;";
  };

  row.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    // Reorder mode uses its own handler — skip swipe gestures there.
    if (guideReorderMode) {
      startDragReorder(row, e);
      return;
    }
    startX = e.clientX;
    startY = e.clientY;
    pointerId = e.pointerId;
    isSwipe = false;
    isLongPressDrag = false;

    clearHold();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      // Long-press fires only if no swipe is in progress.
      if (isSwipe) return;
      enterReorderMode();
      startDragReorder(row, { clientX: startX, clientY: startY, pointerId });
      startX = null;
      isLongPressDrag = true;
    }, LONG_PRESS_MS);
  });

  row.addEventListener("pointermove", (e) => {
    if (isLongPressDrag) return;
    if (startX === null) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!isSwipe) {
      if (Math.abs(dy) > SWIPE_ACTIVATE_PX && Math.abs(dy) > Math.abs(dx)) {
        // Vertical scroll — abandon swipe.
        clearHold();
        startX = null;
        return;
      }
      if (Math.abs(dx) > SWIPE_ACTIVATE_PX) {
        isSwipe = true;
        clearHold();
        try { row.setPointerCapture(e.pointerId); } catch (_) {}
      } else {
        return;
      }
    }
    const maxDrag = row.clientWidth * 0.9;
    const clamped = Math.sign(dx) * Math.min(Math.abs(dx), maxDrag);
    target.style.cssText = `transform: translateX(${clamped}px); transition: none;`;
    row.classList.toggle("swiping-right", clamped > 0);
    row.classList.toggle("swiping-left", clamped < 0);
  });

  const finish = (e) => {
    if (isLongPressDrag) {
      endDragReorder(e);
      isLongPressDrag = false;
      return;
    }
    clearHold();
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    row.classList.remove("swiping-right", "swiping-left");
    if (!isSwipe) {
      // Plain tap — let the collapse toggle naturally (input[type=checkbox]).
      return;
    }
    isSwipe = false;
    const commitPx = row.clientWidth * SWIPE_COMMIT_FRAC;
    if (dx > commitPx) {
      // Swipe right → edit
      resetVisual();
      const chunkId = row.dataset.chunkId;
      if (row.dataset.canEdit === "1") {
        setTimeout(() => openChunkEditor(chunkId), 120);
      } else {
        showToast("Only the creator or an admin can edit this chunk.", "info");
      }
    } else if (dx < -commitPx) {
      // Swipe left → hide
      const chunkId = row.dataset.chunkId;
      // Slide off before the API call for responsiveness.
      target.style.cssText = `transform: translateX(-110%); transition: transform 180ms ease;`;
      setTimeout(() => hideChunk(chunkId), 180);
    } else {
      resetVisual();
    }
  };

  row.addEventListener("pointerup", finish);
  row.addEventListener("pointercancel", (e) => {
    clearHold();
    startX = null;
    isSwipe = false;
    row.classList.remove("swiping-right", "swiping-left");
    resetVisual();
    if (isLongPressDrag) {
      endDragReorder(e);
      isLongPressDrag = false;
    }
  });
}

// ── Reorder mode (press-and-hold drag) ───────────────────────────────────────

let _dragState = null; // { row, startY, placeholder }

function enterReorderMode() {
  if (guideReorderMode) return;
  guideReorderMode = true;
  document.getElementById("guide-chunk-list")?.classList.add("reorder-mode");
  renderGuideToolbar();
  if (navigator.vibrate) navigator.vibrate(15);
}

function exitReorderMode() {
  if (!guideReorderMode) return;
  guideReorderMode = false;
  document.getElementById("guide-chunk-list")?.classList.remove("reorder-mode");
  renderGuideToolbar();
  saveReorderedGuide();
}

function startDragReorder(row, e) {
  const list = row.parentElement;
  if (!list) return;
  row.classList.add("is-dragging");
  const rect = row.getBoundingClientRect();
  _dragState = {
    row,
    list,
    pointerId: e.pointerId,
    offsetY: e.clientY - rect.top,
    height: rect.height,
  };
  try { row.setPointerCapture(e.pointerId); } catch (_) {}
  row.style.cssText = `
    position: relative;
    z-index: 20;
    transition: none;
    transform: translateY(0);
  `;
}

function handleDragReorderMove(e) {
  if (!_dragState) return;
  const { row, list, height } = _dragState;
  const listRect = list.getBoundingClientRect();
  const y = e.clientY - listRect.top - _dragState.offsetY;
  row.style.transform = `translateY(${y - row.offsetTop}px)`;

  // Figure out which sibling we're hovering over and swap if past its midpoint.
  const siblings = Array.from(list.querySelectorAll(".swipe-row")).filter(n => n !== row);
  const pointerY = e.clientY;
  for (const sib of siblings) {
    const r = sib.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    if (pointerY < mid && sib.previousElementSibling !== row) {
      list.insertBefore(row, sib);
      row.style.transform = "";
      const newRect = row.getBoundingClientRect();
      _dragState.offsetY = e.clientY - newRect.top;
      break;
    } else if (pointerY > mid && sib.nextElementSibling !== row &&
               siblings.indexOf(sib) === siblings.length - 1) {
      list.appendChild(row);
      row.style.transform = "";
      const newRect = row.getBoundingClientRect();
      _dragState.offsetY = e.clientY - newRect.top;
      break;
    }
  }
}

function endDragReorder(_e) {
  if (!_dragState) return;
  const { row } = _dragState;
  row.classList.remove("is-dragging");
  row.style.cssText = "";
  _dragState = null;
}

// Global listeners so drag keeps working even if the pointer leaves the row.
document.addEventListener("pointermove", (e) => {
  if (_dragState) handleDragReorderMove(e);
});
document.addEventListener("pointerup", (e) => {
  if (_dragState) endDragReorder(e);
});

async function saveReorderedGuide() {
  if (!session || !currentGame) return;
  const list = document.getElementById("guide-chunk-list");
  if (!list) return;
  const ids = Array.from(list.querySelectorAll(".swipe-row")).map(r => r.dataset.chunkId);
  try {
    await apiFetch(`/games/${currentGame.id}/my-guide`, {
      method: "PUT",
      body: { chunk_ids: ids },
    });
    showToast("Order saved", "success");
    await loadGuide(currentGame.id);
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ── Hide / unhide ────────────────────────────────────────────────────────────

async function hideChunk(chunkId) {
  try {
    await apiFetch(`/chunks/${chunkId}/visibility`, {
      method: "POST",
      body: { is_hidden: true },
    });
    showToast("Chunk hidden. Tap “Hidden” to restore.", "info");
    await loadGuide(currentGame.id);
  } catch (err) {
    showToast(err.message, "error");
    await loadGuide(currentGame.id);
  }
}

async function unhideChunk(chunkId) {
  try {
    await apiFetch(`/chunks/${chunkId}/visibility`, {
      method: "POST",
      body: { is_hidden: false },
    });
    showToast("Chunk restored", "success");
    await loadGuide(currentGame.id);
    // Refresh the hidden panel content if it's still open.
    const dlg = document.getElementById("hidden-chunks-dialog");
    if (dlg?.open) renderHiddenChunksPanel();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ── Hidden chunks modal ──────────────────────────────────────────────────────

function openHiddenChunksPanel() {
  if (!session || !currentGame) return;
  const dlg = document.getElementById("hidden-chunks-dialog");
  dlg.showModal();
  renderHiddenChunksPanel();
}

function closeHiddenChunksPanel() {
  const dlg = document.getElementById("hidden-chunks-dialog");
  if (dlg && dlg.open) dlg.close();
}

function renderHiddenChunksPanel() {
  const body = document.getElementById("hidden-chunks-body");
  if (!body) return;
  if (!hiddenChunks.length) {
    body.innerHTML = `
      <p class="text-sm text-base-content/60">Nothing hidden. Swipe a chunk left on the guide to hide it.</p>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick="closeHiddenChunksPanel()">Close</button>
      </div>`;
    return;
  }
  body.innerHTML = `
    <p class="text-xs text-base-content/60 mb-2">Tap Show to restore a chunk to the guide.</p>
    <div class="space-y-1">
      ${hiddenChunks.map(c => `
        <div class="flex items-center gap-2 py-1">
          <span class="badge badge-sm badge-ghost">${c.chunk_type_label || c.chunk_type}</span>
          <span class="text-sm flex-1 truncate">${c.title}</span>
          <button class="btn btn-xs btn-primary" onclick="unhideChunk('${c.id}')">
            <i data-lucide="eye" class="w-3 h-3"></i> Show
          </button>
        </div>`).join("")}
    </div>
    <div class="modal-action">
      <button class="btn btn-ghost btn-sm" onclick="closeHiddenChunksPanel()">Close</button>
    </div>`;
  lucide.createIcons();
}

// ── Chunk editor (create + edit) ─────────────────────────────────────────────
// openChunkEditorModal is the shared popup used by both the guide and the
// import review flow. Callers pass onSave/onDelete callbacks; what gets done
// with the data differs per context.

let _chunkEditorOnSave = null;
let _chunkEditorOnDelete = null;

async function openChunkEditorModal({ existing = null, onSave, onDelete = null }) {
  const types = await loadChunkTypes();
  _chunkEditorOnSave = onSave;
  _chunkEditorOnDelete = onDelete;

  const dlg = document.getElementById("chunk-editor");
  dlg.showModal();
  document.getElementById("chunk-editor-body").innerHTML = `
    <form onsubmit="submitChunkEditor(event)" class="space-y-3">
      <div class="form-control">
        <label class="label"><span class="label-text text-xs">Type</span></label>
        <select id="chunk-type" class="select select-bordered select-sm" required>
          ${types.map(t => `
            <option value="${t.id}" ${existing?.chunk_type === t.id ? "selected" : ""}>${t.label}</option>
          `).join("")}
        </select>
      </div>
      <div class="form-control">
        <label class="label"><span class="label-text text-xs">Title</span></label>
        <input id="chunk-title" type="text" class="input input-bordered input-sm"
               required maxlength="80"
               value="${escapeAttr(existing?.title || "")}" />
      </div>
      <div class="form-control">
        <div class="flex items-center justify-between mb-1">
          <span class="label-text text-xs">Content</span>
          <div class="join">
            <button type="button" id="tab-write"
                    class="btn btn-xs join-item btn-active"
                    onclick="toggleChunkEditorTab('write')">Write</button>
            <button type="button" id="tab-preview"
                    class="btn btn-xs join-item"
                    onclick="toggleChunkEditorTab('preview')">Preview</button>
          </div>
        </div>
        <span class="text-xs opacity-60 mb-1">Markdown supported</span>
        <textarea id="chunk-content" class="textarea textarea-bordered text-sm h-40"
                  required>${(existing?.content || "").replace(/</g, "&lt;")}</textarea>
        <div id="chunk-preview"
             class="hidden h-40 overflow-y-auto p-3 rounded-lg border border-base-300 bg-base-200 text-sm guide-text"></div>
      </div>
      <div class="modal-action">
        ${onDelete ? `
          <button type="button" class="btn btn-ghost btn-sm text-error"
                  onclick="deleteChunkEditor()">
            <i data-lucide="trash-2" class="w-3 h-3"></i> Delete
          </button>` : ""}
        <button type="button" class="btn btn-ghost btn-sm" onclick="closeChunkEditor()">Cancel</button>
        <button type="submit" class="btn btn-primary btn-sm">
          ${existing ? "Save changes" : "Create chunk"}
        </button>
      </div>
    </form>`;
  lucide.createIcons();
}

function closeChunkEditor() {
  const dlg = document.getElementById("chunk-editor");
  if (dlg && dlg.open) dlg.close();
}

function toggleChunkEditorTab(tab) {
  const textarea   = document.getElementById("chunk-content");
  const preview    = document.getElementById("chunk-preview");
  const writeBtn   = document.getElementById("tab-write");
  const previewBtn = document.getElementById("tab-preview");
  if (tab === "preview") {
    preview.innerHTML = renderMarkdown(textarea.value)
      || '<span class="opacity-40 text-xs">Nothing to preview</span>';
    textarea.classList.add("hidden");
    preview.classList.remove("hidden");
    writeBtn.classList.remove("btn-active");
    previewBtn.classList.add("btn-active");
  } else {
    textarea.classList.remove("hidden");
    preview.classList.add("hidden");
    writeBtn.classList.add("btn-active");
    previewBtn.classList.remove("btn-active");
  }
}

async function submitChunkEditor(e) {
  e.preventDefault();
  const data = {
    chunk_type: document.getElementById("chunk-type").value,
    title: document.getElementById("chunk-title").value.trim(),
    content: document.getElementById("chunk-content").value,
  };
  if (!data.title || !data.content) return;
  try {
    await _chunkEditorOnSave(data);
    closeChunkEditor();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteChunkEditor() {
  if (!_chunkEditorOnDelete) return;
  try {
    await _chunkEditorOnDelete();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function openChunkEditor(chunkId) {
  if (!session || !currentGame) return;
  const pool = [...currentGuideChunks, ...hiddenChunks];
  const existing = chunkId ? pool.find(c => c.id === chunkId) : null;

  await openChunkEditorModal({
    existing,
    onSave: async (data) => {
      if (chunkId) {
        await apiFetch(`/chunks/${chunkId}`, { method: "PATCH", body: data });
        showToast("Chunk updated", "success");
      } else {
        await apiFetch(`/games/${currentGame.id}/chunks`, { method: "POST", body: data });
        showToast("Chunk created", "success");
      }
      await loadGuide(currentGame.id);
    },
    onDelete: chunkId && canEditChunk(existing) ? async () => {
      if (!confirm("Delete this chunk? It will be removed from everyone's guide.")) return;
      await apiFetch(`/chunks/${chunkId}`, { method: "DELETE" });
      showToast("Chunk deleted", "success");
      closeChunkEditor();
      await loadGuide(currentGame.id);
    } : null,
  });
}
