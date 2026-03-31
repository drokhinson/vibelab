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
    if (session) renderCollectionButtons(gameId);
  } catch (err) {
    container.innerHTML = `<div class="text-error text-center py-8">${err.message}</div>`;
  }
}

function applyGameTheme(game) {
  const color = game.theme_color || getCategoryColor(game.categories);
  document.documentElement.style.setProperty("--game-accent", color);
  document.documentElement.style.setProperty("--game-accent-light", color + "22");
}

function getCategoryColor(categories) {
  if (!categories || !categories.length) return "#6C63FF";
  const map = {
    "Strategy": "#8B6914",
    "Card Game": "#2E5A3C",
    "Party Game": "#D4457D",
    "Family Game": "#4A90D9",
    "Wargame": "#6B3A3A",
    "Abstract Strategy": "#555555",
    "Economic": "#B8860B",
  };
  for (const cat of categories) {
    if (map[cat]) return map[cat];
  }
  return "#6C63FF";
}

function renderGameDetail() {
  const g = currentGame;
  const container = document.getElementById("game-detail-content");

  container.innerHTML = `
    <!-- Header banner -->
    <div class="relative -mx-4 -mt-4 mb-4">
      <div class="h-48 bg-cover bg-center relative" style="background-image: url('${g.image_url || ""}')">
        <div class="absolute inset-0" style="background: linear-gradient(transparent 30%, var(--game-accent-light) 70%, var(--b1, #1d232a) 100%)"></div>
        <button class="btn btn-circle btn-ghost btn-sm absolute top-3 left-3 bg-base-100/50" onclick="showView('browse'); loadGames();">
          <i data-lucide="arrow-left" class="w-5 h-5"></i>
        </button>
      </div>
    </div>

    <!-- Game info -->
    <div class="mb-4">
      <h1 class="text-2xl font-bold">${g.name}</h1>
      ${g.year_published ? `<span class="text-base-content/50 text-sm">(${g.year_published})</span>` : ""}

      <div class="flex flex-wrap gap-2 mt-3">
        ${g.bgg_rank ? `<div class="badge" style="border-color: var(--game-accent); color: var(--game-accent);">
          #${g.bgg_rank} on BGG</div>` : ""}
        ${g.bgg_rating ? `<div class="badge badge-ghost">★ ${formatRating(g.bgg_rating)}</div>` : ""}
        ${g.min_players ? `<div class="badge badge-ghost"><i data-lucide="users" class="w-3 h-3 mr-1"></i>${playerRange(g.min_players, g.max_players)}</div>` : ""}
        ${g.playing_time ? `<div class="badge badge-ghost"><i data-lucide="clock" class="w-3 h-3 mr-1"></i>${formatTime(g.playing_time)}</div>` : ""}
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
      <h2 class="text-lg font-bold mb-2 flex items-center gap-2">
        <i data-lucide="book-open" class="w-5 h-5" style="color: var(--game-accent)"></i>
        Quick Reference
      </h2>
      <div id="guide-content">
        <span class="loading loading-spinner loading-sm"></span>
      </div>
    </div>

    <!-- Description -->
    ${g.description ? `
      <div class="collapse collapse-arrow bg-base-200 mb-4">
        <input type="checkbox" />
        <div class="collapse-title font-medium">Game Description</div>
        <div class="collapse-content text-sm text-base-content/70 leading-relaxed">
          ${g.description}
        </div>
      </div>` : ""}

    <!-- Log play shortcut -->
    ${session ? `
      <button class="btn btn-block mt-4" style="background: var(--game-accent); color: white; border: none;"
              onclick="startLogPlay('${g.id}', '${g.name.replace(/'/g, "\\'")}')">
        <i data-lucide="plus-circle" class="w-5 h-5"></i> Log a Play
      </button>` : ""}
  `;
  lucide.createIcons();
}

async function loadGuide(gameId) {
  const container = document.getElementById("guide-content");
  try {
    currentGuide = await apiFetch(`/games/${gameId}/guide`);
    renderGuide();
  } catch {
    currentGuide = null;
    container.innerHTML = `
      <div class="text-center py-4 text-base-content/50">
        <p class="text-sm">No guide available yet.</p>
        ${session ? '<button class="btn btn-sm btn-outline mt-2" onclick="showGuideEditor()">Contribute a guide</button>' : ""}
      </div>`;
  }
}

function renderGuide() {
  const container = document.getElementById("guide-content");
  const g = currentGuide;

  container.innerHTML = `
    <div class="space-y-3">
      ${g.quick_setup ? `
        <div class="collapse collapse-arrow bg-base-200 border border-base-300">
          <input type="checkbox" checked />
          <div class="collapse-title font-medium text-sm">
            <i data-lucide="settings" class="w-4 h-4 inline mr-1" style="color: var(--game-accent)"></i>
            Quick Setup
          </div>
          <div class="collapse-content text-sm leading-relaxed guide-text">${renderMarkdown(g.quick_setup)}</div>
        </div>` : ""}

      ${g.player_guide ? `
        <div class="collapse collapse-arrow bg-base-200 border border-base-300">
          <input type="checkbox" checked />
          <div class="collapse-title font-medium text-sm">
            <i data-lucide="gamepad-2" class="w-4 h-4 inline mr-1" style="color: var(--game-accent)"></i>
            Player Guide
          </div>
          <div class="collapse-content text-sm leading-relaxed guide-text">${renderMarkdown(g.player_guide)}</div>
        </div>` : ""}

      ${g.rulebook_url ? `
        <a href="${g.rulebook_url}" target="_blank" rel="noopener"
           class="btn btn-outline btn-sm w-full">
          <i data-lucide="file-text" class="w-4 h-4"></i> Full Rulebook (PDF)
        </a>` : ""}
    </div>
  `;
  lucide.createIcons();
}

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

function showGuideEditor() {
  const container = document.getElementById("guide-content");
  container.innerHTML = `
    <form onsubmit="submitGuide(event)" class="space-y-3">
      <div class="form-control">
        <label class="label"><span class="label-text text-xs">Quick Setup</span></label>
        <textarea id="guide-setup" class="textarea textarea-bordered text-sm h-24" placeholder="Easy-to-forget setup details...">${currentGuide?.quick_setup || ""}</textarea>
      </div>
      <div class="form-control">
        <label class="label"><span class="label-text text-xs">Player Guide</span></label>
        <textarea id="guide-player" class="textarea textarea-bordered text-sm h-24" placeholder="Turn actions and winning criteria...">${currentGuide?.player_guide || ""}</textarea>
      </div>
      <div class="form-control">
        <label class="label"><span class="label-text text-xs">Rulebook URL (PDF link)</span></label>
        <input id="guide-url" type="url" class="input input-bordered input-sm" placeholder="https://..." value="${currentGuide?.rulebook_url || ""}" />
      </div>
      <div class="flex gap-2">
        <button type="submit" class="btn btn-primary btn-sm flex-1">Save Guide</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="loadGuide('${currentGame.id}')">Cancel</button>
      </div>
    </form>
  `;
}

async function submitGuide(e) {
  e.preventDefault();
  try {
    await apiFetch(`/games/${currentGame.id}/guide`, {
      method: "POST",
      body: {
        quick_setup: document.getElementById("guide-setup").value || null,
        player_guide: document.getElementById("guide-player").value || null,
        rulebook_url: document.getElementById("guide-url").value || null,
      },
    });
    showToast("Guide saved!", "success");
    loadGuide(currentGame.id);
  } catch (err) {
    showToast(err.message, "error");
  }
}
