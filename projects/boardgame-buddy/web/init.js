// init.js — DOMContentLoaded: wire events, check auth, initial render

document.addEventListener("DOMContentLoaded", () => {
  // Initialize Supabase Auth
  initSupabase();

  // Render initial auth view
  renderAuth();

  // Game search form
  document.getElementById("game-search-form").addEventListener("submit", handleGameSearch);

  // Bottom nav
  document.querySelectorAll(".btm-nav button").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.nav;
      if (!session && target !== "browse") {
        showToast("Please log in first", "warning");
        return;
      }
      showView(target);
      if (target === "browse") loadGames();
      if (target === "collection") loadCollection();
      if (target === "log-play") { playerRowCount = 0; renderLogPlayForm(); }
      if (target === "history") loadPlays();
    });
  });

  // Session is handled by onAuthStateChange in auth.js (fires INITIAL_SESSION on load)

  // Analytics
  trackEvent("page_view");
});
