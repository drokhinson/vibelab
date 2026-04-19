// collection.js — Closet: shelves + list view, plus collection mutations used by game detail.

const SHELVES = [
  { key: "owned",    label: "Owned",   icon: "package" },
  { key: "played",   label: "Played",  icon: "dice-5" },
  { key: "wishlist", label: "Wish",    icon: "star" },
];

// ── Entry point ──────────────────────────────────────────────────────────────

async function loadCloset() {
  const shelvesEl = document.getElementById("closet-shelves");
  shelvesEl.innerHTML = '<div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>';

  try {
    collectionItems = await apiFetch("/collection");
    applyClosetControls();
    renderCloset();
  } catch (err) {
    shelvesEl.innerHTML = `<div class="text-error text-center py-8">${err.message}</div>`;
  }
}

function applyClosetControls() {
  const sortSel = document.getElementById("closet-sort");
  if (sortSel) sortSel.value = closetSort;
  const toggleBtn = document.getElementById("closet-view-toggle");
  if (toggleBtn) {
    const icon = closetView === "shelves" ? "list" : "library-big";
    toggleBtn.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4"></i>`;
    toggleBtn.title = closetView === "shelves" ? "Switch to list view" : "Switch to shelf view";
  }
}

function renderCloset() {
  const shelvesEl = document.getElementById("closet-shelves");
  const listEl = document.getElementById("closet-list");

  if (closetView === "shelves") {
    shelvesEl.classList.remove("hidden");
    listEl.classList.add("hidden");
    renderShelves();
  } else {
    shelvesEl.classList.add("hidden");
    listEl.classList.remove("hidden");
    renderList();
  }
  lucide.createIcons();
}

// ── Sort + filter ────────────────────────────────────────────────────────────

function filterItems(items) {
  const q = closetSearch.trim().toLowerCase();
  if (!q) return items;
  return items.filter(it => (it.game?.name || "").toLowerCase().includes(q));
}

function sortItems(items) {
  const copy = items.slice();
  if (closetSort === "alphabetical") {
    copy.sort((a, b) => (a.game?.name || "").localeCompare(b.game?.name || ""));
  } else {
    // last_played desc; items without a play fall back to added_at
    copy.sort((a, b) => {
      const ad = a.last_played_at || a.added_at || "";
      const bd = b.last_played_at || b.added_at || "";
      return bd.localeCompare(ad);
    });
  }
  return copy;
}

// ── Shelf view ───────────────────────────────────────────────────────────────

function renderShelves() {
  const container = document.getElementById("closet-shelves");
  const visible = filterItems(sortItems(collectionItems));

  if (!collectionItems.length) {
    container.innerHTML = emptyStateHTML();
    return;
  }

  container.innerHTML = SHELVES.map(shelf => {
    const books = visible.filter(it => it.status === shelf.key);
    return `
      <section class="shelf mb-5">
        <div class="shelf__label">
          <i data-lucide="${shelf.icon}" class="w-4 h-4"></i>
          <span>${shelf.label}</span>
          <span class="shelf__count">${books.length}</span>
        </div>
        <div class="shelf__row">
          ${books.length
            ? books.map((it, i) => bookSpineHTML(it, i)).join("")
            : `<div class="shelf__empty">No ${shelf.label.toLowerCase()} games yet.</div>`}
          <div class="shelf__base"></div>
        </div>
      </section>`;
  }).join("");
}

function bookSpineHTML(item, i) {
  const g = item.game;
  const color = g.theme_color || colorFromName(g.name);
  const thumb = g.thumbnail_url || "";
  return `
    <button type="button"
            class="book-spine animate-fadeUp"
            style="--book-color:${color}; --i:${i};"
            onclick="onBookClick('${g.id}', this)"
            title="${escapeAttr(g.name)}">
      ${thumb ? `<div class="book-spine__art" style="background-image:url('${thumb}')"></div>` : '<div class="book-spine__art book-spine__art--blank"></div>'}
      <div class="book-spine__title">${escapeHtml(g.name)}</div>
    </button>`;
}

// ── List view ────────────────────────────────────────────────────────────────

function renderList() {
  const container = document.getElementById("closet-list");
  const visible = filterItems(sortItems(collectionItems));

  if (!collectionItems.length) {
    container.innerHTML = emptyStateHTML();
    return;
  }

  container.innerHTML = SHELVES.map(shelf => {
    const rows = visible.filter(it => it.status === shelf.key);
    if (!rows.length) return "";
    return `
      <section class="mb-5">
        <h3 class="text-sm font-semibold uppercase tracking-wide text-base-content/60 mb-2 flex items-center gap-2">
          <i data-lucide="${shelf.icon}" class="w-4 h-4"></i> ${shelf.label}
          <span class="badge badge-sm badge-ghost">${rows.length}</span>
        </h3>
        <div class="grid grid-cols-1 gap-2">
          ${rows.map((it, i) => listRowHTML(it, i)).join("")}
        </div>
      </section>`;
  }).join("") || `<div class="text-center py-8 text-base-content/50">No games match "${escapeHtml(closetSearch)}"</div>`;
}

function listRowHTML(item, i) {
  const g = item.game;
  const lastPlayed = item.last_played_at ? `Last played ${formatDate(item.last_played_at)}` : "Never played";
  return `
    <div class="card card-side bg-base-200 h-20 cursor-pointer hover:shadow-md transition-all animate-fadeUp"
         style="--i:${i}" onclick="openGameDetail('${g.id}')">
      <figure class="w-16 flex-shrink-0">
        <img src="${g.thumbnail_url || ''}" alt="${escapeAttr(g.name)}" class="w-full h-full object-cover" loading="lazy" />
      </figure>
      <div class="card-body p-2 justify-center">
        <h3 class="font-semibold text-sm leading-tight line-clamp-1">${escapeHtml(g.name)}</h3>
        <div class="flex items-center gap-2 text-xs text-base-content/60">
          <span>${lastPlayed}</span>
          ${g.bgg_rating ? `<span>★ ${formatRating(g.bgg_rating)}</span>` : ""}
        </div>
      </div>
    </div>`;
}

// ── Empty state ──────────────────────────────────────────────────────────────

function emptyStateHTML() {
  return `
    <div class="text-center py-12 text-base-content/60">
      <div class="text-5xl mb-3">📚</div>
      <p class="mb-4">Your closet is empty.</p>
      <button class="btn btn-primary btn-sm" onclick="showView('browse'); loadGames();">
        <i data-lucide="plus" class="w-4 h-4"></i> Add your first game
      </button>
    </div>`;
}

// ── Book click → pull-down animation → detail ────────────────────────────────

function onBookClick(gameId, el) {
  if (el.classList.contains("pulling")) return;
  el.classList.add("pulling");
  const done = () => {
    el.removeEventListener("animationend", done);
    openGameDetail(gameId);
  };
  el.addEventListener("animationend", done);
  // Safety fallback in case animation event doesn't fire
  setTimeout(() => { if (el.classList.contains("pulling")) done(); }, 600);
}

// ── Small utilities ──────────────────────────────────────────────────────────

function colorFromName(name) {
  // Deterministic hue from string — used when theme_color is missing.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 42%)`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ── Collection mutations (used by game-detail.js) ────────────────────────────

async function addToCollection(gameId, status) {
  try {
    await apiFetch("/collection", {
      method: "POST",
      body: { game_id: gameId, status },
    });
    showToast(`Added to ${status}!`, "success");
    if (currentGame && currentGame.id === gameId) {
      renderCollectionButtons(gameId);
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function updateCollectionStatus(gameId, newStatus) {
  try {
    await apiFetch(`/collection/${gameId}`, {
      method: "PATCH",
      body: { status: newStatus },
    });
    showToast(`Moved to ${newStatus}`, "success");
    renderCollectionButtons(gameId);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function removeFromCollection(gameId) {
  try {
    await apiFetch(`/collection/${gameId}`, { method: "DELETE" });
    showToast("Removed from collection", "info");
    if (currentView === "closet") loadCloset();
    if (currentGame && currentGame.id === gameId) renderCollectionButtons(gameId);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function renderCollectionButtons(gameId) {
  const container = document.getElementById("collection-actions");
  if (!container) return;

  try {
    const items = await apiFetch("/collection");
    const existing = items.find(i => i.game_id === gameId);

    if (existing) {
      const statuses = ["owned", "played", "wishlist"];
      container.innerHTML = `
        <div class="flex gap-2 flex-wrap">
          ${statuses.map(s => `
            <button class="btn btn-sm ${existing.status === s ? 'btn-primary' : 'btn-outline'}"
                    onclick="updateCollectionStatus('${gameId}', '${s}')">
              ${s === "owned" ? "📦" : s === "played" ? "🎯" : "⭐"} ${s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          `).join("")}
          <button class="btn btn-sm btn-ghost text-error" onclick="removeFromCollection('${gameId}')">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>`;
    } else {
      container.innerHTML = `
        <div class="flex gap-2 flex-wrap">
          <button class="btn btn-sm btn-primary" onclick="addToCollection('${gameId}', 'owned')">📦 Own It</button>
          <button class="btn btn-sm btn-outline" onclick="addToCollection('${gameId}', 'played')">🎯 Played</button>
          <button class="btn btn-sm btn-outline" onclick="addToCollection('${gameId}', 'wishlist')">⭐ Wishlist</button>
        </div>`;
    }
    lucide.createIcons();
  } catch {
    container.innerHTML = '<p class="text-sm text-base-content/50">Log in to add to collection</p>';
  }
}
