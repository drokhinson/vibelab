// init.js — DOMContentLoaded handler, startup logic

document.addEventListener("DOMContentLoaded", function() {
  // One-shot cleanup of legacy custom-JWT token from pre-Supabase builds.
  try { localStorage.removeItem("pp_token"); } catch (_) {}

  // Show auth shell immediately; initSupabase wires onAuthStateChange,
  // which fires SIGNED_IN (if a session is restored) → loadProfileAndBoot,
  // or leaves us on the auth screen otherwise.
  showView("auth");
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
