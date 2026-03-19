// init.js — DOMContentLoaded handler, startup logic

document.addEventListener("DOMContentLoaded", async function() {
  // If we have a stored token, try to restore session
  if (token) {
    try {
      currentUser = await apiFetch("/auth/me");
      await loadPlants();
      preloadThumbnails(plants, renderStyle);
      showView("gardens");
    } catch (err) {
      // Token expired or invalid
      setToken(null);
      showView("auth");
    }
  } else {
    showView("auth");
  }

  // Analytics ping (fire-and-forget)
  try {
    fetch(API + "/api/v1/analytics/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: "plant-planner", event: "page_view" })
    });
  } catch (_) {}
});
