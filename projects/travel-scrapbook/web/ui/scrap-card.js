// ui/scrap-card.js — canonical Scrap render function.
// A scrap is a saved PLACE (the source of truth); the URLs it arrived from
// render as source chips. Variants: 'trip' (default), 'staged' (approve /
// move-to-inbox row), 'inbox' (trip-suggestion chips + picker hooks).
'use strict';

// One value set for both a scrap's own rating (the owner's priority) and the
// per-traveler vibes on shared trips.
// Order = most-committed → least (matches the backend TripVibe ordering).
const VIBE_META = [
  { level: 'booked', label: 'Booked', icon: 'calendar-check' },
  { level: 'must_do', label: 'Must do', icon: 'star' },
  { level: 'interested', label: 'Interested', icon: 'thumbs-up' },
  { level: 'could_skip', label: 'Could skip', icon: 'circle-slash' },
];
const VIBE_LABEL = Object.fromEntries(VIBE_META.map((v) => [v.level, v.label]));

// "Visited" rides in the same picker as the priority levels (one chip, one
// popup — no separate visited toggle on the card). It maps to visited_at,
// not scraps.rating; ScrapDomain.applyPriority routes it.
const VISITED_META = { level: 'visited', label: 'Visited', icon: 'circle-check' };

function _scrapCategoryIcon(scrap) {
  const categories = window.store.get('categories') || [];
  return (categories.find((c) => c.slug === scrap.category) || { icon: 'other' }).icon;
}

// The current traveler's own vibe on this scrap (null if they haven't set one).
function _myVibe(scrap, currentUserId) {
  const mine = (scrap.vibes || []).find((v) => v.user_id === currentUserId);
  return mine ? mine.level : null;
}

// One chip showing the current priority/vibe. `action` decides what a tap
// means: 'rate-open' opens the picker for the scrap's own rating (owner),
// 'vibe-open' for the viewer's vibe on someone else's shared-trip scrap.
// Ghost "+ Priority"/"+ Vibe" when nothing is set yet.
function _renderPriorityChip(scrap, { action = 'rate-open', activeLevel = null } = {}) {
  const verb = action === 'vibe-open' ? 'Vibe' : 'Priority';
  const meta = activeLevel === 'visited'
    ? VISITED_META
    : VIBE_META.find((v) => v.level === activeLevel);
  if (!meta) {
    return `
      <button class="priority-chip priority-chip--ghost" data-action="${action}"
              data-scrap-id="${escapeAttr(scrap.id)}" aria-label="Set ${verb.toLowerCase()}" title="Set ${verb.toLowerCase()}">
        <i data-lucide="plus"></i>${verb}
      </button>`;
  }
  return `
    <button class="priority-chip priority-chip--${meta.level}" data-action="${action}"
            data-scrap-id="${escapeAttr(scrap.id)}"
            aria-label="${verb}: ${meta.label} — tap to change" title="Change ${verb.toLowerCase()}">
      <i data-lucide="${meta.icon}"></i>${meta.label}
    </button>`;
}

// Read-only rating chip for surfaces without the control (e.g. Visited).
function _renderRatingBadge(scrap) {
  if (!scrap.rating) return '';
  const meta = VIBE_META.find((v) => v.level === scrap.rating);
  if (!meta) return '';
  return `
    <span class="rating-badge rating-badge--${meta.level}">
      <i data-lucide="${meta.icon}"></i>${meta.label}
    </span>`;
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

// Icon-only source button. Opens the SourceLinks picker (website names, not
// full URLs) so the traveler chooses which capture to open. Data rides in a
// data attribute so the button is self-wiring across every surface — no view
// needs to bind it. Rendered only when the scrap has at least one source.
function _sourceButton(scrap) {
  const sources = (scrap.sources || []).map((s) => ({ name: s.source_domain || 'link', url: s.url }));
  if (!sources.length) return '';
  return `
    <button type="button" class="link-icon-btn" data-action="sources"
            aria-label="View sources" title="View sources"
            data-sources="${escapeAttr(JSON.stringify(sources))}"
            onclick='event.stopPropagation(); SourceLinks.open(this.getAttribute("data-sources"))'>
      <i data-lucide="link-2"></i>
    </button>`;
}

// Collapsed type bubble for the photo's top-left corner: just the category
// sprite until tapped, when it wobbles and the label unrolls (TypeBubble.pop).
// stopPropagation keeps the tap from opening the card editor.
function _catBubble(scrap) {
  const categories = window.store.get('categories') || [];
  const cat = categories.find((c) => c.slug === scrap.category)
    || { slug: 'other', label: 'Other', icon: 'other' };
  return `
    <button type="button" class="cat-bubble" aria-label="Type: ${escapeAttr(cat.label)}"
            onclick="event.stopPropagation(); TypeBubble.pop(this)">
      ${renderSprite('category', cat.icon, { size: 'sm', alt: '' })}
      <span class="cat-bubble__label">${escapeHtml(cat.label)}</span>
    </button>`;
}

// Icon-only Maps button. Confirms before leaving the app for Google Maps.
function _mapsButton(scrap) {
  if (!scrap.maps_url) return '';
  return `
    <button type="button" class="link-icon-btn" data-action="maps"
            aria-label="Open in Google Maps" title="Open in Maps"
            data-maps-url="${escapeAttr(scrap.maps_url)}"
            onclick='event.stopPropagation(); SourceLinks.openMaps(this.getAttribute("data-maps-url"))'>
      <i data-lucide="map-pin"></i>
    </button>`;
}

/**
 * @param {Scrap} scrap
 * @param {{index?: number, variant?: 'trip'|'staged'|'inbox'|'candidate'|'preview'|'select'|'community'|'suggestion',
 *          tripId?: string, selected?: boolean, fits?: boolean, saved?: boolean,
 *          isNew?: boolean, shared?: boolean, currentUserId?: (string|null), canWrite?: boolean,
 *          checkpoint?: boolean, showRemove?: boolean, communityWishlist?: boolean}} opts
 *   showRemove        — variant 'trip': show the "Remove from this trip" footer
 *                       (default true; false where there's no single-trip
 *                       context, e.g. the Visited list)
 *   communityWishlist — variant 'community' shown on the Community screen (saves
 *                       to the Wander List): relabels the action "Want to go"
 *                       and adds the fix-location pencil. Off inside a trip's
 *                       Add picker, where the place saves to the trip.
 *   isNew         — Wander List: imported since the last visit (shows a "New" tag)
 *   variant preview   — read-only display (share success screen)
 *   variant select    — read-only + selection checkbox (Wander-List picker)
 *   variant community — anonymized community-pool place (CommunityPlaceResponse) + Add button
 *   variant suggestion — a unified add-picker item (TripSuggestionItem): basic card
 *                   only (media + title + location + one-tap Add), with a "Your
 *                   list" badge when it comes from the viewer's Wander List
 *                   (source 'wander'). Add dispatches data-action="suggest-add".
 *   saved             — community place already on the viewer's lists (shows a check)
 *   shared        — trip has other members (show consensus + "added by")
 *   currentUserId — the viewer, to derive their own vibe + scrap ownership
 *   canWrite      — false for viewers (hides add/edit/delete affordances)
 *   checkpoint    — Stays & transport sections: no trip picker (checkpoints
 *                   join trips as roles via the trip screen), keeps edit/notes
 */
function renderScrapCard(scrap, opts = {}) {
  const {
    index = 0, variant = 'trip', tripId = null, selected = false, fits = false,
    isNew = false, shared = false, currentUserId = null, canWrite = true, saved = false,
    checkpoint = false, showRemove = true, communityWishlist = false,
  } = opts;
  // 'preview' = read-only display (share success screen). 'select' = read-only
  // with a selection checkbox (the trip's "add from Wander List" picker).
  // 'community' = an anonymized aggregate place from the community pool. All
  // three are read-only (no owner actions / click-to-edit).
  const isPreview = variant === 'preview';
  const isSelect = variant === 'select';
  const isCommunity = variant === 'community';
  // A suggestion (TripSuggestionItem) shares the community place-level shape but
  // stays deliberately basic — no source/maps chips, no save-count line — and
  // knows which pool it came from so the widget's Add button can branch.
  const isSuggestion = variant === 'suggestion';
  // A community place (CommunityPlaceResponse) has place-level field names and
  // its own id/save-count. Capture the community-only bits, then map it onto the
  // scrap shape so the one card component renders it identically to a scrap.
  const savedByCount = isCommunity ? (scrap.saved_by_count || 1) : 0;
  const placeId = (isCommunity || isSuggestion) ? scrap.ref_place_id : null;
  const suggestSource = isSuggestion ? scrap.source : null;      // 'wander' | 'community'
  const suggestScrapId = isSuggestion ? scrap.scrap_id : null;   // wander items only
  const wanderPriority = isSuggestion && suggestSource === 'wander';
  if (isCommunity || isSuggestion) {
    scrap = {
      id: scrap.ref_place_id,
      place_name: scrap.name,
      place_city: scrap.city,
      place_country: scrap.country,
      category: scrap.category,
      og_image_url: scrap.og_image_url,
      lat: scrap.lat, lng: scrap.lng,
      // Suggestions keep it basic: no source chips, no maps button.
      sources: isCommunity ? (scrap.sample_sources || []) : [],
      maps_url: isCommunity ? scrap.maps_url : null,
    };
  }
  const readOnly = isPreview || isSelect || isCommunity || isSuggestion;
  const catIcon = _scrapCategoryIcon(scrap);
  // "Mine" governs owner-only actions (rating/visited/edit/delete). On solo
  // trips and the inbox added_by is the viewer (or unset), so this stays true.
  const mine = !scrap.added_by_user_id || scrap.added_by_user_id === currentUserId;

  const title = scrap.place_name || 'Saved place';
  const sub = _locationLine(scrap);
  // Prefer the source's og:image; else a static map of the pin (geocoded places
  // only); else the category sprite. The onerror covers a provider hiccup or a
  // dead image URL by swapping in the sprite (and drops the type overlay, since
  // the sprite already shows the category).
  const imgSrc = scrap.og_image_url ||
    (scrap.lat != null ? staticMapUrl(scrap.lat, scrap.lng) : null);
  const spriteFallback = `<div class="scrap-card__sprite-fallback">${renderSprite('category', catIcon, { size: 'lg' })}</div>`;
  // Only the owner can open the editor (place edits are owner-only server-side),
  // so others' cards on a shared trip aren't tappable-to-edit.
  const editable = mine && (variant === 'trip' || variant === 'inbox' || variant === 'candidate');
  // Pencil (creator only) sits at the whole card's top-right corner. It opens
  // the full editor (which houses delete). It's an explicit action button —
  // data-action="edit" + data-scrap-id — dispatched by each editable view's
  // button-delegation loop (see trip/inbox/visited views). The pencil is the
  // ONLY edit trigger; tapping the card body does nothing.
  const editBtn = editable
    ? `<button class="scrap-card__edit" type="button" data-action="edit"
               data-scrap-id="${escapeAttr(scrap.id)}"
               aria-label="Edit place" title="Edit"><i data-lucide="pencil"></i></button>`
    : '';
  // Community pool places aren't yours to edit yet, but the aggregated pin can
  // be wrong. The pencil saves the place to your Wander List and opens the
  // editor so you can fix its location before it settles into your list.
  const communityEditBtn = (isCommunity && communityWishlist && !saved)
    ? `<button class="scrap-card__edit" type="button" data-action="community-edit"
               data-place-id="${escapeAttr(placeId)}"
               aria-label="Fix this place's location" title="Fix location"><i data-lucide="pencil"></i></button>`
    : '';
  // When there's a real image, the type bubble sits on its top-left corner —
  // icon only until tapped, then it wobbles and unrolls its label. When there's
  // no image the category sprite IS the image, so no separate bubble is shown.
  const media = imgSrc
    ? `<div class="scrap-card__media">
         <img class="scrap-card__photo" src="${escapeAttr(imgSrc)}" alt="" loading="lazy"
           onerror="this.closest('.scrap-card__media').classList.add('is-fallback');this.outerHTML='${spriteFallback.replaceAll("'", "\\'").replaceAll('"', '&quot;')}'" />
         ${_catBubble(scrap)}
       </div>`
    : `<div class="scrap-card__media">${spriteFallback}</div>`;

  let footer = '';
  if (variant === 'staged') {
    footer = `
      <div class="scrap-card__row">
        <button class="ts-btn ts-btn--sm ts-btn--mint" data-action="approve" data-scrap-id="${escapeAttr(scrap.id)}">
          <i data-lucide="check"></i>Keep it
        </button>
        <button class="ts-btn ts-btn--sm ts-btn--ghost" data-action="unassign" data-scrap-id="${escapeAttr(scrap.id)}">
          <i data-lucide="heart"></i>To Wander List
        </button>
      </div>`;
  } else if (variant === 'inbox' && checkpoint) {
    // Stays & transport: no plan picker — a checkpoint joins a trip with a
    // role (stay/arrival/…), which flows through the trip screen's
    // "+ Checkpoint". Notes / priority / edit stay available above.
    footer = '';
  } else if (variant === 'inbox') {
    // No separate trip-suggestion bubble — the "add to trips" button itself
    // reflects whether the place is already on any trip (scrap.trip_ids).
    // Delete lives in the editor popup now (pencil → red delete).
    const inAnyTrip = (scrap.trip_ids || []).length > 0;
    footer = `
      <div class="scrap-card__row">
        <button class="ts-btn ts-btn--sm ${inAnyTrip ? 'ts-btn--sky' : 'ts-btn--ghost'} scrap-card__addtrip"
                data-action="pick-trip" data-scrap-id="${escapeAttr(scrap.id)}">
          <i data-lucide="folder-plus"></i>${inAnyTrip ? 'Modify trips' : 'Add to trips'}
        </button>
      </div>`;
  } else if (variant === 'candidate') {
    footer = `
      <div class="scrap-card__row">
        <button class="ts-btn ts-btn--sm ts-btn--mint" data-action="assign"
                data-scrap-id="${escapeAttr(scrap.id)}" data-trip-id="${escapeAttr(tripId)}">
          <i data-lucide="plus"></i>Add to this trip
        </button>
      </div>`;
  } else if (isSuggestion) {
    // Unified add picker — a primary Add plus a compact Skip (x) to dismiss the
    // suggestion without adding it. The widget binds both: 'suggest-add'
    // branches on data-source ('wander' assigns the viewer's scrap via
    // data-scrap-id, 'community' saves the pool place via data-place-id);
    // 'suggest-skip' records a per-trip dismissal keyed on data-place-id
    // (ref_place_id) so the place stops surfacing here.
    footer = `
      <div class="scrap-card__row scrap-card__suggest-actions">
        <button class="ts-btn ts-btn--sm ts-btn--mint scrap-card__addtrip" data-action="suggest-add"
                data-source="${escapeAttr(suggestSource || '')}"
                ${suggestScrapId ? `data-scrap-id="${escapeAttr(suggestScrapId)}"` : ''}
                data-place-id="${escapeAttr(placeId || '')}">
          <i data-lucide="plus"></i>Add
        </button>
        <button type="button" class="scrap-card__skip" data-action="suggest-skip"
                data-place-id="${escapeAttr(placeId || '')}"
                aria-label="Skip this suggestion" title="Not interested — don't suggest again">
          <i data-lucide="x"></i>
        </button>
      </div>`;
  } else if (isCommunity) {
    // Anonymized pool place — a single full-width save action. On the Community
    // screen it lands on your Wander List ("Want to go"); inside a trip's Add
    // picker it lands on the trip ("Add").
    const addLabel = communityWishlist ? 'Want to go' : 'Add';
    const addIcon = communityWishlist ? 'heart' : 'plus';
    footer = `
      <div class="scrap-card__row">
        ${saved
          ? '<span class="ts-btn ts-btn--sm ts-btn--ghost scrap-card__addtrip" aria-disabled="true" style="opacity:0.6;"><i data-lucide="check"></i>Saved</span>'
          : `<button class="ts-btn ts-btn--sm ts-btn--mint scrap-card__addtrip" data-action="save-community" data-place-id="${escapeAttr(placeId)}"><i data-lucide="${addIcon}"></i>${addLabel}</button>`}
      </div>`;
  } else if (variant === 'trip' && canWrite && !checkpoint && showRemove) {
    // Pull the place out of THIS trip (it stays on the Wander List and in any
    // other trips). The 'unassign' action is dispatched by the trip view's
    // button-delegation loop. Suppressed (showRemove:false) where there's no
    // single "this trip" context — e.g. the Visited list spans every trip.
    footer = `
      <div class="scrap-card__row">
        <button class="ts-btn ts-btn--sm ts-btn--ghost scrap-card__remove" data-action="unassign" data-scrap-id="${escapeAttr(scrap.id)}">
          <i data-lucide="folder-minus"></i>Remove
        </button>
      </div>`;
  }

  // Visited is a priority-picker level, not a separate control — the one chip
  // carries rating OR visited state, keeping the card down to a single element.
  const isVisited = !!scrap.visited_at && !readOnly;

  // Notes are edited from the pencil editor (ScrapEditor) only — the card no
  // longer carries an editable note button (it shared the meta row with the
  // priority chip and reflowed as the priority label changed). Others' notes on
  // shared surfaces still surface as a static read-only chip when one exists.
  let noteChip = '';
  if (!readOnly && !mine && scrap.notes) {
    noteChip = `
      <span class="note-chip is-filled" title="${escapeAttr(scrap.notes)}">
        <i data-lucide="sticky-note"></i>
      </span>`;
  }

  const addedBy = (shared && !mine && scrap.added_by_display_name)
    ? `<span class="added-by"><i data-lucide="user"></i>${escapeHtml(scrap.added_by_display_name)}</span>`
    : '';
  // Priority chip: my own scraps get the rating chip (Wander List and trips
  // alike) — showing "Visited" once I've been there; someone else's
  // shared-trip scrap gets the vibe chip so I can weigh in on the consensus.
  // Tapping opens the PriorityPicker popup.
  let chip = '';
  if (!readOnly && canWrite && mine && (variant === 'trip' || variant === 'inbox')) {
    chip = _renderPriorityChip(scrap, {
      action: 'rate-open',
      activeLevel: isVisited ? 'visited' : (scrap.rating || null),
    });
  } else if (!readOnly && !isVisited && variant === 'trip' && !mine && currentUserId && scrap.trip_id) {
    chip = _renderPriorityChip(scrap, { action: 'vibe-open', activeLevel: _myVibe(scrap, currentUserId) });
  } else if (scrap.rating && mine) {
    chip = _renderRatingBadge(scrap);
  }

  // Row 1: icon-only source + maps buttons, each half the card width.
  const linksRow = _sourceButton(scrap) + _mapsButton(scrap);
  // Row 2: note chip + priority/vibe chip, together spanning the card width.
  const metaRow = noteChip + chip;
  const consensus = (variant === 'trip' && shared && scrap.trip_id) ? _renderConsensus(scrap) : '';

  // The action cluster — source/maps links, the priority/vibe meta row, the
  // group consensus roll-up, and the add/remove (or wishlist) footer — is
  // grouped into one block pinned to the card's bottom edge (margin-top:auto,
  // see .scrap-card__actions). Cards in a grid row stretch to equal height, so
  // anchoring this block keeps every card's buttons on the same baseline even
  // when some cards carry a one-line location and others wrap to two.
  const actions =
    (linksRow ? `<div class="scrap-card__row scrap-card__links">${linksRow}</div>` : '') +
    (metaRow ? `<div class="scrap-card__row scrap-card__meta">${metaRow}</div>` : '') +
    consensus +
    footer;

  return `
    <div class="sticker-card scrap-card ${readOnly ? '' : 'card-lift'} ${isSelect ? 'scrap-card--select' : ''} ${isSelect && selected ? 'is-selected' : ''} ${variant === 'staged' ? 'scrap-card--staged' : ''} ${isNew ? 'scrap-card--new' : ''} ${isVisited ? 'is-visited' : ''}"
         style="--i:${index};" data-scrap-id="${escapeAttr(scrap.id)}" data-action="${isSelect ? 'select' : 'none'}">
      ${isNew ? '<span class="scrap-card__new-badge"><i data-lucide="sparkles"></i>New</span>' : ''}
      ${isSelect ? `<span class="scrap-card__check" aria-hidden="true"><i data-lucide="${selected ? 'check-circle-2' : 'circle'}"></i></span>` : ''}
      ${isSelect && fits ? '<span class="scrap-card__fits-badge"><i data-lucide="sparkles"></i>Fits</span>' : ''}
      ${wanderPriority ? '<span class="scrap-card__fits-badge"><i data-lucide="heart"></i>Your list</span>' : ''}
      ${editBtn}${communityEditBtn}
      ${media}
      <p class="scrap-card__title"><span class="scrap-card__title-inner">${escapeHtml(title)}</span></p>
      ${sub ? `<p class="scrap-card__sub">${escapeHtml(sub)}</p>` : ''}
      ${isCommunity ? `<p class="scrap-card__sub scrap-card__saved-by"><i data-lucide="users"></i>Saved by ${savedByCount} traveler${savedByCount === 1 ? '' : 's'}</p>` : ''}
      ${addedBy}
      ${actions ? `<div class="scrap-card__actions">${actions}</div>` : ''}
    </div>
  `;
}

// Self-wiring, like the source/maps buttons above: watches for scrap-card
// titles entering the DOM and flags the ones that overflow their card width
// so CSS can slide them back and forth instead of wrapping (see .is-marquee
// in styles.css). No view needs to call anything.
function _checkTitleMarquee(el) {
  const inner = el.querySelector(':scope > .scrap-card__title-inner');
  if (!inner) return;
  const overflow = inner.scrollWidth - el.clientWidth;
  el.classList.toggle('is-marquee', overflow > 1);
  el.style.setProperty('--marquee-shift', overflow > 1 ? `-${overflow}px` : '0px');
}
function _scanTitleMarquees(root) {
  (root || document).querySelectorAll('.scrap-card__title').forEach(_checkTitleMarquee);
}
function _startTitleMarqueeObserver() {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', _startTitleMarqueeObserver, { once: true });
    return;
  }
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.('.scrap-card__title')) _checkTitleMarquee(node);
        node.querySelectorAll?.('.scrap-card__title').forEach(_checkTitleMarquee);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', () => _scanTitleMarquees());
}
_startTitleMarqueeObserver();
