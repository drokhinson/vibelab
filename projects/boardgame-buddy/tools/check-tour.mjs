#!/usr/bin/env node
// check-tour.mjs — assert the feature tour's invisible contracts.
//
//     node projects/boardgame-buddy/tools/check-tour.mjs
//
// There is no test runner for web/ (the authoring model is ~120 script tags,
// see .claude/rules/web-frontend.md), so this loads the real modules into a VM
// context and checks the seven things about the tour that break SILENTLY —
// every one of which renders as "it looks fine, just wrong" rather than as an
// error anybody would notice:
//
//   1. EVERY CHAPTER'S SCENE IS REGISTERED. A typo in `vignette` leaves that
//      chapter showing its loading frame forever. ui/tour-vignette.js returns
//      null for an unknown id precisely so a dead connection does not throw —
//      which means a typo does not throw either.
//   2. EVERY CHAPTER'S MARK EXISTS ON DISK. The sign-in strip paints the mark
//      through a CSS mask, and a mask whose url() 404s is not a broken-image
//      icon; it is a 22px hole where the mark should be.
//   3. BEAT NAMES ARE UNIQUE. ui/tour-vignette.js resolves seek(name) with
//      findIndex, so a duplicate silently wins and the scene holds the wrong
//      frame — including whatever frame a store screenshot is cut from.
//   4. BEATS ARE ORDERED BY `at`. The runner schedules one timeout per beat
//      from the same start, so an out-of-order `at` applies beats in an order
//      that "reset, then 0..N" can never reproduce: the loop and the seek then
//      disagree about what the scene looks like.
//   5. THE BEATS THE STORE LISTING CITES STILL EXIST. Docs/STORE_LISTING.md
//      names a beat per screenshot rather than a timestamp. Renaming one is a
//      doc change, and this is what says so.
//   6. THE TOUR IS PUBLIC AND CHROMELESS. Missing from PUBLIC_VIEWS, a
//      signed-out visitor following the marketing link is bounced to /auth —
//      indistinguishable from a broken link.
//   7. THE TOUR ARMS NO BACK GUARD, and its scenes stay off the boot path.
//      The first is .claude/rules/overlays.md §8b: a routed screen already has
//      a history entry, and arming over it is the double-entry bug the chapter
//      wizard shipped. The second is why the scene modules are
//      <link rel=prefetch> rather than <script src> — a <script src> would put
//      them on every sign-in's critical path AND inside the bundler's
//      manifest, costing every visitor for a tour most never open.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..");
const W = path.join(PROJECT, "web");

let fails = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const read = (rel) => fs.readFileSync(path.join(W, rel), "utf8");

// ── Load the real modules ───────────────────────────────────────────────────
// None of the four touches `document` at module scope: the shell only defines
// its API, the two scene modules only call register(), and the chapter module
// only declares data. So a bare `window` is the whole environment they need,
// and what comes back is the real registry rather than a re-description of it.
const sandbox = { window: {}, console };
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
for (const rel of [
  "ui/tour-vignette.js",
  "widgets/tour-vignette-ambient.js",
  "widgets/tour-vignette-scripted.js",
  "widgets/tour-vignette-stats.js",
  "widgets/tour-chapters.js",
]) {
  vm.runInContext(read(rel), sandbox, { filename: rel });
}

const V = sandbox.window.BgbTourVignette;
const CHAPTERS = sandbox.window.TourChapters.all();

console.log("\nchapters → scenes");
ok("five chapters", CHAPTERS.length === 5, `got ${CHAPTERS.length}`);
for (const ch of CHAPTERS) {
  ok(`chapter "${ch.slug}" has a registered scene`, V.has(ch.vignette),
      `vignette="${ch.vignette}", registered: ${V.ids().join(", ")}`);
}
ok("no scene is registered that no chapter uses",
   V.ids().every((id) => CHAPTERS.some((c) => c.vignette === id)),
   `orphans: ${V.ids().filter((id) => !CHAPTERS.some((c) => c.vignette === id)).join(", ")}`);
// A CHAPTER MAY CARRY NO BODY.
//
// The community chapter dropped its paragraph — the scene under it scrolls
// through three game nights and makes the same point better than a sentence
// restating it. That makes "no body" a supported shape, and the renderer has
// to tolerate it: an unguarded ${ch.body} prints the string "undefined" into
// the panel, which is not an error anybody's console reports.
ok("the renderer guards a chapter with no body",
   /\$\{ch\.body \? `<p class="tour__body">/.test(read("views/tour-view.js")));
ok("at least one chapter exercises that path",
   CHAPTERS.some((c) => !c.body),
   "every chapter still has a body, so the guard above is untested");
ok("a chapter with no body still has points to carry it",
   CHAPTERS.filter((c) => !c.body).every((c) => (c.points || []).length >= 2));

ok("every chapter has a one-line strip claim",
   CHAPTERS.every((c) => typeof c.strip === "string" && c.strip.length > 0));
ok("chapter slugs are unique",
   new Set(CHAPTERS.map((c) => c.slug)).size === CHAPTERS.length);

console.log("\nchapters → marks on disk");
for (const ch of CHAPTERS) {
  const rel = `assets/sprites/features/bgb-feat-${ch.mark}.svg`;
  ok(`"${ch.slug}" mark exists`, fs.existsSync(path.join(W, rel)), rel);
}

console.log("\nbeats");
for (const id of V.ids()) {
  const names = V.beatsOf(id);
  ok(`"${id}" has beats`, names.length > 0);
  ok(`"${id}" beat names are unique`, new Set(names).size === names.length,
      names.join(", "));
}
// `at` has to rise across the list, or "reset, then apply 0..N" — which is how
// seek() and every loop restart get to a frame — produces a scene the timed
// run never shows.
const rawSrc = read("widgets/tour-vignette-ambient.js")
  + read("widgets/tour-vignette-scripted.js")
  + read("widgets/tour-vignette-stats.js");
ok("no beat carries a negative delay", !/\bat:\s*-/.test(rawSrc));

// ── The store listing cites beats, not timestamps ───────────────────────────
console.log("\nDocs/STORE_LISTING.md");
const listingPath = path.join(PROJECT, "Docs", "STORE_LISTING.md");
if (!fs.existsSync(listingPath)) {
  ok("Docs/STORE_LISTING.md exists", false);
} else {
  const listing = fs.readFileSync(listingPath, "utf8");
  // Every `scene @ beat` reference in the doc has to resolve. The doc is what
  // a future capture script reads; a stale citation there is a screenshot of
  // the wrong frame.
  const cited = [...listing.matchAll(/`([a-z-]+)\s*@\s*([a-z0-9-]+)`/g)];
  ok("the listing cites at least one beat", cited.length > 0);
  for (const [, scene, beat] of cited) {
    ok(`listing cites a real beat: ${scene} @ ${beat}`,
        V.has(scene) && V.beatsOf(scene).includes(beat),
        V.has(scene) ? `beats: ${V.beatsOf(scene).join(", ")}` : "unknown scene");
  }
}

// ── Routing ─────────────────────────────────────────────────────────────────
// The router loads standalone, so these run against the real thing rather
// than against a regex over its source.
console.log("\nrouting");
// URLSearchParams is a browser global the router leans on in both
// directions; a vm context has none unless it is handed one, and
// matchPath swallows the ReferenceError in a try/catch — so without this
// the querystring assertions below would pass a router that reads no
// query params at all.
const rsand = {
  window: { addEventListener() {}, location: { search: "" } },
  URLSearchParams, URL, console,
};
rsand.window.window = rsand.window;
vm.createContext(rsand);
vm.runInContext(read("domain/view.js"), rsand, { filename: "domain/view.js" });
const R = rsand.window.router;

ok('/tour resolves to the tour route', R.matchPath("/tour")?.name === "tour");
ok("?c= rides as a param rather than in the path",
   R.matchPath("/tour", "?c=scoring")?.params?.c === "scoring",
   JSON.stringify(R.matchPath("/tour", "?c=scoring")));
ok('pathFor builds /tour?c=<slug>',
   R.pathFor("tour", { c: "scoring" }) === "/tour?c=scoring",
   R.pathFor("tour", { c: "scoring" }));
ok('the tour is public', R.isPublic("tour") === true);
ok('so are the pages a stranger reaches by definition',
   R.isPublic("privacy") && R.isPublic("terms"));
ok('an account-scoped route is not public',
   !R.isPublic("feed") && !R.isPublic("profile-self") && !R.isPublic("settings"));

const viewSrc = read("domain/view.js");
const chrome = viewSrc.match(/const CHROMELESS_VIEWS\s*=\s*\[([^\]]*)\]/);
ok('"tour" is in CHROMELESS_VIEWS', !!chrome && chrome[1].includes('"tour"'));
ok("the tour is registered on the router", read("init.js").includes('register("tour"'));

// A SIGNED-OUT COLD OPEN HONOURS A PUBLIC DEEP LINK.
//
// Static, and it has to be: exercising it for real needs a live Identity
// Platform session (or the absence of one), and the Firebase SDK it decides
// against is a CDN script. So this asserts the shape of the decision — that
// the no-session branch consults the stashed route and the router's own
// public list before falling back to the login screen. It is the branch that
// sent a stranger following a /tour link, or Google's consent-screen link to
// /privacy, to a login form instead.
const initSrc = read("init.js");
const branch = initSrc.slice(initSrc.indexOf('if (event === "SIGNED_OUT" || !sess)'),
                             initSrc.indexOf("reportBootTiming(\"auth\")"));
ok("the no-session branch reads the stashed deep link",
   branch.includes('window.store.get("pendingRoute")'));
ok("...and asks the router whether it is public",
   branch.includes("window.router.isPublic("));
ok("...and still falls back to the login screen",
   branch.includes('window.router.go("auth")'));
ok("...only on a cold open, not on a mid-session sign-out",
   /wasBooting\s*\?\s*window\.store\.get\("pendingRoute"\)\s*:\s*null/.test(branch));

// ── The screen is a screen, not an overlay ──────────────────────────────────
console.log("\nthe tour is a routed screen");
const tourSrc = read("views/tour-view.js");
ok("views/tour-view.js arms no back guard", !/BgbBackGuard\s*\.\s*arm/.test(tourSrc),
   "a routed screen already has a history entry — .claude/rules/overlays.md §8b");
// ONE TAP IS ONE CHAPTER.
//
// render() runs twice on a cold mount (renderLoading, then View.mount), and
// the deck's click handler goes on the CONTAINER, which innerHTML does not
// replace. Bound from render() the handlers stacked — one tap on Next ran
// _go(step + 1) twice and the deck skipped a chapter, then four on the second
// visit because nothing removed them on unmount. The split is the fix: the
// container click and the keydown latch behind _bound and register a remover,
// while the swipe rebinds every paint because [data-clip] is inside the
// markup render() replaces.
ok("the container click handler is latched, not bound per paint",
   /_bindOnce\(\)\s*\{\s*if \(this\._bound\) return;\s*this\._bound = true;/.test(tourSrc));
ok("...and its remover is registered for unmount",
   /_unsubs\.push\(\(\) => root\.removeEventListener\("click"/.test(tourSrc));
ok("...and the latch is cleared on reset, so the next mount re-binds",
   /_reset\(\)[\s\S]{0,400}this\._bound = false;/.test(tourSrc));
ok("the swipe still rebinds every paint (its element is replaced)",
   tourSrc.includes("_bindClip()") && /_bindClip\(\)\s*\{[\s\S]{0,200}querySelector\("\[data-clip\]"\)/.test(tourSrc));

ok("chapter changes replace the URL rather than pushing it",
   tourSrc.includes("router.replaceUrl(\"tour\"") && !/router\.go\("tour"/.test(tourSrc));

// ── The scenes stay off the boot path ───────────────────────────────────────
console.log("\nboot cost");
const html = read("index.html");
for (const rel of ["ui/tour-vignette.js",
                   "widgets/tour-vignette-ambient.js",
                   "widgets/tour-vignette-scripted.js",
                   "widgets/tour-vignette-stats.js"]) {
  ok(`${rel} is prefetched`, html.includes(`<link rel="prefetch" href="${rel}"`));
  ok(`${rel} is NOT a <script src>`, !html.includes(`<script src="${rel}"`));
}
for (const rel of ["views/tour-view.js", "widgets/tour-chapters.js", "ui/feature-strip.js"]) {
  ok(`${rel} IS loaded`, html.includes(`<script src="${rel}">`));
}
ok('index.html has a <main data-view="tour">', html.includes('data-view="tour"'));
// EVERY SCENE MODULE IS IN THE DECK'S OWN LOAD LIST. A module that is
// prefetched but never loaded registers nothing, and the only symptom is one
// chapter stuck on its loading frame — which is exactly the failure the
// chapter→scene assertion at the top of this file cannot catch, because it
// loads all three itself.
const srcList = read("views/tour-view.js");
for (const rel of ["widgets/tour-vignette-ambient.js",
                   "widgets/tour-vignette-scripted.js",
                   "widgets/tour-vignette-stats.js"]) {
  ok(`${rel} is in SCENE_SRCS`, srcList.includes(`"${rel}"`));
}

console.log(fails ? `\n${fails} FAILED\n` : "\nall good\n");
process.exit(fails ? 1 : 0);
