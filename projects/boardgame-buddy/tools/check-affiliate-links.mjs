#!/usr/bin/env node
// check-affiliate-links.mjs — assert the affiliate feature's off-by-default
// contract on the client.
//
//     node projects/boardgame-buddy/tools/check-affiliate-links.mjs
//
// There is no test runner for web/ (see .claude/rules/web-frontend.md), so
// this loads the real modules into a VM context and checks the one property
// that is invisible when it breaks: a game page with no live partner must show
// NOTHING — no heading, no disclosure, no placeholder — and a page with live
// partners must show every pill, the generic disclosure, and each program's
// required sentence exactly once.
//
//   1. renderBuyLinks([]) is the empty string. Not a section, not "".trim()
//      of a section — the empty string, so `host.innerHTML = ""` is the whole
//      of the off state.
//   2. Pills carry rel="noopener nofollow sponsored" and target="_blank", and
//      their onclick only COUNTS (Affiliate.click) — it never preventDefaults.
//   3. The generic disclosure renders with the pills and only with them; a
//      partner's own sentence (Amazon's) renders once even when two links
//      carry it.
//   4. Affiliate.links(null) resolves to an empty, not-live answer without a
//      network call, and Affiliate.click never throws without an api.
import fs from "node:fs";
import vm from "node:vm";

const W = "/home/user/vibelab/projects/boardgame-buddy/web";

let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};

function sandbox() {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  const ctx = {
    window: null,
    console,
    setTimeout, clearTimeout,
    escapeHtml: esc,
    escapeAttr: esc,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    fetch: () => Promise.resolve(),
    document: { querySelector: () => null },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ["ui/buy-links.js", "domain/affiliate.js"]) {
    vm.runInContext(fs.readFileSync(`${W}/${f}`, "utf8"), ctx, { filename: f });
  }
  return ctx;
}

const ctx = sandbox();
const render = ctx.window.renderBuyLinks;

console.log("off state");
ok("renderBuyLinks([]) is the empty string", render([]) === "");
ok("renderBuyLinks(undefined) is the empty string", render(undefined) === "");
ok("a link with no url renders nothing", render([{ partner_id: "amazon", label: "Amazon", url: "" }]) === "");

console.log("on state");
const amazon = "As an Amazon Associate, BoardgameBuddy earns from qualifying purchases.";
const html = render([
  { partner_id: "amazon", label: "Amazon", url: "https://www.amazon.com/s?k=Catan&tag=bgbuddy-20", disclosure: amazon },
  { partner_id: "amazon-ca", label: "Amazon CA", url: "https://www.amazon.ca/s?k=Catan&tag=x", disclosure: amazon },
  { partner_id: "noble-knight", label: "Noble Knight <Games>", url: "https://www.nobleknight.com/Products/Search?searchTerm=Catan" },
], { surface: "game_detail", gameId: "g1" });
ok("three pills", (html.match(/class="buy-links__pill"/g) || []).length === 3);
ok("the section heading is there", html.includes("Where to buy"));
ok("every pill is rel=noopener nofollow sponsored", (html.match(/rel="noopener nofollow sponsored"/g) || []).length === 3);
ok("every pill opens a new tab", (html.match(/target="_blank"/g) || []).length === 3);
ok("the onclick only counts", html.includes("window.Affiliate.click('amazon', 'g1', 'game_detail')") && !html.includes("preventDefault"));
ok("the generic disclosure renders", html.includes(render.DISCLOSURE));
ok("Amazon's sentence renders exactly once", html.split(amazon).length - 1 === 1);
ok("labels are escaped", html.includes("Noble Knight &lt;Games&gt;") && !html.includes("<Games>"));

console.log("domain");
ctx.window.Affiliate.links(null).then((r) => {
  ok("links(null) is empty and not live without a fetch", r && r.links.length === 0 && r.live === false);
  let threw = false;
  try { ctx.window.Affiliate.click("amazon", "g1", "discover"); } catch (_) { threw = true; }
  ok("click without an api client does not throw", !threw);
  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
});
