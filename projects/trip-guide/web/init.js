// init.js — register views, wire the header, boot to the current URL. Loaded last.
(function () {
  const API = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || "http://localhost:8000";
  const router = window.router;

  router.register("home", new window.TripsView());
  router.register("trip", new window.TripView());

  // ── Header: admin button ────────────────────────────────────────────────────
  const adminBtn = document.getElementById("admin-btn");
  function syncAdminBtn() {
    const on = window.Admin.isAdmin();
    adminBtn.classList.toggle("tg-admin-btn--on", on);
    adminBtn.innerHTML =
      `<i data-lucide="${on ? "lock-open" : "lock"}"></i>` +
      `<span class="tg-admin-btn__label">${on ? "Admin on" : "Admin"}</span>`;
    if (window.lucide) window.lucide.createIcons({ root: adminBtn });
  }
  adminBtn.addEventListener("click", () => {
    if (window.Admin.isAdmin()) window.Admin.logout();
    else window.Admin.openLogin();
  });

  // Re-render the current view when admin mode flips so edit controls appear/vanish.
  document.addEventListener("admin-changed", () => {
    syncAdminBtn();
    const cur = router._current;
    if (cur && cur._mounted) { cur.render(); cur.refreshIcons(); }
  });

  // ── Header: brand → home (SPA nav) ──────────────────────────────────────────
  const brand = document.querySelector("[data-nav-home]");
  if (brand) brand.addEventListener("click", (e) => { e.preventDefault(); router.go("home"); });

  // ── Analytics ping (fire-and-forget) ────────────────────────────────────────
  fetch(`${API}/api/v1/analytics/track`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app: "trip-guide", event: "app_open" }),
  }).catch(() => {});

  // ── Boot to the current URL (deep-link / refresh safe) ──────────────────────
  syncAdminBtn();
  const initial = router.matchPath(window.location.pathname);
  try {
    history.replaceState({ name: initial.name, params: initial.params }, "",
      window.location.pathname + window.location.search);
  } catch (_) {}
  router.go(initial.name, initial.params, { skipPush: true });
})();
