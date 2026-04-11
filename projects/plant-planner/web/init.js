// init.js — DOMContentLoaded handler, startup logic

document.addEventListener("DOMContentLoaded", async function() {
  // Check for existing Supabase session
  var { data: { session } } = await sb.auth.getSession();
  if (session) {
    try {
      currentUser = await apiFetch("/auth/me");
      await loadPlants();
      try { preloadThumbnails(plants, renderStyle); } catch (_) {}
      showView("gardens");
    } catch (err) {
      // Session invalid or profile missing
      await sb.auth.signOut();
      showView("auth");
    }
  } else {
    showView("auth");
  }

  // Listen for auth state changes (e.g. token refresh)
  sb.auth.onAuthStateChange(function(event, session) {
    if (event === "SIGNED_OUT") {
      currentUser = null;
      currentGarden = null;
      gridPlacements = {};
      if (currentView !== "auth") showView("auth");
    }
  });

  // Analytics ping (fire-and-forget)
  try {
    fetch(API + "/api/v1/analytics/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: "plant-planner", event: "page_view" })
    });
  } catch (_) {}
});
