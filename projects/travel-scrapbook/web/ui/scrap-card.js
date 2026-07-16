// ui/scrap-card.js — canonical Scrap render function.
// A scrap is a saved PLACE (the source of truth); the URLs it arrived from
// render as source chips. Variants: 'trip' (default), 'staged' (approve /
// move-to-inbox row), 'inbox' (trip-suggestion chips + picker hooks).
'use strict';

// Vibe = each traveler's take on a place, rolled up into a group consensus.
// Order = most-committed → least (matches the backend TripVibe ordering).
const VIBE_META = [
  { level: 'booked', label: 'Booked', icon: 'calendar-check' },
  { level: 'must_do', label: 'Must do', icon: 'star' },
  { level: 'interested', label: 'Interested', icon: 'thumbs-up' },
  { level: 'could_skip', label: 'Could skip', icon: 'circle-slash' },
];
const VIBE_LABEL = Object.fromEntries(VIBE_META.map((v) => [v.level, v.label]));

function _scrapCategoryIcon(scrap) {
  const categories = window.store.get('categories') || [];
  return (categories.find((c) => c.slug === scrap.category) || { icon: 'other' }).icon;
}

// The current traveler's own vibe on this scrap (null if they haven't set one).
function _myVibe(scrap, currentUserId) {
  const mine = (scrap.vibes || []).find((v) => v.user_id === currentUserId);
  return mine ? mine.level : null;
}

// A 4-way segmented control; the caller's current vibe is highlighted. Tapping
// it again clears it (handled in the view). Shown on every trip scrap so even a
// solo traveler can mark places booked / must-do / etc.
function _renderVibeControl(scrap, currentUserId) {
  const my = _myVibe(scrap, currentUserId);
  return `
    <div class="vibe-control" role="group" aria-label="Your vibe on this place">
      ${VIBE_META.map((v) => `
        <button class="vibe-seg vibe-seg--${v.level} ${my === v.level ? 'is-on' : ''}"
                data-action="vibe" data-scrap-id="${escapeAttr(scrap.id)}" data-level="${v.level}"
                aria-pressed="${my === v.level}" title="${v.label}">
          <i data-lucide="${v.icon}"></i><span>${v.label}</span>
        </button>`).join('')}
    </div>`;
}

// Group roll-up: one chip per traveler (initial + their vibe color) plus the
// consensus headline. Only meaningful once more than one person is on the trip.
function _renderConsensus(scrap) {
  const c = scrap.consensus;
  const vibes = scrap.vibes || [];
  if (!c || !c.total) return '';
  const chips = vibes.map((v) => `
    <span class="vibe-chip vibe-chip--${v.level}" title="${escapeAttr(v.display_name)}: ${VIBE_LABEL[v.level] || v.level}">
      ${escapeHtml((v.display_name || '?').trim().charAt(0).toUpperCase() || '?')}
    </span>`).join('');
  return `
    <div class="vibe-consensus">
      <div class="vibe-consensus__chips">${chips}</div>
      <span class="vibe-consensus__headline">${escapeHtml(c.headline)}</span>
    </div>`;
}

function _confidenceHint(scrap) {
  if (scrap.geocode_confidence === 'none') return 'not on the map yet — tap to edit';
  if (scrap.geocode_confidence === 'low') return 'rough location (city only)';
  if (scrap.geocode_confidence === 'medium') return 'approximate location';
  return '';
}

// City, Country, dropping empties and an adjacent duplicate (a city-centroid
// geocode sometimes repeats the name, e.g. Singapore). Region is a grouping of
// countries (macro-region), used only for grouping — not shown inline.
function _locationLine(scrap) {
  const parts = [];
  for (const seg of [scrap.place_city, scrap.place_country]) {
    if (seg && seg !== parts[parts.length - 1]) parts.push(seg);
  }
  return parts.join(', ');
}

function _sourceChips(scrap) {
  const sources = scrap.sources || [];
  return sources.map((src) => `
    <a class="source-badge" href="${escapeAttr(src.url)}" target="_blank" rel="noopener"
       title="${escapeAttr(src.og_title || src.url)}" onclick="event.stopPropagation()">
      <i data-lucide="link-2"></i>${escapeHtml(src.source_domain || 'link')}
    </a>`).join('');
}

/**
 * @param {Scrap} scrap
 * @param {{index?: number, variant?: 'trip'|'staged'|'inbox'|'candidate'|'preview'|'select',
 *          tripId?: string, selected?: boolean, fits?: boolean,
 *          shared?: boolean, currentUserId?: (string|null), canWrite?: boolean}} opts
 *   variant preview — read-only display (share success screen)
 *   variant select  — read-only + selection checkbox (Wander-List picker)
 *   shared        — trip has other members (show consensus + "added by")
 *   currentUserId — the viewer, to derive their own vibe + scrap ownership
 *   canWrite      — false for viewers (hides add/edit/delete affordances)
 */
function renderScrapCard(scrap, opts = {}) {
  const {
    index = 0, variant = 'trip', tripId = null, selected = false, fits = false,
    shared = false, currentUserId = null, canWrite = true,
  } = opts;
  // 'preview' = read-only display (share success screen). 'select' = read-only
  // with a selection checkbox (the trip's "add from Wander List" picker). Both
  // suppress the normal actions/toggles/click-to-edit.
  const isPreview = variant === 'preview';
  const isSelect = variant === 'select';
  const readOnly = isPreview || isSelect;
  const catIcon = _scrapCategoryIcon(scrap);
  // "Mine" governs owner-only actions (favorite/visited/edit/delete). On solo
  // trips and the inbox added_by is the viewer (or unset), so this stays true.
  const mine = !scrap.added_by_user_id || scrap.added_by_user_id === currentUserId;

  const title = scrap.place_name || 'Saved place';
  const sub = _locationLine(scrap);
  const hint = _confidenceHint(scrap);
  // Prefer the source's og:image; else a static map of the pin (geocoded places
  // only); else the category sprite. The onerror covers a provider hiccup or a
  // dead image URL by swapping in the sprite.
  const imgSrc = scrap.og_image_url ||
    (scrap.lat != null ? staticMapUrl(scrap.lat, scrap.lng) : null);
  const photo = imgSrc
    ? `<img class="scrap-card__photo" src="${escapeAttr(imgSrc)}" alt="" loading="lazy"
         onerror="this.outerHTML='<div class=&quot;scrap-card__sprite-fallback&quot;>${renderSprite('category', catIcon, { size: 'lg' }).replaceAll('"', '&quot;')}</div>'" />`
    : `<div class="scrap-card__sprite-fallback">${renderSprite('category', catIcon, { size: 'lg' })}</div>`;

  let footer = '';
  if (variant === 'staged') {
    footer = `
      <div class="scrap-card__row" style="margin-top:0.6rem;">
        <button class="ts-btn ts-btn--sm ts-btn--mint" data-action="approve" data-scrap-id="${escapeAttr(scrap.id)}">
          <i data-lucide="check"></i>Keep it
        </button>
        <button class="ts-btn ts-btn--sm ts-btn--ghost" data-action="unassign" data-scrap-id="${escapeAttr(scrap.id)}">
          <i data-lucide="heart"></i>To Wander List
        </button>
      </div>`;
  } else if (variant === 'inbox') {
    const chips = (scrap.suggestions || []).map((sug) => `
      <button class="ts-btn ts-btn--sm ts-btn--sky" data-action="assign"
              data-scrap-id="${escapeAttr(scrap.id)}" data-trip-id="${escapeAttr(sug.trip_id)}">
        <i data-lucide="plus"></i>${escapeHtml(sug.name)} · ${formatKm(sug.distance_km)}
      </button>`).join('');
    footer = `
      <div class="scrap-card__row" style="margin-top:0.6rem;">
        ${chips}
        <button class="ts-btn ts-btn--sm ts-btn--ghost" data-action="pick-trip" data-scrap-id="${escapeAttr(scrap.id)}">
          <i data-lucide="folder-plus"></i>Pick a trip
        </button>
        <button class="ts-btn ts-btn--sm ts-btn--ghost" data-action="delete" data-scrap-id="${escapeAttr(scrap.id)}" aria-label="Delete">
          <i data-lucide="trash-2"></i>
        </button>
      </div>`;
  } else if (variant === 'candidate') {
    footer = `
      <div class="scrap-card__row" style="margin-top:0.6rem;">
        <button class="ts-btn ts-btn--sm ts-btn--mint" data-action="assign"
                data-scrap-id="${escapeAttr(scrap.id)}" data-trip-id="${escapeAttr(tripId)}">
          <i data-lucide="plus"></i>Add to this trip
        </button>
      </div>`;
  }

  // Favorite (trip only) + visited toggle (trip + wishlist) live in the corner.
  // Favorite/visited write to the scrap's own row, so only its owner sees them;
  // the read-only preview/select variants suppress them via the variant check.
  const showFav = variant === 'trip' && mine;
  const showVisited = (variant === 'trip' && mine) || variant === 'inbox';
  const isVisited = !!scrap.visited_at && !readOnly;
  const actions = (showFav || showVisited) ? `
    <div class="scrap-card__actions">
      ${showVisited ? `
        <button class="scrap-card__visited ${isVisited ? 'is-visited' : ''}" data-action="visited"
                data-scrap-id="${escapeAttr(scrap.id)}"
                aria-label="${isVisited ? 'Mark not visited' : 'Mark visited'}"
                title="${isVisited ? 'Visited — tap to undo' : 'Mark visited'}">
          <i data-lucide="circle-check"></i>
        </button>` : ''}
      ${showFav ? `
        <button class="scrap-card__fav ${scrap.is_favorite ? 'is-fav' : ''}" data-action="favorite"
                data-scrap-id="${escapeAttr(scrap.id)}" aria-label="Favorite">
          <i data-lucide="heart"></i>
        </button>` : ''}
    </div>` : '';

  // Only the owner can open the editor (place edits are owner-only server-side),
  // so others' cards on a shared trip aren't tappable-to-edit.
  const editable = mine && (variant === 'trip' || variant === 'inbox' || variant === 'candidate');
  const addedBy = (shared && !mine && scrap.added_by_display_name)
    ? `<span class="added-by"><i data-lucide="user"></i>${escapeHtml(scrap.added_by_display_name)}</span>`
    : '';
  // Vibe control on every in-trip scrap (only the trip view passes currentUserId,
  // so retrospective lists like Visited don't get it); consensus only when shared.
  const vibeUi = (variant === 'trip' && currentUserId && scrap.trip_id)
    ? `${_renderVibeControl(scrap, currentUserId)}${shared ? _renderConsensus(scrap) : ''}`
    : '';

  return `
    <div class="sticker-card ${readOnly ? '' : 'card-lift'} ${isSelect ? 'scrap-card--select' : ''} ${isSelect && selected ? 'is-selected' : ''} ${variant === 'staged' ? 'scrap-card--staged' : ''} ${isVisited ? 'is-visited' : ''}"
         style="--i:${index};" data-scrap-id="${escapeAttr(scrap.id)}" data-action="${isSelect ? 'select' : isPreview ? 'none' : (editable ? 'edit' : 'none')}">
      ${actions}
      ${isSelect ? `<span class="scrap-card__check" aria-hidden="true"><i data-lucide="${selected ? 'check-circle-2' : 'circle'}"></i></span>` : ''}
      ${isSelect && fits ? '<span class="scrap-card__fits-badge"><i data-lucide="sparkles"></i>Fits</span>' : ''}
      ${isVisited ? '<span class="scrap-card__visited-badge"><i data-lucide="check"></i>Visited</span>' : ''}
      ${photo}
      <p class="scrap-card__title">${escapeHtml(title)}</p>
      ${sub ? `<p class="scrap-card__sub">${escapeHtml(sub)}</p>` : ''}
      ${addedBy}
      <div class="scrap-card__row">
        ${renderCategoryBadge(scrap.category)}
        ${_sourceChips(scrap)}
        ${scrap.maps_url ? `<a class="source-badge" href="${escapeAttr(scrap.maps_url)}" target="_blank" rel="noopener" data-action="none" onclick="event.stopPropagation()"><i data-lucide="map-pin"></i>Maps</a>` : ''}
      </div>
      ${hint ? `<div class="confidence-hint" style="margin-top:0.4rem;">${escapeHtml(hint)}</div>` : ''}
      ${scrap.notes ? `<p class="scrap-card__sub" style="margin-top:0.4rem;">${escapeHtml(scrap.notes)}</p>` : ''}
      ${vibeUi}
      ${footer}
    </div>
  `;
}
