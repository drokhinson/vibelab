// guide.js — Chunk-based quick reference guides
//
// Data model:
//   Chunk (MyGuideChunkResponse): { id, game_id, chunk_type, chunk_type_label,
//     chunk_type_icon, chunk_type_order, title, layout, content, created_by,
//     created_by_name, updated_at, is_hidden, user_display_order }
//   Anon users see the full chunk library grouped by type (no hide/reorder).
//   Signed-in users see chunks with per-user is_hidden and user_display_order.
//
// Gestures (mobile-first, works with pointer/mouse too):
//   swipe right → edit (creator or admin; toast if blocked)
//   swipe left  → hide the chunk from the guide

// ── Markdown renderer (shared with legacy guide) ─────────────────────────────

function renderMarkdown(text) {
  if (!text) return "";

  // Extract GitHub-style pipe tables before line-level replacements clobber
  // newlines. Header row, --- separator row, then one or more body rows.
  text = text.replace(
    /^\|(.+)\|[ \t]*\n\|([ :\-|]+)\|[ \t]*\n((?:\|.*\|[ \t]*\n?)+)/gm,
    (_m, header, _sep, body) => {
      const ths = header.split("|").map(s => s.trim()).filter(Boolean)
        .map(c => `<th>${c}</th>`).join("");
      const rows = body.trim().split("\n").map(line => {
        const cells = line.replace(/^\||\|$/g, "").split("|").map(s => s.trim());
        return `<tr>${cells.map(c => `<td>${c}</td>`).join("")}</tr>`;
      }).join("");
      return `<div class="overflow-x-auto my-2"><table class="table table-xs table-zebra guide-table"><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table></div>`;
    }
  );

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

function renderCardAnatomy(content) {
  const DIAG = '[DIAGRAM]\n';
  const LEG  = '\n[LEGEND]\n';
  const lIdx = content.indexOf(LEG);
  if (!content.includes(DIAG) || lIdx === -1) return renderMarkdown(content);
  const diagram    = content.slice(content.indexOf(DIAG) + DIAG.length, lIdx);
  const legendText = content.slice(lIdx + LEG.length).trim();
  const items = legendText.split('\n').map(line => {
    const m = line.match(/^([①-⑫])\s+([^:]+):\s+(.+)$/);
    return m
      ? `<dt class="card-anatomy-num">${m[1]}</dt><dd><strong>${m[2].trim()}</strong> — ${m[3].trim()}</dd>`
      : '';
  }).filter(Boolean).join('');
  return `<div class="card-anatomy"><pre class="card-anatomy-diagram">${diagram}</pre><dl class="card-anatomy-legend">${items}</dl></div>`;
}

function escapeAttr(s) {
  return String(s || "").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Search highlight ────────────────────────────────────────────────────────
// Wrap matches in <mark>. When `alreadyHtml` is true the input is the rendered
// chunk body (HTML); we walk text nodes only so we never inject <mark> into
// tag attributes, table cells, or existing markup. Otherwise we treat the
// input as plain text (used for chunk titles which are escaped at render time).
function _escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function highlightSearch(input, query, alreadyHtml = false) {
  const q = (query || "").trim();
  if (!q) return input == null ? "" : String(input);
  const re = new RegExp(_escapeRegex(q), "gi");
  if (!alreadyHtml) {
    return String(input || "").replace(re, m => `<mark>${m}</mark>`);
  }
  const wrapper = document.createElement("div");
  wrapper.innerHTML = input;
  const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n; while ((n = walker.nextNode())) nodes.push(n);
  for (const tn of nodes) {
    if (!re.test(tn.nodeValue)) { re.lastIndex = 0; continue; }
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    tn.nodeValue.replace(re, (match, idx) => {
      if (idx > last) frag.appendChild(document.createTextNode(tn.nodeValue.slice(last, idx)));
      const mark = document.createElement("mark");
      mark.textContent = match;
      frag.appendChild(mark);
      last = idx + match.length;
      return match;
    });
    if (last < tn.nodeValue.length) frag.appendChild(document.createTextNode(tn.nodeValue.slice(last)));
    tn.parentNode.replaceChild(frag, tn);
  }
  return wrapper.innerHTML;
}

// ── Guide controls (search / chunk-type pills / expand-all) ───────────────
// Lives inside #guide-controls (mounted by game-detail.js) directly under
// the "Quick Reference" heading. Re-rendered when the chunk pool changes
// (load, expansion toggle), but NOT on every keystroke — the search input
// keeps focus while the user types.

function renderGuideControls() {
  const host = document.getElementById("guide-controls");
  if (!host) return;
  if (!currentGame) { host.innerHTML = ""; return; }

  // Build chunk-type tally from the user's current visible guide so unused
  // types are dropped and counts are accurate post-filter.
  const counts = new Map();
  for (const c of currentGuideChunks) {
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

  const allActive = guideTypeFilter === null;

  host.innerHTML = `
    <div class="guide-controls">
      <div class="guide-controls__row">
        <input class="guide-search" type="search"
               placeholder="Search guide…" autocomplete="off"
               aria-label="Search guide"
               value="${escapeAttr(guideSearchQuery)}"
               oninput="onGuideSearchInput(this.value)">
      </div>
      <div class="guide-pill-row" role="tablist" aria-label="Filter by section">
        <button type="button" class="guide-pill" role="tab"
                data-pill-type=""
                aria-pressed="${allActive ? "true" : "false"}"
                onclick="setGuideTypeFilter(null)">
          All <span class="guide-pill__count">${currentGuideChunks.length}</span>
        </button>
        ${types.map(t => `
          <button type="button" class="guide-pill" role="tab"
                  data-pill-type="${escapeAttr(t.id)}"
                  aria-pressed="${guideTypeFilter === t.id ? "true" : "false"}"
                  onclick="setGuideTypeFilter('${escapeAttr(t.id)}')">
            <i data-lucide="${escapeAttr(t.icon)}" class="w-3 h-3"></i>
            ${escapeAttr(t.label)}
            <span class="guide-pill__count">${t.count}</span>
          </button>`).join("")}
      </div>
    </div>`;
  if (window.lucide) window.lucide.createIcons();
}

// ── Filter / search / expand-all handlers ───────────────────────────────────

function setGuideTypeFilter(typeId) {
  guideTypeFilter = typeId || null;
  applyGuideFilters();
  // Update aria-pressed on each pill in place — re-rendering would destroy
  // the search input and steal focus if the user is typing.
  document.querySelectorAll("#guide-controls .guide-pill").forEach(btn => {
    const id = btn.dataset.pillType || null;
    btn.setAttribute("aria-pressed", (guideTypeFilter || null) === id ? "true" : "false");
  });
}

let _guideSearchDebounce = null;
function onGuideSearchInput(value) {
  // Debounce so each keystroke doesn't re-render the entire guide.
  clearTimeout(_guideSearchDebounce);
  _guideSearchDebounce = setTimeout(() => {
    guideSearchQuery = value || "";
    // Re-render chunks for fresh <mark> highlights + force-open. Do NOT
    // re-render #guide-controls — that would replace the active <input>
    // and steal focus mid-type.
    renderGuide();
    applyGuideFilters();
  }, 140);
}

// Hide chunk rows whose type or search-haystack doesn't match. Kept separate
// from renderGuide() so type-pill switching is O(N) DOM mutation, not a full
// re-paint of every markdown chunk.
function applyGuideFilters() {
  const q = (guideSearchQuery || "").trim().toLowerCase();
  const list = document.querySelectorAll("#guide-content .swipe-row");
  let visibleTotal = 0;
  list.forEach(row => {
    const matchesType = !guideTypeFilter || row.dataset.chunkType === guideTypeFilter;
    const matchesSearch = !q || (row.dataset.searchHaystack || "").includes(q);
    const visible = matchesType && matchesSearch;
    row.hidden = !visible;
    if (visible) visibleTotal++;
  });
  // Hide entire section blocks whose chunks are all hidden.
  document.querySelectorAll("#guide-content .guide-section").forEach(sec => {
    const stillVisible = sec.querySelectorAll(".swipe-row:not([hidden])").length;
    sec.style.display = stillVisible ? "" : "none";
  });
  // Empty-state messaging when search/filter wipe out everything.
  const empty = document.getElementById("guide-empty-state");
  const list_el = document.getElementById("guide-chunk-list");
  if (!visibleTotal && currentGuideChunks.length) {
    if (!empty && list_el) {
      list_el.insertAdjacentHTML("afterend",
        `<div id="guide-empty-state" class="guide-empty">
           No chunks match this filter${q ? ` for “${escapeAttr(q)}”` : ""}.
         </div>`);
    }
  } else if (empty) {
    empty.remove();
  }
}

// ── Permissions ──────────────────────────────────────────────────────────────

function canEditChunk(chunk) {
  if (!currentUser) return false;
  if (currentUser.is_admin) return true;
  return chunk.created_by === currentUser.user_id;
}

// ── Sorting ──────────────────────────────────────────────────────────────────

function sortVisibleChunks(chunks) {
  // user_display_order wins when set; otherwise fall back to chunk type order
  // (bumped way up so user-ordered rows always sort ahead of unordered ones)
  // then title as a stable tiebreak.
  return chunks.slice().sort((a, b) => {
    const aHas = a.user_display_order !== null && a.user_display_order !== undefined;
    const bHas = b.user_display_order !== null && b.user_display_order !== undefined;
    if (aHas && bHas) return a.user_display_order - b.user_display_order;
    if (aHas) return -1;
    if (bHas) return 1;
    const typeDiff = (a.chunk_type_order || 0) - (b.chunk_type_order || 0);
    if (typeDiff !== 0) return typeDiff;
    return (a.title || "").localeCompare(b.title || "");
  });
}

// ── Guide loading ────────────────────────────────────────────────────────────

async function loadGuide(gameId) {
  const container = document.getElementById("guide-content");
  // Reset per-game UI state so filters/search from a previous game don't
  // bleed into the new view.
  guideTypeFilter = null;
  guideSearchQuery = "";
  try {
    // Pull the expansion list in parallel with the guide so the toggle panel
    // and the merged chunks land together — avoids a second flicker after
    // the guide paints. include_all_expansions=1 returns chunks for disabled
    // expansions too so we can toggle them in memory.
    const [guideRes, expansionsRes] = await Promise.all([
      session
        ? apiFetch(`/games/${gameId}/my-guide?include_all_expansions=1`)
        : apiFetch(`/games/${gameId}/chunks`),
      apiFetch(`/games/${gameId}/expansions`).catch(() => []),
    ]);

    if (session) {
      hasGuideCustomizations = !!guideRes.has_customizations;
      allGuideChunks = guideRes.chunks || [];
    } else {
      allGuideChunks = guideRes || [];
      hasGuideCustomizations = false;
    }

    currentExpansions = Array.isArray(expansionsRes) ? expansionsRes : [];

    recomputeGuideViews();
  } catch (err) {
    allGuideChunks = [];
    currentGuideChunks = [];
    hiddenChunks = [];
    currentExpansions = [];
    hasGuideCustomizations = false;
    container.innerHTML = `<p class="text-error text-sm">${err.message}</p>`;
  }
}

// Rebuilds currentGuideChunks / hiddenChunks from the cache. Out-of-scope
// chunks (from disabled expansions) stay in allGuideChunks so a re-enable
// brings them back without a refetch.
function recomputeGuideViews() {
  const enabledExpansionIds = new Set(
    currentExpansions.filter(e => e.is_enabled).map(e => e.expansion_game_id),
  );
  const inScope = allGuideChunks.filter(c => {
    if (!c.expansion) return true;
    return enabledExpansionIds.has(c.expansion.expansion_game_id);
  });

  if (!hasGuideCustomizations) {
    currentGuideChunks = sortVisibleChunks(inScope.filter(c => !c.is_hidden));
    hiddenChunks = [];
  } else {
    const visible = inScope.filter(c =>
      !c.is_hidden && (c.user_display_order !== null || c.is_default)
    );
    const visibleIds = new Set(visible.map(c => c.id));
    currentGuideChunks = sortVisibleChunks(visible);
    hiddenChunks = inScope.filter(c => !visibleIds.has(c.id));
  }

  renderGuide();
  renderGuideControls();
  applyGuideFilters();
  renderGuideToolbar();
  renderExpansionsPanel();
  renderRulebooksSection();
  const dlg = document.getElementById("hidden-chunks-dialog");
  if (dlg?.open) renderHiddenChunksPanel();
}

function renderGuide() {
  const container = document.getElementById("guide-content");
  const chunks = currentGuideChunks;

  if (!chunks.length) {
    container.innerHTML = `
      <div class="text-center py-4 text-base-content/50">
        <p class="text-sm">No guide chunks yet.</p>
        ${session ? '<button class="btn btn-sm btn-outline mt-2" onclick="openChunkEditor()">Add the first chunk</button>' : ""}
      </div>`;
    lucide.createIcons();
    return;
  }

  const allowGestures = !!session;
  const showRestore = !!session && hasGuideCustomizations;

  // Group by chunk_type: section headers replace the per-card type badge.
  // The flat array keeps its sort order from sortVisibleChunks(), so groups
  // appear in chunk_type_order, and within each group rows preserve user
  // ordering.
  const groups = [];
  const seen = new Map();
  for (const c of chunks) {
    const key = c.chunk_type;
    if (!seen.has(key)) {
      const idx = groups.length;
      seen.set(key, idx);
      groups.push({
        chunk_type: key,
        label: c.chunk_type_label || key,
        icon: c.chunk_type_icon || "sticky-note",
        chunks: [],
      });
    }
    groups[seen.get(key)].chunks.push(c);
  }

  const renderChunk = (c) => {
    const editable = canEditChunk(c);
    const dot = c.expansion?.color
      ? `<span class="expansion-dot flex-shrink-0"
               style="background:${escapeAttr(c.expansion.color)}"
               title="${escapeAttr(c.expansion.name || "Expansion")}"></span>`
      : "";
    const titleSearch = (c.title || "").toLowerCase();
    const contentSearch = (c.content || "").toLowerCase();
    const haystack = `${titleSearch}\n${contentSearch}`;
    const renderedTitle = highlightSearch(c.title, guideSearchQuery);
    const renderedBody = c.layout === 'card_anatomy'
      ? renderCardAnatomy(c.content)
      : renderMarkdown(c.content);
    const finalBody = guideSearchQuery
      ? highlightSearch(renderedBody, guideSearchQuery, /*alreadyHtml*/ true)
      : renderedBody;
    return `
      <div class="swipe-row" data-chunk-id="${c.id}"
           data-chunk-type="${escapeAttr(c.chunk_type || "")}"
           data-search-haystack="${escapeAttr(haystack)}"
           data-can-edit="${editable ? "1" : "0"}">
        <div class="swipe-action swipe-action--hide">
          <i data-lucide="eye-off" class="w-6 h-6"></i>
          <span>Hide</span>
        </div>
        <div class="swipe-action swipe-action--edit">
          <i data-lucide="pencil" class="w-6 h-6"></i>
          <span>Edit</span>
        </div>
        <div class="collapse collapse-arrow scroll-chunk swipe-target">
          <input type="checkbox" ${guideSearchQuery ? "checked" : ""} />
          <div class="collapse-title flex items-center gap-2 min-w-0">
            ${dot}
            <span class="block truncate">${renderedTitle}</span>
          </div>
          <div class="collapse-content text-sm leading-relaxed guide-text">
            ${finalBody}
            ${c.created_by_name ? `<div class="text-xs opacity-60 mt-2">by ${escapeAttr(c.created_by_name)}</div>` : ""}
          </div>
        </div>
      </div>`;
  };

  container.innerHTML = `
    <div id="guide-chunk-list">
      ${groups.map(g => `
        <section class="guide-section">
          <h3 class="guide-section__title">
            <i data-lucide="${g.icon}" class="w-4 h-4"></i>
            <span>${g.label}</span>
          </h3>
          <div class="space-y-2">
            ${g.chunks.map(renderChunk).join("")}
          </div>
        </section>
      `).join("")}
    </div>
    ${showRestore ? `
      <div class="mt-4 flex justify-center">
        <button class="btn btn-sm btn-ghost text-base-content/60"
                onclick="restoreGuideDefaults()">
          <i data-lucide="rotate-ccw" class="w-4 h-4"></i> Restore default guide
        </button>
      </div>` : ""}`;
  lucide.createIcons();

  if (allowGestures) {
    container.querySelectorAll(".swipe-row").forEach(attachChunkGestures);
  }
}

// ── Expansions panel ────────────────────────────────────────────────────────
// Linked expansions auto-appear once their game is imported (the import flow
// stamps is_expansion + base_game_bgg_id). Per-user toggle merges that
// expansion's default chunks into the visible guide.

function renderExpansionsPanel() {
  const host = document.getElementById("expansions-panel");
  if (!host) return;
  if (!currentExpansions.length) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `
    <div class="expansions-panel">
      <div class="expansions-panel__title">
        <i data-lucide="puzzle" class="w-4 h-4"></i>
        <span>Expansions</span>
      </div>
      <div class="expansions-panel__list">
        ${currentExpansions.map(e => {
          const color = e.color || "#6C63FF";
          const enabled = !!e.is_enabled;
          const interactive = !!session;
          const disabled = interactive ? "" : "disabled";
          return `
            <label class="expansions-row">
              <span class="expansion-dot expansion-dot--lg flex-shrink-0"
                    style="background:${escapeAttr(color)}"></span>
              <span class="expansions-row__name">${escapeAttr(e.name)}</span>
              <span class="expansions-row__count">${e.chunk_count || 0} chunk${e.chunk_count === 1 ? "" : "s"}</span>
              <input type="checkbox" class="toggle expansion-toggle"
                     ${enabled ? "checked" : ""}
                     ${disabled}
                     onchange="toggleExpansion('${e.expansion_game_id}', this.checked)" />
            </label>`;
        }).join("")}
      </div>
      ${session ? "" : `
        <p class="text-xs text-base-content/50 mt-2">Sign in to toggle expansions.</p>`}
    </div>`;
  lucide.createIcons();
}

// Combined Rulebooks section, rendered below the Quick Reference scroll:
// official rulebook (from currentGame.rulebook_url) + a card per enabled
// expansion that has its own rulebook URL. recomputeGuideViews() drives
// this on every expansion toggle, so the section live-updates.
function renderRulebooksSection() {
  const host = document.getElementById("rulebooks-section");
  if (!host) return;
  const officialUrl = (currentGame?.rulebook_url || "").trim();
  const enabledExpansions = (currentExpansions || []).filter(
    e => e.is_enabled && (e.rulebook_url || "").trim(),
  );
  if (!officialUrl && !enabledExpansions.length) {
    host.className = "";
    host.innerHTML = "";
    return;
  }
  host.className = "mb-4 space-y-2";
  const officialCard = officialUrl ? `
    <a href="${escapeAttr(officialUrl)}" target="_blank" rel="noopener"
       class="rulebook-card">
      <i data-lucide="file-text" class="w-5 h-5"></i>
      <div class="rulebook-card__text">
        <div class="rulebook-card__title">Official Rulebook</div>
        <div class="rulebook-card__sub">Open official rulebook</div>
      </div>
      <i data-lucide="external-link" class="w-4 h-4 opacity-60"></i>
    </a>` : "";
  const expansionCards = enabledExpansions.map(e => `
    <a href="${escapeAttr(e.rulebook_url.trim())}" target="_blank" rel="noopener"
       class="rulebook-card">
      <i data-lucide="file-text" class="w-5 h-5"
         style="color:${escapeAttr(e.color || "currentColor")}"></i>
      <div class="rulebook-card__text">
        <div class="rulebook-card__title">${escapeHtml(e.name)}</div>
        <div class="rulebook-card__sub">Open expansion rulebook</div>
      </div>
      <i data-lucide="external-link" class="w-4 h-4 opacity-60"></i>
    </a>`).join("");
  host.innerHTML = `
    <h2 class="text-lg font-bold flex items-center gap-2 mb-2">
      <i data-lucide="book-marked" class="w-5 h-5" style="color: var(--game-accent)"></i>
      Rulebooks
    </h2>
    ${officialCard}
    ${expansionCards}`;
  lucide.createIcons();
}

async function toggleExpansion(expansionGameId, isEnabled) {
  if (!session || !currentGame) return;
  const exp = currentExpansions.find(e => e.expansion_game_id === expansionGameId);
  if (!exp) return;
  exp.is_enabled = isEnabled;
  recomputeGuideViews();
  try {
    await apiFetch(
      `/games/${currentGame.id}/expansions/${expansionGameId}/toggle`,
      { method: "POST", body: { is_enabled: isEnabled } }
    );
  } catch (err) {
    exp.is_enabled = !isEnabled;
    recomputeGuideViews();
    showToast(err.message, "error");
  }
}

function renderGuideToolbar() {
  const host = document.getElementById("guide-toolbar");
  if (!host) return;
  if (!session) { host.innerHTML = ""; return; }
  const panelCount = hiddenChunks.length;
  // In custom mode the panel doubles as a picker (hidden + available chunks),
  // so the label says "More" rather than "Hidden". In default mode the panel
  // doesn't surface — there's nothing to add or restore.
  const panelLabel = hasGuideCustomizations ? "More" : "Hidden";
  host.innerHTML = `
    <div class="flex items-center gap-2 flex-wrap">
      <button class="btn btn-sm btn-outline" onclick="openChunkEditor()">
        <i data-lucide="plus" class="w-4 h-4"></i> New chunk
      </button>
      <button class="btn btn-sm btn-ghost ${panelCount ? "" : "btn-disabled"}"
              onclick="openHiddenChunksPanel()">
        <i data-lucide="eye-off" class="w-4 h-4"></i> ${panelLabel} (${panelCount})
      </button>
    </div>`;
  lucide.createIcons();
}

// ── Chunk type lookup (cached) ───────────────────────────────────────────────

async function loadChunkTypes() {
  if (chunkTypeCache) return chunkTypeCache;
  chunkTypeCache = await apiFetch("/chunk-types");
  return chunkTypeCache;
}

// ── Gesture layer (swipe) ────────────────────────────────────────────────────

const SWIPE_ACTIVATE_PX = 8;   // horizontal threshold before we claim the gesture
const SWIPE_COMMIT_FRAC = 0.35; // fraction of row width that commits the action

function attachChunkGestures(row) {
  const target = row.querySelector(".swipe-target");
  if (!target) return;

  let startX = null;
  let startY = null;
  let isSwipe = false;

  const resetVisual = () => {
    target.style.cssText = "transform: translateX(0); transition: transform 200ms ease;";
  };

  row.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    startX = e.clientX;
    startY = e.clientY;
    isSwipe = false;
  });

  row.addEventListener("pointermove", (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!isSwipe) {
      if (Math.abs(dy) > SWIPE_ACTIVATE_PX && Math.abs(dy) > Math.abs(dx)) {
        // Vertical scroll — abandon swipe.
        startX = null;
        return;
      }
      if (Math.abs(dx) > SWIPE_ACTIVATE_PX) {
        isSwipe = true;
        try { row.setPointerCapture(e.pointerId); } catch (_) {}
      } else {
        return;
      }
    }
    const maxDrag = row.clientWidth * 0.9;
    const clamped = Math.sign(dx) * Math.min(Math.abs(dx), maxDrag);
    target.style.cssText = `transform: translateX(${clamped}px); transition: none;`;
    row.classList.toggle("swiping-right", clamped > 0);
    row.classList.toggle("swiping-left", clamped < 0);
  });

  const finish = (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    row.classList.remove("swiping-right", "swiping-left");
    if (!isSwipe) {
      // Plain tap — let the collapse toggle naturally (input[type=checkbox]).
      return;
    }
    isSwipe = false;
    const commitPx = row.clientWidth * SWIPE_COMMIT_FRAC;
    if (dx > commitPx) {
      // Swipe right → edit
      resetVisual();
      const chunkId = row.dataset.chunkId;
      if (row.dataset.canEdit === "1") {
        setTimeout(() => openChunkEditor(chunkId), 120);
      } else {
        showToast("Only the creator or an admin can edit this chunk.", "info");
      }
    } else if (dx < -commitPx) {
      // Swipe left → hide
      const chunkId = row.dataset.chunkId;
      // Slide off before the API call for responsiveness.
      target.style.cssText = `transform: translateX(-110%); transition: transform 180ms ease;`;
      setTimeout(() => hideChunk(chunkId), 180);
    } else {
      resetVisual();
    }
  };

  row.addEventListener("pointerup", finish);
  row.addEventListener("pointercancel", () => {
    startX = null;
    isSwipe = false;
    row.classList.remove("swiping-right", "swiping-left");
    resetVisual();
  });
}

// ── Hide / unhide ────────────────────────────────────────────────────────────

async function setChunkHidden(chunkId, isHidden) {
  const cached = allGuideChunks.find(c => c.id === chunkId);
  if (!cached) return;
  const prevHidden = cached.is_hidden;
  const prevHadCustomizations = hasGuideCustomizations;
  cached.is_hidden = isHidden;
  // Hiding/unhiding flips the user into custom mode: the backend creates a
  // selection row, so subsequent loads will return has_customizations=true.
  hasGuideCustomizations = true;
  recomputeGuideViews();
  try {
    await apiFetch(`/chunks/${chunkId}/visibility`, {
      method: "POST",
      body: { is_hidden: isHidden },
    });
  } catch (err) {
    cached.is_hidden = prevHidden;
    hasGuideCustomizations = prevHadCustomizations;
    recomputeGuideViews();
    showToast(err.message, "error");
  }
}

async function hideChunk(chunkId) {
  await setChunkHidden(chunkId, true);
  showToast("Chunk hidden. Tap “Hidden” to restore.", "info");
}

async function unhideChunk(chunkId) {
  await setChunkHidden(chunkId, false);
  showToast("Chunk restored", "success");
}

// ── Hidden chunks modal ──────────────────────────────────────────────────────

function openHiddenChunksPanel() {
  if (!session || !currentGame) return;
  const dlg = document.getElementById("hidden-chunks-dialog");
  dlg.showModal();
  renderHiddenChunksPanel();
}

function closeHiddenChunksPanel() {
  const dlg = document.getElementById("hidden-chunks-dialog");
  if (dlg && dlg.open) dlg.close();
}

function groupByChunkType(chunks) {
  const seen = new Map();
  const groups = [];
  for (const c of chunks) {
    const key = c.chunk_type;
    if (!seen.has(key)) {
      seen.set(key, groups.length);
      groups.push({ label: c.chunk_type_label || key, chunks: [] });
    }
    groups[seen.get(key)].chunks.push(c);
  }
  return groups;
}

function renderHiddenChunksPanel() {
  const body = document.getElementById("hidden-chunks-body");
  if (!body) return;
  if (!hiddenChunks.length) {
    body.innerHTML = `
      <p class="text-sm text-base-content/60">Nothing hidden. Swipe a chunk left on the guide to hide it.</p>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick="closeHiddenChunksPanel()">Close</button>
      </div>`;
    return;
  }
  body.innerHTML = `
    <p class="text-xs text-base-content/60 mb-2">Tap Show to bring a chunk into your guide.</p>
    <div class="space-y-1">
      ${groupByChunkType(hiddenChunks).map(g => `
        <div class="mb-2">
          <p class="text-xs font-semibold text-base-content/50 uppercase tracking-wide mb-1">${escapeHtml(g.label)}</p>
          ${g.chunks.map(c => `
            <div class="flex items-center gap-2 py-2">
              <span class="text-sm flex-1 truncate">${escapeHtml(c.title)}</span>
              <button class="btn btn-sm btn-primary" onclick="unhideChunk('${c.id}')">
                <i data-lucide="eye" class="w-4 h-4"></i> Show
              </button>
            </div>`).join("")}
        </div>`).join("")}
    </div>
    <div class="modal-action">
      <button class="btn btn-ghost" onclick="closeHiddenChunksPanel()">Close</button>
    </div>`;
  lucide.createIcons();
}

// ── Restore to default ───────────────────────────────────────────────────────

async function restoreGuideDefaults() {
  if (!session || !currentGame) return;
  if (!confirm("Restore the default reference guide? This removes your custom order and any hidden chunks.")) return;
  const snapshot = allGuideChunks.map(c => ({
    id: c.id,
    is_hidden: c.is_hidden,
    user_display_order: c.user_display_order,
  }));
  const prevHadCustomizations = hasGuideCustomizations;
  for (const c of allGuideChunks) {
    c.is_hidden = false;
    c.user_display_order = null;
  }
  hasGuideCustomizations = false;
  recomputeGuideViews();
  try {
    await apiFetch(`/games/${currentGame.id}/my-guide`, { method: "DELETE" });
    showToast("Restored to default", "success");
  } catch (err) {
    const byId = new Map(snapshot.map(s => [s.id, s]));
    for (const c of allGuideChunks) {
      const s = byId.get(c.id);
      if (s) {
        c.is_hidden = s.is_hidden;
        c.user_display_order = s.user_display_order;
      }
    }
    hasGuideCustomizations = prevHadCustomizations;
    recomputeGuideViews();
    showToast(err.message, "error");
  }
}

// ── Chunk editor (create + edit) ─────────────────────────────────────────────
// openChunkEditorModal is the shared popup used by both the guide and the
// import review flow. Callers pass onSave/onDelete callbacks; what gets done
// with the data differs per context.

let _chunkEditorOnSave = null;
let _chunkEditorOnDelete = null;

async function openChunkEditorModal({ existing = null, onSave, onDelete = null }) {
  const types = await loadChunkTypes();
  _chunkEditorOnSave = onSave;
  _chunkEditorOnDelete = onDelete;

  const dlg = document.getElementById("chunk-editor");
  dlg.showModal();
  document.getElementById("chunk-editor-body").innerHTML = `
    <form onsubmit="submitChunkEditor(event)" class="space-y-3">
      <div class="form-control">
        <label class="label"><span class="label-text text-xs">Type</span></label>
        <select id="chunk-type" class="select select-bordered" required>
          ${types.map(t => `
            <option value="${t.id}" ${existing?.chunk_type === t.id ? "selected" : ""}>${t.label}</option>
          `).join("")}
        </select>
      </div>
      <div class="form-control">
        <label class="label"><span class="label-text text-xs">Title</span></label>
        <input id="chunk-title" type="text" class="input input-bordered"
               required maxlength="80"
               value="${escapeAttr(existing?.title || "")}" />
      </div>
      ${currentUser?.is_admin ? `
      <div class="form-control">
        <label class="label cursor-pointer gap-2 justify-start py-1">
          <input id="chunk-is-default" type="checkbox" class="checkbox checkbox-sm"
                 ${existing?.is_default ? "checked" : ""} />
          <span class="label-text text-xs">Mark as default for this game's curated guide</span>
        </label>
      </div>` : ""}
      <div class="form-control">
        <div class="flex items-center justify-between mb-1">
          <span class="label-text text-xs">Content</span>
          <div class="join">
            <button type="button" id="tab-write"
                    class="btn btn-xs join-item btn-active"
                    onclick="toggleChunkEditorTab('write')">Write</button>
            <button type="button" id="tab-preview"
                    class="btn btn-xs join-item"
                    onclick="toggleChunkEditorTab('preview')">Preview</button>
          </div>
        </div>
        <span class="text-xs opacity-60 mb-1">Markdown supported</span>
        <textarea id="chunk-content" class="textarea textarea-bordered text-base h-40"
                  required>${(existing?.content || "").replace(/</g, "&lt;")}</textarea>
        <div id="chunk-preview"
             class="hidden h-40 overflow-y-auto p-3 rounded-lg border border-base-300 bg-base-200 text-sm guide-text"></div>
      </div>
      <div class="modal-action">
        ${onDelete ? `
          <button type="button" class="btn btn-ghost text-error"
                  onclick="deleteChunkEditor()">
            <i data-lucide="trash-2" class="w-4 h-4"></i> Delete
          </button>` : ""}
        <button type="button" class="btn btn-ghost" onclick="closeChunkEditor()">Cancel</button>
        <button type="submit" class="btn btn-primary">
          ${existing ? "Save changes" : "Create chunk"}
        </button>
      </div>
    </form>`;
  lucide.createIcons();
}

function closeChunkEditor() {
  const dlg = document.getElementById("chunk-editor");
  if (dlg && dlg.open) dlg.close();
}

function toggleChunkEditorTab(tab) {
  const textarea   = document.getElementById("chunk-content");
  const preview    = document.getElementById("chunk-preview");
  const writeBtn   = document.getElementById("tab-write");
  const previewBtn = document.getElementById("tab-preview");
  if (tab === "preview") {
    preview.innerHTML = renderMarkdown(textarea.value)
      || '<span class="opacity-40 text-xs">Nothing to preview</span>';
    textarea.classList.add("hidden");
    preview.classList.remove("hidden");
    writeBtn.classList.remove("btn-active");
    previewBtn.classList.add("btn-active");
  } else {
    textarea.classList.remove("hidden");
    preview.classList.add("hidden");
    writeBtn.classList.add("btn-active");
    previewBtn.classList.remove("btn-active");
  }
}

async function submitChunkEditor(e) {
  e.preventDefault();
  const data = {
    chunk_type: document.getElementById("chunk-type").value,
    title: document.getElementById("chunk-title").value.trim(),
    content: document.getElementById("chunk-content").value,
  };
  const defaultEl = document.getElementById("chunk-is-default");
  if (defaultEl) data.is_default = defaultEl.checked;
  if (!data.title || !data.content) return;
  try {
    await _chunkEditorOnSave(data);
    closeChunkEditor();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteChunkEditor() {
  if (!_chunkEditorOnDelete) return;
  try {
    await _chunkEditorOnDelete();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function openChunkEditor(chunkId) {
  if (!session || !currentGame) return;
  const pool = [...currentGuideChunks, ...hiddenChunks];
  const existing = chunkId ? pool.find(c => c.id === chunkId) : null;

  await openChunkEditorModal({
    existing,
    onSave: async (data) => {
      if (chunkId) {
        await apiFetch(`/chunks/${chunkId}`, { method: "PATCH", body: data });
        showToast("Chunk updated", "success");
      } else {
        await apiFetch(`/games/${currentGame.id}/chunks`, { method: "POST", body: data });
        showToast("Chunk created", "success");
      }
      await loadGuide(currentGame.id);
    },
    onDelete: chunkId && canEditChunk(existing) ? async () => {
      if (!confirm("Delete this chunk? It will be removed from everyone's guide.")) return;
      await apiFetch(`/chunks/${chunkId}`, { method: "DELETE" });
      showToast("Chunk deleted", "success");
      closeChunkEditor();
      await loadGuide(currentGame.id);
    } : null,
  });
}
