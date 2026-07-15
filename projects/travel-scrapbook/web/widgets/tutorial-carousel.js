// widgets/tutorial-carousel.js — "How it works" onboarding carousel, opened
// from Settings. Cards are navigable with prev/next buttons, dot indicators,
// keyboard arrows, and touch swipe. All visual aids are custom SVGs — no
// emojis (see .claude/rules/assets.md).
'use strict';

const TUTORIAL_STEPS = [
  {
    illustration: 'travel-scrapbook-tutorial-welcome',
    title: 'Welcome to your scrapbook',
    body: 'Stop losing links in Word docs. Save anything you find while planning a trip — Reddit threads, Instagram reels, blog posts — and we’ll turn them into a real itinerary.',
  },
  {
    illustration: 'travel-scrapbook-tutorial-new-trip',
    title: 'Start a trip',
    body: 'Give it a name, pick dates and a cover sticker. Everything you scrap gets filed under the trip it belongs to.',
  },
  {
    illustration: 'travel-scrapbook-tutorial-quick-paste',
    title: 'Paste any link',
    body: 'Found something worth remembering? Paste the URL into a trip. We read the page, figure out what place it is, and pin it on the map — automatically.',
  },
  {
    illustration: 'travel-scrapbook-tutorial-bookmarklet',
    title: 'Scrap it from anywhere',
    body: 'Drag the “Scrap it” button from Settings into your bookmarks bar. Now you can save a link straight from any site — no copy-pasting.',
  },
  {
    illustration: 'travel-scrapbook-tutorial-organize',
    title: 'Tidy up your scraps',
    body: 'Tap a scrap to fix its name, city, or category if we got it wrong. Heart your favorites and re-pin the map location any time.',
  },
  {
    illustration: 'travel-scrapbook-tutorial-route',
    title: 'Sort the perfect route',
    body: 'Add your start/end airport or a hotel, then hit “Sort my route” — we’ll order every stop into the shortest path. Open it in Google Maps or download a CSV for My Maps.',
  },
];

const TutorialCarousel = {
  _step: 0,
  _touchStartX: null,

  open() {
    this._step = 0;
    this._render();
  },

  close() {
    document.removeEventListener('keydown', this._onKeydown);
    document.getElementById('tutorial-modal')?.remove();
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
