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

const PLAYER_CHIPS = [
  { label: "2", value: 2 },
  { label: "3", value: 3 },
  { label: "4", value: 4 },
  { label: "5", value: 5 },
  { label: "6+", value: 6 },
];

const PLAYTIME_CHIPS = [
  { label: "≤30 min",   min: null, max: 30  },
  { label: "31–60 min", min: 31,   max: 60  },
  { label: "61–120 min",min: 61,   max: 120 },
  { label: "120+ min",  min: 121,  max: null },
];

async function initBrowseFilters() {
  if (mechanicsOptions.length > 0) {
    renderFilterStrip();
    return;
  }
  try {
    mechanicsOptions = await apiFetch("/games/mechanics");
  } catch { mechanicsOptions = []; }
  renderFilterStrip();
}

function renderFilterStrip() {
  const el = document.getElementById("browse-filters");
  if (!el) return;

  const hasActiveFilter = gamesFilterPlayers !== null
    || gamesFilterPlaytimeMin !== null
    || gamesFilterPlaytimeMax !== null
    || gamesFilterMechanics.length > 0;

  el.innerHTML = `
    <div class="space-y-2">

      <!-- Players row -->
      <div class="flex items-center gap-1.5 flex-wrap">
        <span class="text-xs text-base-content/50 mr-1">Players</span>
        ${PLAYER_CHIPS.map(c => `
          <button class="btn btn-xs ${gamesFilterPlayers === c.value ? 'btn-primary' : 'btn-outline'}"
                  onclick="togglePlayersFilter(${c.value})">
            ${c.label}
          </button>
        `).join("")}
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

      <!-- Mechanics row -->
      ${mechanicsOptions.length ? `
        <div>
          <div id="mechanics-chips" class="flex items-center gap-1.5 flex-wrap">
            <span class="text-xs text-base-content/50 mr-1">Mechanics</span>
            ${mechanicsOptions.slice(0, 20).map(m => {
              const active = gamesFilterMechanics.includes(m);
              return `<button class="btn btn-xs ${active ? 'btn-primary' : 'btn-outline'}"
                              onclick="toggleMechanicFilter(${JSON.stringify(m)})">${m}</button>`;
            }).join("")}
            ${mechanicsOptions.length > 20 ? `
              <button class="btn btn-xs btn-ghost" onclick="expandMechanics()">
                +${mechanicsOptions.length - 20} more
              </button>` : ""}
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
}

function togglePlayersFilter(value) {
  gamesFilterPlayers = gamesFilterPlayers === value ? null : value;
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
  renderFilterStrip();
  loadGames();
}

function clearBrowseFilters() {
  gamesFilterPlayers = null;
  gamesFilterPlaytimeMin = null;
  gamesFilterPlaytimeMax = null;
  gamesFilterMechanics = [];
  gamesPage = 1;
  renderFilterStrip();
  loadGames();
}

function expandMechanics() {
  const container = document.getElementById("mechanics-chips");
  if (!container) return;
  // Replace the "show 20" slice with all mechanics
  const extra = mechanicsOptions.slice(20).map(m => {
    const active = gamesFilterMechanics.includes(m);
    return `<button class="btn btn-xs ${active ? 'btn-primary' : 'btn-outline'}"
                    onclick="toggleMechanicFilter(${JSON.stringify(m)})">${m}</button>`;
  });
  const showMoreBtn = container.querySelector("button[onclick='expandMechanics()']");
  if (showMoreBtn) {
    showMoreBtn.replaceWith(...extra.map(h => { const d = document.createElement("div"); d.innerHTML = h; return d.firstChild; }));
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
