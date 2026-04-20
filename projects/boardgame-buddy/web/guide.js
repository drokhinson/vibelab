// guide.js — Chunk-based quick reference guides
//
// Data model:
//   Chunk: { id, game_id, chunk_type, chunk_type_label, chunk_type_icon,
//            title, layout, content, created_by, created_by_name, updated_at }
//   A user's guide = their ordered selection of chunks for a game.
//   Anon users see the full chunk library grouped by type.

// ── Markdown renderer (shared with legacy guide) ─────────────────────────────

function renderMarkdown(text) {
  if (!text) return "";
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

// ── Guide loading ────────────────────────────────────────────────────────────

async function loadGuide(gameId) {
  const container = document.getElementById("guide-content");
  try {
    if (session) {
      // My selection first.
      currentGuideChunks = await apiFetch(`/games/${gameId}/my-guide`);
      if (!currentGuideChunks.length) {
        // Fall back to the full library so the user sees something useful.
        currentGuideChunks = await apiFetch(`/games/${gameId}/chunks`);
      }
    } else {
      currentGuideChunks = await apiFetch(`/games/${gameId}/chunks`);
    }
    renderGuide();
  } catch (err) {
    currentGuideChunks = [];
    container.innerHTML = `<p class="text-error text-sm">${err.message}</p>`;
  }
}

function renderGuide() {
  const container = document.getElementById("guide-content");
  const chunks = currentGuideChunks;

  if (!chunks.length) {
    container.innerHTML = `
      <div class="text-center py-4 text-base-content/50">
        <p class="text-sm">No guide chunks yet.</p>
        ${session ? '<button class="btn btn-sm btn-outline mt-2" onclick="openChunkManager()">Add the first chunk</button>' : ""}
      </div>`;
    lucide.createIcons();
    return;
  }

  const myId = currentUser?.user_id || session?.user?.id || null;

  container.innerHTML = `
    <div class="space-y-3">
      ${chunks.map(c => {
        const isRulebook = c.chunk_type === "rulebook";
        const isMine = myId && c.created_by === myId;
        const icon = c.chunk_type_icon || "sticky-note";
        const label = c.chunk_type_label || c.chunk_type;
        const body = isRulebook
          ? `<a href="${escapeAttr(c.content.trim())}" target="_blank" rel="noopener"
                class="btn btn-outline btn-sm w-full mt-1">
               <i data-lucide="file-text" class="w-4 h-4"></i> Open rulebook
             </a>`
          : `<div class="collapse-content text-sm leading-relaxed guide-text">${renderMarkdown(c.content)}</div>`;
        return `
          <div class="collapse collapse-arrow bg-base-200 border border-base-300">
            <input type="checkbox" checked />
            <div class="collapse-title font-medium text-sm flex items-center justify-between gap-2">
              <span class="flex items-center gap-1">
                <i data-lucide="${icon}" class="w-4 h-4" style="color: var(--game-accent)"></i>
                <span class="badge badge-sm badge-ghost">${label}</span>
                <span>${c.title}</span>
              </span>
              ${c.created_by_name ? `<span class="text-xs text-base-content/50">by ${c.created_by_name}</span>` : ""}
            </div>
            ${body}
            ${isMine ? `
              <div class="px-4 pb-3 flex gap-2">
                <button class="btn btn-xs btn-ghost" onclick="event.stopPropagation(); openChunkEditor('${c.id}')">
                  <i data-lucide="pencil" class="w-3 h-3"></i> Edit
                </button>
                <button class="btn btn-xs btn-ghost text-error" onclick="event.stopPropagation(); deleteChunk('${c.id}')">
                  <i data-lucide="trash-2" class="w-3 h-3"></i> Delete
                </button>
              </div>` : ""}
          </div>`;
      }).join("")}
    </div>`;
  lucide.createIcons();
}

function renderGuideToolbar() {
  const host = document.getElementById("guide-toolbar");
  if (!host) return;
  if (!session) { host.innerHTML = ""; return; }
  host.innerHTML = `
    <button class="btn btn-xs btn-outline" onclick="openChunkManager()">
      <i data-lucide="sliders-horizontal" class="w-3 h-3"></i> Customize
    </button>`;
  lucide.createIcons();
}

// ── Chunk type lookup (cached) ───────────────────────────────────────────────

async function loadChunkTypes() {
  if (chunkTypeCache) return chunkTypeCache;
  chunkTypeCache = await apiFetch("/chunk-types");
  return chunkTypeCache;
}

// ── Chunk manager modal ──────────────────────────────────────────────────────

async function openChunkManager() {
  if (!session || !currentGame) return;
  const dlg = document.getElementById("chunk-manager");
  dlg.showModal();
  document.getElementById("chunk-manager-body").innerHTML = `
    <div class="flex justify-center py-6"><span class="loading loading-spinner"></span></div>`;
  try {
    const [lib, types] = await Promise.all([
      apiFetch(`/games/${currentGame.id}/chunks`),
      loadChunkTypes(),
    ]);
    chunkLibrary = lib;
    // Start with whatever is currently in my guide (preserve order).
    const selected = currentGuideChunks
      .map(c => c.id)
      .filter(id => lib.some(l => l.id === id));
    renderChunkManager(selected, types);
  } catch (err) {
    document.getElementById("chunk-manager-body").innerHTML =
      `<p class="text-error text-sm">${err.message}</p>`;
  }
}

function closeChunkManager() {
  const dlg = document.getElementById("chunk-manager");
  if (dlg && dlg.open) dlg.close();
}

function renderChunkManager(selectedIds, types) {
  const body = document.getElementById("chunk-manager-body");
  const myId = currentUser?.user_id || session?.user?.id || null;
  const byType = {};
  for (const c of chunkLibrary) {
    (byType[c.chunk_type] = byType[c.chunk_type] || []).push(c);
  }

  // Selected-order preview
  const selectedChunks = selectedIds
    .map(id => chunkLibrary.find(c => c.id === id))
    .filter(Boolean);

  const selectedHtml = selectedChunks.length
    ? selectedChunks.map((c, i) => `
        <div class="flex items-center gap-2 py-1">
          <span class="badge badge-sm badge-ghost">${c.chunk_type_label || c.chunk_type}</span>
          <span class="text-sm flex-1 truncate">${c.title}</span>
          <button class="btn btn-xs btn-ghost" ${i === 0 ? "disabled" : ""}
                  onclick="reorderSelected(${i}, -1)" title="Move up">
            <i data-lucide="chevron-up" class="w-3 h-3"></i>
          </button>
          <button class="btn btn-xs btn-ghost" ${i === selectedChunks.length - 1 ? "disabled" : ""}
                  onclick="reorderSelected(${i}, 1)" title="Move down">
            <i data-lucide="chevron-down" class="w-3 h-3"></i>
          </button>
        </div>`).join("")
    : '<p class="text-sm text-base-content/50">No chunks selected yet — toggle some below.</p>';

  const libraryHtml = types
    .filter(t => byType[t.id]?.length)
    .map(t => `
      <div class="mb-3">
        <h4 class="font-semibold text-xs uppercase opacity-70 mb-1 flex items-center gap-1">
          <i data-lucide="${t.icon || "sticky-note"}" class="w-3 h-3"></i> ${t.label}
        </h4>
        ${byType[t.id].map(c => {
          const checked = selectedIds.includes(c.id) ? "checked" : "";
          const mine = myId && c.created_by === myId;
          return `
            <label class="flex items-start gap-2 py-1 cursor-pointer">
              <input type="checkbox" class="checkbox checkbox-sm mt-1"
                     data-chunk-id="${c.id}" ${checked}
                     onchange="toggleChunkSelected('${c.id}', this.checked)" />
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium truncate">${c.title}</div>
                <div class="text-xs text-base-content/50">
                  ${c.created_by_name ? `by ${c.created_by_name}` : "by someone"}
                </div>
              </div>
              ${mine ? `
                <button class="btn btn-xs btn-ghost" onclick="openChunkEditor('${c.id}')">
                  <i data-lucide="pencil" class="w-3 h-3"></i>
                </button>
                <button class="btn btn-xs btn-ghost text-error" onclick="deleteChunk('${c.id}')">
                  <i data-lucide="trash-2" class="w-3 h-3"></i>
                </button>` : ""}
            </label>`;
        }).join("")}
      </div>`).join("");

  body.innerHTML = `
    <div class="space-y-4">
      <section>
        <h3 class="font-bold text-sm mb-1">Your guide</h3>
        <p class="text-xs text-base-content/60 mb-2">Shown on the game page in this order.</p>
        <div id="selected-preview">${selectedHtml}</div>
      </section>

      <section>
        <div class="flex items-center justify-between mb-2">
          <h3 class="font-bold text-sm">Available chunks</h3>
          <button class="btn btn-xs btn-primary" onclick="openChunkEditor()">
            <i data-lucide="plus" class="w-3 h-3"></i> New chunk
          </button>
        </div>
        ${libraryHtml || '<p class="text-sm text-base-content/50">No chunks yet. Create the first one.</p>'}
      </section>
    </div>

    <div class="modal-action">
      <button class="btn btn-ghost" onclick="closeChunkManager()">Cancel</button>
      <button class="btn btn-primary" onclick="saveGuideSelection()">Save guide</button>
    </div>`;

  // Persist the current in-modal selection on the dialog element so
  // toggles/reorders have somewhere to read/write.
  body.dataset.selectedIds = JSON.stringify(selectedIds);
  lucide.createIcons();
}

function getManagerSelection() {
  const body = document.getElementById("chunk-manager-body");
  return JSON.parse(body.dataset.selectedIds || "[]");
}

function setManagerSelection(ids) {
  const body = document.getElementById("chunk-manager-body");
  body.dataset.selectedIds = JSON.stringify(ids);
  // Re-render with cached types (already loaded).
  renderChunkManager(ids, chunkTypeCache || []);
}

function toggleChunkSelected(chunkId, checked) {
  const current = getManagerSelection();
  let next;
  if (checked) {
    next = current.includes(chunkId) ? current : [...current, chunkId];
  } else {
    next = current.filter(id => id !== chunkId);
  }
  setManagerSelection(next);
}

function reorderSelected(index, delta) {
  const current = getManagerSelection();
  const target = index + delta;
  if (target < 0 || target >= current.length) return;
  const next = current.slice();
  [next[index], next[target]] = [next[target], next[index]];
  setManagerSelection(next);
}

async function saveGuideSelection() {
  const ids = getManagerSelection();
  try {
    await apiFetch(`/games/${currentGame.id}/my-guide`, {
      method: "PUT",
      body: { chunk_ids: ids },
    });
    showToast("Guide saved!", "success");
    closeChunkManager();
    await loadGuide(currentGame.id);
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ── Chunk editor (create + edit) ─────────────────────────────────────────────

async function openChunkEditor(chunkId) {
  if (!session || !currentGame) return;
  const types = await loadChunkTypes();
  const existing = chunkId ? chunkLibrary.find(c => c.id === chunkId) : null;

  const dlg = document.getElementById("chunk-editor");
  dlg.showModal();
  document.getElementById("chunk-editor-body").innerHTML = `
    <form onsubmit="submitChunk(event, ${existing ? `'${existing.id}'` : "null"})" class="space-y-3">
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
        <label class="label">
          <span class="label-text text-xs">Content</span>
          <span class="label-text-alt text-xs opacity-60">Markdown supported</span>
        </label>
        <textarea id="chunk-content" class="textarea textarea-bordered text-sm h-40"
                  required>${(existing?.content || "").replace(/</g, "&lt;")}</textarea>
      </div>
      <div class="modal-action">
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

async function submitChunk(e, chunkId) {
  e.preventDefault();
  const body = {
    chunk_type: document.getElementById("chunk-type").value,
    title: document.getElementById("chunk-title").value.trim(),
    content: document.getElementById("chunk-content").value,
  };
  if (!body.title || !body.content) return;

  try {
    let saved;
    if (chunkId) {
      saved = await apiFetch(`/chunks/${chunkId}`, { method: "PATCH", body });
      showToast("Chunk updated", "success");
    } else {
      saved = await apiFetch(`/games/${currentGame.id}/chunks`, { method: "POST", body });
      showToast("Chunk created", "success");
    }
    closeChunkEditor();

    // Refresh the manager (if open) and the live guide.
    const dlg = document.getElementById("chunk-manager");
    if (dlg?.open) {
      chunkLibrary = await apiFetch(`/games/${currentGame.id}/chunks`);
      let selection = getManagerSelection();
      if (!chunkId && saved?.id && !selection.includes(saved.id)) {
        selection = [...selection, saved.id]; // auto-select newly created chunk
      }
      setManagerSelection(selection);
    }
    await loadGuide(currentGame.id);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteChunk(chunkId) {
  if (!confirm("Delete this chunk? It will be removed from everyone's guide.")) return;
  try {
    await apiFetch(`/chunks/${chunkId}`, { method: "DELETE" });
    showToast("Chunk deleted", "success");

    const dlg = document.getElementById("chunk-manager");
    if (dlg?.open) {
      chunkLibrary = await apiFetch(`/games/${currentGame.id}/chunks`);
      const selection = getManagerSelection().filter(id => id !== chunkId);
      setManagerSelection(selection);
    }
    await loadGuide(currentGame.id);
  } catch (err) {
    showToast(err.message, "error");
  }
}
