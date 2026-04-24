// init.js — DOMContentLoaded: wire events, check auth, initial render

document.addEventListener("DOMContentLoaded", () => {
  // Render any lucide icons already in the static DOM (splash icon, etc.)
  if (window.lucide) window.lucide.createIcons();

  // Initialize Supabase Auth. The splash view is shown by default; auth or
  // closet will be swapped in once onAuthStateChange fires INITIAL_SESSION.
  initSupabase();

  // Game search form (Browse view)
  document.getElementById("game-search-form").addEventListener("submit", handleGameSearch);

  // Closet controls
  const sortSel = document.getElementById("closet-sort");
  if (sortSel) {
    sortSel.value = closetSort;
    sortSel.addEventListener("change", (e) => {
      closetSort = e.target.value;
      localStorage.setItem("bgb_closet_sort", closetSort);
      loadCloset();
    });
  }

  const toggleBtn = document.getElementById("closet-view-toggle");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      closetView = closetView === "shelves" ? "list" : "shelves";
      localStorage.setItem("bgb_closet_view", closetView);
      applyClosetControls();
      renderCloset();
    });
  }

  const searchInput = document.getElementById("closet-search");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      closetSearch = e.target.value;
      renderCloset();
    });
  }

  // Bottom nav: Browse | Closet | Play Log
  document.querySelectorAll(".btm-nav button").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.nav;
      if (!session) {
        showToast("Please log in first", "warning");
        return;
      }
      showView(target);
      if (target === "browse") loadGames();
      if (target === "closet") loadCloset();
      if (target === "history") loadPlays();
    });
  });

  // Session is handled by onAuthStateChange in auth.js (fires INITIAL_SESSION on load)

  // Analytics
  trackEvent("page_view");
});
