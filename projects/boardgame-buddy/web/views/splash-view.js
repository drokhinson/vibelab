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
        <button type="button" class="bgb-slow-boot" onclick="location.reload()">
          Still loading — tap to try again
        </button>
      `;
    }
  }

  window.SplashView = SplashView;
})();
