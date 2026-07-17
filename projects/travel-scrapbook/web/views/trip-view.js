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
    // Plans (default) or the day-by-day Timeline (computed locally from the
    // trip bundle — see domain/timeline.js).
    this._tab = localStorage.getItem('ts.trip.tab') || 'plans';
    // Group the trip's scraps by activity type (default) or geography.
    this._groupBy = localStorage.getItem('ts.trip.groupBy') || 'category';
    this._collapsed = new Set();
    this._painted = false; // a different trip is a fresh visit → animate once
    // Structural fingerprint of the last full render — the trip-bundle listener
    // diffs against it to decide surgical (field-only) vs full re-render. Null
    // forces a full render on the first paint (and after a trip switch).
    this._lastSig = null;
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
    // Everything renders off the trip bundle in store; the timeline/plans are
    // pure math over it. A scrap-field mutation (priority, schedule, outcome)
    // surgically re-renders just the active tab's content region; a structural
    // change (membership, anchors, dates) does a full render — see _onTripUpdate.
    this.listen('trip:' + this._tripId, () => this._onTripUpdate());
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
      this.listen('trip:' + this._tripId, () => this._onTripUpdate());
      this.listen('members:' + this._tripId, () => this.render());
      await this._load();
    }
  }

  async onUnmount() {
    window.ScrapDomain.stopPolling();
  }

  // One bundle fetch covers the whole screen (trip + scraps + members +
  // candidates; the timeline is computed locally). Stale-while-revalidate:
  // a cached bundle paints instantly and the fresh one re-renders on arrival.
  async _load() {
    const cached = window.store.get('trip:' + this._tripId) ||
      window.tsCache?.get('trip', this._tripId);
    if (cached) {
      window.store.set('trip:' + this._tripId, cached); // paints via listen()
      window.TripDomain.load(this._tripId).catch(() => {});
      return;
    }
    try {
      await window.TripDomain.load(this._tripId);
    } catch (err) {
      this.container.innerHTML = `<div class="error-banner"><i data-lucide="cloud-off"></i>${escapeHtml(err.message || 'Could not load trip')}</div>`;
      this.refreshIcons();
    }
  }

  // The current timeline days (for the scheduler's day picker).
  _timelineDays(trip) {
    const data = buildTimeline(trip, trip.anchors || [], trip.scraps || []);
    return (data.days || []).map((d) => ({ date: d.date, day_number: d.day_number }));
  }

  render() {
    const trip = window.store.get('trip:' + this._tripId);
    if (!trip) return;
    // Stamp the structural fingerprint so the next bundle update can tell a
    // field-only change (surgical) from a structural one (full render).
    this._lastSig = this._structuralSig(trip);
    const { isOwner, canWrite, cardOpts } = this._deriveCtx(trip);

    // Visited plans stay visible but greyed out and sorted to the bottom
    // (stable sort keeps each half in its original order).
    const allScraps = this._visibleScraps(trip);
    const staged = trip.staged_scraps || [];
    const geocodedCount = allScraps.filter((s) => s.lat != null).length;
    const dates = formatDateRange(trip.start_date, trip.end_date);

    this.container.innerHTML = `
      <div class="trip-toolbar">
        <button class="ts-btn ts-btn--ghost ts-btn--sm" id="trip-back"><i data-lucide="arrow-left"></i>Trips</button>
        <div class="trip-toolbar__actions">
          ${isOwner ? `<button class="ts-btn ts-btn--ghost ts-btn--sm trip-toolbar__btn" id="trip-edit" aria-label="Edit trip"><i data-lucide="pencil"></i></button>` : ''}
          <button class="ts-btn ts-btn--ghost ts-btn--sm trip-toolbar__btn" id="trip-download" aria-label="Download trip"><i data-lucide="download"></i></button>
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
      ${this._tab === 'timeline'
        ? `<div id="tl-content">${renderTripTimeline(trip, buildTimeline(trip, trip.anchors || [], allScraps), { canWrite })}</div>`
        : `
      ${this._renderStaging(staged, cardOpts)}
      ${canWrite ? this._renderCandidates(trip, cardOpts) : ''}
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
      <div id="plans-content">${this._renderPlansContent(trip)}</div>
      ${this._renderCheckpoints(trip, { canWrite })}
      `}
      ${canWrite ? renderQuickPaste(trip.id) : ''}
    `;
    this.refreshIcons();
    this.settleMotion();
    this._bind(trip, { isOwner, canWrite });
  }

  // Per-render context derived from the trip + session. Shared by render() and
  // the surgical patch/render helpers so they can't drift.
  _deriveCtx(trip) {
    const user = window.store.get('user');
    const currentUserId = user ? user.user_id : null;
    const isOwner = trip.role === 'owner';
    const canWrite = isOwner || trip.role === 'collaborator';
    const members = window.store.get('members:' + this._tripId) || [];
    // "Shared" (show consensus + who-added) once anyone besides the owner is on
    // board, or whenever the viewer isn't the owner.
    const acceptedCount = members.filter((m) => m.status !== 'pending').length;
    const shared = !isOwner || acceptedCount > 1;
    return { user, currentUserId, isOwner, canWrite, members, shared,
      cardOpts: { shared, currentUserId, canWrite } };
  }

  // Trip scraps, visited sorted to the bottom (stable). The one source of truth
  // for both the timeline math and the plans list, used by render() + patches.
  _visibleScraps(trip) {
    return [...(trip.scraps || [])].sort(
      (a, b) => (a.visited_at ? 1 : 0) - (b.visited_at ? 1 : 0));
  }

  // The plans-tab card region (grouped list or empty state) — everything that a
  // priority/vibe/note mutation repaints. Lives in #plans-content so it can be
  // swapped surgically; the Plans header (add / filter buttons) stays put.
  _renderPlansContent(trip) {
    const { canWrite, cardOpts } = this._deriveCtx(trip);
    const allScraps = this._visibleScraps(trip);
    const isPriority = (s) => s.rating === 'booked' || s.rating === 'must_do';
    const scraps = this._priorityOnly ? allScraps.filter(isPriority) : allScraps;
    if (scraps.length === 0) {
      return `
        <div class="empty-state">
          <img src="/assets/illustrations/travel-scrapbook-empty-scraps.svg" alt="" />
          <p class="empty-title">${this._priorityOnly ? 'No must-dos yet' : 'No plans yet'}</p>
          <p class="empty-desc">${this._priorityOnly
            ? 'Rate plans “Must do” or “Booked” and they collect here.'
            : (canWrite
              ? 'Tap “+ Todo” to pick from your Wander List — or paste a link below.'
              : 'When the crew adds places, they’ll show up here for you to vibe on.')}</p>
        </div>`;
    }
    return renderGroupedList(scraps, {
      dims: ['category', 'region', 'country', 'city'], active: this._groupBy,
      collapsed: this._collapsed, variant: 'trip', name: 'trip-groupby', ...cardOpts,
    });
  }

  // Cheap structural fingerprint. Includes membership ID sets, the anchor set
  // (with the fields that drive the day range + suggestions) and the chrome
  // meta the toolbar/heading show. It deliberately OMITS per-scrap fields
  // (plan_date/plan_time/rating/vibes/visited/skipped/notes) so those changes
  // fall to the surgical path — buildTimeline / _tlPlanOrder / renderGroupedList
  // all recompute them from local state, so a region re-render is always correct.
  _structuralSig(trip) {
    const ids = (l) => (l || []).map((s) => s.id).sort().join(',');
    const anchors = (trip.anchors || []).map((a) =>
      [a.id, a.role, a.anchor_date || '', a.anchor_time || '',
        a.stay_date || '', a.stay_end_date || '', a.lat ?? '', a.lng ?? ''].join(':')
    ).sort().join('|');
    return [
      ids(trip.scraps), ids(trip.staged_scraps), ids(trip.candidates),
      trip.start_date || '', trip.end_date || '',
      trip.name || '', trip.destination || '', trip.cover_icon || '', trip.role || '',
      anchors,
    ].join('#');
  }

  // Trip-bundle listener. A field-only mutation surgically re-renders just the
  // active tab's content region (no full-view teardown / whole-tree icon reinit,
  // so the change lands instantly); anything structural does a full render.
  _onTripUpdate() {
    const trip = window.store.get('trip:' + this._tripId);
    if (!trip) return;
    const structural = this._lastSig == null || this._structuralSig(trip) !== this._lastSig;
    if (!structural && this._tab === 'timeline' && this.container.querySelector('#tl-content')) {
      this._patchTimeline(trip);
    } else if (!structural && this._tab === 'plans' && this.container.querySelector('#plans-content')) {
      this._patchPlans(trip);
    } else {
      this.render(); // structural change or tab/host mismatch → full (re-stamps _lastSig)
    }
  }

  // Surgical: re-render only the timeline subtree + re-bind only its handlers.
  _patchTimeline(trip) {
    const host = this.container.querySelector('#tl-content');
    if (!host) { this.render(); return; }
    const { isOwner, canWrite } = this._deriveCtx(trip);
    host.innerHTML = renderTripTimeline(
      trip, buildTimeline(trip, trip.anchors || [], this._visibleScraps(trip)), { canWrite });
    this.refreshIcons(host);
    this._bindTimeline(host, trip, { canWrite, isOwner });
  }

  // Surgical: re-render only the plans card region + re-bind only its handlers.
  // The Plans header and checkpoints are outside #plans-content and keep theirs.
  _patchPlans(trip) {
    const host = this.container.querySelector('#plans-content');
    if (!host) { this.render(); return; }
    host.innerHTML = this._renderPlansContent(trip);
    this.refreshIcons(host);
    this._bindPlansContent(host, trip);
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

  _renderCandidates(trip, cardOpts = {}) {
    const cands = trip.candidates || [];
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

    // Plans | Timeline tab — the timeline is computed locally, so switching
    // (and every schedule change) is instant.
    c.querySelectorAll('input[name=trip-tab]').forEach((r) => {
      r.addEventListener('change', () => {
        if (!r.checked) return;
        this._tab = r.value;
        localStorage.setItem('ts.trip.tab', this._tab);
        this.render();
      });
    });
    c.querySelector('#trip-download')?.addEventListener('click', () => {
      // Mapped-pin counts per day (and trip-wide) drive the export scope
      // picker: "points" = geocoded, non-visited plans, matching the exports.
      const tl = buildTimeline(trip, trip.anchors || [], trip.scraps || []);
      const days = (tl.days || []).map((d) => ({
        date: d.date,
        day_number: d.day_number,
        points: d.plans.filter((p) => p.lat != null && !p.visited_at).length,
      }));
      const allPoints = (trip.scraps || []).filter((s) => s.lat != null && !s.visited_at).length;
      ExportMenu.open({ tripId: trip.id, tripName: trip.name, days, allPoints });
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
      TripEditor.open(trip);
    });
    c.querySelector('#add-plans')?.addEventListener('click', () => {
      AddPlans.open(trip, {
        onSaved: async () => {
          // One bundle refresh covers plans + candidates together.
          await window.TripDomain.load(trip.id);
          window.tsCache?.invalidate('inbox'); // trip_ids on wishlist cards changed
          window.SourceDomain?.refreshInboxCount();
        },
      });
    });

    bindQuickPaste(c);

    // Staged review: keep all in one tap.
    c.querySelector('#approve-all-staged')?.addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        await window.ScrapDomain.approveAll(trip.id);
        toast('All kept — welcome aboard!');
      } catch (err) { toast(err.message, { error: true }); }
    });

    // The active tab's content region binds its own scrap-card actions, anchor
    // buttons, group toggles and gestures — the SAME helpers a surgical patch
    // reuses, scoped there to #tl-content / #plans-content. Binding over the
    // whole container here is safe: innerHTML just discarded the old listeners,
    // and only ONE branch runs per paint (the other tab isn't in the DOM), so
    // nothing double-binds.
    if (this._tab === 'timeline') {
      this._bindTimeline(c, trip, { canWrite, isOwner });
    } else {
      this._bindPlansContent(c, trip);
      this._bindAnchorButtons(c, trip);
    }

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

  // Anchor/checkpoint buttons within `root`. Present on both tabs — timeline
  // bookends/markers and the plans-tab Checkpoints list — so it's bound scoped
  // to whichever region is (re)painting.
  _bindAnchorButtons(root, trip) {
    // Timeline empty state → open the trip editor to add dates (the saved trip
    // re-renders via the store, rebuilding the days).
    root.querySelector('#tl-edit-trip')?.addEventListener('click', () => TripEditor.open(trip));

    // "+ Checkpoint" (Plans header + mid-timeline) opens the editor defaulting
    // to a stay — the role select flips to travel.
    root.querySelectorAll('[data-action=add-checkpoint]').forEach((btn) => {
      btn.addEventListener('click', () => AnchorEditor.open(trip, { role: 'stay' }));
    });
    // A gap placeholder between two dated checkpoints prefills the empty dates.
    root.querySelectorAll('[data-action=add-checkpoint-gap]').forEach((btn) => {
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
    root.querySelectorAll('[data-action=add-anchor-role]').forEach((btn) => {
      btn.addEventListener('click', () => AnchorEditor.open(trip, { role: btn.dataset.role }));
    });
    root.querySelectorAll('[data-action=edit-anchor]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const anchor = (trip.anchors || []).find((a) => a.id === btn.dataset.anchorId);
        if (anchor) AnchorEditor.open(trip, { anchor });
      });
    });
    root.querySelectorAll('[data-action=remove-anchor]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const anchor = (trip.anchors || []).find((a) => a.id === btn.dataset.anchorId);
        if (!confirmDestructive(`Remove the "${anchor ? anchor.label : 'this'}" checkpoint? This can't be undone.`)) return;
        try { await window.TripDomain.removeAnchor(trip.id, btn.dataset.anchorId); }
        catch (err) { toast(err.message, { error: true }); }
      });
    });
  }

  // The shared [data-scrap-id] action switch (edit opens the editor; the rest
  // are inline buttons). Scoped to `root` so a surgical patch re-binds only its
  // freshly-rendered cards; `findScrap` closes over the CURRENT bundle each call.
  _bindScrapActions(root, trip, findScrap) {
    root.querySelectorAll('[data-scrap-id]').forEach((el) => {
      const scrapId = el.dataset.scrapId;
      const scrap = findScrap(scrapId);
      if (!scrap) return;
      const action = el.dataset.action;
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
              NotePopup.open(scrap, {
                onSaved: (updated) => window.TripDomain.patchScrapFields(
                  trip.id, scrapId, { notes: updated ? updated.notes : null }),
              });
            } else if (action === 'approve') {
              await window.ScrapDomain.approve(scrapId, trip.id);
              toast('Kept!');
            } else if (action === 'unassign') {
              await window.ScrapDomain.unassign(scrapId, trip.id);
              toast('Moved to your wishlist');
            } else if (action === 'assign') {
              // The echo is the hydrated card — patch it straight in (it also
              // leaves the candidates panel).
              const added = await window.api.assignScrap(scrapId, el.dataset.tripId || trip.id);
              window.TripDomain.patchScrap(trip.id, added);
              toast('Added to the trip');
              window.tsCache?.invalidate('inbox');
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
            } else if (action === 'cycle-outcome') {
              // Timeline checkbox: clear → visited → skipped → clear. Optimistic.
              const cur = scrap.visited_at ? 'visited' : (scrap.skipped_at ? 'skipped' : null);
              const next = cur === null ? 'visited' : (cur === 'visited' ? 'skipped' : null);
              await window.ScrapDomain.setTimelineOutcome(scrapId, trip.id, next);
              toast(next === 'visited' ? 'Marked visited'
                : next === 'skipped' ? 'Marked skipped' : 'Cleared');
            } else if (action === 'slot') {
              // One-tap "add to Day N" from a timeline suggestion chip. The
              // patched card re-renders the timeline instantly.
              await window.ScrapDomain.schedule(scrapId, trip.id, { plan_date: el.dataset.date });
              toast('Slotted in');
            } else if (action === 'delete') {
              if (!confirmDestructive('Delete this place? This can\'t be undone.')) return;
              await window.ScrapDomain.remove(scrapId, trip.id);
            }
          } catch (err) { toast(err.message, { error: true }); }
        });
      }
    });
  }

  // Timeline region bindings: anchor buttons + scrap actions + swipe/drag
  // gestures, all scoped to `root` (the whole container on a full render, or
  // #tl-content on a surgical patch). Called from exactly one place per paint.
  _bindTimeline(root, trip, { canWrite = true } = {}) {
    const findScrap = (id) =>
      (trip.scraps || []).find((s) => s.id === id) ||
      (trip.staged_scraps || []).find((s) => s.id === id) ||
      (trip.candidates || []).find((s) => s.id === id);

    this._bindAnchorButtons(root, trip);
    this._bindScrapActions(root, trip, findScrap);

    // Swipe-right schedules, swipe-left unschedules, press-and-hold drops a plan
    // on any day. Buttons (checkbox/pin) opt out. Optimistic schedule moves the
    // row instantly; the store patch re-renders this region surgically.
    if (this._tab === 'timeline' && canWrite && window.TimelineGestures) {
      const openScheduler = (scrap) => PlanScheduler.open(scrap, {
        tripId: trip.id,
        days: this._timelineDays(trip),
        tripBounds: { start: trip.start_date, end: trip.end_date },
        onSaved: () => toast('Scheduled'),
      });
      window.TimelineGestures.bind(root, {
        canWrite,
        onSchedule: (scrapId) => {
          const scrap = findScrap(scrapId);
          if (scrap) openScheduler(scrap);
        },
        onUnschedule: async (scrapId) => {
          try {
            await window.ScrapDomain.schedule(scrapId, trip.id, { plan_date: null, plan_time: null });
            toast('Removed from the timeline');
          } catch (err) { toast(err.message, { error: true }); }
        },
        onMoveToDay: async (scrapId, date) => {
          const scrap = findScrap(scrapId);
          if (scrap && scrap.plan_date === date) return; // dropped on its own day
          try {
            await window.ScrapDomain.schedule(scrapId, trip.id, { plan_date: date });
            toast(`Moved to ${_tlDay(date)}`);
          } catch (err) { toast(err.message, { error: true }); }
        },
      });
    }
  }

  // Plans-tab card region bindings: the group-by toggle + <details> collapse
  // state, and the scrap-card actions. Scoped to `root` (whole container on a
  // full render, or #plans-content on a surgical patch).
  _bindPlansContent(root, trip) {
    const findScrap = (id) =>
      (trip.scraps || []).find((s) => s.id === id) ||
      (trip.staged_scraps || []).find((s) => s.id === id) ||
      (trip.candidates || []).find((s) => s.id === id);

    bindScrapGroups(root, {
      name: 'trip-groupby',
      collapsed: this._collapsed,
      onChange: (dim) => {
        this._groupBy = dim;
        this._collapsed = new Set();
        localStorage.setItem('ts.trip.groupBy', dim);
        this.render();
      },
    });

    this._bindScrapActions(root, trip, findScrap);
  }
}
window.TripView = TripView;
