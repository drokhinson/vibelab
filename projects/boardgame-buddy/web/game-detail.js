// game-detail.js — Single game view with themed header, guide, collection actions

async function openGameDetail(gameId) {
  showView("game-detail");
  const container = document.getElementById("game-detail-content");
  container.innerHTML = '<div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>';

  try {
    currentGame = await apiFetch(`/games/${gameId}`);
    applyGameTheme(currentGame);
    renderGameDetail();
    loadGuide(gameId);
    if (session) {
      renderCollectionButtons(gameId);
      loadPlayCount(gameId);
      loadGamePlays(gameId);
    }
    if (window._pendingScrollToGuide) {
      window._pendingScrollToGuide = false;
      setTimeout(() => {
        document.getElementById("guide-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 500);
    }
  } catch (err) {
    container.innerHTML = `<div class="text-error text-center py-8">${err.message}</div>`;
  }
}

async function loadPlayCount(gameId) {
  try {
    const { count } = await apiFetch(`/games/${gameId}/play-count`);
    const slot = document.getElementById("play-count-badge");
    if (!slot || !count) return;
    slot.innerHTML = `
      <div class="badge" style="border-color: var(--game-accent); color: var(--game-accent);">
        <i data-lucide="dice-5" class="w-3 h-3 mr-1"></i>Played ${count}×
      </div>`;
    lucide.createIcons();
  } catch { /* ignore — badge just stays empty */ }
}

function applyGameTheme(game) {
  const color = game.theme_color || getCategoryColor(game.categories);
  document.documentElement.style.setProperty("--game-accent", color);
  document.documentElement.style.setProperty("--game-accent-light", color + "28");
}

function getCategoryColor(categories) {
  if (!categories || !categories.length) return "#6C63FF";
  const map = {
    "Strategy":          "#C9922A",
    "Card Game":         "#1A4A32",
    "Party Game":        "#8B1A4A",
    "Family Game":       "#1A3D6B",
    "Wargame":           "#7A2020",
    "Abstract Strategy": "#4A3520",
    "Economic":          "#A07800",
  };
  for (const cat of categories) {
    if (map[cat]) return map[cat];
  }
  return "#6B3FA0";
}

function renderGameDetail() {
  const g = currentGame;
  const container = document.getElementById("game-detail-content");

  container.innerHTML = `
    <!-- Header banner -->
    <div class="relative -mx-4 -mt-4 mb-4">
      <div class="h-48 bg-cover bg-center relative" style="${g.image_url ? `background-image: url('${bggImg(g.image_url)}')` : `background-color: var(--game-accent-light)`}">
        <div class="absolute inset-0" style="background: linear-gradient(transparent 30%, var(--game-accent-light) 70%, var(--b1, #1d232a) 100%)"></div>
        <button class="btn btn-circle btn-ghost btn-sm absolute top-3 left-3 bg-base-100/50" onclick="showView('closet'); loadCloset();">
          <i data-lucide="arrow-left" class="w-5 h-5"></i>
        </button>
      </div>
    </div>

    <!-- Game info -->
    <div class="mb-4">
      <h1 class="text-2xl font-bold">${g.name}</h1>
      ${g.year_published ? `<span class="text-base-content/50 text-sm">(${g.year_published})</span>` : ""}

      <div class="flex flex-wrap gap-2 mt-3">
        ${g.bgg_url ? `<a href="${g.bgg_url}" target="_blank" rel="noopener"
          class="badge badge-outline gap-1 hover:badge-primary">
          <i data-lucide="external-link" class="w-3 h-3"></i>BGG</a>` : ""}
        ${g.min_players ? `<div class="badge badge-ghost"><i data-lucide="users" class="w-3 h-3 mr-1"></i>${playerRange(g.min_players, g.max_players)}</div>` : ""}
        ${g.playing_time ? `<div class="badge badge-ghost"><i data-lucide="clock" class="w-3 h-3 mr-1"></i>${formatTime(g.playing_time)}</div>` : ""}
        <span id="play-count-badge"></span>
      </div>

      ${g.categories?.length ? `
        <div class="flex flex-wrap gap-1 mt-2">
          ${g.categories.map(c => `<span class="badge badge-sm badge-outline">${c}</span>`).join("")}
        </div>` : ""}
    </div>

    <!-- Collection actions -->
    <div id="collection-actions" class="mb-4">
      ${session ? '<span class="loading loading-spinner loading-xs"></span>' : '<p class="text-sm text-base-content/50">Log in to add to collection</p>'}
    </div>

    <!-- Quick Reference Guide -->
    <div id="guide-section" class="mb-4">
      <h2 class="text-lg font-bold flex items-center gap-2 mt-3 mb-2">
        <i data-lucide="book-open" class="w-5 h-5" style="color: var(--game-accent)"></i>
        Quick Reference
      </h2>
      <!-- Search + chunk-type pills + expand-all (rendered by guide.js) -->
      <div id="guide-controls"></div>
      <div id="expansions-panel" class="mb-2"></div>
      <div id="guide-content" class="scroll-panel">
        <span class="loading loading-spinner loading-sm"></span>
      </div>
      <!-- New chunk / Hidden — moved below the scroll (rendered by guide.js) -->
      <div id="guide-toolbar" class="mt-3"></div>
    </div>

    <!-- Rulebooks (official + enabled expansions, rendered by guide.js) -->
    <div id="rulebooks-section" class="mb-4"></div>

    <!-- Play History (logged-in only, populated async) -->
    ${session ? '<div id="game-history-section" class="mb-4"></div>' : ''}

    <!-- Description -->
    ${g.description ? `
      <div class="collapse collapse-arrow bg-base-200 mb-4">
        <input type="checkbox" />
        <div class="collapse-title font-medium">Game Description</div>
        <div class="collapse-content text-sm text-base-content/70 leading-relaxed">
          ${g.description}
        </div>
      </div>` : ""}

  `;
  lucide.createIcons();
}

async function loadGamePlays(gameId) {
  const section = document.getElementById("game-history-section");
  if (!section) return;
  try {
    const gamePlays = await apiFetch(`/games/${gameId}/plays`);
    renderGamePlays(gamePlays);
  } catch { /* supplementary — fail silently */ }
}

function renderGamePlays(gamePlays) {
  const section = document.getElementById("game-history-section");
  if (!section) return;

  // Update play-count badge from the authoritative play list
  if (gamePlays.length) {
    const slot = document.getElementById("play-count-badge");
    if (slot) {
      slot.innerHTML = `
        <div class="badge" style="border-color: var(--game-accent); color: var(--game-accent);">
          <i data-lucide="dice-5" class="w-3 h-3 mr-1"></i>Played ${gamePlays.length}×
        </div>`;
    }
  }

  if (!gamePlays.length) {
    section.innerHTML = `
      <h2 class="text-lg font-bold flex items-center gap-2 mb-2">
        <i data-lucide="history" class="w-5 h-5" style="color: var(--game-accent)"></i>
        Play History
      </h2>
      <p class="text-sm text-base-content/50">No plays logged yet.</p>`;
    lucide.createIcons();
    return;
  }

  section.innerHTML = `
    <h2 class="text-lg font-bold flex items-center gap-2 mb-2">
      <i data-lucide="history" class="w-5 h-5" style="color: var(--game-accent)"></i>
      Play History
      <span class="badge badge-sm">${gamePlays.length}</span>
    </h2>
    <div class="space-y-2">
      ${gamePlays.map((p, i) => `
        <div class="bg-base-200 rounded-xl p-3 animate-fadeUp" style="--i:${i}">
          <div class="flex items-center justify-between gap-2 mb-1.5">
            <span class="text-sm font-medium">${formatDate(p.played_at)}</span>
          </div>
          ${p.players.length ? `
            <div class="flex flex-wrap gap-1">
              ${p.players.map(pl => `
                <span class="badge badge-sm ${pl.is_winner ? 'badge-warning' : 'badge-ghost'}">
                  ${pl.is_winner ? '<i data-lucide="trophy" class="w-3 h-3 inline mr-0.5"></i>' : ''}${escapeHtml(pl.name)}
                </span>
              `).join("")}
            </div>` : ""}
          ${p.notes ? `<p class="text-xs text-base-content/60 mt-1.5 italic">${escapeHtml(p.notes)}</p>` : ""}
        </div>
      `).join("")}
    </div>
  `;
  lucide.createIcons();
}

// Guide rendering and the chunk manager live in guide.js. The "Log a play"
// FAB is global (see index.html / session.js); on Game Detail, the
// "Collection actions" row also exposes a contextual "Start session" button
// pre-loaded with this game (see renderCollectionButtons in collection.js).
