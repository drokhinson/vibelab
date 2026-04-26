// session.js — Floating "Log a Play" session bubble
//
// Replaces the old standalone Log a Play view. Tapping the global "+" FAB
// opens a floating panel that tracks game + players + per-round scores +
// notes; the panel can be minimized back into the FAB while the session
// stays alive on the server (boardgamebuddy_play_drafts), so the user can
// flip to the Quick Reference guide mid-game and come back.

const TODAY = () => new Date().toISOString().split("T")[0];

function emptySession() {
  const seedName = currentUser?.display_name || "";
  return {
    game_id: null,
    game_name: null,
    game_thumbnail: null,
    played_at: TODAY(),
    notes: "",
    players: [{
      name: seedName,
      initials: seedName ? computeInitials(seedName) : "",
      round_scores: [0],
      is_winner_override: null,
    }],
    round_count: 1,
  };
}

// "Meaningful" = worth showing the FAB as active. An empty bubble that the
// user opened and never touched should not flag the FAB.
function isSessionMeaningful(s) {
  if (!s) return false;
  if (s.game_id) return true;
  if ((s.notes || "").trim()) return true;
  if ((s.players || []).length > 1) return true;
  return (s.players || []).some(
    p => (p.round_scores || []).some(v => Number(v) !== 0),
  );
}

function padScores(arr, len) {
  const out = (arr || []).slice(0, len).map(v => Number(v) || 0);
  while (out.length < len) out.push(0);
  return out;
}

function normalizeSession(s) {
  s.notes = s.notes || "";
  s.played_at = s.played_at || TODAY();
  s.round_count = Math.max(1, s.round_count || 1);
  s.players = (s.players || []).map(p => {
    const name = p.name || "";
    return {
      name,
      initials: (p.initials || (name ? computeInitials(name) : "")).toUpperCase().slice(0, 3),
      is_winner_override: p.is_winner_override ?? null,
      round_scores: padScores(p.round_scores, s.round_count),
    };
  });
  if (!s.players.length) {
    const seedName = currentUser?.display_name || "";
    s.players.push({
      name: seedName,
      initials: seedName ? computeInitials(seedName) : "",
      round_scores: padScores([], s.round_count),
      is_winner_override: null,
    });
  }
}

// ── Bootstrap & FAB state ────────────────────────────────────────────────────

async function initSession() {
  try {
    activeSession = await apiFetch("/plays/draft");
    if (activeSession) normalizeSession(activeSession);
  } catch {
    activeSession = null;
  }
  refreshSessionFab();
  // Buddies list is used by the player-name autocomplete inside the bubble.
  if (!buddies.length) {
    try { buddies = await apiFetch("/buddies"); } catch { /* ignore */ }
  }
}

function refreshSessionFab() {
  const fab = document.getElementById("session-fab");
  if (!fab) return;
  if (!session) { fab.classList.add("hidden"); return; }
  fab.classList.remove("hidden");

  const active = isSessionMeaningful(activeSession);
  fab.classList.toggle("fab-log-play--active", active);
  fab.innerHTML = active
    ? '<i data-lucide="dice-5" class="w-6 h-6"></i>'
    : '<i data-lucide="plus" class="w-6 h-6"></i>';
  if (window.lucide) window.lucide.createIcons();
}

// ── Open / minimize ──────────────────────────────────────────────────────────

function toggleSessionBubble() {
  if (sessionExpanded) { minimizeSession(); return; }
  // If the user taps "+" on a game-detail view with no game already selected
  // in the session, pre-seed the open game — matches the old per-page FAB.
  const seed = (currentView === "game-detail" && currentGame &&
    (!activeSession || !activeSession.game_id))
    ? { gameId: currentGame.id, gameName: currentGame.name, gameThumb: currentGame.thumbnail_url }
    : {};
  openSession(seed);
}

function openSession({ gameId, gameName, gameThumb } = {}) {
  if (!activeSession) activeSession = emptySession();

  if (gameId && !activeSession.game_id) {
    activeSession.game_id = gameId;
    activeSession.game_name = gameName || null;
    activeSession.game_thumbnail = gameThumb || null;
    scheduleDraftSave();
  } else if (gameId && activeSession.game_id && activeSession.game_id !== gameId) {
    const prev = activeSession.game_name || "current game";
    if (confirm(`Replace ${prev} with ${gameName || "this game"} in the active session?`)) {
      activeSession.game_id = gameId;
      activeSession.game_name = gameName || null;
      activeSession.game_thumbnail = gameThumb || null;
      scheduleDraftSave();
    }
  }

  sessionExpanded = true;
  document.getElementById("session-backdrop").classList.remove("hidden");
  document.getElementById("session-panel").classList.remove("hidden");
  renderSessionPanel();
}

function minimizeSession() {
  sessionExpanded = false;
  document.getElementById("session-backdrop").classList.add("hidden");
  document.getElementById("session-panel").classList.add("hidden");
  refreshSessionFab();
}

// ── Debounced draft sync ─────────────────────────────────────────────────────

function scheduleDraftSave() {
  refreshSessionFab();
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveDraftNow, 600);
}

async function saveDraftNow() {
  if (!session || !activeSession) return;
  const body = {
    game_id: activeSession.game_id,
    played_at: activeSession.played_at,
    notes: activeSession.notes || null,
    players: activeSession.players.map(p => ({
      name: p.name,
      initials: p.initials || null,
      is_winner_override: p.is_winner_override,
      round_scores: p.round_scores,
    })),
    round_count: activeSession.round_count,
  };
  try {
    const updated = await apiFetch("/plays/draft", { method: "PUT", body });
    activeSession.updated_at = updated.updated_at;
    if (updated.game_name)      activeSession.game_name = updated.game_name;
    if (updated.game_thumbnail) activeSession.game_thumbnail = updated.game_thumbnail;
  } catch (err) {
    showToast("Couldn't save draft: " + err.message, "error");
  }
}

// ── Mutations ────────────────────────────────────────────────────────────────

function addPlayer(name = "", initials = "") {
  activeSession.players.push({
    name,
    initials: (initials || (name ? computeInitials(name) : "")).toUpperCase().slice(0, 3),
    is_winner_override: null,
    round_scores: padScores([], activeSession.round_count),
  });
  scheduleDraftSave();
  renderSessionPanel();
}

function removePlayer(idx) {
  activeSession.players.splice(idx, 1);
  if (!activeSession.players.length) {
    activeSession.players.push({
      name: "",
      initials: "",
      is_winner_override: null,
      round_scores: padScores([], activeSession.round_count),
    });
  }
  scheduleDraftSave();
  renderSessionPanel();
}

function addRound() {
  activeSession.round_count += 1;
  for (const p of activeSession.players) p.round_scores.push(0);
  scheduleDraftSave();
  renderSessionPanel();
}

function removeRound(idx) {
  if (activeSession.round_count <= 1) return;
  activeSession.round_count -= 1;
  for (const p of activeSession.players) p.round_scores.splice(idx, 1);
  scheduleDraftSave();
  renderSessionPanel();
}

function setScore(playerIdx, roundIdx, value) {
  const v = Number(value);
  activeSession.players[playerIdx].round_scores[roundIdx] = isNaN(v) ? 0 : v;
  // Re-render only the totals so the input keeps focus.
  renderTotalsRow();
  scheduleDraftSave();
}

function setPlayerName(idx, name) {
  activeSession.players[idx].name = name;
  scheduleDraftSave();
}

// Append "2", "3", ... if `base` collides with another player's initials.
// If base is already 3 chars, replace the last char with the digit ("ABC" → "AB2").
// `excludeIdx` skips a specific player (used during edits).
function disambiguateInitials(base, excludeIdx = -1) {
  const used = new Set(
    activeSession.players
      .map((p, i) => (i === excludeIdx ? null : (p.initials || "").toUpperCase()))
      .filter(Boolean),
  );
  const candidate = (base || "").toUpperCase().slice(0, 3);
  if (!candidate) return "";
  if (!used.has(candidate)) return candidate;
  const stem = candidate.length >= 3 ? candidate.slice(0, 2) : candidate;
  for (let n = 2; n < 100; n++) {
    const next = stem + n;
    if (!used.has(next)) return next;
  }
  return candidate;
}

// ── Add / edit player form ───────────────────────────────────────────────────

let editingPlayerIdx = null;

function openAddPlayerForm() {
  editingPlayerIdx = null;
  const form = document.getElementById("session-add-player");
  if (!form) return;
  form.classList.remove("hidden");
  document.getElementById("session-add-player-title").textContent = "Add player";
  document.getElementById("session-add-player-confirm").textContent = "Add";
  const nameInput = document.getElementById("add-player-name");
  const initialsInput = document.getElementById("add-player-initials");
  nameInput.value = "";
  initialsInput.value = "";
  initialsInput.dataset.userEdited = "false";
  nameInput.focus();
}

function openEditPlayer(idx) {
  editingPlayerIdx = idx;
  const p = activeSession.players[idx];
  const form = document.getElementById("session-add-player");
  if (!form) return;
  form.classList.remove("hidden");
  document.getElementById("session-add-player-title").textContent = "Edit player";
  document.getElementById("session-add-player-confirm").textContent = "Save";
  const nameInput = document.getElementById("add-player-name");
  const initialsInput = document.getElementById("add-player-initials");
  nameInput.value = p.name || "";
  initialsInput.value = p.initials || "";
  initialsInput.dataset.userEdited = "true";
  nameInput.focus();
}

function cancelAddPlayer() {
  editingPlayerIdx = null;
  const form = document.getElementById("session-add-player");
  if (!form) return;
  form.classList.add("hidden");
  document.getElementById("add-player-name").value = "";
  document.getElementById("add-player-initials").value = "";
}

function onAddPlayerNameInput(name) {
  const initialsInput = document.getElementById("add-player-initials");
  if (!initialsInput) return;
  // Auto-populate initials only if the user hasn't manually edited the field.
  if (initialsInput.dataset.userEdited === "true") return;
  const base = name ? computeInitials(name) : "";
  initialsInput.value = disambiguateInitials(base, editingPlayerIdx ?? -1);
}

function onAddPlayerNameChange(name) {
  // If the typed value matches a buddy's display name, snap to the canonical form.
  const trimmed = (name || "").trim();
  if (!trimmed) return;
  const match = (buddies || []).find(b => {
    const display = b.linked_display_name || b.name;
    return display && display.toLowerCase() === trimmed.toLowerCase();
  });
  if (match) {
    const display = match.linked_display_name || match.name;
    const nameInput = document.getElementById("add-player-name");
    if (nameInput) nameInput.value = display;
    onAddPlayerNameInput(display);
  }
}

function onAddPlayerInitialsInput(value) {
  const initialsInput = document.getElementById("add-player-initials");
  if (!initialsInput) return;
  initialsInput.dataset.userEdited = "true";
  initialsInput.value = (value || "").toUpperCase().slice(0, 3);
}

function confirmAddPlayer() {
  const nameInput = document.getElementById("add-player-name");
  const initialsInput = document.getElementById("add-player-initials");
  const name = (nameInput?.value || "").trim();
  if (!name) {
    nameInput?.focus();
    return;
  }
  const rawInitials = (initialsInput?.value || "").trim() || computeInitials(name);
  const excludeIdx = editingPlayerIdx ?? -1;
  const initials = disambiguateInitials(rawInitials, excludeIdx);

  if (editingPlayerIdx === null) {
    addPlayer(name, initials);
  } else {
    const p = activeSession.players[editingPlayerIdx];
    p.name = name;
    p.initials = initials;
    scheduleDraftSave();
    renderSessionPanel();
  }
  cancelAddPlayer();
}

function setWinnerOverride(idx) {
  // Click trophy → mark this player as the winner. Click an existing winner →
  // clear back to auto.
  const cur = activeSession.players[idx].is_winner_override;
  // Clear all overrides first so we model "single override = winner".
  for (const p of activeSession.players) p.is_winner_override = null;
  activeSession.players[idx].is_winner_override = (cur === true) ? null : true;
  scheduleDraftSave();
  renderTotalsRow();
}

function setNotes(text) {
  activeSession.notes = text;
  scheduleDraftSave();
}

function setPlayedAt(date) {
  activeSession.played_at = date;
  scheduleDraftSave();
}

function setGameFromSearch(id, name, thumb) {
  activeSession.game_id = id;
  activeSession.game_name = name;
  activeSession.game_thumbnail = thumb || null;
  scheduleDraftSave();
  renderSessionPanel();
}

function clearSessionGame() {
  activeSession.game_id = null;
  activeSession.game_name = null;
  activeSession.game_thumbnail = null;
  scheduleDraftSave();
  renderSessionPanel();
}

// ── Save / Discard ───────────────────────────────────────────────────────────

function computeWinners(s) {
  // Manual override wins outright if any player is explicitly marked.
  const explicit = s.players
    .map((p, i) => p.is_winner_override === true ? i : -1)
    .filter(i => i >= 0);
  if (explicit.length) return new Set(explicit);

  const totals = s.players.map(
    p => (p.round_scores || []).reduce((a, b) => a + (Number(b) || 0), 0),
  );
  const allZero = totals.every(t => t === 0);
  if (allZero) return new Set();
  const max = Math.max(...totals);
  return new Set(totals.map((t, i) => t === max ? i : -1).filter(i => i >= 0));
}

async function saveSession() {
  if (!activeSession?.game_id) {
    showToast("Pick a game first", "warning");
    return;
  }
  const namedIdxMap = new Map();
  const named = [];
  activeSession.players.forEach((p, i) => {
    if (p.name && p.name.trim()) {
      namedIdxMap.set(i, named.length);
      named.push(p);
    }
  });
  if (!named.length) {
    showToast("Add at least one player", "warning");
    return;
  }

  const winners = computeWinners(activeSession);
  const namedWinners = new Set(
    [...winners].map(i => namedIdxMap.get(i)).filter(v => v !== undefined),
  );

  const body = {
    game_id: activeSession.game_id,
    played_at: activeSession.played_at || TODAY(),
    notes: (activeSession.notes && activeSession.notes.trim()) || null,
    players: named.map((p, j) => ({
      name: p.name.trim(),
      is_winner: namedWinners.has(j),
    })),
  };

  const btn = document.getElementById("session-save-btn");
  if (btn) { btn.classList.add("loading"); btn.disabled = true; }
  try {
    await apiFetch("/plays", { method: "POST", body });
    try { await apiFetch("/plays/draft", { method: "DELETE" }); } catch { /* ignore */ }
    activeSession = null;
    sessionExpanded = false;
    document.getElementById("session-backdrop").classList.add("hidden");
    document.getElementById("session-panel").classList.add("hidden");
    refreshSessionFab();
    showToast("Play logged!", "success");
    if (currentView === "history") loadPlays();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (btn) { btn.classList.remove("loading"); btn.disabled = false; }
  }
}

async function discardSession() {
  if (!confirm("Discard this in-progress session?")) return;
  try { await apiFetch("/plays/draft", { method: "DELETE" }); } catch { /* ignore */ }
  activeSession = null;
  sessionExpanded = false;
  document.getElementById("session-backdrop").classList.add("hidden");
  document.getElementById("session-panel").classList.add("hidden");
  refreshSessionFab();
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderSessionPanel() {
  const panel = document.getElementById("session-panel");
  const s = activeSession;
  panel.innerHTML = `
    <div class="flex items-center gap-2 mb-3">
      <i data-lucide="dice-5" class="w-5 h-5" style="color: var(--accent)"></i>
      <h3 class="font-bold text-base flex-1">Session</h3>
      <button class="btn btn-ghost btn-xs btn-square" title="Minimize" onclick="minimizeSession()">
        <i data-lucide="chevron-down" class="w-4 h-4"></i>
      </button>
    </div>

    <div class="mb-2">
      <label class="text-xs opacity-60">Game</label>
      <div id="session-game-slot"></div>
    </div>

    <div class="mb-2 flex items-center gap-2">
      <label class="text-xs opacity-60 w-10">Date</label>
      <input type="date" class="input input-bordered input-sm flex-1" value="${s.played_at}"
             onchange="setPlayedAt(this.value)" />
    </div>

    <div class="mb-2">
      <label class="text-xs opacity-60 mb-1 block">Scores</label>
      <div class="overflow-x-auto">
        <table class="session-grid"><thead></thead><tbody></tbody><tfoot></tfoot></table>
      </div>
      <div class="flex gap-2 mt-2">
        <button class="btn btn-ghost btn-xs" onclick="addRound()">
          <i data-lucide="plus" class="w-3 h-3"></i> Round
        </button>
        <button class="btn btn-ghost btn-xs" onclick="openAddPlayerForm()">
          <i data-lucide="user-plus" class="w-3 h-3"></i> Player
        </button>
      </div>
      <div id="session-add-player" class="hidden mt-2 p-2 rounded border border-base-content/10 bg-base-200/40">
        <div class="text-xs opacity-60 mb-1" id="session-add-player-title">Add player</div>
        <div class="flex gap-1 items-center">
          <input type="text" id="add-player-name"
                 class="input input-bordered input-xs flex-1 min-w-0"
                 placeholder="Player name" list="session-buddies"
                 oninput="onAddPlayerNameInput(this.value)"
                 onchange="onAddPlayerNameChange(this.value)" />
          <input type="text" id="add-player-initials" maxlength="3"
                 class="input input-bordered input-xs w-14 text-center"
                 placeholder="ABC"
                 oninput="onAddPlayerInitialsInput(this.value)" />
          <button id="session-add-player-confirm" class="btn btn-primary btn-xs"
                  onclick="confirmAddPlayer()">Add</button>
          <button class="btn btn-ghost btn-xs" onclick="cancelAddPlayer()">Cancel</button>
        </div>
      </div>
    </div>

    <datalist id="session-buddies">
      ${(buddies || []).map(b => `<option value="${escapeHtml(b.linked_display_name || b.name)}">`).join("")}
    </datalist>

    <div class="mb-3">
      <label class="text-xs opacity-60 block mb-1">Notes</label>
      <textarea class="textarea textarea-bordered textarea-sm w-full"
                placeholder="Fun moments, close calls..."
                oninput="setNotes(this.value)">${escapeHtml(s.notes || "")}</textarea>
    </div>

    <div class="flex gap-2">
      <button class="btn btn-ghost btn-sm flex-1" onclick="discardSession()">
        <i data-lucide="trash-2" class="w-4 h-4"></i> Discard
      </button>
      <button id="session-save-btn" class="btn btn-primary btn-sm flex-1" onclick="saveSession()">
        <i data-lucide="check" class="w-4 h-4"></i> Save Play
      </button>
    </div>
  `;
  renderGameSlot();
  renderGrid();
  lucide.createIcons();
}

function renderGameSlot() {
  const slot = document.getElementById("session-game-slot");
  const s = activeSession;
  if (s.game_id && s.game_name) {
    slot.innerHTML = `
      <div class="input input-bordered input-sm flex items-center gap-2">
        ${s.game_thumbnail ? `<img src="${s.game_thumbnail}" class="w-5 h-5 rounded object-cover" />` : ""}
        <span class="truncate flex-1">${escapeHtml(s.game_name)}</span>
        <button class="btn btn-ghost btn-xs" onclick="clearSessionGame()" title="Change game">
          <i data-lucide="x" class="w-3 h-3"></i>
        </button>
      </div>`;
  } else {
    slot.innerHTML = `
      <input type="text" id="session-game-search" class="input input-bordered input-sm w-full"
             placeholder="Search for a game..." oninput="searchSessionGame(this.value)" autofocus />
      <div id="session-game-results" class="mt-1"></div>`;
  }
}

let sessionGameSearchTimer = null;
async function searchSessionGame(q) {
  clearTimeout(sessionGameSearchTimer);
  if (q.length < 2) {
    document.getElementById("session-game-results").innerHTML = "";
    return;
  }
  sessionGameSearchTimer = setTimeout(async () => {
    try {
      const data = await apiFetch(`/games?search=${encodeURIComponent(q)}&per_page=5`);
      const out = document.getElementById("session-game-results");
      // Use data-attributes (safe under any name with quotes/HTML) + delegated click.
      out.innerHTML = data.games.map(g => `
        <button type="button" class="btn btn-ghost btn-xs w-full justify-start text-left session-game-pick"
                data-id="${g.id}"
                data-name="${escapeHtml(g.name)}"
                data-thumb="${escapeHtml(g.thumbnail_url || "")}">
          ${escapeHtml(g.name)}${g.year_published ? " (" + g.year_published + ")" : ""}
        </button>`).join("");
      out.querySelectorAll(".session-game-pick").forEach(btn => {
        btn.addEventListener("click", () => {
          setGameFromSearch(btn.dataset.id, btn.dataset.name, btn.dataset.thumb || null);
        });
      });
    } catch { /* ignore */ }
  }, 300);
}

function renderGrid() {
  renderGridHeader();
  renderGridBody();
  renderTotalsRow();
}

function renderGridHeader() {
  const thead = document.querySelector("#session-panel .session-grid thead");
  if (!thead) return;
  const s = activeSession;
  thead.innerHTML = `
    <tr>
      <th></th>
      ${s.players.map((p, i) => {
        const initials = p.initials || (p.name ? computeInitials(p.name) : `P${i+1}`);
        const fullName = p.name || `Player ${i+1}`;
        return `
        <th>
          <button class="player-header-btn" title="${escapeHtml(fullName)}"
                  aria-label="Edit ${escapeHtml(fullName)}"
                  onclick="openEditPlayer(${i})">
            ${escapeHtml(initials)}
          </button>
          ${s.players.length > 1 ? `
            <button class="btn btn-ghost btn-xs btn-square" title="Remove player"
                    onclick="removePlayer(${i})">
              <i data-lucide="x" class="w-3 h-3"></i>
            </button>` : ""}
        </th>`;
      }).join("")}
    </tr>`;
}

function renderGridBody() {
  const tbody = document.querySelector("#session-panel .session-grid tbody");
  if (!tbody) return;
  const s = activeSession;
  let rows = "";
  for (let r = 0; r < s.round_count; r++) {
    rows += `<tr>
      <th class="text-left text-xs opacity-60">
        R${r+1}
        ${s.round_count > 1 ? `
          <button class="btn btn-ghost btn-xs btn-square ml-1" title="Remove round"
                  onclick="removeRound(${r})">
            <i data-lucide="x" class="w-3 h-3"></i>
          </button>` : ""}
      </th>
      ${s.players.map((p, i) => `
        <td>
          <input type="number" inputmode="numeric"
                 class="input input-ghost input-xs text-center px-1"
                 value="${p.round_scores[r] ?? 0}"
                 oninput="setScore(${i}, ${r}, this.value)" />
        </td>`).join("")}
    </tr>`;
  }
  tbody.innerHTML = rows;
}

function renderTotalsRow() {
  const tfoot = document.querySelector("#session-panel .session-grid tfoot");
  if (!tfoot) return;
  const s = activeSession;
  const totals = s.players.map(
    p => (p.round_scores || []).reduce((a, b) => a + (Number(b) || 0), 0),
  );
  const winners = computeWinners(s);
  tfoot.innerHTML = `
    <tr>
      <th class="text-left text-xs">Total</th>
      ${s.players.map((p, i) => {
        const isWinner = winners.has(i);
        return `<td class="${isWinner ? "winner-cell" : ""}">
          <button class="btn btn-ghost btn-xs btn-square" title="${isWinner ? "Winner" : "Mark as winner"}"
                  onclick="setWinnerOverride(${i})">
            ${isWinner ? '<i data-lucide="trophy" class="w-3 h-3"></i>' : '<i data-lucide="circle" class="w-3 h-3 opacity-25"></i>'}
          </button>
          <span>${totals[i]}</span>
        </td>`;
      }).join("")}
    </tr>`;
  if (window.lucide) window.lucide.createIcons();
}
