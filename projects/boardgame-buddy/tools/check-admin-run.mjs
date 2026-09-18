#!/usr/bin/env node
// check-admin-run.mjs — assert the admin run log's silent failure modes.
//
//     node projects/boardgame-buddy/tools/check-admin-run.mjs
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the four modules into a VM
// context against stubbed globals and checks the things that are invisible
// when they break — every one of which renders a plausible screen that is
// lying about a long, expensive, throttled run:
//
//   1. A RUN KEEPS RUNNING WHEN YOU LEAVE. The drain lives in the flow
//      singleton, not on the view, and a view unmounting stops the WATCHING
//      and nothing else. Get this wrong and walking to the Feed mid-drain ends
//      a twenty-minute catalog fill at whatever pass it had reached, silently.
//   2. ARRIVING AT A LIVE RUN WATCHES IT. Two drains against one ledger
//      interleave their passes and double every BoardGameGeek call, which is
//      how the app gets 429'd for every user at once.
//   3. A STOPPED RUN IS NOT A RUNNING ONE. The ledger sits at `running` for
//      ten minutes after the tab driving it went away. Reading that literally
//      shows a spinner over a dead run forever; the age check is what turns it
//      into "interrupted, continue?".
//   4. AN EXPIRED LEDGER GOES BACK TO IDLE rather than pinning the last
//      snapshot, or the pill says "Done · 412 updated" about a log that no
//      longer exists to open.
//   5. THE PASS COUNTER. Pass 0 starts a new server-side log and anything
//      above continues one; a resume that sends 0 silently throws away the
//      journal it was resuming.
import fs from "node:fs";
import vm from "node:vm";

const W = "/home/user/vibelab/projects/boardgame-buddy/web";

let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};

// ── The sandbox ──────────────────────────────────────────────────────────────
const win = {};
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const api = { gets: [], posts: [], runs: [], summary: [] };
win.api = {
  get(path) {
    api.gets.push(path);
    if (path === "/admin/runs") return Promise.resolve(api.summary);
    return Promise.resolve(api.runs.shift() || { state: "unknown" });
  },
};
// The five run() entries go through window.Game; record what the flow asks for.
const gameStub = (name) => (opts) => {
  api.posts.push({ name, ...opts });
  const queued = api.queue.shift();
  return Promise.resolve(queued || { updated: 0, remaining: 0 });
};
api.queue = [];
win.Game = {
  adminRefreshTrending: gameStub("trending"),
  adminRefreshAllImages: gameStub("bgg-images"),
  adminBackfillMetadata: gameStub("bgg-metadata"),
};

const store = new Map();
win.store = {
  set: (k, v) => store.set(k, v),
  get: (k) => store.get(k),
  subscribe: () => () => {},
};

const sandbox = {
  window: win, console, Date, Number, Math, Map, Set, Promise, Array, JSON, Object,
  isNaN, Infinity,
  escapeHtml: esc,
  escapeAttr: esc,
  document: { hidden: false, addEventListener() {}, removeEventListener() {} },
  setInterval: () => 1,
  clearInterval: () => {},
};
vm.createContext(sandbox);

for (const f of [
  "ui/bgg-log-step.js",
  "ui/phase-log.js",
  "ui/admin-run-log.js",
  // Loaded for §6: the extraction that produced phase-log.js came out of this
  // file, so it is the regression surface.
  "ui/bgg-check-log.js",
  "domain/admin-run-tools.js",
  "domain/admin-run-flow.js",
]) {
  vm.runInContext(fs.readFileSync(`${W}/${f}`, "utf8"), sandbox, { filename: f });
}

const flow = win.AdminRunFlow;
const reset = () => {
  flow.runs = {};
  flow.driving = null;
  flow.errors = {};
  api.posts.length = 0;
  api.queue.length = 0;
  api.summary = [];
};
const nowIso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const ledger = (tool, over = {}) => ({
  tool, state: "running", run_id: "r1", pass_no: 0,
  started_at: nowIso(1000), updated_at: nowIso(0), started_by: "Dana",
  totals: { updated: 0, failed: 0, remaining: 0 },
  steps: [{ key: "scan", state: "active", done: null, total: null, detail: null, retry: null }],
  events: [], events_dropped: 0, error: null,
  ...over,
});

// ── 1. The registry covers every tool the server knows ───────────────────────
console.log("the tool registry");
{
  const slugs = flow.slugs().sort();
  ok("three tools, matching the server's AdminRunTool slugs",
    slugs.join(",") === "bgg-images,bgg-metadata,trending");
  const t = flow.tool("bgg-metadata");
  ok("a backfill inherits the shared three-phase vocabulary",
    t.order.join(",") === "scan,fetch,caches" && !!t.labels.fetch);
  ok("trending brings its own six", flow.tool("trending").order.length === 6);
  ok("every tool carries a deadline, because api.js defaults to 15s",
    flow.slugs().every((s) => flow.tool(s).timeoutMs >= 60000));
  ok("images takes the smallest bite, being the slowest per game",
    flow.tool("bgg-images").limit < flow.tool("bgg-metadata").limit);
  ok("an unknown slug is null, not a half-built tool", flow.tool("nope") === null);
}

// ── 2. What a surface should SAY ─────────────────────────────────────────────
console.log("\nreading a ledger");
{
  reset();
  ok("no record reads as idle, not as 'still working'",
    flow.stateOf("bgg-metadata").state === "unknown");

  reset();
  flow.runs["bgg-metadata"] = ledger("bgg-metadata", {
    steps: [{ key: "fetch", state: "active", done: 3, total: 10 }],
  });
  const live = flow.stateOf("bgg-metadata");
  ok("a fresh running ledger is live", live.live && live.state === "running");
  ok("the pill counts the active phase", live.label === "3 of 10");

  // (3) The one that matters most: a ledger nobody is writing to.
  reset();
  flow.runs["bgg-metadata"] = ledger("bgg-metadata", {
    updated_at: nowIso(5 * 60 * 1000),
    totals: { updated: 200, failed: 0, remaining: 800 },
  });
  const stale = flow.stateOf("bgg-metadata");
  ok("a ledger five minutes cold is interrupted, not running",
    stale.state === "interrupted" && !stale.live);
  ok("and offers to continue, naming what is left",
    stale.resumable && stale.label === "Paused · 800 left");

  // ...unless THIS tab is the one driving it, where the clock knows less than
  // we do (a slow pass can go minutes between writes).
  reset();
  flow.driving = "bgg-metadata";
  flow.runs["bgg-metadata"] = ledger("bgg-metadata", { updated_at: nowIso(5 * 60 * 1000) });
  ok("a run this tab is driving is never called interrupted",
    flow.stateOf("bgg-metadata").state === "running");

  reset();
  flow.runs["trending"] = ledger("trending", {
    state: "done", totals: { updated: 7, failed: 2, remaining: 0 },
  });
  ok("a finished run reports its failures", flow.stateOf("trending").label === "Done · 2 failed");
  ok("and is not resumable with nothing left", !flow.stateOf("trending").resumable);

  reset();
  flow.runs["trending"] = ledger("trending", {
    state: "done", totals: { updated: 200, failed: 0, remaining: 60 },
  });
  ok("a finished PASS with work left is resumable",
    flow.stateOf("trending").resumable);
}

// ── 3. Adoption ──────────────────────────────────────────────────────────────
console.log("\nfinding runs this tab did not start");
await (async () => {
  {
    reset();
    api.summary = [ledger("bgg-images")];
    await flow.adopt();
    ok("one request for every tool, not five", api.gets.filter((p) => p === "/admin/runs").length >= 1);
    ok("a run started elsewhere shows up", flow.stateOf("bgg-images").live);

    // (4) The expiry. A tool that drops out of the summary has expired, and
    // keeping its last snapshot would leave a Done pill on a vanished log.
    api.summary = [];
    await flow.adopt();
    ok("a tool absent from the summary goes back to idle",
      flow.stateOf("bgg-images").state === "unknown");
  }

  // The guard that makes "it keeps running when I leave" true: adopt() runs on
  // every mount of Settings and of the backfill spoke, so if it shared the
  // drain's sequence counter, walking away from the run page mid-drain would
  // fail the loop's own guard on its next pass and stop the run.
  {
    reset();
    api.queue = [
      { updated: 200, remaining: 400 },
      { updated: 200, remaining: 0 },
    ];
    api.summary = [];
    const drain = flow.start("bgg-metadata");
    await flow.adopt();          // the operator opens Settings mid-drain
    await flow.adopt();          // ...and the card's poll ticks
    await drain;
    ok("adopting mid-drain does not cancel the drain", api.posts.length === 2);
  }

  // The two reads interleave, and neither may walk the other backwards: the
  // run page's per-tool poll is faster and carries the journal, the summary is
  // slower and does not. Keeping the newer by updated_at is what stops a
  // Settings tick blanking an open log — and what stops the pill freezing on
  // Settings while this tab is the one driving.
  {
    reset();
    const fresh = ledger("bgg-metadata", { updated_at: nowIso(0), events: [{ at: nowIso(), level: "info", phase: "fetch", pass_no: 0, message: "kept" }] });
    flow.runs["bgg-metadata"] = fresh;
    api.summary = [ledger("bgg-metadata", { updated_at: nowIso(30 * 1000), events: [] })];
    await flow.adopt();
    ok("a staler summary does not overwrite a fresher run snapshot",
      flow.runs["bgg-metadata"].events.length === 1);

    flow.runs["bgg-metadata"] = ledger("bgg-metadata", { updated_at: nowIso(30 * 1000) });
    api.summary = [ledger("bgg-metadata", { updated_at: nowIso(0), totals: { updated: 9, failed: 0, remaining: 0 } })];
    await flow.adopt();
    ok("but a fresher summary does update a stale one — the pill must not freeze",
      flow.runs["bgg-metadata"].totals.updated === 9);
  }
})();

// ── 4. Driving ───────────────────────────────────────────────────────────────
console.log("\ndriving a drain");
await (async () => {
  reset();
  api.queue = [
    { updated: 200, remaining: 400 },
    { updated: 200, remaining: 200 },
    { updated: 200, remaining: 0 },
  ];
  await flow.start("bgg-metadata");
  ok("it keeps asking while the server reports work left", api.posts.length === 3);
  // (5) The pass counter.
  ok("pass 0 opens the log and the rest continue it",
    api.posts.map((p) => p.passNo).join(",") === "0,1,2");
  ok("every pass carries the tool's limit and deadline",
    api.posts.every((p) => p.limit === 200 && p.timeoutMs >= 60000));
  ok("the drain is done, so nothing is being driven", flow.driving === null);

  // A single-pass tool asks once even if the server says something is left.
  reset();
  api.queue = [{ updated: 3, remaining: 5 }];
  await flow.start("trending");
  ok("trending is one request, not a drain", api.posts.length === 1);

  // (2) Arriving at a live run must WATCH it.
  reset();
  flow.runs["bgg-metadata"] = ledger("bgg-metadata");
  await flow.start("bgg-metadata");
  ok("a run already going is watched, never started twice", api.posts.length === 0);

  // A resume continues the server's log rather than throwing it away.
  reset();
  flow.runs["bgg-metadata"] = ledger("bgg-metadata", {
    state: "done", pass_no: 4, updated_at: nowIso(5 * 60 * 1000),
    totals: { updated: 800, failed: 0, remaining: 200 },
  });
  api.queue = [{ updated: 200, remaining: 0 }];
  await flow.resume("bgg-metadata");
  ok("a resume asks for the NEXT pass, keeping the journal",
    api.posts.length === 1 && api.posts[0].passNo === 5);

  // A browser-side failure is its own thing: the server may be perfectly fine.
  reset();
  win.Game.adminBackfillMetadata = () => Promise.reject(new Error("Network request failed"));
  await flow.start("bgg-metadata");
  ok("a dropped connection is reported rather than read as success",
    flow.stateOf("bgg-metadata").error === "Network request failed");
  win.Game.adminBackfillMetadata = gameStub("bgg-metadata");

  // (1) stopWatching is not stopRunning.
  reset();
  flow.driving = "bgg-metadata";
  flow._pollHandle = 99;
  flow.stopWatching();
  ok("unmounting a view mid-run does NOT stand the poll down", flow._pollHandle === 99);
  flow.driving = null;
  flow.stopWatching();
  ok("with nothing running, it does", flow._pollHandle === null);
})();

// ── 5. The log renders what the ledger says ──────────────────────────────────
console.log("\nthe log");
{
  const tool = flow.tool("bgg-metadata");
  const html = win.renderAdminRunLog(ledger("bgg-metadata", {
    steps: [
      { key: "scan", state: "done", done: null, total: null, detail: "50 games are missing BGG stats" },
      { key: "fetch", state: "active", done: 1, total: 3, detail: "batch 2 of 3 · 20 saved so far" },
      { key: "caches", state: "idle" },
    ],
    totals: { updated: 20, failed: 1, remaining: 30 },
    events: [
      { at: nowIso(2000), level: "info", phase: "fetch", pass_no: 0, message: "Batch 1 of 3 — 20 of 20 saved" },
      { at: nowIso(1000), level: "error", phase: "fetch", pass_no: 1, message: "Gloomhaven — BGG 502" },
    ],
    events_dropped: 12,
  }), { labels: tool.labels, order: tool.order });

  ok("phases read as sentences, not wire names", html.includes("Finding what is missing"));
  ok("the active phase carries its counter", html.includes("1 of 3"));
  ok("the totals line is there", html.includes("20 updated") && html.includes("1 failed"));
  ok("an error line is marked as one", html.includes("admin-run__line--error"));
  ok("a pass break appears where the pass changes", html.includes("Pass 2"));
  ok("dropped lines are admitted to, not hidden", html.includes("12 earlier lines not kept"));
  ok("a message is escaped, not injected", !win.renderAdminRunLog(ledger("x", {
    events: [{ at: nowIso(), level: "info", phase: "fetch", pass_no: 0, message: "<img onerror=1>" }],
  }), { labels: {}, order: [] }).includes("<img"));

  // Unknown never reaches this renderer — the view paints its own idle face —
  // so it must not invent a "still working" row the way the BGG check does.
  ok("no record renders nothing, leaving the idle face to the view",
    win.renderAdminRunLog({ state: "unknown", steps: [] }, { labels: {}, order: [] }).trim() === "");
  ok("a stalled run says so", win.renderAdminRunLog(ledger("bgg-metadata"), {
    labels: tool.labels, order: tool.order, stale: true,
  }).includes("stopped reporting"));
}

// ── 6. The BGG check log, which the extraction could have broken ────────────
// ui/phase-log.js came OUT of ui/bgg-check-log.js, and that page is live and
// user-facing. Nothing about its output was meant to change, and every way it
// could have would render a plausible checklist that is lying about a running
// sweep — so the four things its own header calls load-bearing are pinned
// here, next to the primitive they now share.
console.log("\nthe BGG check log after the extraction");
{
  const pending = win.renderBggCheckLog(null, {});
  ok("no ledger still paints the one honest ACTIVE row",
    pending.includes("bgg-log__step--active") && !pending.includes("bgg-log__step--done"));
  ok("and unknown is read the same way — never as finished",
    win.renderBggCheckLog({ state: "unknown", steps: [{ key: "guards", state: "done" }] }, {})
      .includes("about 30 seconds"));

  const snap = {
    state: "running",
    steps: [
      { key: "guards", state: "done" },
      { key: "collection", state: "active", done: 3, total: 8, detail: "Owned · 1",
        retry: { attempt: 1, of: 3, wait_seconds: 5, resume_at: Date.now() / 1000 + 4 } },
      { key: "shelf", state: "idle" }, { key: "compare", state: "idle" },
      { key: "catalog", state: "idle" },
      { key: "collids", state: "skipped", detail: "Nothing new" },
      { key: "queue", state: "idle" },
    ],
    warm_up_failed: false, error: null,
  };
  const html = win.renderBggCheckLog(snap, { className: "bgg-log--screen" });
  ok("all seven phases render", (html.match(/bgg-log__step /g) || []).length === 7);
  ok("the counter and bar survive", html.includes("3 of 8") && html.includes("bgg-log__bar-fill"));
  ok("the warm-up countdown survives — the loudest thing on that screen",
    html.includes("still preparing your collection") && html.includes("attempt 1 of 3"));
  ok("a skipped phase still reads as done-and-greyed", html.includes("bgg-log__body--skipped"));
  ok("a partial sweep still refuses to look clean",
    win.renderBggCheckLog({ ...snap, warm_up_failed: true }, {}).includes("never finished preparing"));
  ok("a failure still shows BGG's own words",
    win.renderBggCheckLog({ ...snap, state: "failed", error: "BGG said no" }, {}).includes("BGG said no"));
}

// ── 7. The panel's Sync now is one tap, and it is the deed ──────────────────
// There was a PolaroidPopup.confirm here, and the argument for it was that
// navigating is one tap too late to ask — true while the run page started
// nothing on arrival. It starts now, so the button has to actually start
// something: a version that only navigates leaves an admin on an idle page
// believing they kicked off a twenty-minute sweep.
console.log("\nthe panel hands off in one tap");
{
  const nav = [];
  win.router = { go: (name, params) => nav.push({ name, params }) };
  win.PolaroidPopup = {
    confirm: () => { ok("no confirm popup", false); return Promise.resolve(true); },
  };
  sandbox.showToast = () => {};
  vm.runInContext(
    fs.readFileSync(`${W}/widgets/admin-backfill-panel.js`, "utf8"),
    sandbox, { filename: "widgets/admin-backfill-panel.js" },
  );

  reset();
  api.queue = [{ updated: 5, remaining: 0 }];
  const panel = new win.AdminBackfillPanel({
    key: "metadata", runTool: "bgg-metadata", title: "t", icon: "i",
    emptyText: "", oneOkToast: "", rowStatus: () => "",
    list: () => Promise.resolve([]), refreshOne: () => Promise.resolve(),
    host: "x", render: () => {},
  });
  panel.goToRun();

  ok("it navigates to that tool's log",
    nav.length === 1 && nav[0].name === "admin-run" && nav[0].params.tool === "bgg-metadata");
  ok("and starts the run in the same tap", api.posts.length === 1);
  ok("the run it started is the panel's own", api.posts[0].name === "bgg-metadata");
  // The confirm would have failed an assertion above if it were still called.
  ok("with no confirm in between", true);

  // A second press while it is going must not open a second drain.
  reset();
  flow.runs["bgg-metadata"] = ledger("bgg-metadata");
  panel.goToRun();
  ok("pressing it again on a live run just takes you there", api.posts.length === 0);
}

console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
