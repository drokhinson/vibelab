#!/usr/bin/env node
// check-imports-spoke.mjs — assert the imports spoke's silent failure modes.
//
//     node projects/boardgame-buddy/tools/check-imports-spoke.mjs
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads views/import-detail-view.js
// into a VM context against stubbed globals and checks the three things that
// are invisible when they break:
//
//   1. THE RUN-SHEET PROJECTION. widgets/play-run-sheet.js reads the card as
//      `card.game.name` and decides whose run it is with `card.user.id`. Hand
//      it `game_name` and the title reads "Unknown game"; omit `user` and
//      isOwn() is false, so the sheet renders its NON-OWNER face — the one
//      that says only the person who imported these can remove them, with no
//      delete button on it. Neither throws. Both are a dead screen.
//   2. WHICH ROW OPENS WHAT. A run opens the sheet and a one-off opens the
//      popup. Swapped, the popup is handed a representative and presents one
//      arbitrary member of 58 identical plays as "the" play, which is the lie
//      the plays log deliberately refuses to tell.
//   3. THE TWO ECHOES LAND. `plays-changed` (the run sheet's delete) had no
//      listener anywhere in the app before this screen; `play-changed` is the
//      popup's. A dropped row has to take its plays off the header count, and
//      emptying the batch has to leave the screen — a header with no body and
//      a delete button for nothing is what staying looks like.
import fs from "node:fs";
import vm from "node:vm";

const W = "/home/user/vibelab/projects/boardgame-buddy/web";

let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};

// ── The sandbox ──────────────────────────────────────────────────────────────
// Only what the view actually touches. A real View base class would drag in
// the Router; the view uses four members of it and stubs are honest about that.
const win = {};
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

class FakeView {
  constructor(name) { this.name = name; this.params = {}; }
  get container() { return win.__container; }
  listenDom() {}
  listen() {}
  refreshIcons() {}
  renderLoading() {}
  render() {}
}

const sandbox = {
  window: win, console, Date, Number, Math, Map, Set, Promise, Array, JSON,
  escapeHtml: esc,
  escapeAttr: esc,
  jsStr: (s) => String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
  formatDate: (d) => String(d || ""),
  showToast: () => {},
};
vm.createContext(sandbox);
win.View = FakeView;
win.Buddy = { nameFor: (_id, name) => name };
win.buddyLoader = () => "<loader>";
win.__container = { innerHTML: "", querySelector: () => null };

vm.runInContext(
  fs.readFileSync(`${W}/views/import-detail-view.js`, "utf8"),
  sandbox,
  { filename: "views/import-detail-view.js" },
);

const ME = { id: "user-me", display_name: "Me" };

function makeView(runs, playCount) {
  const v = new win.ImportDetailView();
  v.params = { batchId: "batch-1" };
  v._runs = runs;
  v._batch = {
    batch_id: "batch-1", play_count: playCount, game_count: 2,
    game_names: ["Azul", "Catan"], imported_at: "2026-03-04",
    first_played_at: "2026-03-01", last_played_at: "2026-03-03",
  };
  v._loaded = true;
  win.importDetailView = v;
  return v;
}

const RUN = {
  play_id: "p-a", import_group_id: "grp-1", group_count: 3,
  game_id: "g-1", game_name: "Catan", game_thumbnail: null,
  played_at: "2026-03-02", notes: "Good game",
  players: [
    { user_id: null, name: "Mick", is_winner: true, score: 12 },
    { user_id: null, name: "Sam", is_winner: false, score: 9 },
  ],
};
const ONE_OFF = {
  play_id: "solo-2", import_group_id: null, group_count: 1,
  game_id: "g-2", game_name: "Azul", game_thumbnail: null,
  played_at: "2026-03-03", notes: null,
  players: [{ user_id: null, name: "Mick", is_winner: true, score: 40 }],
};

// ── 1. The run-sheet projection ──────────────────────────────────────────────
console.log("\n1. _openRun hands the sheet a card it can actually read");
{
  const v = makeView([RUN, ONE_OFF], 4);
  win.store = { get: (k) => (k === "user" ? ME : null) };
  let card = null;
  win.PlayRunSheet = { open: (c) => { card = c; } };

  v._openRun("grp-1");

  ok("the sheet was opened", !!card);
  // play-run-sheet.js#_panel: `const game = (c.game && c.game.name) || "Unknown game"`
  ok("game is an OBJECT with .name, not game_name", card.game && card.game.name === "Catan");
  // play-run-sheet.js#isOwn: `card.user && card.user.id === me.id`
  ok("user.id matches the viewer, so isOwn() is true and Delete is drawn",
     !!card.user && card.user.id === ME.id);
  // A non-empty roster is what makes the sheet's own _loadDetail() a no-op.
  ok("the representative's roster rides along", (card.players || []).length === 2);
  ok("the winner is named for the sheet's headline", card.winner_display_name === "Mick");
  ok("the group id the delete acts on is present", card.import_group_id === "grp-1");
  ok("the count the confirm quotes is present", card.group_count === 3);
}
{
  // A signed-out window is not a state this screen can be in — but reading
  // `me.id` off null would throw inside a click handler, which is worse than a
  // sheet that opens without a delete.
  const v = makeView([RUN], 3);
  win.store = { get: () => null };
  let card = null;
  win.PlayRunSheet = { open: (c) => { card = c; } };
  v._openRun("grp-1");
  ok("no viewer in the store does not throw", !!card && card.user === null);
}

// ── 2. Which row opens what ──────────────────────────────────────────────────
console.log("\n2. a run opens the sheet, a one-off opens the popup");
{
  const v = makeView([RUN, ONE_OFF], 4);
  const runHtml = v._renderRun(RUN);
  const oneHtml = v._renderRun(ONE_OFF);

  ok("run row calls _openRun with its group id", runHtml.includes("_openRun(&#039;grp-1&#039;)")
     || runHtml.includes("_openRun('grp-1')"));
  ok("run row does NOT open the play popup", !runHtml.includes("PlayDetailPopup"));
  ok("run row carries the run modifier class", runHtml.includes("plays-list__row--run"));
  ok("run row states its size", runHtml.includes("3 plays"));

  ok("one-off opens the play popup on its own id",
     oneHtml.includes("PlayDetailPopup.show(&#039;solo-2&#039;)")
     || oneHtml.includes("PlayDetailPopup.show('solo-2')"));
  ok("one-off is not marked as a run", !oneHtml.includes("plays-list__row--run"));
}

// ── 3. The two echoes ────────────────────────────────────────────────────────
console.log("\n3. plays-changed and play-changed keep the screen honest");
{
  const v = makeView([RUN, ONE_OFF], 4);
  let wentUp = null;
  win.router = { up: (n) => { wentUp = n; } };

  v._onRunDeleted({ deleted: 3, importGroupId: "grp-1" });
  ok("the run's row is gone", v._runs.length === 1 && v._runs[0].play_id === "solo-2");
  ok("the header count lost all three plays", v._batch.play_count === 1);
  ok("still on the screen while something is left", wentUp === null);

  v._onPlayChanged({ playId: "solo-2", kind: "delete" });
  ok("the one-off's row is gone too", v._runs.length === 0);
  ok("an emptied batch leaves the screen", wentUp === "imports");
}
{
  const v = makeView([RUN, ONE_OFF], 4);
  win.router = { up: () => { throw new Error("should not navigate"); } };
  v._onRunDeleted({ deleted: 3, importGroupId: "grp-not-here" });
  ok("an echo for another screen's run is ignored", v._runs.length === 2
     && v._batch.play_count === 4);
  v._onPlayChanged({ playId: "not-mine", kind: "delete" });
  ok("an echo for a play this import does not hold is ignored", v._runs.length === 2);
}
{
  // An edit can move the game, the date or the roster — three of the four
  // things the row paints — so the row is re-read rather than guessed at.
  const v = makeView([RUN, ONE_OFF], 4);
  let reloaded = 0;
  v._load = async () => { reloaded++; };
  v._onPlayChanged({ playId: "solo-2", kind: "update" });
  ok("an edit re-reads the import", reloaded === 1);
  ok("an edit removes nothing", v._runs.length === 2);
}

// ── 4. The routes, one letter apart ──────────────────────────────────────────
// /settings/import is the wizard that writes plays; /settings/imports is the
// history of what it wrote. Both patterns are anchored, so neither can swallow
// the other — but they are adjacent rows in the table and look like a typo, and
// a "tidy" that drops the anchors sends the spoke to the wizard silently.
console.log("\n4. /settings/import and /settings/imports stay apart");
{
  const rwin = { addEventListener() {}, location: { pathname: "/", search: "" } };
  const rbox = {
    window: rwin, console, Date, Math, Map, Set, Promise,
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    history: {}, location: rwin.location,
    URLSearchParams, decodeURIComponent, encodeURIComponent,
  };
  vm.createContext(rbox);
  vm.runInContext(fs.readFileSync(`${W}/domain/view.js`, "utf8"), rbox, { filename: "domain/view.js" });
  const R = rwin.router || new rwin.Router();
  const at = (p) => { const m = R.matchPath(p); return m && m.name; };

  ok("/settings/import is still the wizard", at("/settings/import") === "import-wizard");
  ok("/settings/imports is the spoke", at("/settings/imports") === "imports");
  ok("/settings/imports/<id> is the drill-down", at("/settings/imports/abc") === "import-detail");
  ok("the batch id comes off the PATH",
     (R.matchPath("/settings/imports/abc").params || {}).batchId === "abc");

  // A uuid needs no escaping, but pathFor/matchPath are one declarative pair
  // and a round trip is how you know they have not drifted.
  const url = R.pathFor("import-detail", { batchId: "a b/c" });
  ok("pathFor encodes the id", url === "/settings/imports/a%20b%2Fc");
  ok("matchPath decodes it back",
     (R.matchPath(url).params || {}).batchId === "a b/c");
  ok("pathFor('imports') builds the index", R.pathFor("imports", {}) === "/settings/imports");
}

console.log(fails ? `\n${fails} FAILED` : "\nall assertions passed");
process.exit(fails ? 1 : 0);
