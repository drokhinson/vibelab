// views/trip-view.js — trip detail: anchors, quick-paste, scraps, route panel.
'use strict';

class TripView extends View {
  constructor() {
    super('trip');
    this._resetState();
  }

  _resetState() {
    this._tripId = null;
    this._favoritesOnly = false;
    this._route = null;
    this._routeBusy = false;
    this._candidates = [];
    this._candidatesSeq = 0;
    // Group the trip's scraps by activity type (default) or geography.
    this._groupBy = localStorage.getItem('ts.trip.groupBy') || 'category';
    this._collapsed = new Set();
  }

  renderLoading() {
    this.container.innerHTML = `
      <div class="sticker-card shimmer" style="height:90px;"></div>
      <div class="card-grid card-grid--2col" style="margin-top:1rem;">
        <div class="sticker-card shimmer" style="height:180px;"></div>
        <div class="sticker-card shimmer" style="height:180px;"></div>
      </div>
    `;
  }

  async onMount() {
    this._resetState();
    this._tripId = this.params.tripId;
    this.listen('trip:' + this._tripId, () => this.render());
    this.listen('members:' + this._tripId, () => this.render());
    this.listen('pollTimedOut:' + this._tripId, () => this.render());
    await this._load();
  }

  async onParamsChange(params) {
    if (params.tripId !== this._tripId) {
      window.ScrapDomain.stopPolling();
      this._resetState();
      this._tripId = params.tripId;
      this.renderLoading();
      this.listen('trip:' + this._tripId, () => this.render());
      this.listen('members:' + this._tripId, () => this.render());
      await this._load();
    }
  }

  async onUnmount() {
    window.ScrapDomain.stopPolling();
  }

  async _load() {
    try {
      const trip = await window.TripDomain.load(this._tripId);
      // Collaborators can add from their wishlist; viewers can't.
      if (trip.role !== 'viewer') this._loadCandidates();
      window.ShareDomain.loadMembers(this._tripId).catch(() => {});
    } catch (err) {
      this.container.innerHTML = `<div class="error-banner"><i data-lucide="cloud-off"></i>${escapeHtml(err.message || 'Could not load trip')}</div>`;
      this.refreshIcons();
    }
  }

  // Wishlist places that fit this trip's scope. Non-blocking (per the
  // instantaneous-nav rule); a monotonic guard drops stale results after a
  // navigation or a newer refresh.
  async _loadCandidates() {
    const seq = ++this._candidatesSeq;
    const tripId = this._tripId;
    try {
      const res = await window.api.tripCandidates(tripId);
      if (seq !== this._candidatesSeq || this._tripId !== tripId) return;
      this._candidates = res.scraps || [];
      this.render();
    } catch (_) { /* panel just stays hidden */ }
  }

  render() {
    const trip = window.store.get('trip:' + this._tripId);
    if (!trip) return;
    const user = window.store.get('user');
    const currentUserId = user ? user.user_id : null;
    const isOwner = trip.role === 'owner';
    const canWrite = trip.role === 'owner' || trip.role === 'collaborator';
    const members = window.store.get('members:' + this._tripId) || [];
    // "Shared" (show consensus + who-added) once anyone besides the owner is on
    // board, or whenever the viewer isn't the owner.
    const acceptedCount = members.filter((m) => m.status !== 'pending').length;
    const shared = !isOwner || acceptedCount > 1;
    const cardOpts = { shared, currentUserId, canWrite };

    const allScraps = trip.scraps || [];
    const staged = trip.staged_scraps || [];
    const scraps = this._favoritesOnly ? allScraps.filter((s) => s.is_favorite) : allScraps;
    const geocodedCount = allScraps.filter((s) => s.lat != null).length;
    const dates = formatDateRange(trip.start_date, trip.end_date);

    this.container.innerHTML = `
      <button class="ts-btn ts-btn--ghost ts-btn--sm" id="trip-back"><i data-lucide="arrow-left"></i>Trips</button>
      <div style="display:flex;align-items:center;gap:0.8rem;margin-top:0.8rem;">
        ${renderSprite('cover', trip.cover_icon, { size: 'lg', alt: '' })}
        <div style="min-width:0;flex:1;">
          <h1 style="font-size:2.1rem;margin:0;">${escapeHtml(trip.name)}</h1>
          <p class="scrap-card__sub">${escapeHtml([trip.destination, dates].filter(Boolean).join(' · '))}</p>
          ${!isOwner && trip.owner_display_name ? `<span class="added-by"><i data-lucide="user"></i>Shared by ${escapeHtml(trip.owner_display_name)}</span>` : ''}
        </div>
        ${isOwner ? `<button class="ts-header__nav-btn ts-btn ts-btn--ghost ts-btn--sm" id="trip-edit" aria-label="Edit trip"><i data-lucide="pencil"></i></button>` : ''}
        <button class="ts-header__nav-btn ts-btn ts-btn--ghost ts-btn--sm" id="trip-share" aria-label="Share trip"><i data-lucide="users"></i></button>
        ${isOwner ? `<button class="ts-header__nav-btn ts-btn ts-btn--ghost ts-btn--sm" id="trip-delete" aria-label="Delete trip"><i data-lucide="trash-2"></i></button>` : ''}
      </div>
      ${renderAnchorsStrip(trip, { readOnly: !canWrite })}
      ${canWrite ? renderQuickPaste(trip.id) : ''}
      ${this._renderStaging(staged, cardOpts)}
      ${canWrite ? this._renderCandidates(cardOpts) : ''}
      ${this._renderRoutePanel(trip, geocodedCount, canWrite)}
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.6rem;margin-top:1.2rem;flex-wrap:wrap;">
        <h2 style="font-size:1.5rem;margin:0;">Plans</h2>
        <div style="display:flex;gap:0.5rem;">
          ${canWrite ? `<button class="ts-btn ts-btn--blush ts-btn--sm" id="add-plans"><i data-lucide="plus"></i>Add plans</button>` : ''}
          <button class="ts-btn ts-btn--ghost ts-btn--sm ${this._favoritesOnly ? 'is-fav' : ''}" id="fav-filter"
                  style="${this._favoritesOnly ? 'border-color:var(--blush);color:#E4557A;' : ''}">
            <i data-lucide="heart"></i>${this._favoritesOnly ? 'All' : 'Favorites'}
          </button>
        </div>
      </div>
      ${scraps.length === 0 ? `
        <div class="empty-state">
          <img src="/assets/illustrations/travel-scrapbook-empty-scraps.svg" alt="" />
          <p class="empty-title">${this._favoritesOnly ? 'No favorites yet' : 'No plans yet'}</p>
          <p class="empty-desc">${this._favoritesOnly
            ? 'Tap the heart on plans you love and they collect here.'
            : (canWrite
              ? 'Tap “Add plans” to pick from your Wander List or add a place — or paste a link above.'
              : 'When the crew adds places, they’ll show up here for you to vibe on.')}</p>
        </div>` : `
        ${renderGroupedList(scraps, {
          dims: ['category', 'region', 'country', 'city'], active: this._groupBy,
          collapsed: this._collapsed, variant: 'trip', name: 'trip-groupby', ...cardOpts,
        })}`}
    `;
    this.refreshIcons();
    this._bind(trip, { isOwner, canWrite });
  }

  _renderStaging(staged, cardOpts = {}) {
    if (!staged.length) return '';
    return `
      <div class="sticker-card washi washi--lavender" style="padding-top:1.2rem;margin-top:1.1rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.6rem;flex-wrap:wrap;">
          <div>
            <h2 style="font-size:1.5rem;margin:0;">Needs review</h2>
            <p class="scrap-card__sub">We think these belong in this trip — keep or move them.</p>
          </div>
          <button class="ts-btn ts-btn--mint ts-btn--sm" id="approve-all-staged">
            <i data-lucide="check-check"></i>Keep all ${staged.length}
          </button>
        </div>
        <div class="card-grid card-grid--2col" style="margin-top:0.8rem;">
          ${staged.map((s, i) => renderScrapCard(s, { index: i, variant: 'staged', ...cardOpts })).join('')}
        </div>
      </div>
    `;
  }

  _renderCandidates(cardOpts = {}) {
    const cands = this._candidates || [];
    if (!cands.length) return '';
    return `
      <div class="sticker-card washi washi--sky" style="padding-top:1.2rem;margin-top:1.1rem;">
        <div>
          <h2 style="font-size:1.5rem;margin:0;">Suggested plans</h2>
          <p class="scrap-card__sub">From your Wander List, matching this trip — tap to add.</p>
        </div>
        <div class="card-grid card-grid--2col" style="margin-top:0.8rem;">
          ${cands.map((s, i) => renderScrapCard(s, { index: i, variant: 'candidate', tripId: this._tripId, ...cardOpts })).join('')}
        </div>
      </div>
    `;
  }

  _renderRoutePanel(trip, geocodedCount, canWrite = true) {
    if (geocodedCount < 2 && !this._route) return '';
    let body = '';
    if (this._route) {
      const r = this._route;
      const stops = [];
      const anchors = trip.anchors || [];
      const start = anchors.find((a) => a.role === 'start' && a.lat != null) ||
                    anchors.find((a) => a.role === 'stay' && a.lat != null);
      const end = anchors.find((a) => a.role === 'end' && a.lat != null);
      if (start) stops.push({ label: start.label, isAnchor: true });
      r.ordered_scraps.forEach((s) => stops.push({ label: s.place_name || 'Stop' }));
      if (end) stops.push({ label: end.label, isAnchor: true });
      let n = 0;
      body = `
        <div style="margin-top:0.8rem;">
          ${stops.map((stop, i) => {
            if (!stop.isAnchor) n += 1;
            const legKm = i < r.legs.length ? r.legs[i].distance_km : null;
            return renderRouteStop(stop, n, { legKm });
          }).join('')}
          <p class="scrap-card__sub" style="margin-top:0.5rem;">Total: ${formatKm(r.total_km)}
            ${r.skipped_scrap_ids.length ? ` · ${r.skipped_scrap_ids.length} scrap${r.skipped_scrap_ids.length === 1 ? '' : 's'} skipped (no map pin yet)` : ''}</p>
          <div style="display:flex;gap:0.6rem;flex-wrap:wrap;margin-top:0.7rem;">
            <button class="ts-btn ts-btn--sky ts-btn--sm" id="route-maps"><i data-lucide="map"></i>Open in Google Maps</button>
            <button class="ts-btn ts-btn--ghost ts-btn--sm" id="route-csv"><i data-lucide="download"></i>CSV for My Maps</button>
          </div>
          <div id="route-legs" style="display:flex;flex-direction:column;gap:0.4rem;margin-top:0.5rem;"></div>
        </div>
      `;
    }
    return `
      <div class="sticker-card washi washi--butter" style="padding-top:1.2rem;margin-top:1.1rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.6rem;">
          <div>
            <h2 style="font-size:1.5rem;margin:0;">Route</h2>
            <p class="scrap-card__sub">${geocodedCount} place${geocodedCount === 1 ? '' : 's'} on the map</p>
          </div>
          ${canWrite ? `<button class="ts-btn ts-btn--mint ts-btn--sm" id="route-optimize" ${this._routeBusy ? 'disabled' : ''}>
            <i data-lucide="wand-2"></i>${this._route ? 'Re-sort' : 'Sort my route'}
          </button>` : ''}
        </div>
        ${body}
      </div>
    `;
  }

  _bind(trip, { isOwner = true, canWrite = true } = {}) {
    const c = this.container;
    c.querySelector('#trip-back')?.addEventListener('click', () => window.router.back('trips'));
    c.querySelector('#trip-share')?.addEventListener('click', () => this._openShareModal(trip, { isOwner }));
    c.querySelector('#trip-delete')?.addEventListener('click', async () => {
      if (!confirmDestructive(`Delete "${trip.name}" and all its scraps? This can't be undone.`)) return;
      try {
        await window.TripDomain.remove(trip.id);
        toast('Trip deleted');
        window.router.go('trips');
      } catch (err) { toast(err.message, { error: true }); }
    });
    c.querySelector('#fav-filter')?.addEventListener('click', () => {
      this._favoritesOnly = !this._favoritesOnly;
      this.render();
    });
    c.querySelector('#trip-edit')?.addEventListener('click', () => {
      TripEditor.open(trip, { onSaved: () => this._loadCandidates() });
    });
    c.querySelector('#add-plans')?.addEventListener('click', () => {
      AddPlans.open(trip, {
        onSaved: async () => {
          await window.TripDomain.load(trip.id);
          this._loadCandidates();
          window.SourceDomain?.refreshInboxCount();
        },
      });
    });

    bindScrapGroups(c, {
      name: 'trip-groupby',
      collapsed: this._collapsed,
      onChange: (dim) => {
        this._groupBy = dim;
        this._collapsed = new Set();
        localStorage.setItem('ts.trip.groupBy', dim);
        this.render();
      },
    });

    bindQuickPaste(c);

    c.querySelector('[data-action=add-anchor]')?.addEventListener('click', () => AnchorEditor.open(trip));
    c.querySelectorAll('[data-action=remove-anchor]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try { await window.TripDomain.removeAnchor(trip.id, btn.dataset.anchorId); }
        catch (err) { toast(err.message, { error: true }); }
      });
    });

    // Staged review: keep all in one tap.
    c.querySelector('#approve-all-staged')?.addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        await window.ScrapDomain.approveAll(trip.id);
        toast('All kept — welcome aboard!');
      } catch (err) { toast(err.message, { error: true }); }
    });

    // Scrap card actions (edit opens the editor; the rest are inline buttons).
    const findScrap = (id) =>
      (trip.scraps || []).find((s) => s.id === id) ||
      (trip.staged_scraps || []).find((s) => s.id === id) ||
      (this._candidates || []).find((s) => s.id === id);
    c.querySelectorAll('[data-scrap-id]').forEach((el) => {
      const scrapId = el.dataset.scrapId;
      const scrap = findScrap(scrapId);
      if (!scrap) return;
      const action = el.dataset.action;
      if (el.classList.contains('sticker-card') && action === 'edit') {
        el.addEventListener('click', () => ScrapEditor.open(scrap, trip.id));
      }
      if (el.tagName === 'BUTTON') {
        el.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          try {
            if (action === 'favorite') {
              await window.ScrapDomain.update(scrapId, trip.id, { is_favorite: !scrap.is_favorite });
            } else if (action === 'visited') {
              await window.ScrapDomain.toggleVisited(scrapId, trip.id, !!scrap.visited_at);
              toast(scrap.visited_at ? 'Back on your wishlist' : 'Marked visited');
            } else if (action === 'approve') {
              await window.ScrapDomain.approve(scrapId, trip.id);
              toast('Kept!');
            } else if (action === 'unassign') {
              await window.ScrapDomain.unassign(scrapId, trip.id);
              toast('Moved to your wishlist');
              this._loadCandidates();
            } else if (action === 'assign') {
              await window.api.assignScrap(scrapId, el.dataset.tripId || trip.id);
              toast('Added to the trip');
              await window.TripDomain.load(trip.id);
              this._loadCandidates();
              window.SourceDomain?.refreshInboxCount();
            } else if (action === 'edit') {
              ScrapEditor.open(scrap, trip.id);
            } else if (action === 'vibe') {
              const user = window.store.get('user');
              const myVibe = (scrap.vibes || []).find((v) => v.user_id === (user && user.user_id));
              await window.ScrapDomain.setVibe(scrapId, trip.id, el.dataset.level, myVibe ? myVibe.level : null);
            } else if (action === 'delete') {
              if (!confirmDestructive('Delete this scrap? This can\'t be undone.')) return;
              await window.ScrapDomain.remove(scrapId, trip.id);
            }
          } catch (err) { toast(err.message, { error: true }); }
        });
      }
    });

    c.querySelector('#route-optimize')?.addEventListener('click', async () => {
      this._routeBusy = true;
      this.render();
      try {
        this._route = await window.RouteDomain.optimize(trip.id, { favorites_only: this._favoritesOnly });
      } catch (err) {
        toast(err.message || 'Route sorting failed', { error: true });
      } finally {
        this._routeBusy = false;
        this.render();
      }
    });

    c.querySelector('#route-maps')?.addEventListener('click', async () => {
      try {
        const res = await window.RouteDomain.mapsLinks(trip.id);
        if (!res.legs.length) { toast('Pin at least two stops first', { error: true }); return; }
        if (res.legs.length === 1) {
          window.open(res.legs[0].url, '_blank', 'noopener');
          return;
        }
        const legsEl = c.querySelector('#route-legs');
        legsEl.innerHTML = res.legs.map((leg) => `
          <a class="ts-btn ts-btn--ghost ts-btn--sm" href="${escapeAttr(leg.url)}" target="_blank" rel="noopener" style="justify-content:flex-start;">
            <i data-lucide="external-link"></i>${escapeHtml(leg.label)} (${leg.stop_count} stops)
          </a>`).join('');
        this.refreshIcons(legsEl);
      } catch (err) { toast(err.message, { error: true }); }
    });

    c.querySelector('#route-csv')?.addEventListener('click', async () => {
      try {
        await window.RouteDomain.downloadCsv(trip.id, trip.name);
        toast('CSV downloaded — import it in Google My Maps');
      } catch (err) { toast(err.message, { error: true }); }
    });
  }

  // Share panel: invite by username (owner), manage roles, remove/leave.
  _openShareModal(trip, { isOwner = true } = {}) {
    document.getElementById('share-modal')?.remove();
    const tripId = trip.id;
    const user = window.store.get('user');
    const meId = user ? user.user_id : null;
    const ROLE_LABEL = { owner: 'Owner', collaborator: 'Collaborator', viewer: 'Viewer' };

    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'share-modal';
    document.body.appendChild(modal);
    const close = () => modal.remove();

    const memberRow = (m) => {
      const initial = (m.display_name || '?').trim().charAt(0).toUpperCase() || '?';
      const pending = m.status === 'pending';
      const canManage = isOwner && m.role !== 'owner';
      return `
        <div class="crew-row" data-user-id="${escapeAttr(m.user_id)}">
          <span class="crew-avatar">${escapeHtml(initial)}</span>
          <div style="min-width:0;flex:1;">
            <div style="font-weight:700;">${escapeHtml(m.display_name)}${m.user_id === meId ? ' <span class="scrap-card__sub" style="font-weight:600;">(you)</span>' : ''}</div>
            <div class="scrap-card__sub">@${escapeHtml(m.username || '')}${pending ? ' · invite pending' : ''}</div>
          </div>
          ${canManage ? `
            <select class="ts-input crew-role" data-user-id="${escapeAttr(m.user_id)}" style="width:auto;padding:0.3rem 0.5rem;margin:0;">
              <option value="collaborator" ${m.role === 'collaborator' ? 'selected' : ''}>Collaborator</option>
              <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>Viewer</option>
            </select>
            <button class="crew-remove" data-user-id="${escapeAttr(m.user_id)}" aria-label="Remove ${escapeAttr(m.display_name)}"><i data-lucide="x"></i></button>`
            : `<span class="crew-role-badge">${ROLE_LABEL[m.role] || m.role}</span>`}
        </div>`;
    };

    const paint = () => {
      const members = window.store.get('members:' + tripId) || [];
      modal.innerHTML = `
        <div class="ts-modal__backdrop"></div>
        <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Share trip">
          <button class="ts-modal__close" aria-label="Close"><i data-lucide="x"></i></button>
          <h2 class="ts-modal__title">Trip crew</h2>
          <p class="scrap-card__sub" style="margin-top:-0.4rem;">Everyone here can add their vibe on each place; collaborators can also add places.</p>
          <div class="crew-list">${members.map(memberRow).join('')}</div>
          ${isOwner ? `
            <form id="invite-form" style="margin-top:1rem;">
              <label class="ts-label" for="invite-username">Invite by username</label>
              <div style="display:flex;gap:0.5rem;align-items:flex-end;">
                <input class="ts-input" id="invite-username" placeholder="their @username" maxlength="30" style="flex:1;margin:0;" />
                <select class="ts-input" id="invite-role" style="width:auto;margin:0;">
                  <option value="collaborator">Collaborator</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
              <button class="ts-btn ts-btn--mint" type="submit" style="width:100%;margin-top:0.8rem;">
                <i data-lucide="user-plus"></i>Send invite
              </button>
            </form>`
          : `
            <button class="ts-btn ts-btn--ghost" id="leave-trip" style="width:100%;margin-top:1rem;color:#E4557A;border-color:var(--blush);">
              <i data-lucide="log-out"></i>Leave this trip
            </button>`}
        </div>`;
      window.lucide?.createIcons({ root: modal });
      bind();
    };

    const bind = () => {
      modal.querySelector('.ts-modal__backdrop')?.addEventListener('click', close);
      modal.querySelector('.ts-modal__close')?.addEventListener('click', close);

      modal.querySelector('#invite-form')?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const username = modal.querySelector('#invite-username').value.trim().replace(/^@/, '');
        const role = modal.querySelector('#invite-role').value;
        if (!username) return;
        try {
          await window.ShareDomain.invite(tripId, username, role);
          toast(`Invited @${username}`);
          paint();
        } catch (err) { toast(err.message || 'Could not invite', { error: true }); }
      });

      modal.querySelectorAll('.crew-role').forEach((sel) => {
        sel.addEventListener('change', async () => {
          try {
            await window.ShareDomain.changeRole(tripId, sel.dataset.userId, sel.value);
            toast('Role updated');
            paint();
          } catch (err) { toast(err.message, { error: true }); paint(); }
        });
      });

      modal.querySelectorAll('.crew-remove').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirmDestructive('Remove this traveler from the trip?')) return;
          try {
            await window.ShareDomain.removeMember(tripId, btn.dataset.userId);
            toast('Removed');
            paint();
          } catch (err) { toast(err.message, { error: true }); }
        });
      });

      modal.querySelector('#leave-trip')?.addEventListener('click', async () => {
        if (!confirmDestructive(`Leave "${trip.name}"? You'll lose access unless you're re-invited.`)) return;
        try {
          await window.ShareDomain.removeMember(tripId, meId);
          await window.TripDomain.loadAll();
          close();
          toast('You left the trip');
          window.router.go('trips');
        } catch (err) { toast(err.message, { error: true }); }
      });
    };

    paint();
    // Refresh the crew from the server in case it changed since the trip loaded.
    window.ShareDomain.loadMembers(tripId).then(paint).catch(() => {});
  }
}
window.TripView = TripView;
