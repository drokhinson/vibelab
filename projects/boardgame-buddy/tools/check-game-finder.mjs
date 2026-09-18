#!/usr/bin/env node
// check-game-finder.mjs — assert the Gather game picker answers on the device.
//
//     node projects/boardgame-buddy/tools/check-game-finder.mjs
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the real modules into a VM
// context against a fake api, a fake localStorage and a fake-enough DOM, and
// checks the things that are invisible when they break:
//
//   1. WITH THE CATALOG INDEX ON THE DEVICE a keystroke is answered
//      synchronously and makes NO request. This is the whole fix: the picker
//      used to debounce and round-trip to /search on every character.
//   2. RANKING: exact > prefix > word-prefix > contains, and the viewer's own
//      games first within a rung — the collection-first order /search does in
//      SQL, reproduced from the status map.
//   3. WITHOUT THE INDEX the fallback still asks /search, once, after the
//      debounce — and when the index lands while a query is in the box, that
//      query is re-answered from it and the pending request never fires.
//   4. A PICK FROM AN INDEX ROW is hydrated before it is handed on: from a
//      warmed bundle when the game is owned (no request), from GET /games/{id}
//      otherwise (one request), and as the partial row when that fails.
//   5. MEMORY-ONLY CACHE ENTRIES (`persist: false`, and a predicate that says
//      no) never reach localStorage — the per-keystroke stringify + setItem
//      the old search memo paid is gone, and a catalog past its size cap
//      does not compete with the game bundles for the 3 MB budget.
//   6. THE LIST IS PATCHED, NOT REBUILT: every paint goes through
//      BgbDomPatch.morph and every <li> carries a data-morph-key, which is
//      what lets the reconciler keep a row's node across a keystroke.
import fs from "node:fs";
import vm from "node:vm";

const W = new URL("../web/", import.meta.url).pathname;

// ── A DOM just big enough for GameFinder ─────────────────────────────────────

class ClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); return this.set.has(c); }
  contains(c) { return this.set.has(c); }
}

class El {
  constructor(id) {
    this.id = id;
    this._html = "";
    this.paints = 0;
    this.morphs = 0;
    this.classList = new ClassList();
    this.listeners = {};
    this.value = "";
    this.isConnected = true;
    this.onclick = null;
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; this.paints++; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener() {}
  querySelector(sel) {
    // mount()'s idempotence check looks the input up inside the container.
    if (sel.startsWith("#")) return registry.get(sel.slice(1)) || null;
    return null;
  }
  closest() { return null; }
  contains() { return false; }
  focus() {} blur() {}
}

const registry = new Map();
const document = {
  activeElement: null,
  getElementById(id) {
    if (!registry.has(id)) registry.set(id, new El(id));
    return registry.get(id);
  },
  addEventListener() {}, removeEventListener() {},
};

// ── localStorage that records what reaches it ────────────────────────────────

const stored = new Map();
const localStorage = {
  get length() { return stored.size; },
  key(i) { return Array.from(stored.keys())[i] ?? null; },
  getItem(k) { return stored.has(k) ? stored.get(k) : null; },
  setItem(k, v) { stored.set(k, String(v)); },
  removeItem(k) { stored.delete(k); },
};

// ── The sandbox ──────────────────────────────────────────────────────────────

const win = {};
const sandbox = {
  window: win, document, localStorage, console,
  Promise, Set, Map, Math, Date, JSON, String, Number, Array, Object, RegExp, Error,
  setTimeout, clearTimeout, AbortController,
  escapeHtml: (s) => String(s == null ? "" : s),
  escapeAttr: (s) => String(s == null ? "" : s),
  isOfflineError: () => false,
  showToast: () => {},
};
vm.createContext(sandbox);
win.BgbIcons = { render() {} };
win.BgbSearchField = { clearButton: () => "", sync() {} };
// The reconciler is stubbed to a counted innerHTML: node identity across a
// patch is the real DOM's job to prove; what this file pins is that every
// paint GOES THROUGH it and hands it keyed rows (see check 6).
win.BgbDomPatch = { morph(el, html) { el.innerHTML = html; el.morphs++; } };
win.store = { get: () => ({ id: "u1" }) };
let statusMap = null;
win.Collection = { cachedStatusMap: () => statusMap };

for (const f of ["domain/cache.js", "domain/catalog-index.js", "domain/game.js", "widgets/game-finder.js"]) {
  vm.runInContext(fs.readFileSync(`${W}${f}`, "utf8"), sandbox, { filename: f });
}
win.bgbCache.bindUser("u1");

let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BASE = "https://img.example.test";
const row = (id, name, th = `${id}_thumb.jpg`) => ({ id, name, y: 2017, mn: 2, mx: 4, t: 45, th });
const payload = () => ({
  games: [
    row("g-bigcat", "Big Cat"),
    row("g-cat", "Cat"),
    row("g-catlady", "Cat Lady", null),
    row("g-catan", "Catan"),
    row("g-scat", "Scat", "https://cf.geekdo-images.com/abs/thumb.jpg"),
    row("g-star", "Star Realms"),
    row("g-wildcat", "Wildcat"),
  ],
  count: 7, truncated: false, thumb_base: BASE, generated_at: "2026-09-18T00:00:00Z",
});
const seedIndex = (p = payload()) =>
  win.bgbCache.setWithTtls("game.catalog", "index", p, { freshTtl: 60000, staleTtl: 60000, persist: false });

/** A fake api that records every GET and answers by path. */
function fakeApi(handlers) {
  const calls = [];
  win.api = {
    async get(path, query, opts) {
      calls.push({ path, query });
      const h = handlers[path];
      if (!h) throw new Error(`unexpected GET ${path}`);
      return h(query, opts);
    },
    post: async () => { throw new Error("unexpected POST"); },
  };
  return calls;
}
const searches = (calls) => calls.filter((c) => c.path === "/search");
// Everything but the recents seed, which mount() has always fetched once.
const nonSeed = (calls) => calls.filter((c) => c.path !== "/games/recently-played");

function mountFinder(opts = {}) {
  const container = new El("container");
  const finder = new win.GameFinder({ onPick: opts.onPick || (() => {}), ...opts });
  finder.mount(container);
  return {
    finder,
    input: document.getElementById(finder.inputId),
    dd: document.getElementById(finder.dropdownId),
  };
}
const namesIn = (html) => Array.from(html.matchAll(/data-finder-game-id="([^"]+)"/g)).map((m) => m[1]);

// ── 1. With the index, a keystroke makes no request ──────────────────────────

console.log("\n1. With the catalog index on the device, typing makes no request");
{
  const calls = fakeApi({});
  seedIndex();
  const { finder, dd } = mountFinder();
  ok("the index reads as ready", !!finder._indexReady());
  const morphsBefore = dd.morphs;
  finder._onInput("cat");
  ok("rows painted synchronously", namesIn(dd.innerHTML).length > 0);
  ok("exactly one paint for the keystroke", dd.morphs === morphsBefore + 1);
  ok("no dimmed 'refreshing' treatment", !dd.classList.contains("game-finder-dropdown--loading"));
  ok("the BGG footer is still offered", dd.innerHTML.includes('data-finder-action="run-bgg"'));
  await sleep(250);
  ok("no /search call, even after the old debounce window", searches(calls).length === 0);
  ok("no request of any kind (beyond the recents seed mount always made)", nonSeed(calls).length === 0);
  finder._onInput("cata");
  finder._onInput("catan");
  await sleep(250);
  ok("still none after more keystrokes", nonSeed(calls).length === 0);
  finder.unmount();
}

// ── 2. Ranking ───────────────────────────────────────────────────────────────

console.log("\n2. Ranking: exact > prefix > word-prefix > contains, own games first");
{
  statusMap = null;
  const got = win.CatalogIndex.search("cat").map((g) => g.name);
  ok(`exact first: ${got[0]}`, got[0] === "Cat");
  ok("then prefix matches, alphabetical", got[1] === "Cat Lady" && got[2] === "Catan");
  ok("then a word-prefix match", got[3] === "Big Cat");
  ok("then plain substring matches", got[4] === "Scat" && got[5] === "Wildcat");
  ok("no false match", !got.includes("Star Realms"));

  statusMap = { "g-wildcat": "owned", "g-catan": "wishlist" };
  const mine = win.CatalogIndex.search("cat", { statusMap }).map((g) => g.name);
  ok("within the prefix rung, the owned game leads", mine[1] === "Catan" && mine[2] === "Cat Lady");
  ok("within the substring rung, the owned game leads", mine[4] === "Wildcat" && mine[5] === "Scat");
  ok("but never jumps a rung", mine[0] === "Cat" && mine[3] === "Big Cat");
  statusMap = null;

  const [cat] = win.CatalogIndex.search("catan");
  ok("rows are widened to GameSummary names", cat.year_published === 2017 && cat.min_players === 2 && cat.max_players === 4 && cat.playing_time === 45);
  ok("a relative thumb is joined to the base", cat.thumbnail_url === `${BASE}/g-catan_thumb.jpg`);
  ok("an absolute thumb is kept", win.CatalogIndex.search("scat")[0].thumbnail_url === "https://cf.geekdo-images.com/abs/thumb.jpg");
  ok("a missing thumb stays null", win.CatalogIndex.search("cat lady")[0].thumbnail_url === null);
  ok("every row is marked partial", cat._partial === true && cat.is_expansion === false);
  ok("case-insensitive", win.CatalogIndex.search("CATAN").length === 1);
  ok("a limit is honoured", win.CatalogIndex.search("cat", { limit: 2 }).length === 2);
  ok("an empty query matches nothing", win.CatalogIndex.search("  ").length === 0);
}

// ── 3. Without the index: the fallback, and the hand-over when it lands ──────

console.log("\n3. Without the index the fallback asks /search once; a landing index takes over");
{
  win.CatalogIndex.invalidate();
  const calls = fakeApi({
    "/search/index": async () => { throw new Error("offline"); },
    "/search": async (q) => ({ results: [{ source: "db", game: { id: "g-srv", name: `Server ${q.q}` } }] }),
  });
  const { finder, dd } = mountFinder();
  ok("the index is not ready", !finder._indexReady());
  finder._onInput("c");
  finder._onInput("ca");
  await sleep(20);
  ok("under three characters, nothing is asked", searches(calls).length === 0);
  finder._onInput("cat");
  ok("a provisional paint landed before any answer", dd.innerHTML.includes("Searching…") || namesIn(dd.innerHTML).length > 0);
  await sleep(300);
  ok("then exactly one /search", searches(calls).length === 1);
  ok("the answer painted", namesIn(dd.innerHTML).includes("g-srv"));
  ok("the index was asked for (once, on mount)", calls.filter((c) => c.path === "/search/index").length === 1);
  finder.unmount();

  // Now the index resolves 50ms in — inside the debounce — with a query in
  // the box. The re-answer from the index must clear the pending request.
  win.CatalogIndex.invalidate();
  const calls2 = fakeApi({
    "/search/index": async () => { await sleep(50); return payload(); },
    "/search": async (q) => ({ results: [{ source: "db", game: { id: "g-srv", name: `Server ${q.q}` } }] }),
  });
  const m2 = mountFinder();
  m2.input.value = "catan";
  m2.finder._onInput("catan");
  await sleep(300);
  ok("the index landed and answered the query", namesIn(m2.dd.innerHTML).includes("g-catan"));
  ok("the pending /search never fired", searches(calls2).length === 0);
  m2.finder.unmount();
}

// ── 4. A pick from an index row is hydrated first ────────────────────────────

console.log("\n4. A pick from an index row is hydrated before onPick");
{
  seedIndex();
  const full = { id: "g-catan", name: "Catan", image_url: "https://img/full.jpg", rulebook_url: "r", play_mode: "competitive" };
  let picked = null;
  const calls = fakeApi({ "/games/g-catan": async () => full });
  const { finder } = mountFinder({ onPick: (g) => { picked = g; } });
  finder._onInput("catan");
  await finder._pickById("g-catan", "library", null);
  ok("one GET /games/{id}", calls.filter((c) => c.path === "/games/g-catan").length === 1);
  ok("onPick received the full game", picked === full);

  // Owned: the bundle is on the device, so no request.
  const bundleGame = { id: "g-wildcat", name: "Wildcat", image_url: "https://img/w.jpg" };
  win.bgbCache.setWithTtls("game.bundle", "g-wildcat", { game: bundleGame }, { freshTtl: 60000, staleTtl: 60000 });
  picked = null;
  finder._onInput("wildcat");
  await finder._pickById("g-wildcat", "library", null);
  ok("an owned game hydrates from its bundle, no request", picked === bundleGame && calls.filter((c) => c.path.startsWith("/games/g-")).length === 1);

  // Offline: the fetch fails and the partial row is picked anyway.
  fakeApi({ "/games/g-scat": async () => { throw new Error("offline"); } });
  picked = null;
  finder._onInput("scat");
  await finder._pickById("g-scat", "library", null);
  ok("a failed hydrate still picks the partial row", picked && picked.id === "g-scat" && picked._partial === true);
  finder.unmount();
}

// ── 5. Memory-only entries never reach localStorage ─────────────────────────

console.log("\n5. persist:false and a refusing predicate keep entries out of localStorage");
{
  stored.clear();
  win.bgbCache.setWithTtls("t", "mem", { big: "x".repeat(100) }, { freshTtl: 60000, staleTtl: 60000, persist: false });
  ok("persist:false wrote nothing", !Array.from(stored.keys()).some((k) => k.includes(":t:mem")));
  ok("but the value is readable", win.bgbCache.get("t", "mem").big.length === 100);
  ok("and does not count against the budget", win.bgbCache.stats().t.bytes === 0);
  win.bgbCache.persist("t", "mem");
  ok("persist() respects memory-only", !Array.from(stored.keys()).some((k) => k.includes(":t:mem")));

  win.bgbCache.setWithTtls("t", "small", { v: 1 }, { freshTtl: 60000, staleTtl: 60000, persist: (json) => json.length < 10000 });
  win.bgbCache.setWithTtls("t", "large", { v: "y".repeat(20000) }, { freshTtl: 60000, staleTtl: 60000, persist: (json) => json.length < 10000 });
  ok("a predicate persists the small value", Array.from(stored.keys()).some((k) => k.includes(":t:small")));
  ok("and not the large one", !Array.from(stored.keys()).some((k) => k.includes(":t:large")));
  ok("both are readable", win.bgbCache.get("t", "small").v === 1 && win.bgbCache.get("t", "large").v.length === 20000);

  // The search memo (fallback path) is memory-only now.
  win.CatalogIndex.invalidate();
  fakeApi({ "/search": async () => ({ results: [] }), "/search/index": async () => { throw new Error("no"); } });
  await win.Game.search("zzz");
  ok("Game.search's memo never hits localStorage", !Array.from(stored.keys()).some((k) => k.includes(":game.search:")));
  ok("yet re-typing is served from it", win.Game.cachedSearch("zzz") !== null);

  // The catalog index persists while it fits and not past the cap.
  stored.clear();
  fakeApi({ "/search/index": async () => payload() });
  await win.CatalogIndex.ensure();
  ok("a small index is persisted for the next launch", Array.from(stored.keys()).some((k) => k.includes(":game.catalog:index")));
  win.CatalogIndex.invalidate();
  stored.clear();
  const huge = payload();
  huge.games = Array.from({ length: 7000 }, (_, i) => row(`g${i}`, `Game number ${i} with a longer name`));
  fakeApi({ "/search/index": async () => huge });
  await win.CatalogIndex.ensure();
  ok("an index past the cap stays in memory only", !Array.from(stored.keys()).some((k) => k.includes(":game.catalog:index")));
  ok("and still answers", win.CatalogIndex.search("number 6999").length === 1);
}

// ── 6. Every paint is a keyed patch ──────────────────────────────────────────

console.log("\n6. Every paint goes through the reconciler with keyed rows");
{
  seedIndex();
  fakeApi({});
  const { finder, dd } = mountFinder();
  // Seed the recents so _open() has no "Loading recent games…" hint to paint —
  // that hint is the one raw innerHTML this widget still writes on purpose.
  finder._recentGames = [{ id: "g-recent", name: "Recent One" }];
  const before = dd.paints;
  finder.showList();
  await sleep(0);
  finder._onInput("cat");
  finder._onInput("");
  finder._onInput("nothing-matches-this");
  ok("every paint was a morph", dd.morphs === dd.paints - before && dd.morphs >= 4);
  finder._onInput("cat");
  const lis = (dd.innerHTML.match(/<li\b/g) || []).length;
  const keyed = (dd.innerHTML.match(/<li\b[^>]*data-morph-key=/g) || []).length;
  ok(`every <li> carries a morph key (${keyed}/${lis})`, lis > 0 && lis === keyed);
  ok("the delegated click handler is bound", typeof dd.onclick === "function");
  finder.unmount();
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
