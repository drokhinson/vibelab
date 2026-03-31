// plays.js — Log game plays and view play history

function startLogPlay(gameId, gameName) {
  showView("log-play");
  renderLogPlayForm(gameId, gameName);
}

async function renderLogPlayForm(preselectedGameId, preselectedGameName) {
  const container = document.getElementById("log-play-content");

  // Load buddies for autocomplete
  try {
    buddies = await apiFetch("/buddies");
  } catch { buddies = []; }

  container.innerHTML = `
    <h2 class="text-xl font-bold mb-4 flex items-center gap-2">
      <i data-lucide="trophy" class="w-5 h-5 text-warning"></i> Log a Play
    </h2>

    <form onsubmit="handleLogPlay(event)" class="space-y-4">
      <!-- Game selection -->
      <div class="form-control">
        <label class="label"><span class="label-text">Game</span></label>
        ${preselectedGameId
          ? `<input type="hidden" id="play-game-id" value="${preselectedGameId}" />
             <div class="input input-bordered flex items-center">${preselectedGameName}
               <button type="button" class="btn btn-ghost btn-xs ml-auto" onclick="renderLogPlayForm()">Change</button>
             </div>`
          : `<input type="text" id="play-game-search" class="input input-bordered" placeholder="Search for a game..." oninput="searchPlayGame(this.value)" />
             <input type="hidden" id="play-game-id" />
             <div id="play-game-results" class="mt-1"></div>`
        }
      </div>

      <!-- Date -->
      <div class="form-control">
        <label class="label"><span class="label-text">Date Played</span></label>
        <input type="date" id="play-date" class="input input-bordered" value="${new Date().toISOString().split('T')[0]}" required />
      </div>

      <!-- Players -->
      <div class="form-control">
        <label class="label"><span class="label-text">Players</span></label>
        <div id="play-players-list" class="space-y-2"></div>
        <button type="button" class="btn btn-ghost btn-sm mt-2" onclick="addPlayerRow()">
          <i data-lucide="user-plus" class="w-4 h-4"></i> Add Player
        </button>
      </div>

      <!-- Notes -->
      <div class="form-control">
        <label class="label"><span class="label-text">Notes (optional)</span></label>
        <textarea id="play-notes" class="textarea textarea-bordered text-sm h-16" placeholder="Fun moments, close calls..."></textarea>
      </div>

      <button type="submit" id="log-play-btn" class="btn btn-primary w-full">Save Play</button>
    </form>
  `;
  lucide.createIcons();

  // Auto-add current user as first player
  addPlayerRow(currentUser?.display_name || "");
}

let playerRowCount = 0;

function addPlayerRow(name) {
  const list = document.getElementById("play-players-list");
  const idx = playerRowCount++;

  const buddySuggestions = buddies.map(b => `<option value="${b.name}">`).join("");

  const row = document.createElement("div");
  row.className = "flex items-center gap-2";
  row.id = `player-row-${idx}`;
  row.innerHTML = `
    <input type="text" class="input input-bordered input-sm flex-1 player-name" list="buddy-list-${idx}"
           placeholder="Player name" value="${name || ""}" />
    <datalist id="buddy-list-${idx}">${buddySuggestions}</datalist>
    <label class="flex items-center gap-1 cursor-pointer">
      <input type="checkbox" class="checkbox checkbox-sm checkbox-warning player-winner" />
      <span class="text-xs">🏆</span>
    </label>
    <button type="button" class="btn btn-ghost btn-xs" onclick="document.getElementById('player-row-${idx}').remove()">
      <i data-lucide="x" class="w-3 h-3"></i>
    </button>
  `;
  list.appendChild(row);
  lucide.createIcons();
}

let playGameSearchTimeout;
async function searchPlayGame(query) {
  clearTimeout(playGameSearchTimeout);
  if (query.length < 2) {
    document.getElementById("play-game-results").innerHTML = "";
    return;
  }
  playGameSearchTimeout = setTimeout(async () => {
    try {
      const data = await apiFetch(`/games?search=${encodeURIComponent(query)}&per_page=5`);
      const container = document.getElementById("play-game-results");
      container.innerHTML = data.games.map(g => `
        <button type="button" class="btn btn-ghost btn-sm w-full justify-start text-left"
                onclick="selectPlayGame('${g.id}', '${g.name.replace(/'/g, "\\'")}')">
          ${g.name} ${g.year_published ? `(${g.year_published})` : ""}
        </button>
      `).join("");
    } catch { /* ignore */ }
  }, 300);
}

function selectPlayGame(id, name) {
  document.getElementById("play-game-id").value = id;
  const searchInput = document.getElementById("play-game-search");
  if (searchInput) {
    searchInput.value = name;
    searchInput.disabled = true;
  }
  document.getElementById("play-game-results").innerHTML = "";
}

async function handleLogPlay(e) {
  e.preventDefault();
  const gameId = document.getElementById("play-game-id").value;
  if (!gameId) {
    showToast("Please select a game", "warning");
    return;
  }

  const playedAt = document.getElementById("play-date").value;
  const notes = document.getElementById("play-notes").value || null;

  // Collect players
  const players = [];
  document.querySelectorAll("#play-players-list > div").forEach(row => {
    const name = row.querySelector(".player-name").value.trim();
    const isWinner = row.querySelector(".player-winner").checked;
    if (name) players.push({ name, is_winner: isWinner });
  });

  const btn = document.getElementById("log-play-btn");
  btn.classList.add("loading");
  btn.disabled = true;

  try {
    await apiFetch("/plays", {
      method: "POST",
      body: { game_id: gameId, played_at: playedAt, players, notes },
    });
    showToast("Play logged!", "success");
    playerRowCount = 0;
    showView("history");
    loadPlays();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}

// ── Play History ─────────────────────────────────────────────────────────────

async function loadPlays() {
  const container = document.getElementById("history-content");
  container.innerHTML = '<div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>';

  try {
    plays = await apiFetch("/plays");
    renderPlays();
  } catch (err) {
    container.innerHTML = `<div class="text-error text-center py-8">${err.message}</div>`;
  }
}

function renderPlays() {
  const container = document.getElementById("history-content");

  if (!plays.length) {
    container.innerHTML = `
      <div class="text-center py-12 text-base-content/50">
        <div class="text-5xl mb-4">🏆</div>
        <p>No plays recorded yet.</p>
        <button class="btn btn-primary btn-sm mt-4" onclick="showView('log-play'); renderLogPlayForm();">Log Your First Play</button>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="space-y-3">
      ${plays.map((p, i) => `
        <div class="card bg-base-200 animate-fadeUp" style="--i:${i}">
          <div class="card-body p-3">
            <div class="flex items-start gap-3">
              ${p.game_thumbnail
                ? `<img src="${p.game_thumbnail}" class="w-12 h-12 rounded object-cover flex-shrink-0" />`
                : '<div class="w-12 h-12 rounded bg-base-300 flex items-center justify-center text-2xl flex-shrink-0">🎲</div>'
              }
              <div class="flex-1 min-w-0">
                <h3 class="font-semibold text-sm leading-tight">${p.game_name}</h3>
                <p class="text-xs text-base-content/50 mt-0.5">${formatDate(p.played_at)}</p>
                ${p.players.length ? `
                  <div class="flex flex-wrap gap-1 mt-1.5">
                    ${p.players.map(pl => `
                      <span class="badge badge-sm ${pl.is_winner ? 'badge-warning' : 'badge-ghost'}">
                        ${pl.is_winner ? '🏆 ' : ''}${pl.name}
                      </span>
                    `).join("")}
                  </div>` : ""}
                ${p.notes ? `<p class="text-xs text-base-content/60 mt-1 italic">${p.notes}</p>` : ""}
              </div>
              <button class="btn btn-ghost btn-xs flex-shrink-0" onclick="deletePlay('${p.id}')">
                <i data-lucide="trash-2" class="w-3 h-3"></i>
              </button>
            </div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
  lucide.createIcons();
}

async function deletePlay(playId) {
  if (!confirm("Delete this play?")) return;
  try {
    await apiFetch(`/plays/${playId}`, { method: "DELETE" });
    showToast("Play deleted", "info");
    loadPlays();
  } catch (err) {
    showToast(err.message, "error");
  }
}
