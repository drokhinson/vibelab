#!/usr/bin/env node
// check-rulebook-links.mjs — the client half of rulebook links.
//
//     node projects/boardgame-buddy/tools/check-rulebook-links.mjs
//
// There is no test runner for web/ (see .claude/rules/web-frontend.md), so this
// loads the real modules into a VM context and pins the three properties that
// are invisible when they break:
//
//   1. ONE resolver. A game can have several approved links plus the viewer's
//      own pending one, so which is "the rulebook" is a decision, and it lives
//      in domain/chapter.js so a second surface cannot answer it differently.
//      The order: an adopted approved link, then any approved one, then the
//      viewer's own pending one, and never a denied one.
//   2. The guide offers "Add a rulebook link" only while no link is on show,
//      and the rolled-up strip PRINTS "No rulebook link available" once the
//      answer has landed — never before.
//   3. The client never filters on moderation_status. The API decides who may
//      see a row (services/chapter_rulebook.py); the status is on the wire so
//      the AUTHOR's own copy can say whether it is pending, approved or denied.
//   4. Opening a link goes through a "you're leaving" confirm, and the guide
//      carries no Report button — reporting lives on the Edit guide screen.
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
ok("an adopted approved link beats another approved one",
  Chapter.resolveRulebook([
    link({ id: "popular" }),
    link({ id: "adopted", in_my_guide: true }),
  ]).id === "adopted");
ok("an approved link beats my own adopted pending one",
  Chapter.resolveRulebook([
    link({ id: "approved" }),
    link({ id: "mine", moderation_status: "pending", in_my_guide: true, created_by: "me" }),
  ]).id === "approved");
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
ok("offers to add one once the pool comes back empty", none.includes("Add a rulebook link"));
ok("and never offers to add 'another'", !none.includes("Add another"));

scroll._rulebooks = [link()];
const shown = scroll._renderRulebookSection();
ok("draws the link as a real anchor", shown.includes(`href="https://example.com/rules.pdf"`));
ok("opens it away from the app, with noopener",
  shown.includes(`target="_blank"`) && shown.includes(`rel="noopener"`));
ok("names the host it goes to", shown.includes("example.com"));
ok("an approved link carries no badge", !shown.includes("Waiting for approval"));
ok("someone else's link carries no Report button", !shown.includes("_reportChapter"));
ok("and no Add button, because a link is already on show", !shown.includes("Add a rulebook link"));
ok("opening it asks first — you are leaving the app", shown.includes("_confirmLeave"));

scroll._rulebooks = [link({ moderation_status: "pending", created_by: "me" })];
const mine = scroll._renderRulebookSection();
ok("my own pending link says it is waiting", mine.includes("Waiting for approval"));
ok("and offers Edit rather than Report", mine.includes("_editChapter") && !mine.includes("_reportChapter"));
ok("and no second Add button, because the API allows one per game",
  !mine.includes("Add a rulebook link"));

scroll._rulebooks = [
  link({ id: "theirs" }),
  link({ id: "mine-pending", moderation_status: "pending", created_by: "me" }),
];
const alongside = scroll._renderRulebookSection();
ok("my pending link behind somebody's approved one says so in words",
  alongside.includes("waiting for approval"));
ok("and the approved one is the link on show",
  alongside.includes(`href="https://example.com/rules.pdf"`) && !alongside.includes("Add a rulebook link"));

scroll._rulebooks = [
  link({ id: "adopted", in_my_guide: true }),
  link({ id: "mine-approved", created_by: "me" }),
];
const bothApproved = scroll._renderRulebookSection();
ok("my own APPROVED link behind one I adopted is not described as waiting",
  !bothApproved.includes("waiting for approval"));
ok("…it is described as approved", bothApproved.includes("is approved"));

scroll._rulebooks = [link({ id: "mine", moderation_status: "denied", created_by: "me" })];
const denied = scroll._renderRulebookSection();
ok("a denial reaches its author, in words", denied.includes("was declined"));
ok("and no Add button, because the API allows one per game", !denied.includes("Add a rulebook link"));

scroll._rulebooks = [
  link({ id: "theirs" }),
  link({ id: "mine", moderation_status: "denied", created_by: "me" }),
];
const both = scroll._renderRulebookSection();
ok("an approved link is shown even while the viewer's own was denied",
  both.includes(`href="https://example.com/rules.pdf"`) && both.includes("was declined"));

console.log("the rolled-up copy");
scroll._rulebooks = [link()];
const peek = scroll._renderRulebookPeek();
ok("carries the link", peek.includes(`href="https://example.com/rules.pdf"`));
ok("an approved link carries no badge on the strip", !peek.includes("Waiting for approval"));
ok("and asks before leaving the app", peek.includes("_confirmLeave"));
scroll._rulebooks = [link({ moderation_status: "pending", created_by: "me" })];
ok("my pending one does", scroll._renderRulebookPeek().includes("Waiting for approval"));
scroll._rulebooks = [link()];
ok("and none of the section's chrome — no heading, no Add, no Report",
  !peek.includes("scroll-section__header") && !peek.includes("Add a rulebook link")
  && !peek.includes("_reportChapter"));
scroll._rulebooks = [];
ok("still says so when there is no link, because the section is hidden while rolled",
  scroll._renderRulebookPeek().includes("No rulebook link available"));
scroll._rulebooksLoaded = false;
ok("and says nothing before the answer lands", scroll._renderRulebookPeek() === "");
scroll._rulebooksLoaded = true;

console.log("the guide's chapters");
ctx.window.renderMarkdown = (t) => t;
const row = scroll._renderChapter({
  id: "ch1", chapter_type: "tips", title: "Tips", content: "x", game_id: "game-1", created_by: "someone",
});
ok("a chapter in the guide carries no Report button", !row.includes("_reportChapter") && !row.includes("Report"));

console.log("leaving the app");
let asked = null;
let opened = null;
ctx.window.PolaroidPopup = { confirm: (o) => { asked = o; return Promise.resolve(true); } };
ctx.window.open = (u) => { opened = u; };
const prevented = { done: false, preventDefault() { this.done = true; }, stopPropagation() {} };
const ret = scroll._confirmLeave(prevented, "https://example.com/rules.pdf");
ok("the anchor's own navigation is cancelled", ret === false && prevented.done);
ok("the popup says you are leaving and names the site",
  !!asked && /leaving Boardgame Buddy/.test(asked.title) && asked.body.includes("example.com")
  && /trust/.test(asked.body));
await Promise.resolve(); await Promise.resolve();
ok("confirming opens the link", opened === "https://example.com/rules.pdf");
opened = null;
ctx.window.PolaroidPopup = { confirm: () => Promise.resolve(false) };
scroll._confirmLeave(null, "https://example.com/rules.pdf");
await Promise.resolve(); await Promise.resolve();
ok("cancelling opens nothing", opened === null);

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
