// buddies.js — Buddies tab on the account page: list, link modal, profile search.
// Used from profile.js (switchProfileTab("buddies") -> renderBuddiesTab()).

let buddySearchTimer = null;
let buddyLinkTargetId = null;
let buddyLinkTargetName = null;
let addBuddySearchTimer = null;

function computeInitials(name) {
  const parts = (name || "").trim().split(/[\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] || "?").slice(0, 2).toUpperCase();
}

async function renderBuddiesTab() {
  const container = document.getElementById("profile-tab-content");
  container.innerHTML = `<div class="flex justify-center py-8"><span class="loading loading-spinner loading-md"></span></div>`;

  try {
    buddies = await apiFetch("/buddies");
  } catch (err) {
    container.innerHTML = `<div class="text-error text-center py-8">${escapeHtml(err.message)}</div>`;
    return;
  }

  if (!buddies.length) {
    container.innerHTML = `
      <div class="text-center py-12 text-base-content/50">
        <i data-lucide="users" class="w-12 h-12 mb-4 opacity-50"></i>
        <p>No buddies yet.</p>
        <p class="text-xs mt-2 opacity-60">Add players when you log a play and they'll show up here.</p>
        <button class="btn btn-primary btn-sm mt-4" onclick="openAddBuddyModal()">
          <i data-lucide="user-plus" class="w-4 h-4"></i> Add Buddy
        </button>
      </div>
      ${renderAddBuddyDialog()}`;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  container.innerHTML = `
    <div class="flex justify-between items-center mb-3">
      <span class="font-semibold text-sm">Buddies</span>
      <button class="btn btn-primary btn-sm" onclick="openAddBuddyModal()">
        <i data-lucide="user-plus" class="w-4 h-4"></i> Add
      </button>
    </div>
    <ul class="menu bg-base-200 rounded-box p-2 gap-1">
      ${buddies.map((b, i) => renderBuddyRow(b, i)).join("")}
    </ul>
    ${renderLinkBuddyDialog()}
    ${renderAddBuddyDialog()}
  `;
  if (window.lucide) window.lucide.createIcons();
}

function renderBuddyRow(b, i) {
  const linked = !!b.linked_user_id;
  const display = linked ? (b.linked_display_name || b.name) : b.name;
  const playLabel = b.play_count === 1 ? "1 game" : `${b.play_count} games`;
  const avatarColors = linked
    ? "bg-success/20 text-success"
    : "bg-base-300 text-base-content";
  return `
    <li class="animate-fadeUp" style="--i:${i}">
      <div class="flex items-center gap-3 px-2 py-2 bg-base-100 rounded-lg">
        <div class="avatar placeholder">
          <div class="${avatarColors} w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold">
            <span>${computeInitials(display)}</span>
          </div>
        </div>
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-sm truncate">${escapeHtml(display)}</div>
          <div class="text-xs text-base-content/60">${playLabel}${linked ? " · linked" : ""}</div>
        </div>
        ${linked
          ? `<span class="badge badge-success badge-sm gap-1"><i data-lucide="link" class="w-3 h-3"></i> linked</span>`
          : `<button class="btn btn-ghost btn-xs" onclick="openLinkBuddyModal('${b.id}', ${escapeHtml(JSON.stringify(b.name))})">
               <i data-lucide="link" class="w-3 h-3"></i> Link
             </button>`}
      </div>
    </li>
  `;
}

// ── Link modal ───────────────────────────────────────────────────────────────

function renderLinkBuddyDialog() {
  return `
    <dialog id="link-buddy-dialog" class="modal">
      <div class="modal-box max-w-md">
        <h3 class="font-bold text-lg mb-1">Link buddy</h3>
        <p id="link-buddy-subtitle" class="text-xs text-base-content/60 mb-3"></p>
        <input id="link-buddy-search" type="text" autocomplete="off"
               class="input input-bordered input-sm w-full"
               placeholder="Search by display name..." />
        <div id="link-buddy-results" class="mt-3 space-y-1 min-h-12"></div>
        <div class="modal-action">
          <form method="dialog">
            <button class="btn btn-ghost btn-sm">Cancel</button>
          </form>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>
  `;
}

function openLinkBuddyModal(buddyId, buddyName) {
  buddyLinkTargetId = buddyId;
  buddyLinkTargetName = buddyName;
  const dlg = document.getElementById("link-buddy-dialog");
  if (!dlg) return;

  document.getElementById("link-buddy-subtitle").textContent =
    `Linking "${buddyName}" to a BoardgameBuddy account.`;
  const input = document.getElementById("link-buddy-search");
  input.value = "";
  document.getElementById("link-buddy-results").innerHTML =
    `<p class="text-xs text-base-content/50 px-1">Type at least 2 characters.</p>`;
  input.oninput = (e) => onBuddySearchInput(e.target.value);

  dlg.showModal();
  setTimeout(() => input.focus(), 50);
}

function onBuddySearchInput(q) {
  clearTimeout(buddySearchTimer);
  const out = document.getElementById("link-buddy-results");
  if (!q || q.trim().length < 2) {
    out.innerHTML = `<p class="text-xs text-base-content/50 px-1">Type at least 2 characters.</p>`;
    return;
  }
  buddySearchTimer = setTimeout(() => doBuddySearch(q.trim()), 250);
}

async function doBuddySearch(q) {
  const out = document.getElementById("link-buddy-results");
  out.innerHTML = `<div class="flex justify-center py-3"><span class="loading loading-spinner loading-sm"></span></div>`;
  let results = [];
  try {
    results = await apiFetch(`/profiles/search?q=${encodeURIComponent(q)}`);
  } catch (err) {
    out.innerHTML = `<div class="text-error text-xs px-1">${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!results.length) {
    out.innerHTML = `<p class="text-xs text-base-content/50 px-1">No matching accounts.</p>`;
    return;
  }
  out.innerHTML = results.map(r => `
    <button type="button" class="btn btn-ghost btn-sm w-full justify-start text-left h-auto py-2"
            onclick="confirmLinkBuddy('${r.id}', ${escapeHtml(JSON.stringify(r.display_name))})">
      <div class="flex items-center gap-2">
        <div class="avatar placeholder">
          <div class="bg-base-300 text-base-content w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold">
            <span>${computeInitials(r.display_name)}</span>
          </div>
        </div>
        <div class="flex flex-col items-start">
          <span class="font-semibold text-sm">${escapeHtml(r.display_name)}</span>
          ${r.email ? `<span class="text-xs text-base-content/60">${escapeHtml(r.email)}</span>` : ""}
        </div>
      </div>
    </button>
  `).join("");
}

async function confirmLinkBuddy(targetUserId, targetDisplayName) {
  if (!buddyLinkTargetId) return;
  const ok = confirm(
    `Link "${buddyLinkTargetName}" to ${targetDisplayName}?\n\n` +
    `This is permanent. The free-text name will be replaced everywhere with their account, ` +
    `and they'll see these games in their own log.`
  );
  if (!ok) return;
  try {
    await apiFetch(`/buddies/${buddyLinkTargetId}/link`, {
      method: "POST",
      body: { user_id: targetUserId },
    });
    document.getElementById("link-buddy-dialog")?.close();
    showToast(`Linked to ${targetDisplayName}.`, "success");
    buddyLinkTargetId = null;
    buddyLinkTargetName = null;
    renderBuddiesTab();
  } catch (err) {
    showToast(err.message || "Could not link buddy.", "error");
  }
}

// ── Add buddy modal ──────────────────────────────────────────────────────────

function renderAddBuddyDialog() {
  return `
    <dialog id="add-buddy-dialog" class="modal">
      <div class="modal-box max-w-md">
        <h3 class="font-bold text-lg mb-1">Add buddy</h3>
        <p class="text-xs text-base-content/60 mb-3">Search for a BoardgameBuddy user to add.</p>
        <input id="add-buddy-search" type="text" autocomplete="off"
               class="input input-bordered input-sm w-full"
               placeholder="Search by display name..." />
        <div id="add-buddy-results" class="mt-3 space-y-1 min-h-12"></div>
        <div class="modal-action">
          <form method="dialog">
            <button class="btn btn-ghost btn-sm">Cancel</button>
          </form>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>
  `;
}

function openAddBuddyModal() {
  const dlg = document.getElementById("add-buddy-dialog");
  if (!dlg) return;
  const input = document.getElementById("add-buddy-search");
  input.value = "";
  document.getElementById("add-buddy-results").innerHTML =
    `<p class="text-xs text-base-content/50 px-1">Type at least 2 characters.</p>`;
  input.oninput = (e) => onAddBuddySearchInput(e.target.value);
  dlg.showModal();
  setTimeout(() => input.focus(), 50);
}

function onAddBuddySearchInput(q) {
  clearTimeout(addBuddySearchTimer);
  const out = document.getElementById("add-buddy-results");
  if (!q || q.trim().length < 2) {
    out.innerHTML = `<p class="text-xs text-base-content/50 px-1">Type at least 2 characters.</p>`;
    return;
  }
  addBuddySearchTimer = setTimeout(() => doAddBuddySearch(q.trim()), 250);
}

async function doAddBuddySearch(q) {
  const out = document.getElementById("add-buddy-results");
  out.innerHTML = `<div class="flex justify-center py-3"><span class="loading loading-spinner loading-sm"></span></div>`;
  let results = [];
  try {
    results = await apiFetch(`/profiles/search?q=${encodeURIComponent(q)}`);
  } catch (err) {
    out.innerHTML = `<div class="text-error text-xs px-1">${escapeHtml(err.message)}</div>`;
    return;
  }

  const linkedIds = new Set((buddies || []).filter(b => b.linked_user_id).map(b => b.linked_user_id));
  const available = results.filter(r => !linkedIds.has(r.id));

  if (!available.length) {
    const msg = results.length ? "Already in your buddy list." : "No matching accounts.";
    out.innerHTML = `<p class="text-xs text-base-content/50 px-1">${msg}</p>`;
    return;
  }

  out.innerHTML = available.map(r => `
    <button type="button" class="btn btn-ghost btn-sm w-full justify-start text-left h-auto py-2"
            onclick="confirmAddBuddy('${r.id}', ${escapeHtml(JSON.stringify(r.display_name))})">
      <div class="flex items-center gap-2">
        <div class="avatar placeholder">
          <div class="bg-primary/20 text-primary w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold">
            <span>${computeInitials(r.display_name)}</span>
          </div>
        </div>
        <div class="flex flex-col items-start">
          <span class="font-semibold text-sm">${escapeHtml(r.display_name)}</span>
          ${r.email ? `<span class="text-xs text-base-content/60">${escapeHtml(r.email)}</span>` : ""}
        </div>
      </div>
    </button>
  `).join("");
}

async function confirmAddBuddy(targetUserId, targetDisplayName) {
  try {
    await apiFetch("/buddies", {
      method: "POST",
      body: { user_id: targetUserId },
    });
    document.getElementById("add-buddy-dialog")?.close();
    showToast(`${escapeHtml(targetDisplayName)} added as a buddy!`, "success");
    renderBuddiesTab();
  } catch (err) {
    showToast(err.message || "Could not add buddy.", "error");
  }
}
