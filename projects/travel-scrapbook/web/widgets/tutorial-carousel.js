// widgets/tutorial-carousel.js — "How it works" onboarding carousel.
// Auto-launches once on first login (open({firstRun: true}) from init.js);
// replayable anytime from Settings. Cards are navigable with prev/next
// buttons, dot indicators, keyboard arrows, and touch swipe. All visual aids
// are custom SVGs — no emojis (see .claude/rules/assets.md).
'use strict';

const TUTORIAL_STEPS = [
  {
    illustration: 'travel-scrapbook-tutorial-welcome',
    title: 'Welcome to your scrapbook',
    body: 'Every travel find you save becomes a real place on a map — rated, planned into trips, and ready to walk with you day by day.',
  },
  {
    illustration: 'travel-scrapbook-tutorial-collect',
    title: 'Scrap it from anywhere',
    body: 'See somewhere great in a reel, a thread, or an article? Share it straight here from any app. We read the link and pull out every place it mentions — one good listicle can drop five pins at once. Set it up in Settings → “Save from your phone”.',
  },
  {
    illustration: 'travel-scrapbook-tutorial-rating',
    title: 'Your Wander List',
    body: 'New finds land on your Wander List. Rate each one — Booked, Must do, Interested, Could skip — and jot a note so future-you remembers why.',
  },
  {
    illustration: 'travel-scrapbook-tutorial-new-trip',
    title: 'Build a trip',
    body: 'Start a trip with a destination and we’ll do the sorting: finds near it stage themselves under “Needs review”, and your Wander List suggests matching plans. Add the rest with one tap.',
  },
  {
    illustration: 'travel-scrapbook-tutorial-timeline',
    title: 'Anchor it, then watch the timeline',
    body: 'Add your flights and stays with dates, and the trip becomes a day-by-day timeline. Unplanned stops get slotted in — “near your Day 2 hotel” — and booked plans show up right on time.',
  },
  {
    illustration: 'travel-scrapbook-tutorial-community',
    title: 'Explore the community pool',
    body: 'Browse places other travelers have scrapped near your destination and add them in a tap. Only the places are shared — your notes and ratings stay yours.',
  },
  {
    illustration: 'travel-scrapbook-tutorial-route',
    title: 'Been there? Check it off — then take it with you',
    body: 'Mark places visited and they step politely to the back of the trip. When you’re set, sort the shortest route and open it in Google Maps, or download a CSV for My Maps. Replay this tour anytime from Settings.',
  },
];

const TutorialCarousel = {
  _step: 0,
  _touchStartX: null,
  _onDone: null,

  // firstRun: dismissing still counts as done (never nag twice) — onDone
  // fires on Got-it, the X, and the backdrop alike.
  open({ firstRun = false, onDone = null } = {}) {
    this._step = 0;
    this._onDone = onDone;
    this._render();
  },

  close() {
    document.removeEventListener('keydown', this._onKeydown);
    document.getElementById('tutorial-modal')?.remove();
    const done = this._onDone;
    this._onDone = null;
    done?.();
  },

  _go(delta) {
    const next = this._step + delta;
    if (next < 0 || next >= TUTORIAL_STEPS.length) return;
    this._step = next;
    this._render();
  },

  _onKeydown(ev) {
    if (ev.key === 'ArrowRight') TutorialCarousel._go(1);
    else if (ev.key === 'ArrowLeft') TutorialCarousel._go(-1);
    else if (ev.key === 'Escape') TutorialCarousel.close();
  },

  _render() {
    document.getElementById('tutorial-modal')?.remove();
    const step = TUTORIAL_STEPS[this._step];
    const isFirst = this._step === 0;
    const isLast = this._step === TUTORIAL_STEPS.length - 1;

    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'tutorial-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="TutorialCarousel.close()"></div>
      <div class="ts-modal__card tutorial-card" role="dialog" aria-modal="true" aria-label="How Travel Scrapbook works">
        <button class="ts-modal__close" onclick="TutorialCarousel.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <img class="tutorial-card__art" src="/assets/illustrations/${step.illustration}.svg" alt="" />
        <h2 class="ts-modal__title tutorial-card__title">${escapeHtml(step.title)}</h2>
        <p class="tutorial-card__body">${escapeHtml(step.body)}</p>
        <div class="tutorial-card__dots">
          ${TUTORIAL_STEPS.map((_, i) => `<span class="tutorial-dot ${i === this._step ? 'is-active' : ''}" data-dot="${i}"></span>`).join('')}
        </div>
        <div class="tutorial-card__nav">
          <button class="ts-btn ts-btn--ghost ts-btn--sm" id="tutorial-prev" ${isFirst ? 'disabled' : ''} aria-label="Previous">
            <i data-lucide="chevron-left"></i>Back
          </button>
          ${isLast
            ? `<button class="ts-btn ts-btn--mint ts-btn--sm" id="tutorial-done"><i data-lucide="check"></i>Got it!</button>`
            : `<button class="ts-btn ts-btn--blush ts-btn--sm" id="tutorial-next">Next<i data-lucide="chevron-right"></i></button>`}
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });

    modal.querySelector('#tutorial-prev')?.addEventListener('click', () => this._go(-1));
    modal.querySelector('#tutorial-next')?.addEventListener('click', () => this._go(1));
    modal.querySelector('#tutorial-done')?.addEventListener('click', () => this.close());
    modal.querySelectorAll('[data-dot]').forEach((dot) => {
      dot.addEventListener('click', () => { this._step = Number(dot.dataset.dot); this._render(); });
    });

    const card = modal.querySelector('.tutorial-card');
    card.addEventListener('touchstart', (ev) => { this._touchStartX = ev.touches[0].clientX; }, { passive: true });
    card.addEventListener('touchend', (ev) => {
      if (this._touchStartX == null) return;
      const dx = ev.changedTouches[0].clientX - this._touchStartX;
      this._touchStartX = null;
      if (Math.abs(dx) < 40) return;
      this._go(dx < 0 ? 1 : -1);
    }, { passive: true });

    document.addEventListener('keydown', this._onKeydown);
  },
};
window.TutorialCarousel = TutorialCarousel;
