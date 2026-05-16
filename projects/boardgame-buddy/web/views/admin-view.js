// views/admin-view.js — admin tooling shell.
//
// V1 is intentionally minimal: links to the legacy admin tools (import,
// pending guides, missing images) that still live in the old JS bundle.
// Those will be migrated into this view as the redesign progresses.

(function () {
  class AdminView extends window.View {
    constructor() { super("admin"); }

    onMount() {
      const me = window.store.get("user");
      if (!me || !me.is_admin) {
        this.container.innerHTML = `
          <div class="p-6 text-center">
            <p class="opacity-60 mb-3">Admin access required.</p>
            <button class="btn btn-primary" onclick="window.router.go('feed')">Back to feed</button>
          </div>
        `;
        return;
      }
      this.render();
    }

    render() {
      this.container.innerHTML = `
        <header class="search-topbar">
          <button class="btn btn-ghost btn-sm" onclick="history.back()">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="font-display font-semibold text-lg">Admin tools</h2>
          <span></span>
        </header>
        <section class="p-3 space-y-3">
          <a class="card bg-base-200 shadow-sm" href="#" onclick="event.preventDefault(); alert('Legacy import — migrated in a follow-up');">
            <div class="card-body p-4">
              <h3 class="font-semibold"><i data-lucide="download" class="w-4 h-4"></i> Import games</h3>
              <p class="text-sm opacity-70">Bulk-import from BGG or upload a guide bundle.</p>
            </div>
          </a>
          <a class="card bg-base-200 shadow-sm" href="#" onclick="event.preventDefault(); alert('Pending guides review — migrated in a follow-up');">
            <div class="card-body p-4">
              <h3 class="font-semibold"><i data-lucide="file-clock" class="w-4 h-4"></i> Pending guide review</h3>
              <p class="text-sm opacity-70">Approve community-submitted reference guides.</p>
            </div>
          </a>
          <a class="card bg-base-200 shadow-sm" href="#" onclick="event.preventDefault(); alert('Missing-images sweep — migrated in a follow-up');">
            <div class="card-body p-4">
              <h3 class="font-semibold"><i data-lucide="image-off" class="w-4 h-4"></i> Missing-images sweep</h3>
              <p class="text-sm opacity-70">Refetch image URLs for games imported without box art.</p>
            </div>
          </a>
        </section>
      `;
      if (window.lucide) window.lucide.createIcons();
    }
  }

  window.AdminView = AdminView;
})();
