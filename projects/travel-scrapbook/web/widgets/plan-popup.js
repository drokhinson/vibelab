// widgets/plan-popup.js — the plan card opened by tapping a timeline row's
// title. It shows the place read-only (sprite, name, location, photo, source
// links) and lets the user edit just two things IN THE CONTEXT OF THIS TRIP:
//   • the note, and
//   • the day + time — choosing a day ANCHORS the plan there (a saved plan_date);
//     choosing "Auto" (or "Let the route decide") un-anchors it so the route
//     places it again.
// Place identity (name, category, location) is edited elsewhere — the creator's
// pencil opens ScrapEditor. Mirrors the ts-modal pattern of scrap-editor.js.
'use strict';

const PlanPopup = {
  open(scrap, { tripId = null, days = [], tripBounds = {}, canWrite = true, onChanged } = {}) {
    this.close();
    this._scrap = scrap;
    this._tripId = tripId || scrap.trip_id;
    this._onChanged = onChanged || null;

    const s = scrap;
    const categories = window.store.get('categories') || [];
    const catLabel = (categories.find((c) => c.slug === s.category) || {}).label || 'Place';
    const place = [s.place_city, s.place_country].filter(Boolean).join(', ');
    const current = s.plan_date || '';

    // Day picker: an explicit "Auto" option, then one option per trip day.
    // Preserve an out-of-range anchored date as its own option so opening +
    // saving can't silently un-anchor it.
    let dayField;
    if (days.length) {
      const known = new Set(days.map((d) => d.date));
      const extra = current && !known.has(current)
        ? `<option value="${escapeAttr(current)}" selected>${escapeHtml(_tlDay(current))}</option>` : '';
      dayField = `
        <select class="ts-select" id="pp-day" ${canWrite ? '' : 'disabled'}>
          <option value="" ${current ? '' : 'selected'}>Auto — let the route decide</option>
          ${extra}
          ${days.map((d) => `
            <option value="${escapeAttr(d.date)}" ${d.date === current ? 'selected' : ''}>
              Day ${d.day_number} — ${escapeHtml(_tlDay(d.date))}
            </option>`).join('')}
        </select>`;
    } else {
      dayField = `
        <input class="ts-input" type="date" id="pp-day" value="${escapeAttr(current)}" ${canWrite ? '' : 'disabled'}
               ${tripBounds.start ? `min="${escapeAttr(tripBounds.start)}"` : ''}
               ${tripBounds.end ? `max="${escapeAttr(tripBounds.end)}"` : ''} />`;
    }

    const sources = (s.sources || []).length ? `
      <div class="scrap-card__row" style="margin-top:0.5rem;">
        ${(s.sources || []).map((src) => `
          <a class="source-badge" href="${escapeAttr(src.url)}" target="_blank" rel="noopener"
             title="${escapeAttr(src.og_title || src.url)}">
            <i data-lucide="link-2"></i>${escapeHtml(src.source_domain || 'link')}
          </a>`).join('')}
        ${s.maps_url ? `
          <a class="source-badge" href="${escapeAttr(s.maps_url)}" target="_blank" rel="noopener" title="Open in Google Maps">
            <i data-lucide="external-link"></i>Maps</a>` : ''}
      </div>`
      : (s.maps_url ? `
      <div class="scrap-card__row" style="margin-top:0.5rem;">
        <a class="source-badge" href="${escapeAttr(s.maps_url)}" target="_blank" rel="noopener" title="Open in Google Maps">
          <i data-lucide="external-link"></i>Maps</a>
      </div>` : '');

    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'plan-popup-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="PlanPopup.close()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Plan">
        <button class="ts-modal__close" onclick="PlanPopup.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <div class="pp-head">
          ${renderSprite('category', s.category, { size: 'md', alt: '' })}
          <div style="min-width:0;flex:1;">
            <h2 class="ts-modal__title" style="margin:0;">${escapeHtml(s.place_name || 'Saved place')}</h2>
            <p class="scrap-card__sub" style="margin:0;">${escapeHtml([catLabel, place].filter(Boolean).join(' · '))}</p>
          </div>
        </div>
        ${s.og_image_url ? `<img class="pp-photo" src="${escapeAttr(s.og_image_url)}" alt="" loading="lazy" />` : ''}
        ${sources}
        ${canWrite ? `
        <form id="pp-form" style="margin-top:0.6rem;">
          <label class="ts-label" for="pp-notes">Notes</label>
          <textarea class="ts-textarea" id="pp-notes" rows="3" maxlength="2000"
                    placeholder="why you saved it, what to order, who told you…">${escapeHtml(s.notes || '')}</textarea>
          <label class="ts-label" for="pp-day">Day in the trip</label>
          ${dayField}
          <label class="ts-label" for="pp-time">Time (optional)</label>
          <input class="ts-input" type="time" id="pp-time" value="${escapeAttr((s.plan_time || '').slice(0, 5))}" />
          <button class="ts-btn ts-btn--mint" type="submit" style="width:100%;margin-top:1rem;">
            <i data-lucide="check"></i>Save
          </button>
          ${s.plan_date ? `
            <button class="ts-btn ts-btn--ghost" type="button" id="pp-unanchor" style="width:100%;margin-top:0.6rem;">
              <i data-lucide="sparkles"></i>Let the route decide
            </button>` : ''}
        </form>`
        : `
        <div style="margin-top:0.6rem;">
          <label class="ts-label">Notes</label>
          <p class="scrap-card__sub" style="margin-top:0.2rem;">${s.notes ? escapeHtml(s.notes) : 'No notes yet.'}</p>
        </div>`}
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });

    if (!canWrite) return;

    modal.querySelector('#pp-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const notes = modal.querySelector('#pp-notes').value.trim() || null;
      const day = modal.querySelector('#pp-day').value || '';
      const timeRaw = modal.querySelector('#pp-time').value || '';
      // "Auto" (no day) can't carry a fixed time — clear it.
      const planDate = day || null;
      const planTime = planDate ? (timeRaw || null) : null;
      await this._save(notes, planDate, planTime);
    });

    modal.querySelector('#pp-unanchor')?.addEventListener('click', async () => {
      await this._save(undefined, null, null, 'Back to auto — the route will place it');
    });
  },

  // Persist only what changed: notes via ScrapDomain.saveNote, day/time via
  // ScrapDomain.schedule (both paint the trip bundle optimistically → the
  // timeline re-flows instantly). `notes === undefined` skips the notes write
  // (used by the un-anchor button). Close in the same frame the button is
  // pressed; the writes reconcile / roll back in the background.
  _save(notes, planDate, planTime, toastMsg) {
    const s = this._scrap;
    const notesChanged = notes !== undefined && (notes || null) !== (s.notes || null);
    const dateChanged = (planDate || null) !== (s.plan_date || null) ||
      (planTime || null) !== ((s.plan_time || '').slice(0, 5) || null);
    this.close();
    if (toastMsg) toast(toastMsg);
    else if (notesChanged || dateChanged) toast('Saved');
    this._onChanged?.();
    if (notesChanged) window.ScrapDomain.saveNote(s.id, this._tripId, notes)
      .catch((err) => toast(err.message || 'Could not save', { error: true }));
    if (dateChanged) window.ScrapDomain.schedule(s.id, this._tripId, { plan_date: planDate, plan_time: planTime })
      .catch((err) => toast(err.message || 'Could not save', { error: true }));
  },

  close() {
    document.getElementById('plan-popup-modal')?.remove();
    this._scrap = null;
  },
};
window.PlanPopup = PlanPopup;
