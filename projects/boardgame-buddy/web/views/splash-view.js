// views/splash-view.js — boot view while Supabase resolves the session.

(function () {
  class SplashView extends window.View {
    constructor() { super("splash"); }

    render() {
      this.container.innerHTML = `
        <img src="assets/illustrations/bgb-loading.svg" alt="Loading"
             style="width:176px;height:176px;" class="rounded-2xl" />
      `;
    }
  }

  window.SplashView = SplashView;
})();
