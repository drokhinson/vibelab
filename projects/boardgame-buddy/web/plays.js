// plays.js — Play history list. The "log a play" form lives in session.js
// (a floating bubble); this file only renders the saved-history list and
// exposes startLogPlay() as a thin wrapper that opens the session bubble.

function startLogPlay(gameId, gameName, gameThumb) {
  openSession({ gameId, gameName, gameThumb });
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
        <i data-lucide="trophy" class="w-12 h-12 mb-4 opacity-50"></i>
        <p>No plays recorded yet.</p>
        <p class="text-xs mt-2 opacity-60">Tap the <i data-lucide="plus" class="w-3 h-3 inline"></i> button to log your first play.</p>
      </div>`;
    lucide.createIcons();
    return;
  }

  container.innerHTML = `
    <div class="space-y-3">
      ${plays.map((p, i) => `
        <div class="card bg-base-200 animate-fadeUp" style="--i:${i}">
          <div class="card-body p-3">
            <div class="flex items-start gap-3">
              ${p.game_thumbnail
                ? `<img src="${p.game_thumbnail}" class="w-12 h-12 rounded object-cover flex-shrink-0 cursor-pointer" onclick="openGameDetail('${p.game_id}')" />`
                : `<div class="w-12 h-12 rounded bg-base-300 flex items-center justify-center flex-shrink-0 cursor-pointer" onclick="openGameDetail('${p.game_id}')"><i data-lucide="dice-6" class="w-6 h-6 opacity-40"></i></div>`
              }
              <div class="flex-1 min-w-0">
                <h3 class="font-semibold text-sm leading-tight">
                  <a class="link link-hover" onclick="openGameDetail('${p.game_id}')">${p.game_name}</a>
                </h3>
                <p class="text-xs text-base-content/50 mt-0.5">${formatDate(p.played_at)}</p>
                ${p.players.length ? `
                  <div class="flex flex-wrap gap-1 mt-1.5">
                    ${p.players.map(pl => `
                      <span class="badge badge-sm ${pl.is_winner ? 'badge-warning' : 'badge-ghost'}">
                        ${pl.is_winner ? '<i data-lucide="trophy" class="w-3 h-3 inline mr-0.5"></i>' : ''}${pl.name}
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
