// init.js — boot: Supabase auth, view registration, initial route.
'use strict';

(function () {
  class SplashView extends View {
    constructor() { super('splash'); }
  }

  async function boot() {
    const router = window.router;
    router.register('splash', new SplashView());
    router.register('login', new LoginView());
    router.register('trips', new TripsView());
    router.register('trip', new TripView());
    router.register('inbox', new InboxView());
    router.register('visited', new VisitedView());
    router.register('scrap', new ScrapPopupView());
    router.register('share', new ShareView());
    router.register('settings', new SettingsView());

    // The /scrap popup and /share target hide all chrome from the first paint.
    if (window.location.pathname.startsWith('/scrap') ||
        window.location.pathname.startsWith('/share')) {
      document.body.classList.add('popup-mode');
    }

    // A registered service worker (plus manifest.json) makes Chrome treat the
    // site as installable — which is what puts it in the Android share sheet.
    try { navigator.serviceWorker?.register('/sw.js').catch(() => {}); } catch (_) {}

    initSupabase();

    // Inbox badge: refresh on auth and whenever the count changes in store.
    const badge = document.getElementById('inbox-badge');
    window.store.subscribe('inboxCount', () => {
      const n = window.store.get('inboxCount') || 0;
      if (!badge) return;
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.toggle('hidden', n === 0);
    });
    window.store.subscribe('user', () => {
      if (window.store.get('user')) window.SourceDomain.refreshInboxCount();
    });

    // Header nav (static shell — bound once).
    document.querySelectorAll('[data-route]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        router.go(el.dataset.route);
      });
    });
    window.lucide?.createIcons();

    // Backstop so a boot-time hang (a stalled auth listener, a future
    // regression, anything) can never strand the splash with no way out —
    // auth.js's own cap is 3s, this is a longer outer ceiling in case that
    // path itself never resolves for some unforeseen reason.
    await Promise.race([
      awaitInitialAuth(),
      new Promise((resolve) => setTimeout(resolve, 6000)),
    ]);

    const target = router.matchPath(window.location.pathname) || { name: 'trips', params: {} };
    // Route off the restored session, not the loaded profile: `user` may still
    // be null here because loadProfile() runs in the background (see auth.js).
    // Gating on it would bounce a signed-in visitor off a deep link to /login
    // whenever /me is slow (cold backend).
    const authed = !!window.store.get('authed');

    if (!authed && target.name !== 'scrap' && target.name !== 'share' && target.name !== 'login') {
      // /scrap and /share handle their own signed-out state (compact OAuth) so
      // the bookmarklet and share-sheet flows never bounce through the full
      // login page.
      await router.go('login', {}, { skipPush: target.name === 'trips' });
      return;
    }
    await router.go(target.name, target.params, { skipPush: true });
  }

  function showBootError() {
    const splash = document.querySelector('[data-view="splash"] .ts-splash');
    if (!splash) return;
    splash.innerHTML = `
      <img src="/assets/brand/travel-scrapbook-logo.svg" alt="" class="ts-splash__logo" />
      <p class="ts-splash__text">Something went wrong loading your scrapbook.</p>
      <button class="ts-btn ts-btn--mint" id="boot-retry">Retry</button>
    `;
    splash.querySelector('#boot-retry')?.addEventListener('click', () => window.location.reload());
  }

  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((err) => {
      console.error('[travel-scrapbook] boot failed:', err);
      showBootError();
    });
  });
})();
