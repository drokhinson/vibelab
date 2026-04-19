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
        <p>No games found. Try a different search.</p>
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
            <img src="${g.thumbnail_url || 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22200%22><rect fill=%22%23333%22 width=%22200%22 height=%22200%22/></svg>'}"
                 alt="${g.name}" class="rounded-lg w-full h-32 object-cover bg-base-300" loading="lazy" />
          </figure>
          <div class="card-body p-3 pt-2">
            <h3 class="font-semibold text-sm leading-tight line-clamp-2">${g.name}</h3>
            <div class="flex items-center gap-2 text-xs text-base-content/60 mt-1">
              ${g.bgg_rank ? `<span class="badge badge-sm badge-ghost">#${g.bgg_rank}</span>` : ""}
              ${g.bgg_rating ? `<span><i data-lucide="star" class="w-3 h-3 inline mr-0.5"></i>${formatRating(g.bgg_rating)}</span>` : ""}
            </div>
            <div class="text-xs text-base-content/50 mt-1">
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
      <div>
        <span class="font-medium text-sm">${r.name}</span>
        ${r.year_published ? `<span class="text-xs text-base-content/50">(${r.year_published})</span>` : ""}
      </div>
      ${r.already_in_db
        ? '<span class="badge badge-sm badge-success">In library</span>'
        : `<button class="btn btn-xs btn-primary" onclick="importBggGame(${r.bgg_id})">Add</button>`
      }
    </div>
  `).join("");
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
