#!/usr/bin/env node
// check-player-picker.mjs — assert the player picker offers everyone it should.
//
//     node projects/boardgame-buddy/tools/check-player-picker.mjs
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the real sheet into a VM
// context against a fake bottom-sheet shell and a fake-enough DOM, and checks
// the two things about "who can I add?" that are invisible when they break:
//
//   1. PENDING BUDDIES ARE OFFERED. A buddy request nobody has answered yet
//      (migration 049) is a seatable person: they get their own section while
//      the search box is empty — the empty box paints `recent`, which they are
//      not in — and they filter inline like anyone else once you type. The row
//      says which way the request points, and picking one hands back their
//      ACCOUNT, not a same-named ghost.
//   2. THE SEARCH REACHES PAST THE BUDDY LIST BY ITSELF. Typing filters the
//      cached list in the same synchronous call, and the global search runs
//      debounced behind it and APPENDS: one request for a name typed letter by
//      letter, none at all for a one-character query, nobody offered twice, a
//      response the user has typed past discarded, and a failure that leaves a
//      retry rather than a dead end.
import fs from "node:fs";
import vm from "node:vm";

const W = new URL("../web/", import.meta.url).pathname;

// ── A DOM just big enough for the sheet ──────────────────────────────────────

class El {
  constructor(sel) {
    this.sel = sel;
    this._html = "";
    this.paints = 0;
    this.value = "";
    this.isConnected = true;
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; this.paints++; }
  addEventListener(t, fn) { (this.listeners ||= {})[t] = fn; }
  removeEventListener() {}
  focus() {}
  closest() { return null; }
}

/**
 * The bottom-sheet shell, faked down to what the picker actually uses: it
 * holds the panel html, hands back the list and foot hosts `_repaintList`
 * patches, and exposes the search callback as `type()` so a test can drive the
 * field without a real input.
 */
class FakeSheet {
  constructor() { this.isOpen = false; this.el = null; this.opts = null; }
  open(opts) {
    this.opts = opts;
    this.isOpen = true;
    this.list = new El("[data-picker-list]");
    this.foot = new El("[data-picker-foot]");
    // The panel markup is rendered before the hosts exist, so seed the list
    // from it the way the real innerHTML would.
    const m = /data-picker-list>([\s\S]*)<\/div>\s*<div class="bgb-sheet__foot"/.exec(opts.html);
    this.list.innerHTML = m ? m[1] : "";
    const root = {
      querySelector: (sel) => {
        if (sel === "[data-picker-list]") return this.list;
        if (sel === "[data-picker-foot]") return this.foot;
        return new El(sel);
      },
    };
    this.el = root;
    if (opts.onOpen) opts.onOpen(root);
  }
  close() {
    this.isOpen = false;
    this.el = null;
    if (this.opts && this.opts.onClose) this.opts.onClose();
  }
  /** What a keystroke in the search field turns into. */
  type(v) { this.opts.search.onQuery(v); }
  /** What a tap on a row turns into. */
  tap(attr, value) {
    this.opts.onClick({
      target: {
        closest: (sel) => (sel === `[${attr}="${value}"]` || sel === `[${attr}]`
          ? { dataset: { pickerName: value, pickerAction: value } } : null),
      },
    });
  }
  /** A tap on a row keyed by the person's name. */
  tapName(name) {
    this.opts.onClick({
      target: {
        closest: (sel) => (sel === "[data-picker-name]" ? { dataset: { pickerName: name } } : null),
      },
    });
  }
  html() { return this.list.innerHTML; }
}

let sheetInstance = null;

const sandbox = {
  window: {}, console,
  Promise, Set, Map, Math, Date, JSON, String, Number, Array, Object, RegExp, Error,
  setTimeout, clearTimeout,
  escapeHtml: (s) => String(s == null ? "" : s),
  escapeAttr: (s) => String(s == null ? "" : s),
  document: { activeElement: null },
};
vm.createContext(sandbox);
const win = sandbox.window;
win.BgbBottomSheet = function () { sheetInstance = new FakeSheet(); return sheetInstance; };
win.BgbBadge = { render: () => "" };
win.BgbIcons = { render() {} };
win.BgbSearchField = {
  clearButton: () => "",
  clear: () => { if (sheetInstance) sheetInstance.type(""); },
};
vm.runInContext(fs.readFileSync(`${W}widgets/player-picker-sheet.js`, "utf8"), sandbox,
                { filename: "widgets/player-picker-sheet.js" });

const picker = win.PlayerPickerSheet;
let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Comfortably past the sheet's 350ms debounce.
const settle = () => sleep(450);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const buddy = (name, id) => ({ source: "account", user_id: id, name, username: null,
                               avatar: null, plays: 3 });
const pending = (name, id, direction) => ({ source: "account", user_id: id, name,
                                            username: null, avatar: null, pending: direction });
const ghost = (name) => ({ source: "ghost", user_id: null, name, username: null, avatar: null });
const rowsIn = (html) => Array.from(html.matchAll(/data-picker-name="([^"]+)"/g)).map((m) => m[1]);
const sectionOf = (html, name) => {
  // The heading a row sits under: the last section opened before it.
  const idx = html.indexOf(`data-picker-name="${name}"`);
  if (idx < 0) return null;
  const secs = Array.from(html.slice(0, idx).matchAll(/bgb-sheet__sec">([^<]*)</g));
  return secs.length ? secs[secs.length - 1][1] : null;
};

// ── 1. A pending request is a person you can seat ────────────────────────────

console.log("\n1. Unanswered buddy requests are offered, and say which way they point");
{
  let picked = null;
  picker.open({
    candidates: [buddy("Marcus", "u-marcus"), pending("Priya", "u-priya", "outgoing"),
                 pending("Dev", "u-dev", "incoming"), ghost("Sam")],
    // The empty-box list, which by construction holds nobody you have never
    // played with — this is the whole reason the section below has to exist.
    recent: [buddy("Marcus", "u-marcus")],
    onConfirm: (picks) => { picked = picks; },
  });
  const empty = sheetInstance.html();
  ok("the pending pair is on screen with an empty box", 
     rowsIn(empty).includes("Priya") && rowsIn(empty).includes("Dev"));
  ok("under their own heading", sectionOf(empty, "Priya") === "Buddy requests");
  ok("the recent list keeps its own", sectionOf(empty, "Marcus") === "Recently played with");
  ok("an outgoing request reads as sent", empty.includes("Buddy request sent"));
  ok("an incoming one reads as theirs to accept", empty.includes("Wants to be buddies"));
  ok("both are pilled as pending", (empty.match(/>Pending</g) || []).length === 2);

  sheetInstance.type("pri");
  const filtered = sheetInstance.html();
  ok("typing finds them in the flat filtered list", rowsIn(filtered).includes("Priya"));
  ok("and does not also paint the pending section", !filtered.includes("Buddy requests"));
  ok("a partial name still offers the guest row — \u201cpri\u201d is not Priya",
     filtered.includes('data-picker-action="guest"'));
  sheetInstance.type("priya");
  ok("but their own name does not: that row is the better action",
     !sheetInstance.html().includes('data-picker-action="guest"'));

  sheetInstance.tapName("Priya");
  picker._confirm();
  ok("picking one hands back their account, not a ghost",
     picked && picked.length === 1 && picked[0].user_id === "u-priya");
}

// ── 2. The local list answers first, the global search appends ───────────────

console.log("\n2. Buddies filter instantly; the rest of the app is appended behind them");
{
  const asked = [];
  let resolveWith = [{ source: "account", user_id: "u-dana", name: "Dana Okoro",
                       username: "dana", avatar: null }];
  const searchAll = async (q) => { asked.push(q); return resolveWith; };
  picker.open({
    candidates: [buddy("Danielle", "u-dani"), buddy("Marcus", "u-marcus")],
    searchAll,
    onConfirm: () => {},
  });

  sheetInstance.type("d");
  ok("a one-character query asks nobody", asked.length === 0);

  const before = sheetInstance.list.paints;
  sheetInstance.type("da");
  const instant = sheetInstance.html();
  ok("the local match is painted in the same call as the keystroke",
     rowsIn(instant).includes("Danielle") && sheetInstance.list.paints > before);
  ok("nothing has been asked yet — the request is debounced", asked.length === 0);
  // Typed through, letter by letter, inside the debounce window.
  sheetInstance.type("dan");
  sheetInstance.type("dana");
  await settle();
  ok("a name typed letter by letter costs exactly one request", asked.length === 1);
  ok("and it asks the query that was actually typed", asked[0] === "dana");
  const appended = sheetInstance.html();
  ok("the remote row is appended", rowsIn(appended).includes("Dana Okoro"));
  ok("under a heading that says where it came from",
     sectionOf(appended, "Dana Okoro") === "On BoardgameBuddy");
  ok("no button is offered for a search that already ran",
     !appended.includes('data-picker-action="global"'));

  // Someone the local list already holds must not be offered twice.
  resolveWith = [{ source: "account", user_id: "u-dani", name: "Danielle",
                   username: null, avatar: null }];
  sheetInstance.type("danielle");
  await settle();
  ok("a remote hit the local list already holds is dropped",
     rowsIn(sheetInstance.html()).filter((n) => n === "Danielle").length === 1);
}

// ── 3. A late answer never lands under a different question ──────────────────

console.log("\n3. A slow search the user has typed past is discarded");
{
  let release = null;
  const searchAll = (q) => new Promise((res) => {
    if (q === "slow") release = () => res([{ source: "account", user_id: "u-slow",
                                             name: "Slowpoke", username: null, avatar: null }]);
    else res([{ source: "account", user_id: "u-fast", name: "Speedy",
                username: null, avatar: null }]);
  });
  picker.open({ candidates: [], searchAll, onConfirm: () => {} });
  sheetInstance.type("slow");
  await settle();
  ok("the slow request is in the air", release !== null);
  sheetInstance.type("fast");
  await settle();
  ok("the newer query's rows are on screen", rowsIn(sheetInstance.html()).includes("Speedy"));
  release();
  await sleep(20);
  ok("the stale response never lands", !rowsIn(sheetInstance.html()).includes("Slowpoke"));
  ok("and does not displace the newer one", rowsIn(sheetInstance.html()).includes("Speedy"));
}

// ── 4. A failure is a retry, not a dead end ──────────────────────────────────

console.log("\n4. A failed search offers a retry, and the retry works");
{
  let fail = true;
  const asked = [];
  const searchAll = async (q) => {
    asked.push(q);
    if (fail) throw new Error("offline");
    return [{ source: "account", user_id: "u-rita", name: "Rita", username: null, avatar: null }];
  };
  picker.open({ candidates: [], searchAll, searchAllLabel: "Search all of BoardgameBuddy",
                onConfirm: () => {} });
  sheetInstance.type("rita");
  await settle();
  const failed = sheetInstance.html();
  ok("the failure is said out loud", failed.includes("Couldn't search right now."));
  ok("a retry row is offered", failed.includes('data-picker-action="global"'));
  ok("the guest row still stands as the other way out",
     failed.includes('data-picker-action="guest"'));
  fail = false;
  picker._runGlobalSearch();
  await sleep(20);
  ok("the retry asks again", asked.length === 2);
  ok("and its rows land", rowsIn(sheetInstance.html()).includes("Rita"));
  ok("with the retry row gone", !sheetInstance.html().includes('data-picker-action="global"'));
}

// ── 5. Closing drops everything, including work in flight ────────────────────

console.log("\n5. A closed sheet leaves nothing running");
{
  const asked = [];
  picker.open({
    candidates: [buddy("Marcus", "u-marcus")],
    searchAll: async (q) => { asked.push(q); return []; },
    onConfirm: () => {},
  });
  sheetInstance.type("marc");
  picker.close();
  await settle();
  ok("a debounce the close outran never fires", asked.length === 0);
  // The singleton is reused, so a mode or a searcher left set would reach the
  // next opener — Gather would get the importer's sheet.
  picker.open({ candidates: [buddy("Marcus", "u-marcus")], onConfirm: () => {} });
  ok("the next open has no searcher", picker._searchAll === null);
  ok("and no leftover query", picker._query === "");
  ok("and no leftover global rows", picker._globalRows.length === 0);
  picker.close();
}

// ── 6. The guest row stands down for an account the search just found ───────

console.log("\n6. A global hit of the typed name takes the guest row off the table");
{
  picker.open({
    candidates: [],
    searchAll: async () => [{ source: "account", user_id: "u-dana", name: "Dana Okoro",
                              username: null, avatar: null }],
    onConfirm: () => {},
  });
  sheetInstance.type("dana okoro");
  ok("before the answer lands, the guest row is the only offer",
     sheetInstance.html().includes('data-picker-action="guest"'));
  await settle();
  const answered = sheetInstance.html();
  ok("the account is offered", rowsIn(answered).includes("Dana Okoro"));
  ok("and 'add them as a guest' is withdrawn — it would seat a duplicate",
     !answered.includes('data-picker-action="guest"'));
}

// ── 7. A buddy list that lands late does not double anyone ──────────────────

console.log("\n7. A cold-cache search, then the buddy bundle, is still one row per person");
{
  picker.open({
    // Cold: the caller opened before its own bundle resolved.
    candidates: [],
    searchAll: async () => [{ source: "account", user_id: "u-marcus", name: "Marcus",
                              username: null, avatar: null }],
    onConfirm: () => {},
  });
  sheetInstance.type("marcus");
  await settle();
  ok("the search found them while the local list was empty",
     rowsIn(sheetInstance.html()).includes("Marcus"));
  picker.setCandidates([buddy("Marcus", "u-marcus")], []);
  ok("and the arriving buddy row replaces rather than joins it",
     rowsIn(sheetInstance.html()).filter((n) => n === "Marcus").length === 1);
  ok("the surviving row is the local one, with its play count",
     sheetInstance.html().includes("3 plays together"));
  picker.close();
}

// ── 8. The bundle's pending list becomes picker rows ────────────────────────

console.log("\n8. Buddy.toPlayerCandidates maps the bundle's pending edges");
{
  const bsandbox = {
    window: {}, console, Promise, Set, Map, Math, Date, JSON,
    String, Number, Array, Object, RegExp, Error, setTimeout, clearTimeout,
  };
  vm.createContext(bsandbox);
  vm.runInContext(fs.readFileSync(`${W}domain/buddy.js`, "utf8"), bsandbox,
                  { filename: "domain/buddy.js" });
  const rows = bsandbox.window.Buddy.toPlayerCandidates({
    accounts: [{ id: "e-0", other_user_id: "u-marcus", other_display_name: "Marcus" }],
    pending: [
      { id: "e-1", other_user_id: "u-priya", other_display_name: "Priya",
        other_username: "priya", direction: "outgoing" },
      // Already an accepted buddy above: the accepted edge wins, and no row is
      // painted twice.
      { id: "e-2", other_user_id: "u-marcus", other_display_name: "Marcus",
        direction: "incoming" },
    ],
    ghosts: [{ display_name: "Sam", play_count: 2 }],
    recent: [{ user_id: "u-priya", display_name: "Priya", play_count: 4 }],
  });
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  ok("a pending edge becomes an account row", byName.Priya && byName.Priya.user_id === "u-priya");
  ok("carrying its direction", byName.Priya.pending === "outgoing");
  ok("and the play count off `recent`, which the dedupe would otherwise lose",
     byName.Priya.plays === 4);
  ok("never an alias — a pending edge cannot hold one", byName.Priya.alias === null);
  ok("an accepted edge wins over a pending row for the same person",
     rows.filter((r) => r.user_id === "u-marcus").length === 1
     && !byName.Marcus.pending);
  ok("ghosts still come last", rows[rows.length - 1].name === "Sam");
}

console.log(fails ? `\n${fails} FAILED\n` : "\nAll checks passed\n");
process.exit(fails ? 1 : 0);
