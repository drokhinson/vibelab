// library.js — "My Plants" library view.
//
// Top-level peer to "My Gardens". Lists every plant the user has shortlisted
// (wishlist), placed (current), or explicitly demoted (former). Auto-populated
// by the backend on shortlist updates and placement saves; users can edit
// status / quantity / notes / acquired_at and remove rows from a slide-in
// detail panel.
//
// The card grid mirrors `.garden-card` (gardens.js); the detail panel reuses
// the `.shopping-detail-overlay` / `.shopping-detail-panel` slide-in pattern
// from shopping.js.

var libraryState = {
  rows: [],                  // Array<UserPlantResponse>
  loading: false,
  statusFilter: 'all',       // 'all' | 'current' | 'wishlist' | 'former'
  detailRowId: null,
};

var LIBRARY_STATUS_TABS = [
  { id: 'all',      label: 'All' },
  { id: 'current',  label: 'Current' },
  { id: 'wishlist', label: 'Wishlist' },
  { id: 'former',   label: 'Former' }
];


// ── List view ──────────────────────────────────────────────────────────────

async function renderLibrary() {
  app.innerHTML = '<div class="flex flex-col items-center justify-center py-12 text-base-content/50 gap-3"><span class="loading loading-spinner loading-md text-primary"></span>Loading your plants…</div>';
  libraryState.loading = true;
  try {
    libraryState.rows = (await apiFetch('/user_plants?include_gardens=true')) || [];
  } catch (err) {
    app.innerHTML = '<div class="error-banner">Could not load your plants: ' + escapeHtml(err.message || String(err)) + '</div>';
    return;
  } finally {
    libraryState.loading = false;
  }
  _renderLibraryShell();
}

function _renderLibraryShell() {
  var html = '<div class="library-view">';

  html += '<div class="flex justify-between items-center mb-3">';
  html += '<h3 class="text-xl font-display font-semibold">My Planters</h3>';
  html += '<span class="library-total">' + libraryState.rows.length + ' tracked</span>';
  html += '</div>';

  html += '<div class="library-status-tabs">' + _renderLibraryTabs() + '</div>';
  html += '<div class="library-list">' + _renderLibraryList() + '</div>';

  html += '<div id="library-detail-panel"></div>';
  html += '</div>';

  app.innerHTML = html;
  _bindLibraryEvents();
  _initIcons();
}

function _renderLibraryTabs() {
  var counts = { all: libraryState.rows.length, current: 0, wishlist: 0, former: 0 };
  for (var i = 0; i < libraryState.rows.length; i++) {
    var s = libraryState.rows[i].status;
    if (counts[s] != null) counts[s] += 1;
  }
  var html = '';
  for (var j = 0; j < LIBRARY_STATUS_TABS.length; j++) {
    var t = LIBRARY_STATUS_TABS[j];
    var active = libraryState.statusFilter === t.id ? ' active' : '';
    html += '<button type="button" class="library-tab' + active + '" data-status="' + t.id + '">'
         +   escapeHtml(t.label) + ' <span class="library-tab-count">' + (counts[t.id] || 0) + '</span>'
         + '</button>';
  }
  return html;
}

function _filteredRows() {
  if (libraryState.statusFilter === 'all') return libraryState.rows;
  return libraryState.rows.filter(function(r) { return r.status === libraryState.statusFilter; });
}

function _renderLibraryList() {
  var rows = _filteredRows();
  if (!rows.length) {
    if (libraryState.rows.length === 0) {
      return '<div class="empty-state-illustration">'
           +   '<svg width="200" height="160" viewBox="0 0 200 160" fill="none" xmlns="http://www.w3.org/2000/svg">'
           +     '<ellipse cx="100" cy="148" rx="70" ry="8" fill="currentColor" opacity="0.06"/>'
           +     '<path d="M100 130 Q88 100 76 90 Q90 96 100 84 Q110 96 124 90 Q112 100 100 130Z" fill="#7BAE7F" opacity="0.7"/>'
           +     '<path d="M100 90 Q100 60 92 45 Q100 52 100 38 Q100 52 108 45 Q100 60 100 90Z" fill="#7BAE7F" opacity="0.85"/>'
           +     '<circle cx="100" cy="38" r="5" fill="#E8856C" opacity="0.85"/>'
           +   '</svg>'
           +   '<p class="text-base-content/50">No plants tracked yet. Heart a plant in the shopping step or place one in a planter to get started.</p>'
           + '</div>';
    }
    return '<div class="text-base-content/50 text-center py-8 text-sm">No plants in this category.</div>';
  }

  var html = '<div class="library-grid">';
  for (var i = 0; i < rows.length; i++) {
    html += _renderLibraryCard(rows[i], i);
  }
  html += '</div>';
  return html;
}

function _renderLibraryCard(row, idx) {
  var plant = row.plant || {};
  var name = plant.common_name || plant.scientific_name || 'Plant';
  var sub  = plant.scientific_name && plant.common_name && plant.scientific_name !== plant.common_name
              ? plant.scientific_name : '';
  var img = _libraryImageFor(plant, 'thumbnail');
  var imgHtml = img
    ? '<img class="library-card-img" src="' + escapeHtml(img) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'" />'
    : '<div class="library-card-img-placeholder">' + (plant.emoji || '🌿') + '</div>';

  var statusPill = _statusPillHtml(row);
  var planterChips = _planterChipsHtml(row);

  return ''
    + '<div class="garden-card library-card" data-row-id="' + row.id + '" style="--i:' + idx + '">'
    +   '<div class="library-card-media">' + imgHtml + '</div>'
    +   '<div class="library-card-body">'
    +     '<div class="garden-card-title">' + escapeHtml(name) + '</div>'
    +     (sub ? '<div class="library-card-sub"><i>' + escapeHtml(sub) + '</i></div>' : '')
    +     '<div class="library-card-row">' + statusPill + '</div>'
    +     '<div class="library-card-planters">' + planterChips + '</div>'
    +   '</div>'
    +   '<div class="garden-card-actions">'
    +     '<button class="btn btn-sm btn-primary gap-1 library-detail-btn" data-row-id="' + row.id + '"><i data-lucide="info" style="width:0.85em;height:0.85em"></i> Details</button>'
    +     '<button class="btn btn-sm btn-ghost text-error gap-1 library-delete-btn" data-row-id="' + row.id + '"><i data-lucide="trash-2" style="width:0.85em;height:0.85em"></i> Remove</button>'
    +   '</div>'
    + '</div>';
}

function _statusPillHtml(row) {
  if (row.status === 'wishlist') return '<span class="library-pill library-pill-wishlist"><i data-lucide="heart" style="width:0.8em;height:0.8em"></i> Wishlist</span>';
  if (row.status === 'former')   return '<span class="library-pill library-pill-former"><i data-lucide="archive" style="width:0.8em;height:0.8em"></i> Former</span>';
  // current
  var qty = row.quantity || 0;
  return '<span class="library-pill library-pill-current"><i data-lucide="leaf" style="width:0.8em;height:0.8em"></i> Current'
       + (qty > 0 ? ' ×' + qty : '') + '</span>';
}

function _planterChipsHtml(row) {
  var gardens = row.gardens || [];
  if (!gardens.length) {
    if (row.status === 'current') return '<span class="library-planter-chip library-planter-chip-warn">🪴 Unpotted</span>';
    return '';
  }
  var html = '';
  for (var i = 0; i < gardens.length; i++) {
    var g = gardens[i];
    html += '<button type="button" class="library-planter-chip library-open-garden" data-garden-id="' + g.id + '">'
         +   '<i data-lucide="layout-grid" style="width:0.8em;height:0.8em"></i> ' + escapeHtml(g.name)
         + '</button>';
  }
  return html;
}

function _libraryImageFor(plant, preferredSize) {
  if (!plant) return null;
  var order = preferredSize === 'thumbnail'
    ? ['thumbnail', 'medium', 'regular']
    : preferredSize === 'regular'
      ? ['regular', 'medium', 'thumbnail']
      : ['medium', 'regular', 'thumbnail'];
  for (var i = 0; i < order.length; i++) {
    if (plant['image_' + order[i] + '_path']) return plant['image_' + order[i] + '_path'];
  }
  for (var j = 0; j < order.length; j++) {
    if (plant['image_' + order[j] + '_url']) return plant['image_' + order[j] + '_url'];
  }
  return null;
}

function _bindLibraryEvents() {
  document.querySelectorAll('.library-tab').forEach(function(btn) {
    btn.onclick = function() {
      libraryState.statusFilter = btn.dataset.status;
      _renderLibraryShell();
    };
  });
  document.querySelectorAll('.library-detail-btn').forEach(function(btn) {
    btn.onclick = function() { _openLibraryDetailPanel(btn.dataset.rowId); };
  });
  document.querySelectorAll('.library-delete-btn').forEach(function(btn) {
    btn.onclick = function() { _removeLibraryRow(btn.dataset.rowId); };
  });
  document.querySelectorAll('.library-open-garden').forEach(function(btn) {
    btn.onclick = function(e) {
      e.stopPropagation();
      if (typeof openGarden === 'function') openGarden(btn.dataset.gardenId);
    };
  });
  // Card click → details (anywhere except action buttons / planter chips).
  document.querySelectorAll('.library-card').forEach(function(card) {
    card.onclick = function(e) {
      if (e.target.closest('.library-detail-btn')) return;
      if (e.target.closest('.library-delete-btn')) return;
      if (e.target.closest('.library-open-garden')) return;
      _openLibraryDetailPanel(card.dataset.rowId);
    };
  });
}

async function _removeLibraryRow(rowId) {
  if (!confirm('Remove this plant from your library? Placements in your planters won\'t be affected.')) return;
  try {
    await apiFetch('/user_plants/' + rowId, { method: 'DELETE' });
    libraryState.rows = libraryState.rows.filter(function(r) { return r.id !== rowId; });
    _renderLibraryShell();
  } catch (err) {
    alert('Could not remove: ' + (err.message || err));
  }
}


// ── Detail slide-in panel ──────────────────────────────────────────────────

function _findLibraryRow(rowId) {
  for (var i = 0; i < libraryState.rows.length; i++) {
    if (libraryState.rows[i].id === rowId) return libraryState.rows[i];
  }
  return null;
}

function _openLibraryDetailPanel(rowId) {
  var row = _findLibraryRow(rowId);
  if (!row) return;
  libraryState.detailRowId = rowId;
  var panel = document.getElementById('library-detail-panel');
  if (!panel) return;

  var plant = row.plant || {};
  var name = plant.common_name || plant.scientific_name || 'Plant';
  var img = _libraryImageFor(plant, 'regular');
  var sci = plant.scientific_name ? '<div class="shopping-detail-sci"><i>' + escapeHtml(plant.scientific_name) + '</i></div>' : '';
  var family = plant.family ? '<div class="shopping-detail-family">' + escapeHtml(plant.family) + '</div>' : '';

  var bullets = [];
  if (plant.sunlight)    bullets.push(['Sunlight', plant.sunlight.replace(/_/g, ' ')]);
  if (plant.watering)    bullets.push(['Water', plant.watering]);
  if (plant.cycle)       bullets.push(['Cycle', plant.cycle]);
  if (plant.hardiness_min != null && plant.hardiness_max != null) bullets.push(['Hardiness', 'Zone ' + plant.hardiness_min + '–' + plant.hardiness_max]);
  if (plant.height_min_cm != null || plant.height_max_cm != null) bullets.push(['Height', (plant.height_min_cm || '?') + '–' + (plant.height_max_cm || '?') + ' cm']);
  if (plant.edible)      bullets.push(['Edible', 'yes']);

  var showOwnedFields = row.status !== 'wishlist';

  var html = '<div class="shopping-detail-overlay" id="library-detail-overlay"></div>';
  html += '<aside class="shopping-detail-panel" role="dialog">';
  html += '<button type="button" class="shopping-detail-close" id="library-detail-close" aria-label="Close"><i data-lucide="x"></i></button>';
  if (img) html += '<div class="shopping-detail-hero"><img src="' + escapeHtml(img) + '" alt="" /></div>';
  html += '<div class="shopping-detail-body">';
  html += '<h3>' + escapeHtml(name) + '</h3>';
  html += sci + family;

  // Plant facts
  if (bullets.length) {
    html += '<dl class="shopping-detail-bullets">';
    for (var i = 0; i < bullets.length; i++) {
      html += '<dt>' + escapeHtml(bullets[i][0]) + '</dt><dd>' + escapeHtml(bullets[i][1]) + '</dd>';
    }
    html += '</dl>';
  }

  // Status picker — three-way radio.
  html += '<div class="library-detail-section">';
  html += '<div class="library-detail-label">Status</div>';
  html += '<div class="library-detail-status">';
  ['wishlist', 'current', 'former'].forEach(function(s) {
    var active = row.status === s ? ' active' : '';
    var icon = s === 'wishlist' ? 'heart' : s === 'former' ? 'archive' : 'leaf';
    html += '<button type="button" class="library-status-btn library-status-' + s + active + '" data-status="' + s + '">'
         +   '<i data-lucide="' + icon + '" style="width:0.9em;height:0.9em"></i> '
         +   s.charAt(0).toUpperCase() + s.slice(1)
         + '</button>';
  });
  html += '</div></div>';

  if (showOwnedFields) {
    html += '<div class="library-detail-section library-detail-row">';
    html +=   '<label class="library-detail-field">';
    html +=     '<span class="library-detail-label">Quantity</span>';
    html +=     '<input type="number" min="0" max="999" id="library-qty" class="input input-bordered input-sm" value="' + (row.quantity || 0) + '" />';
    html +=   '</label>';
    html +=   '<label class="library-detail-field">';
    html +=     '<span class="library-detail-label">Acquired</span>';
    html +=     '<input type="date" id="library-acquired" class="input input-bordered input-sm" value="' + escapeHtml(row.acquired_at || '') + '" />';
    html +=   '</label>';
    html += '</div>';
  }

  html += '<div class="library-detail-section">';
  html += '<label class="library-detail-field">';
  html += '<span class="library-detail-label">Notes</span>';
  html += '<textarea id="library-notes" class="textarea textarea-bordered textarea-sm" rows="3" placeholder="Care notes, where you got it, anything else">' + escapeHtml(row.notes || '') + '</textarea>';
  html += '</label></div>';

  // Planter membership
  var gardens = row.gardens || [];
  if (gardens.length) {
    html += '<div class="library-detail-section">';
    html += '<div class="library-detail-label">In planters</div>';
    html += '<div class="library-detail-planters">';
    for (var k = 0; k < gardens.length; k++) {
      html += '<button type="button" class="library-planter-chip library-detail-open-garden" data-garden-id="' + gardens[k].id + '">'
           +   '<i data-lucide="layout-grid" style="width:0.8em;height:0.8em"></i> ' + escapeHtml(gardens[k].name)
           + '</button>';
    }
    html += '</div></div>';
  } else if (row.status === 'current') {
    html += '<div class="library-detail-section"><span class="library-planter-chip library-planter-chip-warn">🪴 Unpotted — not in any planter yet</span></div>';
  }

  html += '<button type="button" class="btn btn-error btn-outline btn-block mt-3" id="library-detail-remove">'
       +   '<i data-lucide="trash-2" style="width:0.9em;height:0.9em"></i> Remove from library'
       + '</button>';

  html += '</div></aside>';

  panel.innerHTML = html;
  _initIcons();

  document.getElementById('library-detail-overlay').onclick = _closeLibraryDetailPanel;
  document.getElementById('library-detail-close').onclick   = _closeLibraryDetailPanel;
  document.getElementById('library-detail-remove').onclick  = function() { _removeLibraryRow(row.id); };

  document.querySelectorAll('.library-status-btn').forEach(function(btn) {
    btn.onclick = function() { _patchRow(row.id, { status: btn.dataset.status }); };
  });
  var qtyEl = document.getElementById('library-qty');
  if (qtyEl) qtyEl.onchange = function() {
    var q = parseInt(qtyEl.value, 10);
    if (Number.isNaN(q) || q < 0) q = 0;
    _patchRow(row.id, { quantity: q });
  };
  var acqEl = document.getElementById('library-acquired');
  if (acqEl) acqEl.onchange = function() { _patchRow(row.id, { acquired_at: acqEl.value || null }); };
  var notesEl = document.getElementById('library-notes');
  if (notesEl) notesEl.onblur = function() { _patchRow(row.id, { notes: notesEl.value }); };

  document.querySelectorAll('.library-detail-open-garden').forEach(function(btn) {
    btn.onclick = function() { if (typeof openGarden === 'function') openGarden(btn.dataset.gardenId); };
  });
}

function _closeLibraryDetailPanel() {
  libraryState.detailRowId = null;
  var panel = document.getElementById('library-detail-panel');
  if (panel) panel.innerHTML = '';
}

async function _patchRow(rowId, patch) {
  try {
    var updated = await apiFetch('/user_plants/' + rowId, {
      method: 'PUT',
      body: patch
    });
    // Replace the row in state.
    for (var i = 0; i < libraryState.rows.length; i++) {
      if (libraryState.rows[i].id === rowId) {
        libraryState.rows[i] = updated;
        break;
      }
    }
    _renderLibraryShell();
    if (libraryState.detailRowId === rowId) _openLibraryDetailPanel(rowId);
  } catch (err) {
    alert('Could not save: ' + (err.message || err));
  }
}
