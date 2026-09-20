#!/usr/bin/env node
// check-rulebook-links.mjs — the client half of migration 052.
//
//     node projects/boardgame-buddy/tools/check-rulebook-links.mjs
//
// There is no test runner for web/ (see .claude/rules/web-frontend.md), so this
// loads the real modules into a VM context and pins the three properties that
// are invisible when they break:
//
//   1. ONE resolver. A game can have several links — an admin's, a buddy's,
//      your own — so which one is "the rulebook" is a decision, and it lives in
//      domain/chapter.js so a second surface cannot answer it differently and
//      send the same person somewhere else. The order: an adopted link first,
//      then an approved one, then whatever is left, and never a denied one.
//   2. "No rulebook link available" is PRINTED, and only once the answer has
//      landed. An absent section reads exactly like a section that failed to
//      draw — which was the state this feature set out to fix — and printing it
//      a beat before a link appears is the one way to be worse than silent.
//   3. The client never filters on moderation_status. The API decides who may
//      see a row (services/chapter_rulebook.py); the status is on the wire so
//      the AUTHOR's own copy can say it is waiting or was turned down. A denied
//      link reaching a viewer at all means it is theirs, and it is shown as
//      such rather than dropped.
import fs from "node:fs";
import vm from "node:vm";

const W = new URL("../web/", import.meta.url).pathname;

let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};

function sandbox({ user = { id: "me" } } = {}) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  const calls = [];
  const ctx = {
    window: null,
    console,
    setTimeout, clearTimeout, requestAnimationFrame: () => {},
    escapeHtml: esc,
    escapeAttr: esc,
    URL,
    CustomEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o); } },
    document: { querySelector: () => null, querySelectorAll: () => [], dispatchEvent: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    session: { user: { id: "me" } },
  };
  ctx.window = ctx;
  ctx.window.api = {
    get: (path, query) => { calls.push({ path, query }); return Promise.resolve([]); },
    post: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
    patch: () => Promise.resolve({}),
  };
  ctx.window.store = { get: (k) => (k === "user" ? user : null) };
  ctx.window.bgbCache = null;
  ctx.window.BgbIcons = { render: () => {} };
  vm.createContext(ctx);
  for (const f of ["domain/chapter.js", "widgets/reference-guide-scroll.js"]) {
    vm.runInContext(fs.readFileSync(`${W}${f}`, "utf8"), ctx, { filename: f });
  }
  return { ctx, calls };
}

const link = (over = {}) => ({
  id: "c1",
  layout: "rulebook_link",
  chapter_type: "rulebook",
  link_url: "https://example.com/rules.pdf",
  moderation_status: "approved",
  in_my_guide: false,
  created_by: "someone",
  ...over,
});

const { ctx, calls } = sandbox();
const Chapter = ctx.window.Chapter;

console.log("the pool request");
Chapter.rulebookLinks("game-1", { expansionIds: ["exp-1"] });
const req = calls[calls.length - 1];
ok("asks the chapter pool, filtered to the one layout",
  req.path === "/games/game-1/chapter-pool"
  && req.query.layout === "rulebook_link"
  && req.query.chapter_type === "rulebook");
ok("carries the expansions the guide is merged over", req.query.expansion_ids === "exp-1");

console.log("one resolver, one answer");
ok("nothing available resolves to null", Chapter.resolveRulebook([]) === null);
ok("a row with no url is not a link", Chapter.resolveRulebook([link({ link_url: "" })]) === null);
ok("an adopted link beats an approved one the viewer passed over",
  Chapter.resolveRulebook([
    link({ id: "approved" }),
    link({ id: "mine", moderation_status: "pending", in_my_guide: true }),
  ]).id === "mine");
ok("an approved link beats a pending one",
  Chapter.resolveRulebook([
    link({ id: "pending", moderation_status: "pending" }),
    link({ id: "approved" }),
  ]).id === "approved");
ok("a pending link is shown when it is all there is",
  Chapter.resolveRulebook([link({ id: "pending", moderation_status: "pending" })]).id === "pending");
ok("a denied link never wins, even as the only one",
  Chapter.resolveRulebook([link({ id: "denied", moderation_status: "denied" })]) === null);
ok("a denied link does not beat an approved one either",
  Chapter.resolveRulebook([
    link({ id: "denied", moderation_status: "denied", in_my_guide: true }),
    link({ id: "approved" }),
  ]).id === "approved");

console.log("what the guide section says");
const scroll = new ctx.window.ReferenceGuideScroll({
  baseGameId: "game-1",
  gameIds: ["game-1"],
  expansionMeta: { "game-1": { name: "Everdell", color: null } },
});

scroll._rulebooks = [];
scroll._rulebooksLoaded = false;
ok("says nothing at all before the answer lands", scroll._renderRulebookSection() === "");

scroll._rulebooksLoaded = true;
const none = scroll._renderRulebookSection();
ok("prints 'No rulebook link available' once the pool comes back empty",
  none.includes("No rulebook link available"));
ok("and offers to add one", none.includes("Add a rulebook link"));

scroll._rulebooks = [link()];
const shown = scroll._renderRulebookSection();
ok("draws the link as a real anchor", shown.includes(`href="https://example.com/rules.pdf"`));
ok("opens it away from the app, with noopener",
  shown.includes(`target="_blank"`) && shown.includes(`rel="noopener"`));
ok("names the host it goes to", shown.includes("example.com"));
ok("an approved link carries no badge", !shown.includes("Waiting for approval"));
ok("someone else's link can be reported", shown.includes("_reportChapter"));

scroll._rulebooks = [link({ moderation_status: "pending", created_by: "me" })];
const mine = scroll._renderRulebookSection();
ok("my own pending link says it is waiting", mine.includes("Waiting for approval"));
ok("and offers Edit rather than Report", mine.includes("_editChapter") && !mine.includes("_reportChapter"));
ok("and no second Add button, because the API allows one per game",
  !mine.includes("Add a rulebook link"));

scroll._rulebooks = [link({ id: "mine", moderation_status: "denied", created_by: "me" })];
const denied = scroll._renderRulebookSection();
ok("a denial reaches its author, in words", denied.includes("turned your rulebook link down"));
ok("and the game still reads as having no link", denied.includes("No rulebook link available"));

scroll._rulebooks = [
  link({ id: "theirs" }),
  link({ id: "mine", moderation_status: "denied", created_by: "me" }),
];
const both = scroll._renderRulebookSection();
ok("an approved link is shown even while the viewer's own was denied",
  both.includes(`href="https://example.com/rules.pdf"`) && both.includes("turned your rulebook link down"));

console.log("the rolled-up copy");
scroll._rulebooks = [link()];
const peek = scroll._renderRulebookPeek();
ok("carries the link", peek.includes(`href="https://example.com/rules.pdf"`));
ok("and none of the section's chrome — no heading, no Add, no Report",
  !peek.includes("scroll-section__header") && !peek.includes("Add a rulebook link")
  && !peek.includes("_reportChapter"));
scroll._rulebooks = [];
ok("still says so when there is no link, because the section is hidden while rolled",
  scroll._renderRulebookPeek().includes("No rulebook link available"));
scroll._rulebooksLoaded = false;
ok("and says nothing before the answer lands", scroll._renderRulebookPeek() === "");
scroll._rulebooksLoaded = true;

console.log("a signed-out reader");
const anon = sandbox({ user: null });
const anonScroll = new anon.ctx.window.ReferenceGuideScroll({
  baseGameId: "game-1", gameIds: ["game-1"], expansionMeta: {},
});
anonScroll._rulebooks = [link()];
anonScroll._rulebooksLoaded = true;
const guest = anonScroll._renderRulebookSection();
ok("still gets the link (a guest spectator is this viewer)",
  guest.includes(`href="https://example.com/rules.pdf"`));
anon.ctx.window.session = null;
anonScroll._rulebooks = [];
ok("and is not asked to add one while signed out",
  !anonScroll._renderRulebookSection().includes("Add a rulebook link"));

if (fails) {
  console.log(`\n${fails} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
