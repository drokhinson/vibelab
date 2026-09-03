// sw.js — app-shell service worker.
//
// WHY THIS ONE CACHES AND travel-scrapbook's DOESN'T
// --------------------------------------------------
// projects/travel-scrapbook/web/sw.js is deliberately a no-op: "the app is a
// thin shell over the API and stale HTML/JS causes more trouble than offline
// support is worth." That reasoning is sound for an app whose every screen
// needs the server anyway — there, caching buys you nothing and costs you a
// stale-bundle failure mode.
//
// BoardgameBuddy's offline mode changes the trade. The host cascade genuinely
// runs with no backend (see domain/net.js): the pickers paint from bgbCache,
// the draft lives in localStorage, and Save queues to the outbox. Without a
// service worker none of that is reachable — closing the tab in a basement
// means the next open is the browser's dinosaur, and the whole feature only
// works for people who thought to leave the tab open.
//
// The stale-bundle risk is answered rather than accepted: the cache name
// carries a build id the deploy workflow stamps in, so every deploy lands in a
// fresh cache and the old one is deleted on activate. Locally the placeholder
// is left un-stamped and the worker turns itself off entirely — a dev editing
// JS should never be served yesterday's copy.
//
// PRECACHE LIST
// -------------
// Derived at install time from index.html and styles.css rather than written
// out by hand. This is a no-build-step project (.claude/rules/web-frontend.md)
// where new modules arrive as <script> tags, and a hand-kept list in here would
// silently drift the first time someone added one — producing a worker that
// serves a shell missing the very file the new feature needs.

// Replaced at deploy time by .github/workflows/deploy-frontend*.yml. Left
// literal in the repo and in local dev, which is the signal to disable.
const BUILD_ID = "__BGB_BUILD_ID__";
const IS_DEV = BUILD_ID.indexOf("BGB_BUILD_ID") !== -1;
const CACHE = `bgb-shell-${BUILD_ID}`;

// Cross-origin runtime deps. In the deployed artifact the workflow already
// rewrites the DaisyUI + Tailwind CDN pair to a same-origin assets/bgb-tw.css,
// so this is what's genuinely left: the Supabase client and the fonts. The
// icon set is NOT among them — it is vendored into ui/icons.js precisely so it
// rides the precache below and survives offline. Cached opportunistically on
// the first online load rather than at install — a CDN hiccup must not be able
// to fail the whole install and leave the app with no shell at all.
const RUNTIME_ORIGINS = [
  "https://cdn.jsdelivr.net",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];

// How long a navigation waits for the network before falling back to the
// cached shell. Short on purpose: a dead-zone request can hang for 30s, and
// the whole point is that the host reaches Gather immediately.
const NAV_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
  if (IS_DEV) { self.skipWaiting(); return; }
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith("bgb-shell-") && n !== CACHE)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (IS_DEV) return;
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // The API and Supabase are never cached, and never served from cache.
  //
  // Load-bearing, not conservative: a cached GET /feed or GET /sessions/{code}
  // would hand the app data that looks live and isn't, and the app has no way
  // to tell. Freshness for reads is bgbCache's job — it has TTLs, a schema
  // version and explicit invalidation on every mutation, none of which a
  // URL-keyed HTTP cache can express. Retry for writes is the outbox's job.
  if (isBackend(url)) return;

  if (req.mode === "navigate") {
    event.respondWith(navigationResponse(req));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, false));
    return;
  }

  if (RUNTIME_ORIGINS.indexOf(url.origin) !== -1) {
    event.respondWith(cacheFirst(req, true));
  }
});

/** The FastAPI backend and Supabase, wherever they're deployed. */
function isBackend(url) {
  if (url.pathname.startsWith("/api/")) return true;
  // Supabase Auth + Realtime + Storage all live under *.supabase.co. Matched
  // by hostname because the SW has no access to window.APP_CONFIG.
  if (url.hostname.endsWith(".supabase.co")) return true;
  return false;
}

/**
 * Network-first with a short timeout, falling back to the cached shell.
 *
 * Network-first because index.html is the one file whose staleness cascades:
 * it names every script, so an old copy pins the whole app to an old build
 * even after the caches rotate. The vercel.json catch-all rewrites every path
 * to index.html, so the cached shell answers /play/{code} and /game/{id} too.
 */
async function navigationResponse(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await withTimeout(fetch(req), NAV_TIMEOUT_MS);
    if (res && res.ok) {
      cache.put("/index.html", res.clone()).catch(() => {});
      return res;
    }
  } catch (_) {}
  const cached = await cache.match("/index.html");
  if (cached) return cached;
  // No network and nothing cached — a first-ever visit with no connectivity.
  // Let the browser show its own offline page rather than inventing one.
  return fetch(req);
}

/**
 * Serve from cache, fall back to the network, and revalidate behind the
 * response only where revalidating can actually change the answer.
 *
 * `revalidate` is false for same-origin and true for the CDN entries, and the
 * asymmetry is the point. CACHE carries the deploy's build id, so a same-origin
 * hit is BY CONSTRUCTION the byte-for-byte file this build shipped — a deploy
 * lands in a fresh cache and activate() deletes the old one. Re-fetching it can
 * only ever return what we already hold.
 *
 * That made it free to skip and expensive to keep: the shell is ~120 files, so
 * every warm load fired ~120 background requests that could not change
 * anything, over the same radio the boot's own /bootstrap was waiting on. The
 * CDN entries are the genuinely different case — cached opportunistically on a
 * first online load, possibly from an error response, and not versioned by
 * anything we control.
 */
async function cacheFirst(req, revalidate) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) {
    if (revalidate) {
      fetch(req)
        .then((res) => { if (isCacheable(res)) cache.put(req, res.clone()); })
        .catch(() => {});
    }
    return cached;
  }
  const res = await fetch(req);
  if (isCacheable(res)) cache.put(req, res.clone()).catch(() => {});
  return res;
}

/**
 * `opaque` is the normal shape for the CDN entries: a plain <script src> or
 * <link rel=stylesheet> to another origin is a no-cors request, so the worker
 * never sees a status. The browser can still execute and apply what it gets
 * back, which is all these need to do.
 */
function isCacheable(res) {
  return !!res && (res.ok || res.type === "opaque");
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// ── Install-time precache ─────────────────────────────────────────────────────

async function precache() {
  const cache = await caches.open(CACHE);

  // `reload` so a stale HTTP-cache copy of the shell can't seed the new build's
  // cache with the previous build's script list.
  const shellRes = await fetch("/index.html", { cache: "reload" });
  if (!shellRes.ok) throw new Error(`sw: shell fetch failed (${shellRes.status})`);
  const shellHtml = await shellRes.text();

  const urls = new Set();
  for (const ref of extractHtmlRefs(shellHtml)) urls.add(ref);

  // styles.css names its own assets (illustrations, the loader mark) via
  // url(...), and nothing in index.html mentions them.
  const cssRefs = await extractCssRefs("/styles.css");
  for (const ref of cssRefs) urls.add(ref);

  // Referenced only from manifest.json, which the browser reads itself.
  urls.add("/assets/brand/bgb-icon-192.png");
  urls.add("/assets/brand/bgb-icon-512.png");
  urls.add("/assets/brand/bgb-icon-512-maskable.png");

  // Stored from the text we already have rather than re-fetched — the parse
  // above and the cached copy must be the same build's shell.
  await cache.put("/index.html", new Response(shellHtml, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }));

  await pooled(Array.from(urls), (u) => precacheOne(cache, u));
}

/**
 * Run `fn` over `items` a few at a time instead of all at once.
 *
 * The shell is ~60 files and every one is fetched with `cache: "reload"`, so
 * an unbounded Promise.all is a 60-request burst — issued, on a first-ever
 * install, at the same moment the page it belongs to is fetching /bootstrap
 * and the feed over the same radio. The user is staring at a loader while the
 * app races itself for bandwidth. Nothing here is urgent (the precache only
 * matters on the NEXT launch), so it gives way.
 *
 * Rejection semantics match Promise.all deliberately: precacheOne throws on a
 * missing file, and install must still fail loudly rather than cache a partial
 * shell. Workers already in flight when one rejects are left to settle.
 */
async function pooled(items, fn, limit = 6) {
  const queue = items.slice();
  const workers = [];
  for (let i = 0; i < Math.min(limit, queue.length); i++) {
    workers.push((async () => {
      while (queue.length) await fn(queue.shift());
    })());
  }
  await Promise.all(workers);
}

/**
 * Fetch and store one shell file, refusing an HTML body served under a
 * non-HTML URL.
 *
 * That combination is specifically what vercel.json's catch-all rewrite
 * produces for a path that doesn't exist: `/(.*)` → `/index.html`, returned
 * with a 200. Without this check a mistyped or deleted script would be cached
 * as a .js file containing the whole page, and the app would break on the NEXT
 * boot — long after the deploy that caused it — with a syntax error pointing
 * at markup. Failing the install instead leaves the previous worker in charge
 * and surfaces the problem immediately.
 */
async function precacheOne(cache, url) {
  const res = await fetch(url, { cache: "reload" });
  if (!res.ok) throw new Error(`sw: precache ${url} failed (${res.status})`);
  const type = res.headers.get("content-type") || "";
  if (type.includes("text/html") && !/\.html$/.test(new URL(url, self.location.origin).pathname)) {
    throw new Error(`sw: ${url} served HTML — missing file behind the SPA rewrite?`);
  }
  await cache.put(url, res);
}

/** Same-origin src= / href= references in the shell, as root-relative paths. */
function extractHtmlRefs(html) {
  const out = [];
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const resolved = sameOriginPath(m[1]);
    // manifest.json is fetched by the browser, not the page, and is tiny —
    // but an installed PWA that can't read it loses its identity, so it rides
    // along with the rest.
    if (resolved) out.push(resolved);
  }
  return out;
}

async function extractCssRefs(cssUrl) {
  const out = [];
  try {
    const res = await fetch(cssUrl, { cache: "reload" });
    if (!res.ok) return out;
    const css = await res.text();
    const re = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    let m;
    while ((m = re.exec(css))) {
      const resolved = sameOriginPath(m[1], cssUrl);
      if (resolved) out.push(resolved);
    }
  } catch (_) {}
  return out;
}

/**
 * Resolve a reference to a same-origin path, or null when it isn't one we
 * should precache (another origin, a data: URI, a bare fragment).
 *
 * index.html carries <base href="/">, so its relative refs resolve against the
 * root regardless of which deep-linked path the shell was served for.
 */
function sameOriginPath(ref, base) {
  if (!ref || ref.startsWith("data:") || ref.startsWith("#")) return null;
  let u;
  try {
    u = new URL(ref, new URL(base || "/", self.location.origin));
  } catch (_) {
    return null;
  }
  if (u.origin !== self.location.origin) return null;
  const path = u.pathname + u.search;
  // The shell's own <base href="/"> matches the same src/href sweep as
  // everything else. It isn't a file, and precacheOne would reject the HTML it
  // returns as a missing-file-behind-the-rewrite. The shell is cached
  // explicitly under /index.html either way.
  if (path === "/" || path === "/index.html") return null;
  return path;
}
