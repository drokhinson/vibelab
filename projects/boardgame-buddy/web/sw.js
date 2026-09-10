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
// Precache fetches happen inside install's waitUntil: one that never settles
// is a worker that never activates. Runtime misses get the same protection.
const PRECACHE_TIMEOUT_MS = 15000;
const RUNTIME_TIMEOUT_MS = 10000;

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
  // (Two independent version axes: this worker's cache name follows the build
  // id; bgbCache's SCHEMA_VERSION follows the shape of what the API returns.)
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

// ── Push (migration 017) ─────────────────────────────────────────────────────
//
// OUTSIDE THE IS_DEV GATE, unlike everything above. IS_DEV turns off the
// CACHING half of this worker so a developer editing JS is never served
// yesterday's copy — it says nothing about push, and gating these on it would
// make the feature impossible to try locally, which is where it most needs
// trying: the alternative is discovering a bad payload shape in production.

self.addEventListener("push", (event) => {
  event.waitUntil(showPush(event));
});

async function showPush(event) {
  // Every notification the app sends is user-visible by construction, and the
  // browser enforces that: a push handler that shows nothing burns the origin's
  // budget and eventually gets the subscription revoked. So a payload that
  // fails to parse still shows SOMETHING — a generic card that opens the bell
  // is a worse notification than the right one, and a far better outcome than
  // silently spending a strike.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {}

  const title = data.title || "BoardgameBuddy";
  await self.registration.showNotification(title, {
    body: data.body || "Something happened in BoardgameBuddy.",
    icon: "/assets/brand/bgb-icon-192.png",
    // Android's monochrome status-bar mark. Ignored elsewhere.
    badge: "/assets/brand/bgb-badge-96.png",
    // The server tags by (event, actor) or by session, so a second buddy
    // request from the same person REPLACES the first rather than stacking —
    // it tells the recipient nothing new. renotify makes the replacement still
    // buzz, because it is a fresh act even when it is the same sentence.
    tag: data.tag || "bgb",
    renotify: !!data.tag,
    data: { url: data.url || "/notifications" },
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openFromPush(event.notification.data || {}));
});

/**
 * Land the tap on the right screen, in the window the user already has.
 *
 * `includeUncontrolled` matters: right after an update the open tab is claimed
 * by the PREVIOUS worker, so without it matchAll() returns nothing and every
 * tap opens a second copy of an app that was already on screen.
 *
 * The message rather than navigate(): this is a History-API SPA
 * (.claude/rules/web-frontend.md), so a real navigation would throw away the
 * booted app — its cache, its session, its Realtime subscription — and pay the
 * whole splash-and-bootstrap cost to arrive somewhere the router could have
 * reached in a frame. navigate() is the fallback for a client that never picks
 * the message up.
 */
async function openFromPush(data) {
  const url = data.url || "/notifications";
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of clients) {
    if (new URL(client.url).origin !== self.location.origin) continue;
    try {
      client.postMessage({ type: "bgb:push-nav", url });
      if ("focus" in client) return client.focus();
    } catch (_) {}
  }
  if (self.clients.openWindow) return self.clients.openWindow(url);
}

/**
 * The browser rotated this device's subscription out from under us.
 *
 * Re-subscribing here keeps the OS-level registration alive, but the new
 * endpoint CANNOT be reported from a worker: the API needs a bearer token and
 * the Supabase session lives in the page's localStorage, which is unreachable
 * from here. So this is half the fix, and domain/push.js's boot-time re-sync is
 * the other half — the authoritative one. Between the two, a rotation costs at
 * most the notifications sent before the app is next opened.
 *
 * The key is read off the OLD subscription rather than stored separately, so it
 * cannot drift from what the device actually subscribed with.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      const key = event.oldSubscription && event.oldSubscription.options
        ? event.oldSubscription.options.applicationServerKey
        : null;
      if (!key) return;
      await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
    } catch (_) {}
  })());
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
    const res = await fetchWithDeadline(req, NAV_TIMEOUT_MS);
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
 * That made it free to skip and expensive to keep: the shell is every file
 * index.html names (precache() derives the list), so every warm load fired
 * that many background requests that could not change
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
      fetchWithDeadline(req, RUNTIME_TIMEOUT_MS)
        .then((res) => { if (isCacheable(res)) cache.put(req, res.clone()); })
        .catch(() => {});
    }
    return cached;
  }
  const res = await fetchWithDeadline(req, RUNTIME_TIMEOUT_MS);
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

// A stalled connection never rejects on its own, so every fetch here has a
// deadline — and the deadline cancels the request rather than orphaning it.
function fetchWithDeadline(req, ms, init) {
  return fetch(req, Object.assign({}, init, { signal: AbortSignal.timeout(ms) }));
}

// ── Install-time precache ─────────────────────────────────────────────────────

async function precache() {
  const cache = await caches.open(CACHE);

  // `reload` so a stale HTTP-cache copy of the shell can't seed the new build's
  // cache with the previous build's script list.
  const shellRes = await fetchWithDeadline("/index.html", PRECACHE_TIMEOUT_MS, { cache: "reload" });
  if (!shellRes.ok) throw new Error(`sw: shell fetch failed (${shellRes.status})`);
  const shellHtml = await shellRes.text();

  const urls = new Set();
  for (const ref of extractHtmlRefs(shellHtml)) urls.add(ref);

  // The stylesheet names its own assets (illustrations, the loader mark) via
  // url(...), and nothing in index.html mentions them.
  //
  // Its path is read out of the shell rather than hardcoded, because the deploy
  // bundler renames it to a content-hashed /bgb-<sha>.css. A literal
  // "/styles.css" would 404 there — silently, since extractCssRefs swallows the
  // error and returns [] — and the first thing anyone would notice is missing
  // illustrations offline, long after the deploy that caused it.
  for (const href of extractStylesheetHrefs(shellHtml)) {
    for (const ref of await extractCssRefs(href)) urls.add(ref);
  }

  // Referenced only from manifest.json, which the browser reads itself.
  urls.add("/assets/brand/bgb-icon-192.png");
  urls.add("/assets/brand/bgb-icon-512.png");
  urls.add("/assets/brand/bgb-icon-512-maskable.png");
  // Referenced only from showNotification() below — it appears in neither
  // index.html nor styles.css, so the derived sweep above cannot find it.
  // Without this a push that arrives offline draws a blank status-bar mark on
  // Android, which is the one moment the whole feature is being judged.
  urls.add("/assets/brand/bgb-badge-96.png");

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
 * Every shell file is fetched with `cache: "reload"`, so an unbounded
 * Promise.all is a burst of the whole list — issued, on a first-ever
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
  // NOT `cache: "reload"`, unlike the shell fetch above. The shell needs it
  // because a stale copy would seed this build's cache with the PREVIOUS
  // build's script list — one file whose staleness cascades into every other.
  // Nothing else here has that property, and forcing a full network fetch for
  // all of them re-downloaded the whole shell after every deploy.
  //
  // A plain fetch is still correct. The bundle and the stylesheet are
  // content-hashed by the deploy bundler, so their URL either holds exactly the
  // right bytes or has never been seen — vercel.json marks those two immutable
  // for a year on that basis. For everything else (the vendored QR codecs,
  // manifest.json, the icons) a normal fetch goes through the browser's own
  // freshness rules, which is at worst the same request `reload` would have
  // made and at best a 304 with no body.
  const res = await fetchWithDeadline(url, PRECACHE_TIMEOUT_MS);
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

/**
 * Same-origin <link rel="stylesheet"> hrefs in the shell, as root-relative
 * paths. The DaisyUI/Tailwind CDN sheet is cross-origin and drops out via
 * sameOriginPath; the precompiled assets/bgb-tw.css that replaces it at deploy
 * time has no url() of its own, so scanning it costs one cache-warm fetch and
 * finds nothing.
 */
function extractStylesheetHrefs(html) {
  const out = [];
  const re = /<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi;
  let tag;
  while ((tag = re.exec(html))) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag[0]);
    const resolved = href && sameOriginPath(href[1]);
    if (resolved) out.push(resolved);
  }
  return out;
}

async function extractCssRefs(cssUrl) {
  const out = [];
  try {
    const res = await fetchWithDeadline(cssUrl, PRECACHE_TIMEOUT_MS, { cache: "reload" });
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
