// session.js — Floating "Log a Play" session bubble
//
// Replaces the old standalone Log a Play view. Tapping the global "+" FAB
// opens a floating panel that tracks game + players + per-round scores +
// notes; the panel can be minimized back into the FAB while the session
// stays alive on the server (boardgamebuddy_play_drafts).
//
// The bubble's "Reference" button overlays an in-place Quick Reference
// guide on top of the scoreboard so a player can look up a rule mid-game
// without losing scores. The session DOM is rebuilt on close (renderSessionPanel)
// so no state mutation is needed.

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
      round_scores: [],
      is_winner_override: null,
    }],
    round_count: 0,
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
  s.round_count = Math.max(0, Number(s.round_count) || 0);
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
  sessionDirty = false;
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
    // Seed the game in memory only — don't persist a draft until the user
    // actually does something. Closing without changes leaves no trace.
    activeSession.game_id = gameId;
    activeSession.game_name = gameName || null;
    activeSession.game_thumbnail = gameThumb || null;
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
  sessionShowingGuide = false;            // back to scoreboard on reopen
  document.getElementById("session-backdrop").classList.add("hidden");
  document.getElementById("session-panel").classList.add("hidden");
  // If the user opened the bubble but never made a real change, drop the
  // in-memory session so closing leaves no trace (no server draft was created).
  if (!sessionDirty && activeSession && !activeSession.updated_at) {
    activeSession = null;
  }
  refreshSessionFab();
}

// ── Debounced draft sync ─────────────────────────────────────────────────────

function scheduleDraftSave() {
  sessionDirty = true;
  refreshSessionFab();
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveDraftNow, 600);
}

async function saveDraftNow() {
  if (!session || !activeSession) return;
  if (!sessionDirty) return;
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
    // The user may have hit Save (which nulls activeSession) while this PUT
    // was in flight — drop the response in that case.
    if (!activeSession) return;
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
  if (activeSession.round_count <= 0) return;
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
  renderBuddySuggestions("");
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
  renderBuddySuggestions(nameInput.value);
  nameInput.focus();
}

function cancelAddPlayer() {
  editingPlayerIdx = null;
  const form = document.getElementById("session-add-player");
  if (!form) return;
  form.classList.add("hidden");
  document.getElementById("add-player-name").value = "";
  document.getElementById("add-player-initials").value = "";
  hideBuddySuggestions();
}

function onAddPlayerNameInput(name) {
  const initialsInput = document.getElementById("add-player-initials");
  if (initialsInput && initialsInput.dataset.userEdited !== "true") {
    const base = name ? computeInitials(name) : "";
    initialsInput.value = disambiguateInitials(base, editingPlayerIdx ?? -1);
  }
  renderBuddySuggestions(name);
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

function buddyDisplayName(b) {
  return b.linked_display_name || b.name || "";
}

function renderBuddySuggestions(query) {
  const panel = document.getElementById("buddy-suggestions");
  if (!panel) return;
  const q = (query || "").trim().toLowerCase();
  const usedNames = new Set(
    (activeSession?.players || [])
      .map((p, i) => i === editingPlayerIdx ? null : (p.name || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const all = (buddies || [])
    .map(b => ({ b, name: buddyDisplayName(b) }))
    .filter(({ name }) => name);
  const matches = q
    ? all.filter(({ name }) => name.toLowerCase().includes(q))
    : all;
  matches.sort((a, b) => a.name.localeCompare(b.name));

  const exact = q && matches.some(({ name }) => name.toLowerCase() === q);
  const newRow = (q && !exact) ? `
    <li class="px-2 py-1.5 rounded cursor-pointer hover:bg-base-200 text-sm flex items-center gap-2 text-base-content/70"
        onmousedown="event.preventDefault()"
        onclick="pickNewBuddy(${JSON.stringify(query)})">
      <i data-lucide="user-plus" class="w-3 h-3"></i>
      <span>Use "<span class="font-medium">${escapeHtml(query)}</span>" as new buddy</span>
    </li>` : "";

  const rows = matches.map(({ b, name }) => {
    const used = usedNames.has(name.toLowerCase());
    const initials = computeInitials(name);
    return `
      <li class="px-2 py-1.5 rounded cursor-pointer hover:bg-base-200 text-sm flex items-center gap-2 ${used ? 'opacity-40' : ''}"
          onmousedown="event.preventDefault()"
          onclick="pickBuddy(${JSON.stringify(name)})">
        <span class="avatar-bubble avatar-bubble--xs">${escapeHtml(initials)}</span>
        <span class="flex-1 truncate">${escapeHtml(name)}</span>
        ${b.play_count ? `<span class="text-xs opacity-50">${b.play_count}</span>` : ""}
      </li>`;
  }).join("");

  if (!rows && !newRow) {
    panel.innerHTML = `<div class="px-2 py-3 text-xs text-base-content/50 text-center">No buddies yet — type a name to add one.</div>`;
  } else {
    panel.innerHTML = `<ul class="max-h-48 overflow-y-auto space-y-0.5">${newRow}${rows}</ul>`;
  }
  panel.classList.remove("hidden");
  if (window.lucide) window.lucide.createIcons();
}

function showBuddySuggestions() {
  const nameInput = document.getElementById("add-player-name");
  renderBuddySuggestions(nameInput?.value || "");
}

function hideBuddySuggestions() {
  const panel = document.getElementById("buddy-suggestions");
  if (panel) panel.classList.add("hidden");
}

function onAddPlayerNameBlur() {
  // Delay so a click on a suggestion row registers before we hide.
  setTimeout(hideBuddySuggestions, 150);
}

function pickBuddy(name) {
  const nameInput = document.getElementById("add-player-name");
  const initialsInput = document.getElementById("add-player-initials");
  if (nameInput) nameInput.value = name;
  if (initialsInput) initialsInput.dataset.userEdited = "false";
  onAddPlayerNameInput(name);
  onAddPlayerNameChange(name);
  hideBuddySuggestions();
  initialsInput?.focus();
}

function pickNewBuddy(name) {
  const nameInput = document.getElementById("add-player-name");
  if (nameInput) nameInput.value = name;
  onAddPlayerNameInput(name);
  hideBuddySuggestions();
  document.getElementById("add-player-initials")?.focus();
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

  // Cancel any pending debounced draft save so it can't race the cleanup
  // below (and resurrect a draft we're about to delete).
  if (sessionSaveTimer) { clearTimeout(sessionSaveTimer); sessionSaveTimer = null; }

  const btn = document.getElementById("session-save-btn");
  if (btn) { btn.classList.add("loading"); btn.disabled = true; }
  try {
    await apiFetch("/plays", { method: "POST", body });
    try {
      await apiFetch("/plays/draft", { method: "DELETE" });
    } catch (err) {
      // Don't block the cleanup — the play is already logged. But surface
      // the failure so a stuck server draft doesn't silently resurrect.
      console.warn("Failed to delete play draft after save:", err);
    }
    activeSession = null;
    sessionDirty = false;
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
  sessionDirty = false;
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
      ${currentGame || activeSession?.game_id ? `
      <button class="btn btn-ghost btn-sm" title="View Quick Reference"
              onclick="openSessionGuide()">
        <i data-lucide="book-open" class="w-4 h-4"></i> Reference
      </button>` : ""}
      <button class="btn btn-ghost btn-sm btn-square" title="Minimize" onclick="minimizeSession()">
        <i data-lucide="chevron-down" class="w-5 h-5"></i>
      </button>
    </div>

    <div class="mb-2">
      <label class="text-xs opacity-60">Game</label>
      <div id="session-game-slot"></div>
    </div>

    <div class="mb-2 flex items-center gap-2">
      <label class="text-xs opacity-60 w-10">Date</label>
      <input type="date" class="input input-bordered flex-1" value="${s.played_at}"
             onchange="setPlayedAt(this.value)" />
    </div>

    <div class="mb-2">
      <label class="text-xs opacity-60 mb-1 block">Scores</label>
      <div class="overflow-x-auto">
        <table class="session-grid"><thead></thead><tbody></tbody><tfoot></tfoot></table>
      </div>
      <div class="flex gap-2 mt-2">
        <button class="btn btn-sm btn-ghost" onclick="addRound()">
          <i data-lucide="plus" class="w-4 h-4"></i> Round
        </button>
        <button class="btn btn-sm btn-ghost" onclick="openAddPlayerForm()">
          <i data-lucide="user-plus" class="w-4 h-4"></i> Player
        </button>
      </div>
      <div id="session-add-player" class="hidden mt-2 p-2 rounded border border-base-content/10 bg-base-200/40">
        <div class="text-xs opacity-60 mb-1" id="session-add-player-title">Add player</div>
        <div class="flex gap-2 items-center flex-wrap">
          <div class="relative flex-1 min-w-[140px]">
            <input type="text" id="add-player-name"
                   class="input input-bordered input-sm w-full"
                   placeholder="Player name" autocomplete="off"
                   oninput="onAddPlayerNameInput(this.value)"
                   onchange="onAddPlayerNameChange(this.value)"
                   onfocus="showBuddySuggestions()"
                   onblur="onAddPlayerNameBlur()" />
            <div id="buddy-suggestions"
                 class="hidden absolute z-50 left-0 right-0 mt-1 bg-base-100 border border-base-300 rounded-box shadow-xl p-1"></div>
          </div>
          <input type="text" id="add-player-initials" maxlength="3"
                 class="input input-bordered input-sm w-16 text-center"
                 placeholder="ABC"
                 oninput="onAddPlayerInitialsInput(this.value)" />
          <button id="session-add-player-confirm" class="btn btn-sm btn-primary"
                  onclick="confirmAddPlayer()">Add</button>
          <button class="btn btn-sm btn-ghost" onclick="cancelAddPlayer()">Cancel</button>
        </div>
      </div>
    </div>

    <div class="mb-3">
      <label class="text-xs opacity-60 block mb-1">Notes</label>
      <textarea class="textarea textarea-bordered w-full text-sm"
                placeholder="Fun moments, close calls..."
                oninput="setNotes(this.value)">${escapeHtml(s.notes || "")}</textarea>
    </div>

    <div class="flex gap-2">
      <button class="btn btn-ghost flex-1" onclick="discardSession()">
        <i data-lucide="trash-2" class="w-4 h-4"></i> Discard
      </button>
      <button id="session-save-btn" class="btn btn-primary flex-1" onclick="saveSession()">
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
      <div class="input input-bordered flex items-center gap-2">
        ${s.game_thumbnail ? `<img src="${s.game_thumbnail}" class="w-6 h-6 rounded object-cover" />` : ""}
        <span class="truncate flex-1">${escapeHtml(s.game_name)}</span>
        <button class="btn btn-ghost btn-sm btn-square" onclick="clearSessionGame()" title="Change game">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
      </div>`;
  } else {
    slot.innerHTML = `
      <input type="text" id="session-game-search" class="input input-bordered w-full"
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
        <button type="button" class="btn btn-ghost btn-sm w-full justify-start text-left session-game-pick"
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
          <div class="flex items-center justify-center gap-2">
            <button class="player-header-btn" title="${escapeHtml(fullName)}"
                    aria-label="Edit ${escapeHtml(fullName)}"
                    onclick="openEditPlayer(${i})">
              ${escapeHtml(initials)}
            </button>
            ${s.players.length > 1 ? `
              <button class="btn btn-ghost btn-sm btn-square" title="Remove player"
                      onclick="removePlayer(${i})">
                <i data-lucide="x" class="w-4 h-4"></i>
              </button>` : ""}
          </div>
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
        <span class="inline-flex items-center gap-2">
          R${r+1}
          <button class="btn btn-ghost btn-sm btn-square" title="Remove round"
                  onclick="removeRound(${r})">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </span>
      </th>
      ${s.players.map((p, i) => `
        <td>
          <input type="number" inputmode="decimal"
                 class="input input-ghost text-center"
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
          <div class="flex items-center justify-center gap-1.5">
            <button class="btn btn-ghost btn-sm btn-square" title="${isWinner ? "Winner" : "Mark as winner"}"
                    onclick="setWinnerOverride(${i})">
              ${isWinner ? '<i data-lucide="trophy" class="w-4 h-4"></i>' : '<i data-lucide="circle" class="w-4 h-4 opacity-25"></i>'}
            </button>
            <span class="font-bold">${totals[i]}</span>
          </div>
        </td>`;
      }).join("")}
    </tr>`;
  if (window.lucide) window.lucide.createIcons();
}

// ── Session → Guide overlay ──────────────────────────────────────────────────
// Mid-game rule lookup: re-uses the active session's game_id (or the open
// game-detail's currentGame) and overlays a focused Quick Reference inside
// the bubble. Scores and player state remain on the server draft; closing
// the overlay rebuilds the scoreboard panel from activeSession unchanged.
//
// Scoped IDs (session-guide-*) avoid collisions with #guide-content from
// game-detail, which may be in the DOM beneath the bubble.

let _sessionGuideChunks = [];      // cached chunks for the active overlay
let _sessionGuideTypeFilter = null;
let _sessionGuideSearch = "";
let _sessionGuideExpandAll = false;

async function openSessionGuide() {
  const gameId = activeSession?.game_id || currentGame?.id;
  if (!gameId) {
    showToast("Pick a game first to open its reference.", "info");
    return;
  }
  sessionShowingGuide = true;
  _sessionGuideTypeFilter = null;
  _sessionGuideSearch = "";
  _sessionGuideExpandAll = false;

  const panel = document.getElementById("session-panel");
  const gameName = activeSession?.game_name || currentGame?.name || "Quick Reference";
  panel.innerHTML = `
    <div class="flex items-center gap-2 mb-2">
      <button class="btn btn-ghost btn-sm" onclick="closeSessionGuide()">
        <i data-lucide="arrow-left" class="w-4 h-4"></i>
        <span class="ml-1">Session</span>
      </button>
      <h3 class="font-bold text-sm flex-1 text-center truncate font-display"
          style="color: var(--accent)">${escapeHtml(gameName)}</h3>
      <button class="btn btn-ghost btn-sm btn-square" title="Minimize"
              onclick="minimizeSession()">
        <i data-lucide="chevron-down" class="w-5 h-5"></i>
      </button>
    </div>
    <div id="session-guide-sticky"></div>
    <div id="session-guide-content" class="scroll-panel">
      <div class="text-center py-4"><span class="loading loading-spinner loading-sm"></span></div>
    </div>`;
  if (window.lucide) window.lucide.createIcons();

  try {
    const chunks = session
      ? (await apiFetch(`/games/${gameId}/my-guide?include_all_expansions=1`)).chunks
      : await apiFetch(`/games/${gameId}/chunks`);
    _sessionGuideChunks = sortVisibleChunks(
      (chunks || []).filter(c => !c.is_hidden && (c.user_display_order !== null || c.is_default || !session))
    );
    renderSessionGuideHeader();
    renderSessionGuideBody();
  } catch (err) {
    document.getElementById("session-guide-content").innerHTML =
      `<p class="text-error text-sm">${escapeHtml(err.message)}</p>`;
  }
}

function closeSessionGuide() {
  sessionShowingGuide = false;
  _sessionGuideChunks = [];
  renderSessionPanel();
}

function renderSessionGuideHeader() {
  const host = document.getElementById("session-guide-sticky");
  if (!host) return;
  const counts = new Map();
  for (const c of _sessionGuideChunks) {
    counts.set(c.chunk_type, {
      count: (counts.get(c.chunk_type)?.count || 0) + 1,
      label: c.chunk_type_label || c.chunk_type,
      icon: c.chunk_type_icon || "sticky-note",
      order: c.chunk_type_order || 0,
    });
  }
  const types = [...counts.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => a.order - b.order);
  const allActive = _sessionGuideTypeFilter === null;
  const expandLabel = _sessionGuideExpandAll ? "Collapse all" : "Expand all";
  const expandIcon  = _sessionGuideExpandAll ? "chevrons-down-up" : "chevrons-up-down";

  host.innerHTML = `
    <div class="guide-sticky" style="margin-left: -0.5rem; margin-right: -0.5rem; margin-top: -0.25rem;">
      <div class="guide-sticky__row">
        <input class="guide-search" type="search"
               placeholder="Search this guide…" autocomplete="off"
               aria-label="Search guide"
               value="${escapeAttr(_sessionGuideSearch)}"
               oninput="onSessionGuideSearchInput(this.value)">
        ${_sessionGuideChunks.length > 1 ? `
          <button class="guide-sticky__expand-all" type="button"
                  onclick="toggleSessionGuideExpandAll()" title="${expandLabel}">
            <i data-lucide="${expandIcon}" class="w-3 h-3"></i>
            <span class="ml-1">${expandLabel}</span>
          </button>` : ""}
      </div>
      <div class="guide-pill-row" role="tablist" aria-label="Filter by section">
        <button type="button" class="guide-pill"
                aria-pressed="${allActive ? "true" : "false"}"
                onclick="setSessionGuideTypeFilter(null)">
          All <span class="guide-pill__count">${_sessionGuideChunks.length}</span>
        </button>
        ${types.map(t => `
          <button type="button" class="guide-pill"
                  aria-pressed="${_sessionGuideTypeFilter === t.id ? "true" : "false"}"
                  onclick="setSessionGuideTypeFilter('${escapeAttr(t.id)}')">
            <i data-lucide="${escapeAttr(t.icon)}" class="w-3 h-3"></i>
            ${escapeAttr(t.label)}
            <span class="guide-pill__count">${t.count}</span>
          </button>`).join("")}
      </div>
    </div>`;
  if (window.lucide) window.lucide.createIcons();
}

function renderSessionGuideBody() {
  const host = document.getElementById("session-guide-content");
  if (!host) return;
  const q = (_sessionGuideSearch || "").toLowerCase().trim();
  const filtered = _sessionGuideChunks.filter(c => {
    if (_sessionGuideTypeFilter && c.chunk_type !== _sessionGuideTypeFilter) return false;
    if (!q) return true;
    return (c.title || "").toLowerCase().includes(q) ||
           (c.content || "").toLowerCase().includes(q);
  });

  if (!filtered.length) {
    host.innerHTML = `
      <div class="guide-empty">
        ${_sessionGuideChunks.length
          ? `No chunks match this filter${q ? ` for “${escapeHtml(q)}”` : ""}.`
          : "No guide available for this game yet."}
      </div>`;
    return;
  }

  // Group by chunk_type
  const groups = [];
  const seen = new Map();
  for (const c of filtered) {
    if (!seen.has(c.chunk_type)) {
      seen.set(c.chunk_type, groups.length);
      groups.push({
        chunk_type: c.chunk_type,
        label: c.chunk_type_label || c.chunk_type,
        icon: c.chunk_type_icon || "sticky-note",
        chunks: [],
      });
    }
    groups[seen.get(c.chunk_type)].chunks.push(c);
  }

  const open = _sessionGuideExpandAll || !!q;
  host.innerHTML = `
    <div id="session-guide-chunk-list">
      ${groups.map(g => `
        <section class="guide-section">
          <h3 class="guide-section__title">
            <i data-lucide="${escapeAttr(g.icon)}" class="w-4 h-4"></i>
            <span>${escapeAttr(g.label)}</span>
          </h3>
          <div class="space-y-2">
            ${g.chunks.map(c => {
              const dot = c.expansion?.color
                ? `<span class="expansion-dot flex-shrink-0"
                         style="background:${escapeAttr(c.expansion.color)}"></span>`
                : "";
              const bodyHtml = c.layout === 'card_anatomy'
                ? renderCardAnatomy(c.content)
                : renderMarkdown(c.content);
              const finalBody = q ? highlightSearch(bodyHtml, q, true) : bodyHtml;
              const finalTitle = q ? highlightSearch(c.title, q) : escapeHtml(c.title);
              return `
                <div class="collapse collapse-arrow scroll-chunk">
                  <input type="checkbox" ${open ? "checked" : ""} />
                  <div class="collapse-title flex items-center gap-2 min-w-0">
                    ${dot}
                    <span class="block truncate">${finalTitle}</span>
                  </div>
                  <div class="collapse-content text-sm leading-relaxed guide-text">
                    ${finalBody}
                  </div>
                </div>`;
            }).join("")}
          </div>
        </section>`).join("")}
    </div>`;
  if (window.lucide) window.lucide.createIcons();
}

function setSessionGuideTypeFilter(typeId) {
  _sessionGuideTypeFilter = typeId || null;
  renderSessionGuideHeader();
  renderSessionGuideBody();
}

let _sessionGuideSearchDebounce = null;
function onSessionGuideSearchInput(value) {
  clearTimeout(_sessionGuideSearchDebounce);
  _sessionGuideSearchDebounce = setTimeout(() => {
    _sessionGuideSearch = value || "";
    renderSessionGuideBody();
  }, 140);
}

function toggleSessionGuideExpandAll() {
  _sessionGuideExpandAll = !_sessionGuideExpandAll;
  renderSessionGuideBody();
  renderSessionGuideHeader();
}
