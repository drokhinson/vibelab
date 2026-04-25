// session.js — Floating "Log a Play" session bubble
//
// Replaces the old standalone Log a Play view. Tapping the global "+" FAB
// opens a floating panel that tracks game + players + per-round scores +
// notes; the panel can be minimized back into the FAB while the session
// stays alive on the server (boardgamebuddy_play_drafts), so the user can
// flip to the Quick Reference guide mid-game and come back.

const TODAY = () => new Date().toISOString().split("T")[0];

function emptySession() {
  return {
    game_id: null,
    game_name: null,
    game_thumbnail: null,
    played_at: TODAY(),
    notes: "",
    players: [{
      name: currentUser?.display_name || "",
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
  s.players = (s.players || []).map(p => ({
    name: p.name || "",
    is_winner_override: p.is_winner_override ?? null,
    round_scores: padScores(p.round_scores, s.round_count),
  }));
  if (!s.players.length) {
    s.players.push({
      name: currentUser?.display_name || "",
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

function addPlayer(name = "") {
  activeSession.players.push({
    name,
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
        <button class="btn btn-ghost btn-xs" onclick="addPlayer()">
          <i data-lucide="user-plus" class="w-3 h-3"></i> Player
        </button>
      </div>
    </div>

    <datalist id="session-buddies">
      ${(buddies || []).map(b => `<option value="${escapeHtml(b.name)}">`).join("")}
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
      ${s.players.map((p, i) => `
        <th>
          <input type="text" class="input input-ghost input-xs w-20 px-1"
                 placeholder="Player ${i+1}" list="session-buddies"
                 value="${escapeHtml(p.name || "")}"
                 onchange="setPlayerName(${i}, this.value)" />
          ${s.players.length > 1 ? `
            <button class="btn btn-ghost btn-xs btn-square" title="Remove player"
                    onclick="removePlayer(${i})">
              <i data-lucide="x" class="w-3 h-3"></i>
            </button>` : ""}
        </th>`).join("")}
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
                 class="input input-ghost input-xs w-16 text-center px-1"
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
