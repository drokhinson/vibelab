// games.js — Browse game library, search, filter

async function loadGames() {
  const container = document.getElementById("games-grid");
  container.innerHTML = `<div class="flex justify-center py-12">${buddyLoader('lg')}</div>`;

  try {
    const params = new URLSearchParams({
      page: gamesPage,
      per_page: gamesPerPage,
    });
    if (gamesSearch) params.set("search", gamesSearch);
    if (gamesFilterPlayers !== null) params.set("players", gamesFilterPlayers);
    if (gamesFilterPlaytimeMin !== null) params.set("playtime_min", gamesFilterPlaytimeMin);
    if (gamesFilterPlaytimeMax !== null) params.set("playtime_max", gamesFilterPlaytimeMax);
    gamesFilterMechanics.forEach(m => params.append("mechanics", m));
    if (gamesFilterPlayMode) params.set("play_mode", gamesFilterPlayMode);
    if (gamesFilterOwnedOnly && currentUser) params.set("owned_only", "true");

    const [data] = await Promise.all([
      apiFetch(`/games?${params}`),
      refreshUserCollectionStatus(),
    ]);
    gamesCache = data.games;
    gamesTotalCount = data.total;
    renderGamesGrid();
  } catch (err) {
    container.innerHTML = `<div class="text-error text-center py-8">Failed to load games: ${err.message}</div>`;
  }
}

async function refreshUserCollectionStatus() {
  if (!currentUser) {
    userCollectionStatus = {};
    return;
  }
  try {
    const items = await apiFetch("/collection");
    const next = {};
    for (const it of items) {
      if (it.status === "owned" || it.status === "wishlist") {
        next[it.game_id] = it.status;
      }
    }
    userCollectionStatus = next;
  } catch {
    // Leave the previous map in place on transient failures.
  }
}

function browseBookmarkHtml(gameId) {
  if (!currentUser) return "";
  const status = userCollectionStatus[gameId] || null;
  const icon = status === "owned" ? "package"
             : status === "wishlist" ? "star"
             : "bookmark-plus";
  const iconClass = status ? "w-4 h-4 text-primary" : "w-4 h-4";
  const items = [
    { key: "owned",    label: "Owned",    icon: "package" },
    { key: "wishlist", label: "Wishlist", icon: "star" },
  ];
  return `
    <div class="dropdown dropdown-end dropdown-top absolute bottom-1 right-4"
         data-browse-bookmark="${gameId}"
         onclick="event.stopPropagation()">
      <button tabindex="0" class="btn btn-circle btn-ghost btn-sm bg-base-100/80 shadow"
              aria-label="${status ? `In ${status}` : "Add to collection"}">
        <i data-lucide="${icon}" class="${iconClass}"></i>
      </button>
      <ul tabindex="0" class="dropdown-content menu bg-base-200 rounded-box z-30 w-40 p-2 shadow">
        ${items.map(opt => {
          const active = status === opt.key;
          return `
            <li>
              <a class="${active ? "active" : ""}"
                 onclick="quickSetCollection('${gameId}', '${opt.key}')">
                <i data-lucide="${opt.icon}" class="w-4 h-4"></i>
                <span class="flex-1">${opt.label}</span>
                ${active ? '<i data-lucide="check" class="w-4 h-4"></i>' : ""}
              </a>
            </li>`;
        }).join("")}
        <li class="${status ? "" : "menu-disabled"}">
          <a ${status ? `onclick="quickSetCollection('${gameId}', null)"` : ""}>
            <i data-lucide="x" class="w-4 h-4"></i>
            <span>Remove</span>
          </a>
        </li>
      </ul>
    </div>`;
}

async function quickSetCollection(gameId, status) {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const current = userCollectionStatus[gameId] || null;
  try {
    if (status === null || status === current) {
      await apiFetch(`/collection/${gameId}`, { method: "DELETE" });
      delete userCollectionStatus[gameId];
      showToast("Removed from collection", "info");
    } else if (current) {
      await apiFetch(`/collection/${gameId}`, { method: "PATCH", body: { status } });
      userCollectionStatus[gameId] = status;
      showToast(`Moved to ${status}`, "success");
    } else {
      await apiFetch("/collection", { method: "POST", body: { game_id: gameId, status } });
      userCollectionStatus[gameId] = status;
      showToast(`Added to ${status}!`, "success");
    }
    refreshBrowseBookmark(gameId);
  } catch (err) {
    showToast(err.message, "error");
  }
}

function refreshBrowseBookmark(gameId) {
  const wrapper = document.querySelector(`[data-browse-bookmark="${gameId}"]`);
  if (!wrapper) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = browseBookmarkHtml(gameId).trim();
  const replacement = tmp.firstElementChild;
  if (replacement) {
    wrapper.replaceWith(replacement);
    if (window.lucide) window.lucide.createIcons();
  }
}

function renderGamesGrid() {
  const container = document.getElementById("games-grid");
  const totalPages = Math.ceil(gamesTotalCount / gamesPerPage);

  if (!gamesCache.length) {
    const importLink = gamesSearch
      ? `<a class="link link-primary font-medium" href="#"
            onclick="event.preventDefault(); prefillImportSearch(decodeURIComponent('${encodeURIComponent(gamesSearch)}'))">
           Search &amp; import via BoardGameGeek →
         </a>`
      : "";
    container.innerHTML = `
      <div class="text-center py-12 text-base-content/50">
        <i data-lucide="search-x" class="w-12 h-12 mb-4 opacity-50 mx-auto"></i>
        <p class="font-semibold mb-1">No matches found in the BoardgameBuddy database.</p>
        ${gamesSearch ? `<p class="text-sm">Continue to search and import the game via BoardGameGeek?</p>
        <p class="mt-2">${importLink}</p>` : "<p class=\"text-sm\">Try a different search or filter.</p>"}
      </div>`;
    lucide.createIcons();
    return;
  }

  container.innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
      ${gamesCache.map((g, i) => `
        <div class="card bg-base-200 cursor-pointer hover:shadow-lg transition-all duration-200 animate-fadeUp"
             style="--i:${i}" onclick="openGameDetail('${g.id}')">
          <figure class="relative px-3 pt-3 overflow-visible">
            <img src="${bggImg(g.thumbnail_url) || IMG_PLACEHOLDER}"
                 onerror="this.onerror=null;this.src=IMG_PLACEHOLDER"
                 alt="${g.name}" class="rounded-lg w-full h-32 object-cover bg-base-300" loading="lazy" />
            ${browseBookmarkHtml(g.id)}
          </figure>
          <div class="card-body p-3 pt-2">
            <h3 class="font-semibold text-sm leading-tight line-clamp-2">${g.name}</h3>
            <div class="text-xs text-base-content/60 mt-1">
              ${playerRange(g.min_players, g.max_players)}
              ${g.playing_time ? ` · ${formatTime(g.playing_time)}` : ""}
            </div>
          </div>
        </div>
      `).join("")}
    </div>

    ${totalPages > 1 ? `
      <div class="flex justify-center gap-2 mt-6">
        <button class="btn btn-sm ${gamesPage <= 1 ? 'btn-disabled' : ''}" onclick="changePage(-1)">
          <i data-lucide="chevron-left" class="w-4 h-4"></i> Prev
        </button>
        <span class="btn btn-sm btn-ghost no-animation">${gamesPage} / ${totalPages}</span>
        <button class="btn btn-sm ${gamesPage >= totalPages ? 'btn-disabled' : ''}" onclick="changePage(1)">
          Next <i data-lucide="chevron-right" class="w-4 h-4"></i>
        </button>
      </div>
    ` : ""}
  `;
  lucide.createIcons();
}

function handleGameSearch(e) {
  e.preventDefault();
  gamesSearch = document.getElementById("game-search-input").value.trim();
  gamesPage = 1;
  syncSearchClearBtn("game-search-input", "game-search-clear");
  loadGames();
}

function clearGameSearch() {
  gamesSearch = "";
  document.getElementById("game-search-input").value = "";
  syncSearchClearBtn("game-search-input", "game-search-clear");
  gamesPage = 1;
  loadGames();
}

/** Show/hide the X button inside a search input based on whether it has text. */
function syncSearchClearBtn(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input || !btn) return;
  btn.classList.toggle("hidden", !input.value.trim());
}

function changePage(delta) {
  gamesPage += delta;
  if (gamesPage < 1) gamesPage = 1;
  loadGames();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── Browse filter panel (collapsible) ──────────────────────────────────────

const PLAYER_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

const PLAYTIME_CHIPS = [
  { label: "≤30 min",   min: null, max: 30  },
  { label: "31–60 min", min: 31,   max: 60  },
  { label: "61–120 min",min: 61,   max: 120 },
  { label: "120+ min",  min: 121,  max: null },
];

function hasBrowseActiveFilter() {
  return gamesFilterPlayers !== null
    || gamesFilterPlaytimeMin !== null
    || gamesFilterPlaytimeMax !== null
    || gamesFilterMechanics.length > 0
    || gamesFilterPlayMode !== null;
}

const PLAY_MODE_OPTIONS = [
  { value: "competitive", label: "Competitive" },
  { value: "coop",        label: "Co-op" },
  { value: "team",        label: "Teams" },
];

async function initBrowseFilters() {
  if (mechanicsOptions.length === 0) {
    try { mechanicsOptions = await apiFetch("/games/mechanics"); } catch { mechanicsOptions = []; }
  }
  renderFilterStrip();
  renderBrowseActiveFilterBar();
  _ensureBrowseDropdownCloser();
}

function toggleBrowseFilters() {
  browseFiltersOpen = !browseFiltersOpen;
  const el = document.getElementById("browse-filters");
  const btn = document.getElementById("browse-filter-toggle");
  if (el) el.classList.toggle("hidden", !browseFiltersOpen);
  if (btn) btn.classList.toggle("btn-primary", browseFiltersOpen);
  if (browseFiltersOpen) renderFilterStrip();
}

let _browseDropdownCloserAttached = false;
function _ensureBrowseDropdownCloser() {
  if (_browseDropdownCloserAttached) return;
  document.addEventListener("click", _closeBrowseDropdowns);
  _browseDropdownCloserAttached = true;
}

function _closeBrowseDropdowns(e) {
  if (!e.target.closest("#mechanics-dropdown")) {
    document.getElementById("mechanics-panel")?.classList.add("hidden");
  }
}

function renderBrowseActiveFilterBar() {
  const bar = document.getElementById("browse-active-filter-bar");
  if (!bar) return;
  if (!hasBrowseActiveFilter()) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  bar.classList.remove("hidden");
  bar.innerHTML = `
    <div class="flex items-center gap-1 flex-wrap">
      <span class="text-xs text-base-content/50">Filtered:</span>
      ${browseFilterPills()}
      <button class="btn btn-ghost btn-xs text-error" onclick="clearBrowseFilters()">
        <i data-lucide="x" class="w-3 h-3"></i> Clear all
      </button>
    </div>`;
  if (window.lucide) window.lucide.createIcons();
}

function browseFilterPills() {
  const pills = [];
  if (gamesFilterPlayers !== null) pills.push(`<span class="badge badge-sm badge-outline">${gamesFilterPlayers === 8 ? '8+' : gamesFilterPlayers}P</span>`);
  if (gamesFilterPlaytimeMin !== null || gamesFilterPlaytimeMax !== null) {
    const chip = PLAYTIME_CHIPS.find(c => c.min === gamesFilterPlaytimeMin && c.max === gamesFilterPlaytimeMax);
    if (chip) pills.push(`<span class="badge badge-sm badge-outline">${chip.label}</span>`);
  }
  gamesFilterMechanics.forEach(m => pills.push(`<span class="badge badge-sm badge-outline">${escapeHtml(m)}</span>`));
  if (gamesFilterPlayMode) {
    const opt = PLAY_MODE_OPTIONS.find(o => o.value === gamesFilterPlayMode);
    if (opt) pills.push(`<span class="badge badge-sm badge-outline">${opt.label}</span>`);
  }
  return pills.join("");
}

function renderFilterStrip() {
  const el = document.getElementById("browse-filters");
  if (!el) return;

  const mechanicsCount = gamesFilterMechanics.length;

  el.innerHTML = `
    <div class="bgb-filter-panel space-y-2">

      <!-- Players row -->
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs text-base-content/50 mr-1">Players</span>
        <select class="select select-bordered select-sm"
                onchange="setPlayersFilter(this.value)">
          <option value="" ${gamesFilterPlayers === null ? 'selected' : ''}>Any</option>
          ${PLAYER_OPTIONS.map(n => `
            <option value="${n}" ${gamesFilterPlayers === n ? 'selected' : ''}>${n === 8 ? '8+' : n}</option>
          `).join("")}
        </select>
      </div>

      <!-- Playtime row -->
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs text-base-content/50 mr-1">Length</span>
        ${PLAYTIME_CHIPS.map((c, i) => {
          const active = gamesFilterPlaytimeMin === c.min && gamesFilterPlaytimeMax === c.max;
          return `
            <button class="btn btn-sm ${active ? 'btn-primary' : 'btn-outline'}"
                    onclick="togglePlaytimeFilter(${i})">
              ${c.label}
            </button>`;
        }).join("")}
      </div>

      <!-- Play-mode row (competitive / coop / team) -->
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs text-base-content/50 mr-1">Mode</span>
        ${PLAY_MODE_OPTIONS.map(opt => {
          const active = gamesFilterPlayMode === opt.value;
          return `
            <button class="btn btn-sm ${active ? 'btn-primary' : 'btn-outline'}"
                    onclick="setPlayModeFilter('${opt.value}')">
              ${opt.label}
            </button>`;
        }).join("")}
      </div>

      <!-- Mechanics dropdown -->
      ${mechanicsOptions.length ? `
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-xs text-base-content/50 mr-1">Mechanics</span>
          <div class="relative" id="mechanics-dropdown">
            <button class="btn btn-sm ${mechanicsCount ? 'btn-primary' : 'btn-outline'} gap-1"
                    onclick="event.stopPropagation(); _toggleMechanicsPanel()">
              <span>Mechanics</span>
              <span id="mechanics-badge" class="badge badge-sm ${mechanicsCount ? '' : 'hidden'}">${mechanicsCount}</span>
              <i data-lucide="chevron-down" class="w-3 h-3 opacity-60"></i>
            </button>
            <div id="mechanics-panel" class="hidden absolute z-50 left-0 mt-1 w-72 bg-base-100 border border-base-300 rounded-box shadow-xl p-2">
              <input type="text" class="input input-sm input-bordered w-full mb-2"
                     placeholder="Search mechanics..."
                     oninput="_filterMechanicsList(this)"
                     onclick="event.stopPropagation()" />
              <ul id="mechanics-list" class="max-h-64 overflow-y-auto space-y-0.5">
                ${_renderMechanicsList()}
              </ul>
            </div>
          </div>
        </div>
      ` : ""}

      <!-- Clear filters -->
      ${hasBrowseActiveFilter() ? `
        <div>
          <button class="btn btn-ghost btn-xs text-base-content/50" onclick="clearBrowseFilters()">
            ✕ Clear all filters
          </button>
        </div>
      ` : ""}
    </div>
  `;
  if (window.lucide) window.lucide.createIcons();
}

function setPlayersFilter(value) {
  gamesFilterPlayers = value === "" || value === null ? null : Number(value);
  gamesPage = 1;
  renderFilterStrip();
  renderBrowseActiveFilterBar();
  loadGames();
}

function togglePlaytimeFilter(index) {
  const c = PLAYTIME_CHIPS[index];
  const already = gamesFilterPlaytimeMin === c.min && gamesFilterPlaytimeMax === c.max;
  if (already) {
    gamesFilterPlaytimeMin = null;
    gamesFilterPlaytimeMax = null;
  } else {
    gamesFilterPlaytimeMin = c.min;
    gamesFilterPlaytimeMax = c.max;
  }
  gamesPage = 1;
  renderFilterStrip();
  renderBrowseActiveFilterBar();
  loadGames();
}

function toggleMechanicFilter(mechanic) {
  const idx = gamesFilterMechanics.indexOf(mechanic);
  if (idx === -1) {
    gamesFilterMechanics = [...gamesFilterMechanics, mechanic];
  } else {
    gamesFilterMechanics = gamesFilterMechanics.filter(m => m !== mechanic);
  }
  gamesPage = 1;
  _rerenderMechanicsPanelInPlace();
  renderBrowseActiveFilterBar();
  loadGames();
}

function clearBrowseFilters() {
  gamesFilterPlayers = null;
  gamesFilterPlaytimeMin = null;
  gamesFilterPlaytimeMax = null;
  gamesFilterMechanics = [];
  gamesFilterPlayMode = null;
  gamesPage = 1;
  renderFilterStrip();
  renderBrowseActiveFilterBar();
  loadGames();
}

function setPlayModeFilter(value) {
  // Click the active mode again → clear back to "any".
  gamesFilterPlayMode = (gamesFilterPlayMode === value) ? null : value;
  gamesPage = 1;
  renderFilterStrip();
  renderBrowseActiveFilterBar();
  loadGames();
}

// ── Mechanics dropdown helpers ────────────────────────────────────────────────

function _renderMechanicsList() {
  // Checked items first (in selection order); then the rest, alphabetically.
  const checked = gamesFilterMechanics.filter(m => mechanicsOptions.includes(m));
  const rest = mechanicsOptions
    .filter(m => !gamesFilterMechanics.includes(m))
    .slice()
    .sort((a, b) => a.localeCompare(b));
  const ordered = [...checked, ...rest];
  return ordered.map(m => {
    const isChecked = gamesFilterMechanics.includes(m);
    return `
      <li class="px-2 py-1.5 rounded cursor-pointer hover:bg-base-200 text-sm flex items-center gap-2"
          data-mechanic="${escapeAttr(m)}"
          onclick="event.stopPropagation(); toggleMechanicFilter(this.dataset.mechanic)">
        <input type="checkbox" class="checkbox checkbox-xs pointer-events-none" ${isChecked ? 'checked' : ''} />
        <span class="flex-1">${escapeHtml(m)}</span>
      </li>`;
  }).join("");
}

function _filterMechanicsList(input) {
  const q = input.value.toLowerCase();
  document.querySelectorAll("#mechanics-list li").forEach(li => {
    const name = (li.dataset.mechanic || "").toLowerCase();
    li.style.display = name.includes(q) ? "" : "none";
  });
}

function _toggleMechanicsPanel() {
  const panel = document.getElementById("mechanics-panel");
  if (!panel) return;
  panel.classList.toggle("hidden");
  if (window.lucide) window.lucide.createIcons();
}

function _rerenderMechanicsPanelInPlace() {
  const list = document.getElementById("mechanics-list");
  const badge = document.getElementById("mechanics-badge");
  const dropdownBtn = document.querySelector("#mechanics-dropdown > button");
  if (list) list.innerHTML = _renderMechanicsList();
  if (badge) {
    const n = gamesFilterMechanics.length;
    badge.textContent = String(n);
    badge.classList.toggle("hidden", n === 0);
  }
  if (dropdownBtn) {
    dropdownBtn.classList.toggle("btn-primary", gamesFilterMechanics.length > 0);
    dropdownBtn.classList.toggle("btn-outline", gamesFilterMechanics.length === 0);
  }
}

// ── BGG Live Search ──────────────────────────────────────────────────────────

// Search-string -> result-name closeness score. Lower is closer:
//   0           exact (case-insensitive)
//   100..       starts with query (penalty grows with extra characters)
//   200..       contains query (penalty by position + length)
//   300         word-boundary match (any token starts with the query)
//   1000        no match (BGG matched on a synonym / description)
function _bggCloseness(name, query) {
  const n = (name || "").toLowerCase().trim();
  const q = (query || "").toLowerCase().trim();
  if (!q) return 0;
  if (n === q) return 0;
  if (n.startsWith(q)) return 100 + (n.length - q.length);
  const idx = n.indexOf(q);
  if (idx >= 0) return 200 + idx + (n.length - q.length) * 0.1;
  const words = n.split(/[^a-z0-9]+/i).filter(Boolean);
  if (words.some(w => w.startsWith(q))) return 300;
  return 1000;
}

// Sort: closest name first, then base games before expansions, then year desc.
function _sortBggResults(results, query) {
  return results.slice().sort((a, b) => {
    const sa = _bggCloseness(a.name, query);
    const sb = _bggCloseness(b.name, query);
    if (sa !== sb) return sa - sb;
    if (!!a.is_expansion !== !!b.is_expansion) return a.is_expansion ? 1 : -1;
    const ya = a.year_published || 0;
    const yb = b.year_published || 0;
    if (ya !== yb) return yb - ya;
    return a.name.localeCompare(b.name);
  });
}

let _bggLastQuery = "";
// Expansions inlined under a base game card after the user taps "Find
// expansions". Keyed by base game's bgg_id; each entry is a list of
// BggSearchResult rows. Cached so re-rendering (e.g. after import) doesn't
// re-fetch from BGG.
const _bggInlineExpansions = new Map();   // bgg_id -> BggSearchResult[]
const _bggExpansionsLoading = new Set();  // bgg_ids currently fetching
const _bggExpansionsOpen = new Set();     // bgg_ids whose expansions panel is expanded

async function searchBGG() {
  const query = document.getElementById("bgg-search-input").value.trim();
  if (query.length < 2) return;

  _bggLastQuery = query;
  // Reset inline expansion state on a fresh query so stale rows don't bleed in.
  _bggInlineExpansions.clear();
  _bggExpansionsLoading.clear();
  _bggExpansionsOpen.clear();

  const container = document.getElementById("bgg-results");
  container.innerHTML = `<div class="flex justify-center py-6">${buddyLoader('md')}</div>`;

  try {
    bggSearchResults = await apiFetch(`/games/search-bgg?query=${encodeURIComponent(query)}`);
    bggSearchResults = _sortBggResults(bggSearchResults, query);
    renderBggResults();
  } catch (err) {
    container.innerHTML = `<p class="text-error text-sm">${escapeHtml(err.message)}</p>`;
  }
}

function _bggCardHTML(r, { indent = false } = {}) {
  const isExp = !!r.is_expansion;
  const showExpansionsBtn = !isExp;
  const open = _bggExpansionsOpen.has(r.bgg_id);
  const indentClass = indent ? "ml-6" : "";
  const expansionsChild = (!isExp && open)
    ? `<div class="mt-2 pl-2 border-l-2 border-base-300 space-y-2">${_renderInlineExpansions(r.bgg_id)}</div>`
    : "";

  return `
    <div class="card bg-base-200 ${indentClass} animate-fadeUp" data-bgg-id="${r.bgg_id}">
      <div class="card-body p-3">
        <div class="flex items-start gap-2">
          <div class="w-9 h-9 rounded bg-base-300 flex items-center justify-center flex-shrink-0">
            <i data-lucide="${isExp ? "puzzle" : "dice-5"}" class="w-4 h-4 ${isExp ? "text-warning" : "opacity-60"}"></i>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <a href="${r.bgg_url}" target="_blank" rel="noopener"
                 class="font-medium text-sm link link-hover inline-flex items-center gap-1"
                 onclick="event.stopPropagation()">
                ${escapeHtml(r.name)}
                <i data-lucide="external-link" class="w-3 h-3 opacity-60"></i>
              </a>
              ${r.year_published ? `<span class="text-xs text-base-content/50">(${r.year_published})</span>` : ""}
              ${isExp ? `<span class="badge badge-warning badge-xs gap-0.5"><i data-lucide="puzzle" class="w-3 h-3"></i>Expansion</span>` : ""}
            </div>
          </div>
          <div class="flex items-center gap-1 flex-shrink-0">
            ${showExpansionsBtn ? `
              <button class="btn btn-ghost btn-xs"
                      onclick="event.stopPropagation(); toggleBggExpansions(${r.bgg_id})"
                      title="${open ? 'Hide expansions' : 'Find expansions'}">
                <i data-lucide="${open ? 'chevron-up' : 'puzzle'}" class="w-3 h-3"></i>
                ${open ? 'Hide' : 'Expansions'}
              </button>` : ""}
            ${r.already_in_db
              ? '<span class="badge badge-sm badge-success">Imported</span>'
              : `<button class="btn btn-xs btn-primary" onclick="event.stopPropagation(); importBggGame(${r.bgg_id})">
                   <i data-lucide="plus" class="w-3 h-3"></i> Add
                 </button>`
            }
          </div>
        </div>
        ${expansionsChild}
      </div>
    </div>`;
}

function _renderInlineExpansions(baseBggId) {
  if (_bggExpansionsLoading.has(baseBggId)) {
    return `<div class="flex justify-center py-3">${buddyLoader('sm')}</div>`;
  }
  const list = _bggInlineExpansions.get(baseBggId) || [];
  if (!list.length) {
    return `<p class="text-xs text-base-content/50 px-2 py-2">No expansions found on BGG.</p>`;
  }
  return list.map(r => _bggCardHTML(r, { indent: true })).join("");
}

function renderBggResults() {
  const container = document.getElementById("bgg-results");
  if (!bggSearchResults.length) {
    container.innerHTML = `
      <div class="text-center py-12 text-base-content/50">
        <i data-lucide="search-x" class="w-10 h-10 mb-3 opacity-50 mx-auto"></i>
        <p>No results from BoardGameGeek.</p>
      </div>`;
    lucide.createIcons();
    return;
  }
  const baseCount = bggSearchResults.filter(r => !r.is_expansion).length;
  const expCount = bggSearchResults.length - baseCount;
  container.innerHTML = `
    <div class="text-xs text-base-content/60 px-1 mt-2 mb-2 flex items-center gap-2">
      <span>${bggSearchResults.length} result${bggSearchResults.length === 1 ? "" : "s"}</span>
      ${baseCount ? `<span>· ${baseCount} game${baseCount === 1 ? "" : "s"}</span>` : ""}
      ${expCount ? `<span>· ${expCount} expansion${expCount === 1 ? "" : "s"}</span>` : ""}
    </div>
    <div class="space-y-2">
      ${bggSearchResults.map(r => _bggCardHTML(r)).join("")}
    </div>`;
  lucide.createIcons();
}

async function toggleBggExpansions(baseBggId) {
  if (_bggExpansionsOpen.has(baseBggId)) {
    _bggExpansionsOpen.delete(baseBggId);
    renderBggResults();
    return;
  }
  _bggExpansionsOpen.add(baseBggId);
  // Serve cached list if present; otherwise fetch.
  if (!_bggInlineExpansions.has(baseBggId)) {
    _bggExpansionsLoading.add(baseBggId);
    renderBggResults();
    try {
      const list = await apiFetch(`/games/bgg/${baseBggId}/expansions`);
      // Sort against the user's current query so "Inns" surfaces Inns &
      // Cathedrals to the top within an Expansions list too.
      _bggInlineExpansions.set(baseBggId, _sortBggResults(list || [], _bggLastQuery));
    } catch (err) {
      _bggInlineExpansions.set(baseBggId, []);
      showToast("Couldn't load expansions: " + err.message, "error");
    } finally {
      _bggExpansionsLoading.delete(baseBggId);
    }
  }
  renderBggResults();
}

async function importBggGame(bggId) {
  try {
    const game = await apiFetch(`/games/import-bgg/${bggId}`, { method: "POST" });
    showToast(`${game.name} imported to BgB!`, "success");
    // Flip the already_in_db flag on the matching row — top-level *or* inline
    // expansion — so the button re-renders as "Imported".
    const flip = list => list?.forEach(r => { if (r.bgg_id === bggId) r.already_in_db = true; });
    flip(bggSearchResults);
    _bggInlineExpansions.forEach(flip);
    renderBggResults();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function prefillImportSearch(query) {
  importTab = "bgg";
  showView("import");
  renderImport();
  const input = document.getElementById("bgg-search-input");
  if (input) input.value = query;
  searchBGG();
}
