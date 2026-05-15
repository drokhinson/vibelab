// play-detail.js — Read-only detail view for a single logged play.
//
// Reached by clicking any row in the play log. Surfaces the data the bubble
// captures on save (per-player score, expansions used, photo, notes) and
// offers an "Edit" button that re-opens the session bubble in edit mode.

async function openPlayDetail(playId) {
  showView("play-detail");
  const container = document.getElementById("play-detail-content");
  container.innerHTML = `<div class="flex justify-center py-12">${buddyLoader('lg')}</div>`;
  try {
    const play = await apiFetch(`/plays/${playId}`);
    renderPlayDetail(play);
  } catch (err) {
    container.innerHTML = `<div class="text-error text-center py-8">${escapeHtml(err.message)}</div>`;
  }
}

function renderPlayDetail(p) {
  const container = document.getElementById("play-detail-content");
  const thumb = p.game_thumbnail
    ? `<img src="${escapeAttr(p.game_thumbnail)}" class="w-14 h-14 rounded object-cover flex-shrink-0 cursor-pointer" onclick="openGameDetail('${p.game_id}')" />`
    : `<div class="w-14 h-14 rounded bg-base-300 flex items-center justify-center flex-shrink-0 cursor-pointer" onclick="openGameDetail('${p.game_id}')"><i data-lucide="dice-6" class="w-6 h-6 opacity-40"></i></div>`;

  // Sort players: winners first, then by score desc, then by name.
  const players = (p.players || []).slice().sort((a, b) => {
    if (a.is_winner !== b.is_winner) return a.is_winner ? -1 : 1;
    const sa = a.score == null ? -Infinity : a.score;
    const sb = b.score == null ? -Infinity : b.score;
    if (sb !== sa) return sb - sa;
    return (a.name || "").localeCompare(b.name || "");
  });
  const hasAnyScore = players.some(pl => pl.score != null);

  container.innerHTML = `
    <div class="flex items-center gap-2 mb-3">
      <button class="btn btn-ghost btn-sm btn-square"
              onclick="showView('history'); loadPlays();" aria-label="Back">
        <i data-lucide="arrow-left" class="w-5 h-5"></i>
      </button>
      <h2 class="text-lg font-bold flex-1 truncate">Play details</h2>
      ${p.is_own ? `
        <button class="btn btn-sm btn-primary"
                onclick="openSession({ playId: '${p.id}' })">
          <i data-lucide="pencil" class="w-4 h-4"></i> Edit
        </button>
        <button class="btn btn-sm btn-ghost btn-square"
                title="Delete play" onclick="_deletePlayFromDetail('${p.id}')">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>` : ""}
    </div>

    <div class="card bg-base-200 mb-4">
      <div class="card-body p-3 flex flex-row items-center gap-3">
        ${thumb}
        <div class="flex-1 min-w-0">
          <h3 class="font-semibold text-base leading-tight">
            <a class="link link-hover" onclick="openGameDetail('${p.game_id}')">${escapeHtml(p.game_name)}</a>
          </h3>
          <p class="text-xs text-base-content/60">${formatDate(p.played_at)}</p>
          ${p.is_own ? "" : `<p class="text-xs text-base-content/50 mt-0.5">logged by ${escapeHtml(p.logged_by_name)}</p>`}
        </div>
      </div>
    </div>

    ${p.photo_url ? `
      <a href="${escapeAttr(p.photo_url)}" target="_blank" rel="noopener" class="block mb-4">
        <img src="${escapeAttr(p.photo_url)}" class="play-photo" alt="Play photo" />
      </a>` : ""}

    ${players.length ? `
      <section class="mb-4">
        <h3 class="text-sm font-bold mb-2 flex items-center gap-2">
          <i data-lucide="users" class="w-4 h-4"></i> Players
        </h3>
        <ul class="space-y-1">
          ${players.map(pl => `
            <li class="flex items-center gap-2 px-2 py-1.5 rounded bg-base-200">
              <span class="avatar-bubble avatar-bubble--xs">${escapeHtml(computeInitials(pl.name))}</span>
              <span class="flex-1 truncate ${pl.is_winner ? 'font-semibold' : ''}">${escapeHtml(pl.name)}</span>
              ${pl.is_winner ? '<i data-lucide="trophy" class="w-4 h-4 text-warning"></i>' : ''}
              ${hasAnyScore ? `<span class="font-mono text-sm ${pl.is_winner ? 'font-bold' : 'opacity-70'}">${pl.score != null ? pl.score : '—'}</span>` : ""}
            </li>`).join("")}
        </ul>
      </section>` : ""}

    ${p.expansions?.length ? `
      <section class="mb-4">
        <h3 class="text-sm font-bold mb-2 flex items-center gap-2">
          <i data-lucide="puzzle" class="w-4 h-4"></i> Expansions used
        </h3>
        <div class="expansion-chip-row">
          ${p.expansions.map(e => `
            <span class="expansion-chip expansion-chip--static"
                  style="background:${escapeAttr((e.color || '#6C63FF') + '26')}; border-color:${escapeAttr(e.color || '#6C63FF')};">
              <span class="expansion-dot" style="background:${escapeAttr(e.color || '#6C63FF')}"></span>
              <span>${escapeHtml(stripBaseName(e.name, p.game_name))}</span>
            </span>`).join("")}
        </div>
      </section>` : ""}

    ${p.notes ? `
      <section class="mb-4">
        <h3 class="text-sm font-bold mb-2 flex items-center gap-2">
          <i data-lucide="sticky-note" class="w-4 h-4"></i> Notes
        </h3>
        <p class="text-sm whitespace-pre-wrap bg-base-200 rounded p-3">${escapeHtml(p.notes)}</p>
      </section>` : ""}
  `;
  if (window.lucide) window.lucide.createIcons();
}

async function _deletePlayFromDetail(playId) {
  if (!confirm("Delete this play?")) return;
  try {
    await apiFetch(`/plays/${playId}`, { method: "DELETE" });
    showToast("Play deleted", "info");
    showView("history");
    loadPlays();
  } catch (err) {
    showToast(err.message, "error");
  }
}
