#!/usr/bin/env node
// check-lazy-assets.mjs — assert that a file at a STABLE url can still change.
//
//     node projects/boardgame-buddy/tools/check-lazy-assets.mjs
//
// THE BUG THIS EXISTS FOR, because it is invisible and it recurred:
//
// sw.js serves same-origin subresources from its cache. Navigations are
// network-first, so the shell and the content-hashed bundle are always
// current — which means an app whose lazily-loaded modules are frozen at some
// older build looks completely fine. The only symptom is a screen that
// resembles an older version of itself, and that is indistinguishable from
// work that was never done. A tour scene shipped three releases before anyone
// could see it.
//
// Two mechanisms keep it fixed, and each fails silently on its own:
//
//   1. THE DEPLOY STAMPS ?v=<sha> on every stable url the page fetches by
//      name — the rel=prefetch modules and the regenerated Tailwind sheet. A
//      stamped url is one no cache has ever held, so it reaches the network
//      whatever state the service worker is in. If the shell drifts out from
//      under the stamp's patterns the step fails loudly, but only if the
//      patterns still describe the shell — which is what (2) and (3) check.
//   2. ui/lazy-script.js RESOLVES a bare path through those links, so the
//      stamp reaches the <script> without any call site knowing. A module
//      with no prefetch link silently keeps the bare path and stays frozen.
//   3. sw.js REVALIDATES anything whose url does not identify its own bytes,
//      so an already-stale entry heals rather than persisting forever.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const W = path.join(PROJECT, "web");
const REPO = path.join(PROJECT, "..", "..");

let fails = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const read = (rel) => fs.readFileSync(path.join(W, rel), "utf8");

const html = read("index.html");
const swSrc = read("sw.js");
const wf = fs.readFileSync(
  path.join(REPO, ".github", "workflows", "deploy-bgb-web.yml"), "utf8");

// ── 1. The deploy stamps, and stamps after the bundler ──────────────────────
console.log("\nthe deploy stamps stable urls");
const iBundle = wf.indexOf("bgb-bundle.mjs web");
const iStamp = wf.indexOf("Stamp cache-busting version");
ok("the workflow has a cache-busting stamp step", iStamp > 0);
ok("...which runs AFTER the bundle step", iBundle > 0 && iStamp > iBundle,
   "the bundler rewrites index.html, so a stamp before it is overwritten");
ok("...and fails loudly when it matches nothing",
   /no rel=prefetch links found/.test(wf) && /bgb-tw\.css link not found/.test(wf),
   "a silent no-op here returns the app to stale-forever");

// THE PATTERNS ARE RUN AGAINST THE REAL SHELL. A workflow regex that no longer
// describes index.html is the whole failure, and it cannot be caught by
// reading either file alone.
const PREFETCH_RE = /(<link rel="prefetch" href=")([^"?]+)(")/g;
const TW_RE = /(<link rel="stylesheet" href=")(assets\/bgb-tw\.css)(")/;
const prefetched = [...html.matchAll(PREFETCH_RE)].map((m) => m[2]);
ok("the stamp's prefetch pattern matches the shell", prefetched.length > 0,
   "no <link rel=prefetch href=...> matched");
// The Tailwind link only exists after the deploy's CDN swap, so assert the
// swap's own output shape rather than the checked-in shell.
const swapped = html.replace(
  /<link[^>]*href="https:\/\/cdn\.jsdelivr\.net\/npm\/daisyui[^"]*"[^>]*\/?>/,
  '<link rel="stylesheet" href="assets/bgb-tw.css" />');
ok("...and the Tailwind pattern matches the swapped shell", TW_RE.test(swapped));

// ── 2. Every lazily-loaded module has a link to carry the stamp ─────────────
console.log("\nevery lazy module is stamped");
// EVERY module path in a file that lazily loads anything, not just the ones
// passed as a literal to load(). views/tour-view.js keeps its three scene
// modules in a SCENE_SRCS array — which is precisely the set that went stale,
// so a guard that only reads load("…") would have missed the whole bug.
const MODULE_PATH = /"((?:ui|widgets|domain|views)\/[\w.-]+\.js)"/g;
const loads = new Set();
for (const rel of fs.readdirSync(W, { recursive: true })) {
  if (typeof rel !== "string" || !rel.endsWith(".js")) continue;
  const src = fs.readFileSync(path.join(W, rel), "utf8");
  if (!src.includes("BgbLazyScript")) continue;
  for (const m of src.matchAll(MODULE_PATH)) loads.add(m[1]);
}
// ui/lazy-script.js names none itself; its own callers do.
loads.delete("ui/lazy-script.js");
ok("found the lazy-load call sites", loads.size >= 7, `found ${loads.size}: ${[...loads].join(", ")}`);
for (const src of loads) {
  ok(`"${src}" has a prefetch link`, prefetched.includes(src),
     `links: ${prefetched.join(", ")}`);
}

// ── 3. The worker keeps the query, and revalidates what is not pinned ───────
console.log("\nsw.js");
// Load the worker's pure helpers into a vm. It only defines functions and
// consts at module scope plus addEventListener calls, so a stub `self` is the
// whole environment they need — the real extractors, not a re-description.
const sand = { self: { location: { origin: "https://bgbuddy.app" },
                       addEventListener() {} }, URL, console, Response: class {} };
sand.self.self = sand.self;
sand.caches = { open: async () => ({}) };
vm.createContext(sand);
vm.runInContext(swSrc, sand, { filename: "sw.js" });
const stamped = html.replace(PREFETCH_RE, (_m, a, href, c) => a + href + "?v=abc123" + c);
const refs = sand.extractHtmlRefs(stamped);
ok("extractHtmlRefs finds the stamped modules",
   refs.some((r) => r.includes("tour-vignette-ambient.js?v=abc123")),
   refs.filter((r) => r.includes("vignette")).join(", "));
ok("sameOriginPath keeps the query",
   sand.sameOriginPath("widgets/x.js?v=abc123") === "/widgets/x.js?v=abc123",
   String(sand.sameOriginPath("widgets/x.js?v=abc123")));
ok("...and still drops the shell's own <base href>",
   sand.sameOriginPath("/") === null && sand.sameOriginPath("/index.html") === null);

// The fetch handler's pinned test, asserted on the source: a same-origin hit
// must revalidate unless the url itself identifies the bytes.
ok("same-origin revalidates unless the url is pinned",
   /const pinned = [^\n]*\/\^\\\/bgb-\/[^\n]*searchParams\.has\("v"\)/.test(swSrc)
   && /cacheFirst\(req, !pinned\)/.test(swSrc),
   "cacheFirst(req, false) for all of same-origin is the frozen-file bug");

// ── 4. The loader resolves through the links ────────────────────────────────
console.log("\nui/lazy-script.js");
function mountLoader(links) {
  const made = [];
  const ls = {
    window: {}, console,
    document: {
      querySelectorAll: () => links.map((h) => ({ getAttribute: () => h })),
      querySelector: () => null,
      createElement: () => {
        const el = { dataset: {}, addEventListener() {}, remove() {} };
        made.push(el);
        return el;
      },
      head: { appendChild() {} },
    },
  };
  ls.window.window = ls.window;
  vm.createContext(ls);
  vm.runInContext(read("ui/lazy-script.js"), ls, { filename: "ui/lazy-script.js" });
  return { api: ls.window.BgbLazyScript, made };
}
{
  const { api, made } = mountLoader(["widgets/tour-vignette-ambient.js?v=abc123"]);
  api.load("widgets/tour-vignette-ambient.js");
  ok("a bare path loads the stamped href",
     made[0] && made[0].src === "widgets/tour-vignette-ambient.js?v=abc123",
     made[0] && made[0].src);
}
{
  const { api, made } = mountLoader([]);
  api.load("widgets/tour-vignette-ambient.js");
  ok("...and the bare path with no link (local dev)",
     made[0] && made[0].src === "widgets/tour-vignette-ambient.js",
     made[0] && made[0].src);
}
{
  // ui/qr-encode.js must not resolve through ui/qr-encode.js.map or any other
  // link whose href merely starts with it.
  const { api, made } = mountLoader(["ui/qr-encode.js.map?v=abc", "ui/qr-encode.js?v=abc"]);
  api.load("ui/qr-encode.js");
  ok("a longer path is not mistaken for a prefix match",
     made[0] && made[0].src === "ui/qr-encode.js?v=abc",
     made[0] && made[0].src);
}
// A finished tag never fires `load` again, so a reused one has to answer from
// its own state or every caller after the first hangs with no error.
ok("an already-run tag resolves rather than waiting for a load event",
   /lazyDone === "1"[\s\S]{0,40}resolve\(\)/.test(read("ui/lazy-script.js")));

console.log(fails ? `\n${fails} FAILED\n` : "\nall good\n");
process.exit(fails ? 1 : 0);
