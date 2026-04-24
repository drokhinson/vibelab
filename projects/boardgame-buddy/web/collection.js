// collection.js — Closet: shelves + list view, plus collection mutations used by game detail.

const IMG_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='80' viewBox='0 0 64 80'%3E%3Crect width='64' height='80' fill='%23333'/%3E%3Ctext x='32' y='44' font-size='28' text-anchor='middle' fill='%23666'%3E%3F%3C/text%3E%3C/svg%3E";

const SHELVES = [
  { key: "owned",    label: "Owned",   icon: "package" },
  { key: "played",   label: "Played",  icon: "dice-5" },
];

// ── Entry point ──────────────────────────────────────────────────────────────

const _shelfObservers = { owned: null, played: null };

function resetShelfState() {
  for (const key of ["owned", "played"]) {
    shelfItems[key] = [];
    shelfPage[key] = 1;
    shelfTotal[key] = 0;
    shelfHasMore[key] = true;
    shelfLoading[key] = false;
    if (_shelfObservers[key]) {
      _shelfObservers[key].disconnect();
      _shelfObservers[key] = null;
    }
  }
}

async function loadCloset() {
  resetShelfState();
  applyClosetControls();

  if (closetTab === "wishlist") {
    await loadWishlist();
    renderCloset();
    return;
  }

  const shelvesEl = document.getElementById("closet-shelves");
  const listEl = document.getElementById("closet-list");
  const spinner = '<div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>';
  shelvesEl.innerHTML = spinner;
  listEl.innerHTML = spinner;

  try {
    await Promise.all([loadShelfPage("owned", 1), loadShelfPage("played", 1)]);
    renderCloset();
  } catch (err) {
    shelvesEl.innerHTML = `<div class="text-error text-center py-8">${err.message}</div>`;
    listEl.innerHTML = `<div class="text-error text-center py-8">${err.message}</div>`;
  }
}

async function loadShelfPage(shelf, page) {
  if (shelfLoading[shelf]) return;
  if (page > 1 && !shelfHasMore[shelf]) return;

  shelfLoading[shelf] = true;
  try {
    const params = new URLSearchParams({
      status: shelf,
      page,
      per_page: SHELF_PER_PAGE,
      sort: closetSort,
    });
    const data = await apiFetch(`/collection/shelf?${params}`);
    if (page === 1) {
      shelfItems[shelf] = data.items;
    } else {
      shelfItems[shelf] = shelfItems[shelf].concat(data.items);
    }
    shelfPage[shelf] = page;
    shelfTotal[shelf] = data.total;
    shelfHasMore[shelf] = shelfItems[shelf].length < data.total;
  } finally {
    shelfLoading[shelf] = false;
  }
}

async function loadWishlist() {
  try {
    wishlistItems = await apiFetch("/collection?status=wishlist");
  } catch (err) {
    wishlistItems = [];
    showToast(err.message, "error");
  }
}

function applyClosetControls() {
  const sortSel = document.getElementById("closet-sort");
  if (sortSel) sortSel.value = closetSort;

  const toggleBtn = document.getElementById("closet-view-toggle");
  if (toggleBtn) {
    // The icon shows what you'll *switch to* when tapping.
    const icon = closetView === "list" ? "library-big" : "list";
    toggleBtn.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4"></i>`;
    toggleBtn.title = closetView === "list" ? "Switch to shelf view" : "Switch to list view";
  }

  const tabCollection = document.getElementById("tab-collection");
  const tabWishlist = document.getElementById("tab-wishlist");
  const controls = document.getElementById("closet-controls");
  if (tabCollection) tabCollection.classList.toggle("tab-active", closetTab === "collection");
  if (tabWishlist) tabWishlist.classList.toggle("tab-active", closetTab === "wishlist");
  if (controls) controls.classList.toggle("hidden", closetTab === "wishlist");
}

async function switchClosetTab(tab) {
  closetTab = tab;
  applyClosetControls();
  if (tab === "wishlist") {
    const el = document.getElementById("closet-wishlist");
    if (el) el.innerHTML = '<div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>';
    await loadWishlist();
  }
  renderCloset();
}

function renderCloset() {
  const shelvesEl = document.getElementById("closet-shelves");
  const listEl = document.getElementById("closet-list");
  const wishlistEl = document.getElementById("closet-wishlist");

  if (closetTab === "wishlist") {
    shelvesEl.classList.add("hidden");
    listEl.classList.add("hidden");
    wishlistEl.classList.remove("hidden");
    renderWishlist();
    return;
  }

  wishlistEl.classList.add("hidden");
  if (closetView === "shelves") {
    shelvesEl.classList.remove("hidden");
    listEl.classList.add("hidden");
    renderShelves();
  } else {
    shelvesEl.classList.add("hidden");
    listEl.classList.remove("hidden");
    renderList();
    lucide.createIcons();
    attachAllListSwipes();
    return;
  }
  lucide.createIcons();
}

// ── Sort + filter (client-side, applied to loaded pages only) ───────────────

function filterItems(items) {
  const q = closetSearch.trim().toLowerCase();
  if (!q) return items;
  return items.filter(it => (it.game?.name || "").toLowerCase().includes(q));
}

// ── Shelf view (owned + played only) ─────────────────────────────────────────

function renderShelves() {
  const container = document.getElementById("closet-shelves");
  const hasAny = shelfTotal.owned > 0 || shelfTotal.played > 0;

  if (!hasAny) {
    container.innerHTML = emptyCollectionHTML();
    lucide.createIcons();
    return;
  }

  container.innerHTML = SHELVES.map(shelf => `
    <section class="shelf mb-5" data-shelf="${shelf.key}">
      <div class="shelf__label">
        <i data-lucide="${shelf.icon}" class="w-4 h-4"></i>
        <span>${shelf.label}</span>
        <span class="shelf__count" data-shelf-count="${shelf.key}">0</span>
      </div>
      <div class="shelf__row" data-shelf-row="${shelf.key}">
        <div class="shelf__base"></div>
      </div>
    </section>
  `).join("");

  for (const shelf of SHELVES) renderShelfRow(shelf.key);
  lucide.createIcons();
}

function renderShelfRow(shelf) {
  const row = document.querySelector(`[data-shelf-row="${shelf}"]`);
  const countEl = document.querySelector(`[data-shelf-count="${shelf}"]`);
  if (!row) return;

  const shelfDef = SHELVES.find(s => s.key === shelf);
  const visible = filterItems(shelfItems[shelf]);

  const total = shelfTotal[shelf];
  const loaded = shelfItems[shelf].length;
  if (countEl) {
    countEl.textContent = loaded < total ? `${loaded} / ${total}` : String(total);
  }

  let content;
  if (!visible.length) {
    if (shelfItems[shelf].length && closetSearch) {
      content = `<div class="shelf__empty">No ${shelfDef.label.toLowerCase()} games match "${escapeHtml(closetSearch)}".</div>`;
    } else if (!loaded) {
      content = `<div class="shelf__empty">No ${shelfDef.label.toLowerCase()} games yet.</div>`;
    } else {
      content = "";
    }
  } else {
    content = visible.map((it, i) => bookSpineHTML(it, i)).join("");
  }

  row.innerHTML = `
    ${content}
    ${shelfHasMore[shelf] ? '<div class="shelf__sentinel" data-sentinel="' + shelf + '"></div>' : ""}
    <div class="shelf__base"></div>
  `;

  if (_shelfObservers[shelf]) {
    _shelfObservers[shelf].disconnect();
    _shelfObservers[shelf] = null;
  }
  if (shelfHasMore[shelf]) {
    const sentinel = row.querySelector(`[data-sentinel="${shelf}"]`);
    if (sentinel) {
      _shelfObservers[shelf] = new IntersectionObserver(async (entries) => {
        if (!entries[0].isIntersecting) return;
        if (shelfLoading[shelf] || !shelfHasMore[shelf]) return;
        await loadShelfPage(shelf, shelfPage[shelf] + 1);
        renderShelfRow(shelf);
        lucide.createIcons();
        attachShelfGestures(shelf);
      }, { root: row, rootMargin: "0px 300px 0px 0px" });
      _shelfObservers[shelf].observe(sentinel);
    }
  }
  attachShelfGestures(shelf);
}

function bookSpineHTML(item, i) {
  const g = item.game;
  const color = g.theme_color || colorFromName(g.name);
  const thumb = g.thumbnail_url || "";
  const plays = item.play_count || 0;
  return `
    <button type="button"
            class="book-spine animate-fadeUp"
            style="--book-color:${color}; --i:${i};"
            data-game-id="${g.id}"
            data-game-name="${escapeAttr(g.name)}"
            title="${escapeAttr(g.name)}">
      ${thumb ? `<div class="book-spine__art" style="background-image:url('${thumb}')"></div>` : '<div class="book-spine__art book-spine__art--blank"></div>'}
      <div class="book-spine__title">${escapeHtml(g.name)}</div>
      ${plays > 0 ? `<div class="book-spine__plays">${plays}×</div>` : ""}
    </button>`;
}

// ── List view (owned + played only) ──────────────────────────────────────────

function renderList() {
  const container = document.getElementById("closet-list");
  const hasAny = shelfTotal.owned > 0 || shelfTotal.played > 0;

  if (!hasAny) {
    container.innerHTML = emptyCollectionHTML();
    return;
  }

  container.innerHTML = SHELVES.map(shelf => {
    const rows = filterItems(shelfItems[shelf.key]);
    const total = shelfTotal[shelf.key];
    const loaded = shelfItems[shelf.key].length;
    const countLabel = loaded < total ? `${loaded} / ${total}` : String(total);
    if (!total) return "";
    return `
      <section class="mb-5" data-shelf-list="${shelf.key}">
        <h3 class="text-sm font-semibold uppercase tracking-wide text-base-content/60 mb-2 flex items-center gap-2">
          <i data-lucide="${shelf.icon}" class="w-4 h-4"></i> ${shelf.label}
          <span class="badge badge-sm badge-ghost">${countLabel}</span>
        </h3>
        <div class="grid grid-cols-1 gap-2">
          ${rows.length
            ? rows.map((it, i) => listRowHTML(it, i)).join("")
            : `<div class="text-base-content/50 text-sm italic">No matches in loaded pages.</div>`}
        </div>
        ${shelfHasMore[shelf.key] ? `
          <button class="btn btn-sm btn-ghost w-full mt-2" onclick="loadMoreList('${shelf.key}')">
            <i data-lucide="chevron-down" class="w-4 h-4"></i> Load more
          </button>` : ""}
      </section>`;
  }).join("") || `<div class="text-center py-8 text-base-content/50">No games match "${escapeHtml(closetSearch)}"</div>`;
}

async function loadMoreList(shelf) {
  await loadShelfPage(shelf, shelfPage[shelf] + 1);
  renderList();
  lucide.createIcons();
  attachAllListSwipes();
}

function listRowHTML(item, i) {
  const g = item.game;
  const lastPlayed = item.last_played_at ? `Last played ${formatDate(item.last_played_at)}` : "Never played";
  const plays = item.play_count || 0;
  return `
    <div class="swipe-wrap animate-fadeUp" style="--i:${i}"
         data-game-id="${g.id}" data-game-name="${escapeAttr(g.name)}">
      <div class="swipe-hint swipe-hint--log">
        <i data-lucide="plus" class="w-5 h-5"></i><span>Log Play</span>
      </div>
      <div class="swipe-hint swipe-hint--guide">
        <i data-lucide="book-open" class="w-5 h-5"></i><span>Guide</span>
      </div>
      <div class="card card-side bg-base-200 h-20 cursor-pointer hover:shadow-md transition-all">
        <figure class="w-16 flex-shrink-0">
          <img src="${bggImg(g.thumbnail_url) || IMG_PLACEHOLDER}" onerror="this.onerror=null;this.src=IMG_PLACEHOLDER" alt="${escapeAttr(g.name)}" class="w-full h-full object-cover" loading="lazy" />
        </figure>
        <div class="card-body p-2 justify-center">
          <h3 class="font-semibold text-sm leading-tight line-clamp-1">${escapeHtml(g.name)}</h3>
          <div class="flex items-center gap-2 text-xs text-base-content/60">
            <span>${lastPlayed}</span>
            ${plays > 0 ? `<span><i data-lucide="dice-5" class="w-3 h-3"></i> ${plays}×</span>` : ""}
            ${g.bgg_rating ? `<span>★ ${formatRating(g.bgg_rating)}</span>` : ""}
          </div>
        </div>
      </div>
    </div>`;
}

// ── Wishlist view (flat list) ─────────────────────────────────────────────────

function renderWishlist() {
  const container = document.getElementById("closet-wishlist");
  const wishlist = wishlistItems;

  if (!wishlist.length) {
    container.innerHTML = `
      <div class="text-center py-12 text-base-content/60">
        <i data-lucide="star" class="w-12 h-12 mb-3 opacity-50"></i>
        <p class="mb-4">Your wishlist is empty.</p>
        <button class="btn btn-primary btn-sm" onclick="showView('browse'); loadGames();">
          <i data-lucide="search" class="w-4 h-4"></i> Browse Games
        </button>
      </div>`;
    lucide.createIcons();
    return;
  }

  const sorted = wishlist.slice().sort((a, b) => (a.game?.name || "").localeCompare(b.game?.name || ""));
  container.innerHTML = `
    <div class="space-y-2">
      ${sorted.map((item, i) => wishlistRowHTML(item, i)).join("")}
    </div>`;
  lucide.createIcons();
}

function wishlistRowHTML(item, i) {
  const g = item.game;
  return `
    <div class="card card-side bg-base-200 h-20 animate-fadeUp" style="--i:${i}">
      <figure class="w-16 flex-shrink-0 cursor-pointer" onclick="openGameDetail('${g.id}')">
        <img src="${bggImg(g.thumbnail_url) || IMG_PLACEHOLDER}" onerror="this.onerror=null;this.src=IMG_PLACEHOLDER" alt="${escapeAttr(g.name)}" class="w-full h-full object-cover" loading="lazy" />
      </figure>
      <div class="card-body p-2 justify-center cursor-pointer" onclick="openGameDetail('${g.id}')">
        <h3 class="font-semibold text-sm leading-tight line-clamp-2">${escapeHtml(g.name)}</h3>
        ${g.bgg_rating ? `<div class="text-xs text-base-content/60">★ ${formatRating(g.bgg_rating)}</div>` : ""}
      </div>
      <div class="flex items-center pr-3 flex-shrink-0">
        <button class="btn btn-sm btn-primary" onclick="moveWishlistToOwned('${g.id}')">
          <i data-lucide="package" class="w-4 h-4"></i> Own It
        </button>
      </div>
    </div>`;
}

async function moveWishlistToOwned(gameId) {
  try {
    await apiFetch(`/collection/${gameId}`, {
      method: "PATCH",
      body: { status: "owned" },
    });
    showToast("Added to collection!", "success");
    closetTab = "collection";
    await loadCloset();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ── Empty states ──────────────────────────────────────────────────────────────

function emptyCollectionHTML() {
  return `
    <div class="text-center py-12 text-base-content/60">
      <i data-lucide="library-big" class="w-12 h-12 mb-3 opacity-50"></i>
      <p class="mb-4">Your collection is empty.</p>
      <button class="btn btn-primary btn-sm" onclick="showView('browse'); loadGames();">
        <i data-lucide="search" class="w-4 h-4"></i> Browse games to add
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
  setTimeout(() => { if (el.classList.contains("pulling")) done(); }, 600);
}

// ── Navigate to game detail scrolled to the guide section ────────────────────

function openGameGuide(gameId) {
  window._pendingScrollToGuide = true;
  openGameDetail(gameId);
}

// ── Book spine gesture: pull up → log play, pull down → guide ────────────────

function createBookGhost(el, rect) {
  const g = el.cloneNode(true);
  g.classList.remove("animate-fadeUp", "pulling");
  Object.assign(g.style, {
    position: "fixed",
    top: rect.top + "px",
    left: rect.left + "px",
    width: rect.width + "px",
    height: rect.height + "px",
    zIndex: "100",
    pointerEvents: "none",
    margin: "0",
    transition: "none",
    boxShadow: "0 12px 30px rgba(0,0,0,0.6)",
  });
  document.body.appendChild(g);
  return g;
}

function attachBookGesture(el, gameId, gameName) {
  let startX, startY, axis = null, ghost = null, origRect, active = false;

  el.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    startX = e.clientX; startY = e.clientY;
    axis = null; active = true; ghost = null;
  });

  el.addEventListener("pointermove", (e) => {
    if (!active) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!axis) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx) + 4) {
        axis = "v";
        el.setPointerCapture(e.pointerId);
        origRect = el.getBoundingClientRect();
        ghost = createBookGhost(el, origRect);
        el.style.opacity = "0.3";
      } else if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) + 4) {
        axis = "h"; active = false;
      }
      return;
    }
    if (axis === "v" && ghost) {
      ghost.style.top = (origRect.top + dy) + "px";
      ghost.style.boxShadow = dy < -40
        ? "0 0 22px rgba(201,146,42,0.8), 0 4px 20px rgba(0,0,0,0.5)"
        : dy > 40
        ? "0 0 22px rgba(100,160,255,0.5), 0 4px 20px rgba(0,0,0,0.5)"
        : "0 12px 30px rgba(0,0,0,0.6)";
    }
  });

  el.addEventListener("pointerup", (e) => {
    if (!active) return;
    active = false;
    const dy = e.clientY - startY;
    if (axis === "h") { axis = null; return; }
    el.style.opacity = "";
    if (ghost) {
      if (dy < -50) {
        Object.assign(ghost.style, {
          transition: "transform 300ms ease-in, opacity 280ms ease-in",
          transform: "translateY(-180px) rotate(8deg)",
          opacity: "0",
        });
        setTimeout(() => { ghost.remove(); startLogPlay(gameId, gameName); }, 280);
      } else if (dy > 50) {
        Object.assign(ghost.style, {
          transition: "transform 340ms ease-in, opacity 280ms ease-in",
          transform: "translateY(160px) rotate(-10deg)",
          opacity: "0",
        });
        setTimeout(() => { ghost.remove(); openGameGuide(gameId); }, 300);
      } else {
        Object.assign(ghost.style, {
          transition: "top 180ms ease, opacity 180ms",
          top: origRect.top + "px",
          opacity: "1",
        });
        setTimeout(() => ghost.remove(), 180);
        if (!axis && Math.abs(dy) < 8) onBookClick(gameId, el);
      }
      ghost = null;
    } else {
      onBookClick(gameId, el);
    }
    axis = null;
  });

  el.addEventListener("pointercancel", () => {
    active = false; axis = null;
    el.style.opacity = "";
    if (ghost) { ghost.remove(); ghost = null; }
  });
}

function attachShelfGestures(shelfKey) {
  const row = document.querySelector(`[data-shelf-row="${shelfKey}"]`);
  if (!row) return;
  row.querySelectorAll(".book-spine[data-game-id]").forEach(el => {
    attachBookGesture(el, el.dataset.gameId, el.dataset.gameName);
  });
}

// ── List card swipe: right → log play, left → guide ──────────────────────────

function attachListSwipe(wrapEl) {
  const card = wrapEl.querySelector(".card");
  const gameId = wrapEl.dataset.gameId;
  const gameName = wrapEl.dataset.gameName;
  let startX = null, isDragging = false;

  wrapEl.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    startX = e.clientX; isDragging = false;
  });

  wrapEl.addEventListener("pointermove", (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    if (!isDragging && Math.abs(dx) > 8) {
      isDragging = true;
      wrapEl.setPointerCapture(e.pointerId);
    }
    if (isDragging) {
      const clamped = Math.sign(dx) * Math.min(Math.abs(dx), 110);
      card.style.cssText = `transform: translateX(${clamped}px); transition: none;`;
    }
  });

  wrapEl.addEventListener("pointerup", (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (!isDragging) { openGameDetail(gameId); return; }
    isDragging = false;
    card.style.cssText = "transform: translateX(0); transition: transform 200ms ease;";
    if (dx > 70) setTimeout(() => startLogPlay(gameId, gameName), 150);
    else if (dx < -70) setTimeout(() => openGameGuide(gameId), 150);
  });

  wrapEl.addEventListener("pointercancel", () => {
    startX = null; isDragging = false;
    if (card) card.style.cssText = "";
  });
}

function attachAllListSwipes() {
  const listEl = document.getElementById("closet-list");
  if (!listEl) return;
  listEl.querySelectorAll(".swipe-wrap[data-game-id]").forEach(attachListSwipe);
}

// ── Small utilities ──────────────────────────────────────────────────────────

function colorFromName(name) {
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
    // Derived "played" rows are not user-selected collection entries — they
    // only exist so the Played shelf in the closet populates automatically.
    const existing = items.find(
      i => i.game_id === gameId && i.status !== "played"
    );
    const current = existing?.status || null;

    const options = [
      { key: "owned",    label: "Owned",    icon: "package" },
      { key: "wishlist", label: "Wishlist", icon: "star" },
    ];

    container.innerHTML = `
      <div class="collection-toggle join w-full">
        ${options.map(opt => {
          const active = current === opt.key;
          return `
            <button
              class="btn join-item flex-1 ${active ? 'btn-primary collection-toggle__active' : 'btn-outline'}"
              aria-pressed="${active}"
              style="${active ? 'background: var(--game-accent); border-color: var(--game-accent); color: #fff;' : ''}"
              onclick="toggleCollectionStatus('${gameId}', '${opt.key}', ${active ? 'true' : 'false'})">
              <i data-lucide="${opt.icon}" class="w-4 h-4"></i>
              <span>${opt.label}</span>
              ${active ? '<i data-lucide="x" class="w-3 h-3 opacity-70 ml-1"></i>' : ''}
            </button>`;
        }).join("")}
      </div>
      ${current ? '<p class="text-xs text-base-content/50 mt-1 text-center">Tap the active button to remove</p>' : ''}
    `;
    lucide.createIcons();
  } catch {
    container.innerHTML = '<p class="text-sm text-base-content/50">Log in to add to collection</p>';
  }
}

async function toggleCollectionStatus(gameId, status, isActive) {
  if (isActive) {
    await removeFromCollection(gameId);
    return;
  }
  // Use POST (upsert) so it works whether or not there's an existing row.
  await addToCollection(gameId, status);
}
