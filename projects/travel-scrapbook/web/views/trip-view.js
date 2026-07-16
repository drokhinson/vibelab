// views/trip-view.js — trip detail: plans (todos), checkpoints (stays/travel),
// quick-paste, route panel (rendered by ui/route-panel.js; share modal lives
// in widgets/trip-share.js).
'use strict';

class TripView extends View {
  constructor() {
    super('trip');
    this._resetState();
  }

  _resetState() {
    this._tripId = null;
    this._priorityOnly = false;
    this._route = null;
    this._routeBusy = false;
    this._candidates = [];
    this._candidatesSeq = 0;
    // Plans (default) or the day-by-day Timeline.
    this._tab = localStorage.getItem('ts.trip.tab') || 'plans';
    this._timeline = null; // null = not loaded yet
    this._timelineSeq = 0;
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
    // Anchor/plan changes reload the trip → keep the timeline data in step
    // (sequence-guarded, so bursts collapse to the latest response).
    this.listen('trip:' + this._tripId, () => {
      this.render();
      if (this._tab === 'timeline') this._loadTimeline();
    });
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
      if (this._tab === 'timeline') this._loadTimeline();
      window.ShareDomain.loadMembers(this._tripId).catch(() => {});
    } catch (err) {
      this.container.innerHTML = `<div class="error-banner"><i data-lucide="cloud-off"></i>${escapeHtml(err.message || 'Could not load trip')}</div>`;
      this.refreshIcons();
    }
  }

  // After a schedule change: fresh timeline + fresh trip (plan_date rides on
  // the scraps the Plans tab shows too).
  _refreshTimeline(tripId) {
    this._loadTimeline();
    window.TripDomain.load(tripId).catch(() => {});
  }

  // Lazy-load the timeline for the Timeline tab. Sequence-guarded like
  // _loadCandidates so a stale response never paints another trip's days.
  async _loadTimeline() {
    const seq = ++this._timelineSeq;
    const tripId = this._tripId;
    try {
      const data = await window.api.tripTimeline(tripId);
      if (seq !== this._timelineSeq || this._tripId !== tripId) return;
      this._timeline = data;
      this.render();
    } catch (_) { /* tab keeps its skeleton; a retap retries */ }
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

    // Visited plans stay visible but greyed out and sorted to the bottom
    // (stable sort keeps each half in its original order).
    const allScraps = [...(trip.scraps || [])].sort(
      (a, b) => (a.visited_at ? 1 : 0) - (b.visited_at ? 1 : 0)
    );
    const staged = trip.staged_scraps || [];
    const isPriority = (s) => s.rating === 'booked' || s.rating === 'must_do';
    const scraps = this._priorityOnly ? allScraps.filter(isPriority) : allScraps;
    const geocodedCount = allScraps.filter((s) => s.lat != null).length;
    const dates = formatDateRange(trip.start_date, trip.end_date);

    this.container.innerHTML = `
      <div class="trip-toolbar">
        <button class="ts-btn ts-btn--ghost ts-btn--sm" id="trip-back"><i data-lucide="arrow-left"></i>Trips</button>
        <div class="trip-toolbar__actions">
          ${isOwner ? `<button class="ts-btn ts-btn--ghost ts-btn--sm trip-toolbar__btn" id="trip-edit" aria-label="Edit trip"><i data-lucide="pencil"></i></button>` : ''}
          <button class="ts-btn ts-btn--ghost ts-btn--sm trip-toolbar__btn" id="trip-share" aria-label="Collaborators"><i data-lucide="users"></i></button>
          ${isOwner ? `<button class="ts-btn ts-btn--ghost ts-btn--sm trip-toolbar__btn" id="trip-delete" aria-label="Delete trip"><i data-lucide="trash-2"></i></button>` : ''}
        </div>
      </div>
      <div class="trip-heading">
        ${renderSprite('cover', trip.cover_icon, { size: 'lg', alt: '' })}
        <div style="min-width:0;flex:1;">
          <h1 style="font-size:2.1rem;margin:0;">${escapeHtml(trip.name)}</h1>
          <p class="scrap-card__sub">${escapeHtml([trip.destination, dates].filter(Boolean).join(' · '))}</p>
          ${!isOwner && trip.owner_display_name ? `<span class="added-by"><i data-lucide="user"></i>Shared by ${escapeHtml(trip.owner_display_name)}</span>` : ''}
        </div>
      </div>
      <div class="ts-segmented" role="tablist" aria-label="Trip view" style="margin-top:0.9rem;">
        <label class="ts-segmented__opt"><input type="radio" name="trip-tab" value="plans" ${this._tab === 'plans' ? 'checked' : ''} /><span>Plans</span></label>
        <label class="ts-segmented__opt"><input type="radio" name="trip-tab" value="timeline" ${this._tab === 'timeline' ? 'checked' : ''} /><span>Timeline</span></label>
      </div>
      ${this._tab === 'timeline' ? renderTripTimeline(trip, this._timeline, { canWrite }) : `
      ${this._renderStaging(staged, cardOpts)}
      ${canWrite ? this._renderCandidates(cardOpts) : ''}
      ${renderRoutePanel(trip, { route: this._route, geocodedCount, canWrite, routeBusy: this._routeBusy })}
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.6rem;margin-top:1.2rem;flex-wrap:wrap;">
        <h2 style="font-size:1.5rem;margin:0;">Plans</h2>
        <div style="display:flex;gap:0.5rem;">
          ${canWrite ? `
            <button class="ts-btn ts-btn--blush ts-btn--sm" id="add-plans"><i data-lucide="plus"></i>Todo</button>
            <button class="ts-btn ts-btn--sky ts-btn--sm" data-action="add-checkpoint"><i data-lucide="plus"></i>Checkpoint</button>` : ''}
          <button class="ts-btn ts-btn--ghost ts-btn--sm" id="priority-filter"
                  style="${this._priorityOnly ? 'border-color:var(--butter-deep, #C9A227);color:#8A6D1A;' : ''}">
            <i data-lucide="star"></i>${this._priorityOnly ? 'All' : 'Must-dos'}
          </button>
        </div>
      </div>
      ${scraps.length === 0 ? `
        <div class="empty-state">
          <img src="/assets/illustrations/travel-scrapbook-empty-scraps.svg" alt="" />
          <p class="empty-title">${this._priorityOnly ? 'No must-dos yet' : 'No plans yet'}</p>
          <p class="empty-desc">${this._priorityOnly
            ? 'Rate plans “Must do” or “Booked” and they collect here.'
            : (canWrite
              ? 'Tap “+ Todo” to pick from your Wander List — or paste a link below.'
              : 'When the crew adds places, they’ll show up here for you to vibe on.')}</p>
        </div>` : `
        ${renderGroupedList(scraps, {
          dims: ['category', 'region', 'country', 'city'], active: this._groupBy,
          collapsed: this._collapsed, variant: 'trip', name: 'trip-groupby', ...cardOpts,
        })}`}
      ${this._renderCheckpoints(trip, { canWrite })}
      `}
      ${canWrite ? renderQuickPaste(trip.id) : ''}
    `;
    this.refreshIcons();
    this._bind(trip, { isOwner, canWrite });
  }

  // The trip's checkpoints — stays and travel — as simple typed cards under
  // the plans list, chronological, with gap placeholders between dated ones.
  _renderCheckpoints(trip, { canWrite = true } = {}) {
    const anchors = trip.anchors || [];
    if (!anchors.length && !canWrite) return '';
    return `
      <div style="margin-top:1.4rem;">
        <h2 style="font-size:1.5rem;margin:0;">Checkpoints</h2>
        <p class="scrap-card__sub">Stays and travel that frame the trip.</p>
        ${anchors.length
          ? renderCheckpointList(anchors, { canWrite })
          : `<button class="checkpoint-gap" data-action="add-checkpoint" style="margin-top:0.6rem;">
               <i data-lucide="plus"></i>Add your first checkpoint — a stay or travel leg
             </button>`}
      </div>
    `;
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

  _bind(trip, { isOwner = true, canWrite = true } = {}) {
    const c = this.container;
    c.querySelector('#trip-back')?.addEventListener('click', () => window.router.back('trips'));

    // Plans | Timeline tab. The timeline lazy-loads on first switch.
    c.querySelectorAll('input[name=trip-tab]').forEach((r) => {
      r.addEventListener('change', () => {
        if (!r.checked) return;
        this._tab = r.value;
        localStorage.setItem('ts.trip.tab', this._tab);
        this.render();
        if (this._tab === 'timeline' && !this._timeline) this._loadTimeline();
      });
    });
    // Timeline empty state → open the trip editor to add dates.
    c.querySelector('#tl-edit-trip')?.addEventListener('click', () => {
      TripEditor.open(trip, { onSaved: () => { this._timeline = null; this._loadTimeline(); } });
    });
    c.querySelector('#trip-share')?.addEventListener('click', () => TripShare.open(trip, { isOwner }));
    c.querySelector('#trip-delete')?.addEventListener('click', async () => {
      if (!confirmDestructive(`Delete "${trip.name}" and all its plans? This can't be undone.`)) return;
      try {
        await window.TripDomain.remove(trip.id);
        toast('Trip deleted');
        window.router.go('trips');
      } catch (err) { toast(err.message, { error: true }); }
    });
    c.querySelector('#priority-filter')?.addEventListener('click', () => {
      this._priorityOnly = !this._priorityOnly;
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

    // Checkpoints: the "+ Checkpoint" buttons (Plans header + mid-timeline)
    // open the editor defaulting to a stay — the role select flips to travel.
    c.querySelectorAll('[data-action=add-checkpoint]').forEach((btn) => {
      btn.addEventListener('click', () => AnchorEditor.open(trip, { role: 'stay' }));
    });
    // A gap placeholder between two dated checkpoints prefills the empty dates.
    c.querySelectorAll('[data-action=add-checkpoint-gap]').forEach((btn) => {
      btn.addEventListener('click', () => AnchorEditor.open(trip, {
        role: 'stay',
        prefill: {
          stay_date: btn.dataset.start,
          stay_end_date: btn.dataset.end,
          anchor_date: btn.dataset.start,
        },
      }));
    });
    // Timeline bookends: create the arrival/departure with the role preset.
    c.querySelectorAll('[data-action=add-anchor-role]').forEach((btn) => {
      btn.addEventListener('click', () => AnchorEditor.open(trip, { role: btn.dataset.role }));
    });
    c.querySelectorAll('[data-action=edit-anchor]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const anchor = (trip.anchors || []).find((a) => a.id === btn.dataset.anchorId);
        if (anchor) AnchorEditor.open(trip, { anchor });
      });
    });
    c.querySelectorAll('[data-action=remove-anchor]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const anchor = (trip.anchors || []).find((a) => a.id === btn.dataset.anchorId);
        if (!confirmDestructive(`Remove the "${anchor ? anchor.label : 'this'}" checkpoint? This can't be undone.`)) return;
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
            if (action === 'rate-open') {
              PriorityPicker.open({
                activeLevel: scrap.visited_at ? 'visited' : (scrap.rating || null),
                verb: 'priority',
                withVisited: true,
                onPick: async (level) => {
                  try {
                    await window.ScrapDomain.applyPriority(scrapId, trip.id, level, !!scrap.visited_at);
                    if (level === 'visited') toast('Marked visited');
                    else if (scrap.visited_at) toast('Back on your wishlist');
                  } catch (err) { toast(err.message, { error: true }); }
                },
              });
            } else if (action === 'notes') {
              NotePopup.open(scrap, { onSaved: () => window.TripDomain.load(trip.id) });
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
            } else if (action === 'vibe-open') {
              const user = window.store.get('user');
              const myVibe = (scrap.vibes || []).find((v) => v.user_id === (user && user.user_id));
              PriorityPicker.open({
                activeLevel: myVibe ? myVibe.level : null,
                verb: 'vibe',
                onPick: async (level) => {
                  try { await window.ScrapDomain.applyVibe(scrapId, trip.id, level); }
                  catch (err) { toast(err.message, { error: true }); }
                },
              });
            } else if (action === 'slot') {
              // One-tap "add to Day N" from a timeline suggestion chip.
              await window.api.scheduleScrap(scrapId, trip.id, { plan_date: el.dataset.date });
              toast('Slotted in');
              this._refreshTimeline(trip.id);
            } else if (action === 'schedule') {
              PlanScheduler.open(scrap, {
                tripId: trip.id,
                days: (this._timeline?.days || []).map((d) => ({ date: d.date, day_number: d.day_number })),
                tripBounds: { start: trip.start_date, end: trip.end_date },
                onSaved: () => { toast('Scheduled'); this._refreshTimeline(trip.id); },
              });
            } else if (action === 'delete') {
              if (!confirmDestructive('Delete this place? This can\'t be undone.')) return;
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
        this._route = await window.RouteDomain.optimize(trip.id, { priority_only: this._priorityOnly });
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
}
window.TripView = TripView;
