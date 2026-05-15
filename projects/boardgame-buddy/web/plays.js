// plays.js — Play history list. The "log a play" form lives in session.js
// (a floating bubble); this file only renders the saved-history list and
// exposes startLogPlay() as a thin wrapper that opens the session bubble.

function startLogPlay(gameId, gameName, gameThumb) {
  openSession({ gameId, gameName, gameThumb });
}

// ── Play History ─────────────────────────────────────────────────────────────

async function loadPlays() {
  const container = document.getElementById("history-content");
  container.innerHTML = `<div class="flex justify-center py-12">${buddyLoader('lg')}</div>`;

  // Reset filters and page on fresh load
  playsPage = 1;
  playsFilterGameId = null;
  playsFilterBuddyId = null;

  try {
    const params = new URLSearchParams({ page: playsPage, per_page: PLAYS_PER_PAGE });
    const data = await apiFetch(`/plays?${params}`);
    plays = data.plays;
    playsTotalCount = data.total;

    // Fetch filter options once
    if (!playsFilterOptions) {
      try {
        playsFilterOptions = await apiFetch("/plays/filter-options");
      } catch { playsFilterOptions = { games: [], buddies: [] }; }
    }
    renderPlaysFilterRow();
    renderPlays();
  } catch (err) {
    container.innerHTML = `<div class="text-error text-center py-8">${err.message}</div>`;
  }
}

async function fetchPlays() {
  const container = document.getElementById("history-content");
  container.innerHTML = `<div class="flex justify-center py-12">${buddyLoader('lg')}</div>`;
  try {
    const params = new URLSearchParams({ page: playsPage, per_page: PLAYS_PER_PAGE });
    if (playsFilterGameId) params.set("game_id", playsFilterGameId);
    if (playsFilterBuddyId) params.set("buddy_id", playsFilterBuddyId);
    const data = await apiFetch(`/plays?${params}`);
    plays = data.plays;
    playsTotalCount = data.total;
    renderPlays();
  } catch (err) {
    container.innerHTML = `<div class="text-error text-center py-8">${err.message}</div>`;
  }
}

function changePlaysPage(delta) {
  const totalPages = Math.ceil(playsTotalCount / PLAYS_PER_PAGE);
  playsPage = Math.max(1, Math.min(playsPage + delta, totalPages));
  fetchPlays();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── Searchable filter dropdowns ───────────────────────────────────────────────

function renderPlaysFilterRow() {
  const row = document.getElementById("plays-filter-row");
  if (!row || !playsFilterOptions) return;
  const { games, buddies } = playsFilterOptions;
  if (!games.length && !buddies.length) return;

  row.innerHTML = `
    <div class="flex gap-2 flex-wrap">
      ${games.length ? `<div id="plays-game-dropdown" class="relative">${_renderFilterDropdown({
        id: "plays-game-dropdown",
        placeholder: "All Games",
        options: games,
        selectedId: playsFilterGameId,
        onSelect: "_onPlaysGameSelect",
        onClear: "_onPlaysGameClear",
      })}</div>` : ""}
      ${buddies.length ? `<div id="plays-buddy-dropdown" class="relative">${_renderFilterDropdown({
        id: "plays-buddy-dropdown",
        placeholder: "All Buddies",
        options: buddies,
        selectedId: playsFilterBuddyId,
        onSelect: "_onPlaysBuddySelect",
        onClear: "_onPlaysBuddyClear",
      })}</div>` : ""}
    </div>
  `;

  // Close dropdowns when clicking outside
  document.addEventListener("click", _closePlaysDropdowns);
}

function _renderFilterDropdown({ id, placeholder, options, selectedId, onSelect, onClear }) {
  const selected = selectedId ? options.find(o => o.id === selectedId) : null;
  const label = selected ? escapeHtml(selected.name) : placeholder;
  return `
    <button class="btn btn-sm btn-outline gap-1 ${selected ? 'btn-primary' : ''}"
            onclick="event.stopPropagation(); _toggleDropdown('${id}-panel')">
      ${label}
      ${selected
        ? `<span onclick="event.stopPropagation(); ${onClear}()" class="ml-1 opacity-70 hover:opacity-100">✕</span>`
        : `<i data-lucide="chevron-down" class="w-3 h-3 opacity-60"></i>`}
    </button>
    <div id="${id}-panel" class="hidden absolute z-50 bg-base-100 border border-base-300 rounded-box shadow-xl w-64 p-2 mt-1 left-0">
      <input type="text" class="input input-sm input-bordered w-full mb-2"
             placeholder="Search..."
             oninput="_filterDropdownList(this, '${id}-list')"
             onclick="event.stopPropagation()" />
      <ul id="${id}-list" class="max-h-48 overflow-y-auto space-y-0.5">
        ${options.map(o => `
          <li class="px-2 py-1.5 rounded cursor-pointer hover:bg-base-200 text-sm flex items-center justify-between ${o.id === selectedId ? 'bg-primary/10 font-medium' : ''}"
              onclick="event.stopPropagation(); ${onSelect}('${o.id}', ${escapeHtml(JSON.stringify(o.name))})">
            ${escapeHtml(o.name)}
            ${o.id === selectedId ? '<i data-lucide="check" class="w-3 h-3 text-primary flex-shrink-0"></i>' : ''}
          </li>
        `).join("")}
      </ul>
    </div>
  `;
}

function _filterDropdownList(input, listId) {
  const q = input.value.toLowerCase();
  const items = document.getElementById(listId)?.querySelectorAll("li");
  items?.forEach(li => {
    li.style.display = li.textContent.toLowerCase().includes(q) ? "" : "none";
  });
}

function _toggleDropdown(panelId) {
  // Close all other dropdowns first. Scoped to the two plays-filter panels —
  // a broad [id$='-panel'] selector here also matched #session-panel and
  // re-hid the session bubble whenever the play log dropdowns were on screen.
  const PLAYS_DROPDOWN_PANELS = "#plays-game-dropdown-panel, #plays-buddy-dropdown-panel";
  document.querySelectorAll(PLAYS_DROPDOWN_PANELS).forEach(p => {
    if (p.id !== panelId) p.classList.add("hidden");
  });
  document.getElementById(panelId)?.classList.toggle("hidden");
  lucide.createIcons();
}

function _closePlaysDropdowns(e) {
  if (!e.target.closest("#plays-game-dropdown") && !e.target.closest("#plays-buddy-dropdown")) {
    document
      .querySelectorAll("#plays-game-dropdown-panel, #plays-buddy-dropdown-panel")
      .forEach(p => p.classList.add("hidden"));
  }
}

function _onPlaysGameSelect(id, name) {
  playsFilterGameId = id;
  playsPage = 1;
  _rebuildPlaysFilterRow();
  fetchPlays();
}

function _onPlaysGameClear() {
  playsFilterGameId = null;
  playsPage = 1;
  _rebuildPlaysFilterRow();
  fetchPlays();
}

function _onPlaysBuddySelect(id, name) {
  playsFilterBuddyId = id;
  playsPage = 1;
  _rebuildPlaysFilterRow();
  fetchPlays();
}

function _onPlaysBuddyClear() {
  playsFilterBuddyId = null;
  playsPage = 1;
  _rebuildPlaysFilterRow();
  fetchPlays();
}

function _rebuildPlaysFilterRow() {
  document.removeEventListener("click", _closePlaysDropdowns);
  renderPlaysFilterRow();
}

// ── Render plays list ─────────────────────────────────────────────────────────

function renderPlays() {
  const container = document.getElementById("history-content");
  const totalPages = Math.ceil(playsTotalCount / PLAYS_PER_PAGE);
  const isFiltered = playsFilterGameId || playsFilterBuddyId;

  if (!plays.length) {
    if (isFiltered) {
      container.innerHTML = `
        <div class="text-center py-12 text-base-content/50">
          <i data-lucide="search-x" class="w-10 h-10 mb-3 opacity-50 mx-auto"></i>
          <p>No plays match these filters.</p>
          <button class="btn btn-ghost btn-sm mt-3" onclick="_clearPlaysFilters()">Clear filters</button>
        </div>`;
    } else {
      container.innerHTML = `
        <div class="text-center py-12 text-base-content/50">
          <i data-lucide="trophy" class="w-12 h-12 mb-4 opacity-50"></i>
          <p>No plays recorded yet.</p>
          <p class="text-xs mt-2 opacity-60">Tap the <i data-lucide="plus" class="w-3 h-3 inline"></i> button to log your first play.</p>
        </div>`;
    }
    lucide.createIcons();
    return;
  }

  container.innerHTML = `
    <div class="space-y-3">
      ${plays.map((p, i) => {
        const winners = (p.players || []).filter(pl => pl.is_winner);
        const winnerLabel = winners.length === 0
          ? ""
          : winners.length === 1
            ? escapeHtml(winners[0].name)
            : `${winners.length} winners`;
        const playerCount = (p.players || []).length;
        return `
        <div class="card bg-base-200 animate-fadeUp play-card ${p.is_own ? "" : "opacity-90 border border-base-300"}"
             style="--i:${i}" onclick="openPlayDetail('${p.id}')">
          <div class="card-body p-3">
            <div class="flex items-center gap-3">
              ${p.game_thumbnail
                ? `<img src="${p.game_thumbnail}" class="w-12 h-12 rounded object-cover flex-shrink-0 cursor-pointer" onclick="event.stopPropagation(); openGameDetail('${p.game_id}')" />`
                : `<div class="w-12 h-12 rounded bg-base-300 flex items-center justify-center flex-shrink-0 cursor-pointer" onclick="event.stopPropagation(); openGameDetail('${p.game_id}')"><i data-lucide="dice-6" class="w-6 h-6 opacity-40"></i></div>`
              }
              <div class="flex-1 min-w-0">
                <h3 class="font-semibold text-sm leading-tight truncate">
                  <a class="link link-hover" onclick="event.stopPropagation(); openGameDetail('${p.game_id}')">${escapeHtml(p.game_name)}</a>
                </h3>
                <p class="text-xs text-base-content/50">${formatDate(p.played_at)}</p>
                <div class="flex items-center gap-2 flex-wrap mt-1 text-xs">
                  ${winnerLabel ? `<span class="inline-flex items-center gap-1 text-warning"><i data-lucide="trophy" class="w-3 h-3"></i>${winnerLabel}</span>` : ""}
                  ${playerCount ? `<span class="inline-flex items-center gap-1 text-base-content/60"><i data-lucide="users" class="w-3 h-3"></i>${playerCount} ${playerCount === 1 ? "player" : "players"}</span>` : ""}
                  ${p.play_mode && p.play_mode !== "competitive" ? `<span class="badge badge-sm badge-outline">${playModeLabel(p.play_mode)}</span>` : ""}
                </div>
              </div>
            </div>
          </div>
        </div>
        `;
      }).join("")}
    </div>

    ${totalPages > 1 ? `
      <div class="flex justify-center gap-2 mt-6">
        <button class="btn btn-sm ${playsPage <= 1 ? 'btn-disabled' : ''}" onclick="changePlaysPage(-1)">
          <i data-lucide="chevron-left" class="w-4 h-4"></i> Prev
        </button>
        <span class="btn btn-sm btn-ghost no-animation">${playsPage} / ${totalPages}</span>
        <button class="btn btn-sm ${playsPage >= totalPages ? 'btn-disabled' : ''}" onclick="changePlaysPage(1)">
          Next <i data-lucide="chevron-right" class="w-4 h-4"></i>
        </button>
      </div>
    ` : ""}
  `;
  lucide.createIcons();
}

function _clearPlaysFilters() {
  playsFilterGameId = null;
  playsFilterBuddyId = null;
  playsPage = 1;
  _rebuildPlaysFilterRow();
  fetchPlays();
}
