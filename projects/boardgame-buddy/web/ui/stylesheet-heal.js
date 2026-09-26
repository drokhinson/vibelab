// ui/stylesheet-heal.js — recover from a stylesheet that never applied.
//
// The deploy renames styles.css to a content-hashed /bgb-<sha>.css, and the
// _redirects catch-all answers a path Pages doesn't have with index.html and a
// 200. A device that asks for the new sheet a moment before its edge has it
// gets the HTML page instead; `nosniff` makes the browser refuse it, _headers
// has already told it to keep that answer for a year, and the app boots
// working but completely unstyled. sw.js no longer caches such an answer, but
// the browser's own HTTP cache may still hold it.
//
// So: once the page has loaded, check that styles.css actually applied (its
// --bgb-sheet token), and if not, drop every cached copy of the same-origin
// sheets, re-fetch them past the HTTP cache, and reload. Once per tab session,
// so a sheet that is genuinely missing can't loop.

(function () {
  const KEY = "bgb-sheet-heal";

  function store(fn) { try { return fn(window.sessionStorage); } catch (_) { return null; } }

  function check() {
    const ok = getComputedStyle(document.documentElement).getPropertyValue("--bgb-sheet").trim();
    if (ok) { store((s) => s.removeItem(KEY)); return; }
    if (store((s) => s.getItem(KEY))) return;
    store((s) => s.setItem(KEY, "1"));

    const hrefs = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .map((l) => /** @type {HTMLLinkElement} */ (l).href)
      .filter((h) => { try { return new URL(h).origin === location.origin; } catch (_) { return false; } });

    // Worker caches first: the re-fetch below goes through sw.js, which would
    // otherwise answer it from the bad copy.
    const purge = window.caches
      ? caches.keys().then((keys) => Promise.all(keys.map((k) =>
          caches.open(k).then((c) => Promise.all(hrefs.map((h) => c.delete(h)))))))
      : Promise.resolve();
    purge
      .then(() => Promise.all(hrefs.map((h) => fetch(h, { cache: "reload" }).catch(() => {}))))
      .catch(() => {})
      .then(() => location.reload());
  }

  if (document.readyState === "complete") check();
  else window.addEventListener("load", check);
})();
