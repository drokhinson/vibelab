#!/usr/bin/env node
// check-release-notices.mjs — assert the what's-new popup's dismissal contract.
//
//     node projects/boardgame-buddy/tools/check-release-notices.mjs
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the real modules into a VM
// context against a fake DOM and checks the four things that are invisible
// when they break — a notice that never shows and a notice that shows forever
// look identical from the outside until a user complains.
//
//   1. EVERY EXIT MARKS SEEN, AND MARKS THE WHOLE BATCH. The x after slide one
//      and Done after slide three must have identical consequences, or the
//      same control means two things depending on where the reader stopped.
//      This is what makes dismissal safe: "cycle through them OR close out",
//      with no re-nag either way. Driven here through BgbModal's own delegated
//      click handler, which is the single funnel the x, the outside tap,
//      Escape and the device back gesture all reach.
//   2. `through` IS THE NEWEST published_at IN THE BATCH, never now(). The
//      server's RPC takes the client's watermark precisely so a notice
//      published between /bootstrap and the dismissal survives to the next
//      visit — and since the admin publishes from inside this same app, that
//      is an ordinary sequence rather than a contrived race.
//   3. ONE DECK PER PAGE LOAD. The watermark write is fire-and-forget with one
//      retry, so a dead network must not turn into the popup reopening.
//   4. THE CTA DIES WITH ITS ROUTE. link_route outlives the route table, so
//      the button renders only when router.pathFor() can still build a URL. A
//      dead button is worse than no button: it reads as the app being broken
//      on the one screen announcing new work.
import fs from "node:fs";
import vm from "node:vm";

const W = "/home/user/vibelab/projects/boardgame-buddy/web";
const CARD = ".polaroid-popup__card";
const CLOSE = ".polaroid-popup__close";

let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};

/**
 * A DOM just real enough for ui/modal-shell.js.
 *
 * The one part that has to be faithful is the outside-tap test: the shell asks
 * the dispatch path first and falls back to closest(), and it has a third
 * branch for "nothing in the backdrop matches cardSelector at all". Getting
 * querySelector wrong would silently exercise that fallback instead of the
 * real branch, and the test would pass for the wrong reason.
 */
function makeEl(tag = "div") {
  return {
    tagName: tag,
    className: "",
    id: "",
    style: { setProperty() {} },
    dataset: {},
    attrs: {},
    _html: "",
    _click: null,
    parentNode: null,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    get isConnected() { return !!this.parentNode; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(type, fn) { if (type === "click") this._click = fn; },
    removeEventListener() {},
    // The card exists, so the shell takes its real branch rather than the
    // mis-set-cardSelector fallback.
    querySelector(sel) { return sel === CARD ? this._card : null; },
    querySelectorAll() { return []; },
    focus() {},
    contains() { return false; },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

function buildSandbox({ pathFor }) {
  const body = makeEl("body");
  body.children = [];
  const win = {};
  const document = {
    body: {
      ...body,
      style: { overflow: "" },
      appendChild(el) { el.parentNode = document.body; document.body._last = el; return el; },
      removeChild(el) { el.parentNode = null; },
    },
    createElement: makeEl,
    getElementById: () => null,
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox = {
    window: win,
    document,
    console,
    Date,
    Number,
    Math,
    Promise,
    setTimeout,
    clearTimeout,
    // helpers.js is not loaded (it drags in the whole app), so the formatters
    // the modules reach for are stubbed at their contract.
    escapeHtml: (s) => String(s == null ? "" : s),
    escapeAttr: (s) => String(s == null ? "" : s),
    formatDate: (s) => String(s || ""),
    renderMarkdown: (s) => `<p>${s}</p>`,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  win.BgbIcons = { render() {} };
  win.BgbBackGuard = { arm: () => 1, release() {} };
  win.router = { pathFor, go() {} };

  for (const f of [
    "ui/modal-shell.js",
    "ui/release-notice-body.js",
    "widgets/release-notice-deck.js",
  ]) {
    vm.runInContext(fs.readFileSync(`${W}/${f}`, "utf8"), sandbox, { filename: f });
  }
  return { sandbox, win, document };
}

const NOTICES = [
  { id: "a", title: "Scoring grids", body_md: "Grids.", published_at: "2026-09-01T10:00:00Z" },
  { id: "b", title: "New home", body_md: "Domain.", published_at: "2026-09-08T10:00:00Z" },
  { id: "c", title: "Discover", body_md: "Tab.", published_at: "2026-09-15T10:00:00Z" },
];
const NEWEST = "2026-09-15T10:00:00Z";

/** A click target that is outside the card (the backdrop tap / the x). */
function target({ inCard = false, close = false } = {}) {
  const card = {};
  return {
    nodeType: 1,
    closest(sel) {
      if (sel === CARD) return inCard ? card : null;
      if (sel.includes(CLOSE)) return close ? {} : null;
      return null;
    },
  };
}

/** Open a deck, take one exit, and report what the watermark write received. */
function dismissVia(exit) {
  const { win, document } = buildSandbox({ pathFor: () => "/discover" });
  const seen = [];
  win.ReleaseNotices = { markSeen: (t) => { seen.push(t); return Promise.resolve(); } };

  win.ReleaseNoticeDeck.open(NOTICES);
  const root = document.body._last;
  root._card = {}; // the card the shell looks for
  root._click(exit);
  return { seen, open: win.ReleaseNoticeDeck.isOpen() };
}

console.log("Release notices — every exit means the same thing");

{
  const outside = dismissVia({ target: target({ inCard: false }) });
  ok("a tap outside the card closes it", outside.open === false);
  ok("...and marks the batch seen", outside.seen.length === 1);
  ok("...through the NEWEST published_at, not now()", outside.seen[0] === NEWEST);
}

{
  const x = dismissVia({ target: target({ inCard: true, close: true }) });
  ok("the x closes it", x.open === false);
  ok("...and marks the same watermark as the outside tap", x.seen[0] === NEWEST);
}

{
  // Closing on slide one must not leave slides two and three to re-nag
  // tomorrow — that is the whole "or close out" half of the promise.
  const early = dismissVia({ target: target({ inCard: false }) });
  ok("closing on slide one still marks the WHOLE batch", early.seen[0] === NEWEST);
}

{
  const inside = dismissVia({ target: target({ inCard: true }) });
  ok("a tap inside the card does NOT close it", inside.open === true);
  ok("...and writes no watermark", inside.seen.length === 0);
}

console.log("\nRelease notices — one deck per page load");

{
  const { win } = buildSandbox({ pathFor: () => "/discover" });
  win.ReleaseNotices = { markSeen: () => Promise.resolve() };
  ok("opens with a batch", win.ReleaseNoticeDeck.open(NOTICES) === true);
  ok("a second open in the same load is refused", win.ReleaseNoticeDeck.open(NOTICES) === false);
}

{
  const { win } = buildSandbox({ pathFor: () => "/discover" });
  win.ReleaseNotices = { markSeen: () => Promise.resolve() };
  ok("an empty batch never opens", win.ReleaseNoticeDeck.open([]) === false);
  ok("a null batch never opens", win.ReleaseNoticeDeck.open(null) === false);
}

console.log("\nRelease notices — the take-me-there button");

{
  const { win } = buildSandbox({ pathFor: (n) => (n === "discovery" ? "/discover" : null) });
  ok(
    "rendered when the route still resolves",
    win.ReleaseNoticeBody.cta({ link_route: "discovery", link_label: "See it" }).includes("See it"),
  );
  ok(
    "dropped when the route was retired",
    win.ReleaseNoticeBody.cta({ link_route: "retired", link_label: "Gone" }) === "",
  );
  ok("absent when the notice has no link", win.ReleaseNoticeBody.cta({ link_route: null }) === "");
  ok(
    "falls back to default copy with no label",
    win.ReleaseNoticeBody.cta({ link_route: "discovery" }).includes("Take me there"),
  );
}

{
  const { win } = buildSandbox({ pathFor: () => "/discover" });
  const html = win.ReleaseNoticeBody.render(NOTICES[0]);
  ok("the body goes through the markdown pass", html.includes("<p>Grids.</p>"));
  ok("the route rides a data attribute, not a handler string", !html.includes("onclick="));
}

console.log(fails === 0 ? "\nAll checks passed" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
