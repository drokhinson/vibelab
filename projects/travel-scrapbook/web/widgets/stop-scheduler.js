// widgets/stop-scheduler.js — pick a day (and optional time) for a stop.
// Days come from the trip's timeline; falls back to a raw date input when the
// trip has no day range yet. Saving PATCHes the stop's per-trip timeline slot
// (plan_date/plan_time live on the scrap↔trip membership), so a tripId is
// required.
'use strict';

const StopScheduler = {
  open(scrap, { tripId = null, days = [], tripBounds = {}, onSaved } = {}) {
    this.close();
    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'stop-scheduler-modal';
    const current = scrap.plan_date || '';
    const dayPicker = days.length ? `
      <label class="ts-label" for="ps-day">Day</label>
      <select class="ts-select" id="ps-day">
        ${days.map((d) => `
          <option value="${escapeAttr(d.date)}" ${d.date === current ? 'selected' : ''}>
            Day ${d.day_number} — ${escapeHtml(_tlDay(d.date))}
          </option>`).join('')}
      </select>` : `
      <label class="ts-label" for="ps-day">Day</label>
      <input class="ts-input" type="date" id="ps-day" value="${escapeAttr(current)}" required
             ${tripBounds.start ? `min="${escapeAttr(tripBounds.start)}"` : ''}
             ${tripBounds.end ? `max="${escapeAttr(tripBounds.end)}"` : ''} />`;
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="StopScheduler.close()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Schedule stop">
        <button class="ts-modal__close" onclick="StopScheduler.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">When?</h2>
        <p class="scrap-card__sub" style="margin-top:-0.4rem;">${escapeHtml(scrap.place_name || 'This place')} — pick its day; time is optional.</p>
        <form id="ps-form">
          ${dayPicker}
          <label class="ts-label" for="ps-time">Time (optional)</label>
          <input class="ts-input" type="time" id="ps-time" value="${escapeAttr((scrap.plan_time || '').slice(0, 5))}" />
          <button class="ts-btn ts-btn--mint" type="submit" style="width:100%;margin-top:1rem;">
            <i data-lucide="calendar-check"></i>Schedule it
          </button>
          ${scrap.plan_date ? `
            <button class="ts-btn ts-btn--ghost" type="button" id="ps-clear" style="width:100%;margin-top:0.6rem;">
              <i data-lucide="calendar-x"></i>Clear schedule
            </button>` : ''}
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });

    const save = async (fields) => {
      try {
        // ScrapDomain.schedule patches the returned card into the trip bundle
        // (the timeline recomputes locally on render — no refetch).
        await window.ScrapDomain.schedule(scrap.id, tripId || scrap.trip_id, fields);
        this.close();
        onSaved?.();
      } catch (err) { toast(err.message || 'Could not schedule', { error: true }); }
    };
    modal.querySelector('#ps-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const day = modal.querySelector('#ps-day').value;
      if (!day) return;
      const time = modal.querySelector('#ps-time').value;
      save({ plan_date: day, plan_time: time || null });
    });
    modal.querySelector('#ps-clear')?.addEventListener('click', () => {
      save({ plan_date: null, plan_time: null });
    });
  },

  close() {
    document.getElementById('stop-scheduler-modal')?.remove();
  },
};
window.StopScheduler = StopScheduler;
