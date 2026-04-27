// games.js — Browse game library, search, filter

async function loadGames() {
  const container = document.getElementById("games-grid");
  container.innerHTML = '<div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>';

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
    if (gamesFilterOwnedOnly && currentUser) params.set("owned_only", "true");

    const data = await apiFetch(`/games?${params}`);
    gamesCache = data.games;
    gamesTotalCount = data.total;
    renderGamesGrid();
  } catch (err) {
    container.innerHTML = `<div class="text-error text-center py-8">Failed to load games: ${err.message}</div>`;
  }
}

function renderGamesGrid() {
  const container = document.getElementById("games-grid");
  const totalPages = Math.ceil(gamesTotalCount / gamesPerPage);

  if (!gamesCache.length) {
    container.innerHTML = `
      <div class="text-center py-12 text-base-content/50">
        <i data-lucide="search-x" class="w-12 h-12 mb-4 opacity-50"></i>
        <p>No games found. Try a different search or filter.</p>
      </div>`;
    lucide.createIcons();
    return;
  }

  container.innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
      ${gamesCache.map((g, i) => `
        <div class="card bg-base-200 cursor-pointer hover:shadow-lg transition-all duration-200 animate-fadeUp"
             style="--i:${i}" onclick="openGameDetail('${g.id}')">
          <figure class="px-3 pt-3">
            <img src="${bggImg(g.thumbnail_url) || IMG_PLACEHOLDER}"
                 onerror="this.onerror=null;this.src=IMG_PLACEHOLDER"
                 alt="${g.name}" class="rounded-lg w-full h-32 object-cover bg-base-300" loading="lazy" />
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
  loadGames();
}

function clearGameSearch() {
  gamesSearch = "";
  document.getElementById("game-search-input").value = "";
  gamesPage = 1;
  loadGames();
}

function changePage(delta) {
  gamesPage += delta;
  if (gamesPage < 1) gamesPage = 1;
  loadGames();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── Browse filter strip ───────────────────────────────────────────────────────

const PLAYER_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

const PLAYTIME_CHIPS = [
  { label: "≤30 min",   min: null, max: 30  },
  { label: "31–60 min", min: 31,   max: 60  },
  { label: "61–120 min",min: 61,   max: 120 },
  { label: "120+ min",  min: 121,  max: null },
];

async function initBrowseFilters() {
  if (mechanicsOptions.length > 0) {
    renderFilterStrip();
    _ensureBrowseDropdownCloser();
    return;
  }
  try {
    mechanicsOptions = await apiFetch("/games/mechanics");
  } catch { mechanicsOptions = []; }
  renderFilterStrip();
  _ensureBrowseDropdownCloser();
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

function renderFilterStrip() {
  const el = document.getElementById("browse-filters");
  if (!el) return;

  const hasActiveFilter = gamesFilterPlayers !== null
    || gamesFilterPlaytimeMin !== null
    || gamesFilterPlaytimeMax !== null
    || gamesFilterMechanics.length > 0
    || gamesFilterOwnedOnly;

  const mechanicsCount = gamesFilterMechanics.length;

  // Source toggle: only meaningful when signed in (the API ignores owned_only
  // for anon callers anyway, but hiding it avoids a misleading UI).
  const sourceToggle = currentUser ? `
      <div class="flex items-center gap-1.5 flex-wrap">
        <span class="text-xs text-base-content/50 mr-1">Show</span>
        <div class="join">
          <button class="btn btn-xs join-item ${gamesFilterOwnedOnly ? 'btn-outline' : 'btn-primary'}"
                  onclick="setOwnedOnlyFilter(false)">All games</button>
          <button class="btn btn-xs join-item ${gamesFilterOwnedOnly ? 'btn-primary' : 'btn-outline'}"
                  onclick="setOwnedOnlyFilter(true)">Owned only</button>
        </div>
      </div>` : "";

  el.innerHTML = `
    <div class="space-y-2">

      ${sourceToggle}

      <!-- Players row -->
      <div class="flex items-center gap-1.5 flex-wrap">
        <span class="text-xs text-base-content/50 mr-1">Players</span>
        <select class="select select-bordered select-xs"
                onchange="setPlayersFilter(this.value)">
          <option value="" ${gamesFilterPlayers === null ? 'selected' : ''}>Any</option>
          ${PLAYER_OPTIONS.map(n => `
            <option value="${n}" ${gamesFilterPlayers === n ? 'selected' : ''}>${n === 8 ? '8+' : n}</option>
          `).join("")}
        </select>
      </div>

      <!-- Playtime row -->
      <div class="flex items-center gap-1.5 flex-wrap">
        <span class="text-xs text-base-content/50 mr-1">Length</span>
        ${PLAYTIME_CHIPS.map((c, i) => {
          const active = gamesFilterPlaytimeMin === c.min && gamesFilterPlaytimeMax === c.max;
          return `
            <button class="btn btn-xs ${active ? 'btn-primary' : 'btn-outline'}"
                    onclick="togglePlaytimeFilter(${i})">
              ${c.label}
            </button>`;
        }).join("")}
      </div>

      <!-- Mechanics dropdown -->
      ${mechanicsOptions.length ? `
        <div class="flex items-center gap-1.5 flex-wrap">
          <span class="text-xs text-base-content/50 mr-1">Mechanics</span>
          <div class="relative" id="mechanics-dropdown">
            <button class="btn btn-xs ${mechanicsCount ? 'btn-primary' : 'btn-outline'} gap-1"
                    onclick="event.stopPropagation(); _toggleMechanicsPanel()">
              <span>Mechanics</span>
              <span id="mechanics-badge" class="badge badge-xs ${mechanicsCount ? '' : 'hidden'}">${mechanicsCount}</span>
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
      ${hasActiveFilter ? `
        <div>
          <button class="btn btn-ghost btn-xs text-base-content/50" onclick="clearBrowseFilters()">
            ✕ Clear filters
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
  loadGames();
}

function clearBrowseFilters() {
  gamesFilterPlayers = null;
  gamesFilterPlaytimeMin = null;
  gamesFilterPlaytimeMax = null;
  gamesFilterMechanics = [];
  gamesFilterOwnedOnly = false;
  gamesPage = 1;
  renderFilterStrip();
  loadGames();
}

function setOwnedOnlyFilter(value) {
  if (gamesFilterOwnedOnly === value) return;
  gamesFilterOwnedOnly = value;
  gamesPage = 1;
  renderFilterStrip();
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

async function searchBGG() {
  const query = document.getElementById("bgg-search-input").value.trim();
  if (query.length < 2) return;

  const container = document.getElementById("bgg-results");
  container.innerHTML = '<span class="loading loading-spinner loading-sm"></span>';

  try {
    bggSearchResults = await apiFetch(`/games/search-bgg?query=${encodeURIComponent(query)}`);
    renderBggResults();
  } catch (err) {
    container.innerHTML = `<p class="text-error text-sm">${err.message}</p>`;
  }
}

function renderBggResults() {
  const container = document.getElementById("bgg-results");
  if (!bggSearchResults.length) {
    container.innerHTML = '<p class="text-base-content/50 text-sm">No results from BoardGameGeek.</p>';
    return;
  }
  container.innerHTML = bggSearchResults.map(r => `
    <div class="flex items-center justify-between py-2 border-b border-base-300">
      <div class="min-w-0">
        <a href="${r.bgg_url}" target="_blank" rel="noopener"
           class="font-medium text-sm link link-hover inline-flex items-center gap-1">
          ${r.name}
          <i data-lucide="external-link" class="w-3 h-3 opacity-60"></i>
        </a>
        ${r.year_published ? `<span class="text-xs text-base-content/50 ml-1">(${r.year_published})</span>` : ""}
      </div>
      ${r.already_in_db
        ? '<span class="badge badge-sm badge-success">In library</span>'
        : `<button class="btn btn-xs btn-primary" onclick="importBggGame(${r.bgg_id})">Add</button>`
      }
    </div>
  `).join("");
  lucide.createIcons();
}

async function importBggGame(bggId) {
  try {
    const game = await apiFetch(`/games/import-bgg/${bggId}`, { method: "POST" });
    showToast(`${game.name} added to library!`, "success");
    // Refresh BGG results to show "In library"
    const existing = bggSearchResults.find(r => r.bgg_id === bggId);
    if (existing) existing.already_in_db = true;
    renderBggResults();
  } catch (err) {
    showToast(err.message, "error");
  }
}
