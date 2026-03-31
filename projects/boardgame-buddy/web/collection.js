// collection.js — User's game collection: closet / played / wishlist

async function loadCollection() {
  const container = document.getElementById("collection-grid");
  container.innerHTML = '<div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>';

  try {
    const params = collectionFilter !== "all" ? `?status=${collectionFilter}` : "";
    collectionItems = await apiFetch(`/collection${params}`);
    renderCollection();
  } catch (err) {
    container.innerHTML = `<div class="text-error text-center py-8">${err.message}</div>`;
  }
}

function renderCollection() {
  const container = document.getElementById("collection-grid");

  if (!collectionItems.length) {
    const label = collectionFilter === "all" ? "collection" : collectionFilter + " list";
    container.innerHTML = `
      <div class="text-center py-12 text-base-content/50">
        <div class="text-5xl mb-4">📦</div>
        <p>Your ${label} is empty.</p>
        <button class="btn btn-primary btn-sm mt-4" onclick="showView('browse'); loadGames();">Browse Games</button>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="grid grid-cols-1 gap-3">
      ${collectionItems.map((item, i) => {
        const g = item.game;
        const statusBadge = {
          owned: "badge-success",
          played: "badge-info",
          wishlist: "badge-warning",
        }[item.status] || "badge-ghost";

        return `
          <div class="card card-side bg-base-200 h-24 cursor-pointer hover:shadow-md transition-all animate-fadeUp"
               style="--i:${i}" onclick="openGameDetail('${g.id}')">
            <figure class="w-20 flex-shrink-0">
              <img src="${g.thumbnail_url || ''}" alt="${g.name}" class="w-full h-full object-cover" loading="lazy" />
            </figure>
            <div class="card-body p-3 justify-center">
              <h3 class="font-semibold text-sm leading-tight line-clamp-1">${g.name}</h3>
              <div class="flex items-center gap-2 mt-1">
                <span class="badge badge-sm ${statusBadge}">${item.status}</span>
                ${g.bgg_rating ? `<span class="text-xs text-base-content/60">★ ${formatRating(g.bgg_rating)}</span>` : ""}
                <span class="text-xs text-base-content/50">${playerRange(g.min_players, g.max_players)}</span>
              </div>
            </div>
            <button class="btn btn-ghost btn-sm self-center mr-2" onclick="event.stopPropagation(); removeFromCollection('${g.id}')">
              <i data-lucide="x" class="w-4 h-4"></i>
            </button>
          </div>`;
      }).join("")}
    </div>
  `;
  lucide.createIcons();
}

function setCollectionFilter(filter) {
  collectionFilter = filter;
  document.querySelectorAll("#collection-tabs .tab").forEach(t => {
    t.classList.toggle("tab-active", t.dataset.filter === filter);
  });
  loadCollection();
}

async function addToCollection(gameId, status) {
  try {
    await apiFetch("/collection", {
      method: "POST",
      body: { game_id: gameId, status },
    });
    showToast(`Added to ${status}!`, "success");
    // Update detail view buttons
    if (currentGame && currentGame.id === gameId) {
      renderCollectionButtons(gameId);
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function updateCollectionStatus(gameId, newStatus) {
  try {
    await apiFetch(`/collection/${gameId}`, {
      method: "PATCH",
      body: { status: newStatus },
    });
    showToast(`Moved to ${newStatus}`, "success");
    renderCollectionButtons(gameId);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function removeFromCollection(gameId) {
  try {
    await apiFetch(`/collection/${gameId}`, { method: "DELETE" });
    showToast("Removed from collection", "info");
    if (currentView === "collection") loadCollection();
    if (currentGame && currentGame.id === gameId) renderCollectionButtons(gameId);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function renderCollectionButtons(gameId) {
  const container = document.getElementById("collection-actions");
  if (!container) return;

  // Check current status
  try {
    const items = await apiFetch("/collection");
    const existing = items.find(i => i.game_id === gameId);

    if (existing) {
      const statuses = ["owned", "played", "wishlist"];
      container.innerHTML = `
        <div class="flex gap-2 flex-wrap">
          ${statuses.map(s => `
            <button class="btn btn-sm ${existing.status === s ? 'btn-primary' : 'btn-outline'}"
                    onclick="updateCollectionStatus('${gameId}', '${s}')">
              ${s === "owned" ? "📦" : s === "played" ? "🎯" : "⭐"} ${s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          `).join("")}
          <button class="btn btn-sm btn-ghost text-error" onclick="removeFromCollection('${gameId}')">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>`;
    } else {
      container.innerHTML = `
        <div class="flex gap-2 flex-wrap">
          <button class="btn btn-sm btn-primary" onclick="addToCollection('${gameId}', 'owned')">📦 Own It</button>
          <button class="btn btn-sm btn-outline" onclick="addToCollection('${gameId}', 'played')">🎯 Played</button>
          <button class="btn btn-sm btn-outline" onclick="addToCollection('${gameId}', 'wishlist')">⭐ Wishlist</button>
        </div>`;
    }
    lucide.createIcons();
  } catch {
    container.innerHTML = '<p class="text-sm text-base-content/50">Log in to add to collection</p>';
  }
}
