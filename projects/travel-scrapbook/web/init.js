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
    router.register('scrap', new ScrapPopupView());
    router.register('settings', new SettingsView());

    // The /scrap popup hides all chrome from the first paint.
    if (window.location.pathname.startsWith('/scrap')) {
      document.body.classList.add('popup-mode');
    }

    initSupabase();

    // Header nav (static shell — bound once).
    document.querySelectorAll('[data-route]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        router.go(el.dataset.route);
      });
    });
    window.lucide?.createIcons();

    await awaitInitialAuth();

    const target = router.matchPath(window.location.pathname) || { name: 'trips', params: {} };
    const authed = !!window.store.get('user');

    if (!authed && target.name !== 'scrap' && target.name !== 'login') {
      // /scrap handles its own signed-out state (compact OAuth) so the
      // bookmarklet flow never bounces through the full login page.
      await router.go('login', {}, { skipPush: target.name === 'trips' });
      return;
    }
    await router.go(target.name, target.params, { skipPush: true });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
