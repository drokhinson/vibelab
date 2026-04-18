// init.js — DOMContentLoaded handler, startup logic

document.addEventListener("DOMContentLoaded", function() {
  // Clean up any leftover token from the old custom-JWT system.
  try { localStorage.removeItem("pp_token"); } catch (_) {}

  // initSupabase() registers an onAuthStateChange listener that fires once
  // synchronously on startup with the current session (or null), which then
  // routes to /profile or the auth view.
  initSupabase();

  // Analytics ping (fire-and-forget)
  try {
    fetch(API + "/api/v1/analytics/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: "plant-planner", event: "page_view" })
    });
  } catch (_) {}
});
