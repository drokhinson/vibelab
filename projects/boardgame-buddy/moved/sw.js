// sw.js — the kill switch that replaces BoardgameBuddy's app-shell worker on
// the retired Vercel origin.
//
// It must live at this exact path. A service worker is identified by its
// script URL, so this is the file the browser re-fetches when it revalidates
// the existing registration — deploying the notice WITHOUT this would leave
// the old worker installed, still controlling the origin and still serving the
// cached shell to anyone who had the app installed.
//
// Note what is missing: there is no fetch handler. That is the point. Every
// request goes to the network, so nothing can be answered out of the old
// cache while this worker waits its turn to unregister.
//
// Why it works, given the old worker was cache-first for same-origin
// subresources: the browser does not read the worker script through that
// worker. It revalidates the script itself on navigation (and vercel.json
// serves it no-store), so a byte-different sw.js installs, activates, deletes
// the shell caches and then removes itself.

self.addEventListener("install", function () {
  // Do not wait for the old worker's clients to close. An installed PWA can
  // sit open for days, and waiting means the old shell keeps being served for
  // exactly that long.
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    (async function () {
      // Only the app-shell caches, which hold copies of static files this
      // deploy replaces. localStorage and IndexedDB are left alone — they
      // carry the user's own data, including an outbox that may still hold
      // writes made offline. See the note in index.html.
      try {
        const names = await caches.keys();
        await Promise.all(
          names
            .filter(function (n) { return n.indexOf("bgb-shell-") === 0; })
            .map(function (n) { return caches.delete(n); })
        );
      } catch (_) {}

      // Unregister BEFORE navigating clients. The other order leaves a window
      // where a reload is still controlled by a worker that is about to go.
      try {
        await self.registration.unregister();
      } catch (_) {}

      // Anyone with the old app open right now is looking at a shell served
      // from a cache that no longer exists, talking to an API that no longer
      // serves it. Reload them into the notice rather than leaving them on a
      // page whose every request now fails.
      try {
        const clients = await self.clients.matchAll({ type: "window" });
        for (const client of clients) {
          if (client.url) {
            try { await client.navigate(client.url); } catch (_) {}
          }
        }
      } catch (_) {}
    })()
  );
});
