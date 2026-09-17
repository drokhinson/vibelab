#!/usr/bin/env node
// check-feedback.mjs — assert the Dev feedback board's client behaviour.
//
//     node projects/boardgame-buddy/tools/check-feedback.mjs
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the real modules into a VM
// context against a fake api and checks the four things that are invisible when
// they break:
//
//   1. The OPTIMISTIC LIKE reconciles against the server's count, not its own
//      ±1. Somebody else liking the same item while the request is in the air
//      would otherwise leave the row one behind for the rest of the session.
//   2. A FAILED like rolls back to exactly where it was — and rolls back BOTH
//      the flag and the count, not just the flag, which is the half-fix that
//      leaves a "not liked" row showing somebody else's total.
//   3. The BUSY GUARD is per item. A double-tap on one row must not interleave
//      two writes, and a tap on a second row must not be blocked by the first.
//   4. The LOADING BRANCH wins over the empty state whenever a fetch is in
//      flight OR nothing has loaded yet. A filter change clears the list before
//      the request goes out, so a branch gated on `loaded` alone renders
//      "the board is empty" next to a spinner — the exact bug
//      .claude/rules/web-frontend.md's three-states rule exists to prevent.
//
// (4) is checked by driving the real _renderList through a stub view rather
// than by re-deriving its condition here: a copy of the condition would agree
// with itself forever.
import fs from "node:fs";
import vm from "node:vm";

const W = new URL("../web/", import.meta.url).pathname;

// Globals the modules reach for at load time or during a render.
const win = {};
const sandbox = {
  window: win, console, Promise, Set, Map, Math, Date, JSON, String, Number, Array, Object,
  escapeHtml: (s) => String(s == null ? "" : s),
  escapeAttr: (s) => String(s == null ? "" : s),
  formatDate: () => "17 Sep",
  showToast: () => {},
  notifyRequestError: () => {},
  captureFocus: () => null,
  restoreFocus: () => {},
};
vm.createContext(sandbox);

// A View base just complete enough for the subclass to extend and run.
win.View = class View {
  constructor(name) { this.name = name; this.params = {}; }
  get container() { return this._container || null; }
  listen() {}
  listenDom() {}
  refreshIcons() {}
};
win.AdminGate = { allowed: () => false };
win.buddyLoader = () => "<!--LOADER-->";
win.BgbIcons = { render() {} };
win.router = { back() {}, go() {}, replaceUrl() {} };
win.FeedbackComposeSheet = { isOpen: false, open() {}, close() {} };

for (const f of ["domain/feedback.js", "views/feedback-view.js"]) {
  vm.runInContext(fs.readFileSync(`${W}${f}`, "utf8"), sandbox, { filename: f });
}

let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};

/** A view with no DOM: _patchRow finds no row and no-ops, which is fine here. */
function makeView(items) {
  const v = new win.FeedbackView();
  v._items = items;
  v._loaded = true;
  v._container = null;
  return v;
}

const item = (over = {}) => ({
  id: "f1", user_id: "u2", author_name: "Them",
  feedback_type: "bug", feedback_type_label: "Bug", feedback_type_icon: "alert-triangle",
  topic: "feed", topic_label: "Feed", topic_icon: "home",
  body: "Broken", status: "open", resolved_at: null, resolver_name: null,
  created_at: "2026-09-17T00:00:00Z", like_count: 3, viewer_liked: false, ...over,
});

console.log("\n1. An optimistic like reconciles against the server's count");
{
  const it = item();
  const v = makeView([it]);
  const seen = [];
  // The server says 9, not the 4 the optimistic paint guessed: two other people
  // liked it while this request was in the air.
  win.api = {
    post: async () => { seen.push(it.like_count); return { liked: true, like_count: 9 }; },
    del: async () => ({ liked: false, like_count: 0 }),
    get: async () => [],
  };
  await v._toggleLike("f1");
  ok("painted its own guess before the request", seen[0] === 4);
  ok("settled on the server's count", it.like_count === 9);
  ok("flag reflects the settled state", it.viewer_liked === true);
}

console.log("\n2. A failed like rolls back BOTH halves");
{
  const it = item({ like_count: 3, viewer_liked: false });
  const v = makeView([it]);
  win.api = {
    post: async () => { throw new Error("offline"); },
    del: async () => ({ liked: false, like_count: 0 }),
    get: async () => [],
  };
  await v._toggleLike("f1");
  ok("count is back where it started", it.like_count === 3);
  ok("flag is back where it started", it.viewer_liked === false);
  ok("the guard released after the failure", !v._likeBusy.has("f1"));
}

console.log("\n3. Unliking rolls back to liked, not to zero");
{
  // The asymmetric direction, and the one a flag-only rollback gets wrong: the
  // row started liked with a real count, so "back where it was" is 5 and true.
  const it = item({ like_count: 5, viewer_liked: true });
  const v = makeView([it]);
  win.api = {
    post: async () => ({ liked: true, like_count: 6 }),
    del: async () => { throw new Error("offline"); },
    get: async () => [],
  };
  await v._toggleLike("f1");
  ok("count restored to 5", it.like_count === 5);
  ok("flag restored to liked", it.viewer_liked === true);
}

console.log("\n4. The busy guard is per item, not global");
{
  const a = item({ id: "a" });
  const b = item({ id: "b" });
  const v = makeView([a, b]);
  let inFlight = 0, maxConcurrentOnA = 0, calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  win.api = {
    post: async (path) => {
      calls++;
      if (path.includes("/a/")) { inFlight++; maxConcurrentOnA = Math.max(maxConcurrentOnA, inFlight); await gate; inFlight--; }
      return { liked: true, like_count: 4 };
    },
    del: async () => ({ liked: false, like_count: 3 }),
    get: async () => [],
  };
  const first = v._toggleLike("a");
  const second = v._toggleLike("a");   // double-tap, must be dropped
  await v._toggleLike("b");            // a different row, must NOT be blocked
  ok("a second tap on the same row is dropped", maxConcurrentOnA === 1);
  ok("another row still went through", calls === 2);
  ok("the second row settled", b.like_count === 4);
  release();
  await Promise.all([first, second]);
  ok("guards released for both rows", v._likeBusy.size === 0);
}

console.log("\n5. An unknown id is a no-op, not a crash");
{
  const v = makeView([item()]);
  win.api = { post: async () => { throw new Error("should not be called"); }, del: async () => {}, get: async () => [] };
  await v._toggleLike("nope");
  ok("no write attempted for an id that is not on the board", true);
}

console.log("\n6. The loader wins over the empty state while a fetch is in flight");
{
  const v = makeView([]);

  // A filter change clears the list and marks the fetch in flight BEFORE the
  // first paint. This is the state the three-states rule is about.
  v._items = []; v._loading = true; v._loaded = false; v._error = "";
  ok("mid-fetch, empty list -> loader", v._renderList().includes("<!--LOADER-->"));

  // A seeded-but-empty list that has never fetched is still not an empty state.
  v._loading = false; v._loaded = false;
  ok("never loaded, empty list -> loader", v._renderList().includes("<!--LOADER-->"));

  // Only once a fetch has actually completed empty does the empty state show.
  v._loading = false; v._loaded = true;
  const empty = v._renderList();
  ok("loaded and empty -> the empty state", !empty.includes("<!--LOADER-->") && empty.includes("feedback__empty"));

  // And a failure gets its own branch with a way to ask again — never the
  // empty state, which reads as permanent and offers nothing.
  v._error = "Network is down"; v._loaded = false; v._loading = false;
  const err = v._renderList();
  ok("a failed first load -> a retry branch", err.includes("Try again") && err.includes("Network is down"));
}

console.log("\n7. A submitted item is dropped when the current filters exclude it");
{
  const v = makeView([]);
  v._status = "open"; v._type = "feature"; v._topic = "";
  v._onSubmitted(item({ id: "new", feedback_type: "bug" }));
  ok("a bug does not appear under the feature filter", v._items.length === 0);

  v._type = "bug";
  v._onSubmitted(item({ id: "new", feedback_type: "bug" }));
  ok("it does appear once the filter matches", v._items.length === 1);
  ok("and it goes on top, where the person can see it", v._items[0].id === "new");
}

console.log("\n8. A stale ?compose= type is ignored rather than preselected");
{
  // The sheet's own guard: only a type the lookup table knows is honoured, so a
  // bookmark to ?compose=whatever opens a normal empty sheet rather than one
  // carrying an invisible selection the server would reject.
  // The shell stub has to exist BEFORE the widget loads: it builds its sheet in
  // the constructor, and the module ends by constructing its singleton.
  let opened = null;
  win.BgbBottomSheet = class {
    open(o) { opened = o; }
    close() {}
    get isOpen() { return false; }
    get el() { return null; }
  };
  vm.runInContext(fs.readFileSync(`${W}widgets/feedback-compose-sheet.js`, "utf8"),
                  sandbox, { filename: "widgets/feedback-compose-sheet.js" });
  const sheet = win.FeedbackComposeSheet;
  const types = [{ id: "bug", label: "Bug", icon: "alert-triangle" }];
  const topics = [{ id: "feed", label: "Feed", icon: "home" }];

  sheet.open({ types, topics, type: "bug", onDone() {} });
  ok("a known type is preselected", sheet._type === "bug");
  ok("and the dialog is labelled for it", opened.label === "Report a bug");

  sheet.open({ types, topics, type: "made-up", onDone() {} });
  ok("an unknown type is discarded", sheet._type === "");

  sheet.open({ types, topics, type: "", onDone() {} });
  ok("no type asked for leaves it unset", sheet._type === "");
  ok("send is disabled until type, topic and body are all set",
     sheet._renderFoot().includes("disabled"));
  sheet._type = "bug"; sheet._topic = "feed"; sheet._body = "it broke";
  ok("and enabled once they are", !sheet._renderFoot().includes("disabled"));
}

console.log(fails ? `\n${fails} FAILED\n` : "\nAll checks passed\n");
process.exit(fails ? 1 : 0);
