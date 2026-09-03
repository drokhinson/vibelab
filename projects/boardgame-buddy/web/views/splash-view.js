// views/splash-view.js — boot view while Supabase resolves the session.

(function () {
  class SplashView extends window.View {
    constructor() { super("splash"); }

    render() {
      // index.html ships this markup inline so the loader paints before any of
      // the app's scripts have run. Re-writing it here would only swap
      // identical HTML and restart the image decode, so leave a populated
      // container alone; this branch exists for a shell that somehow lacks it.
      const el = this.container;
      if (!el || el.childElementCount > 0) return;
      el.innerHTML = `
        <img src="assets/illustrations/bgb-loading.svg" alt="Loading"
             style="width:176px;height:176px;" class="rounded-2xl" />
        <div class="bgb-boot-failed" role="alert">
          <p class="bgb-boot-failed__msg">Couldn't load Boardgame Buddy.<br />Check your connection.</p>
          <button type="button" class="bgb-boot-failed__btn" onclick="location.reload()">
            Try again
          </button>
        </div>
      `;
    }
  }

  window.SplashView = SplashView;
})();
