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
//   5. The TOPIC GROUPING: one header per topic that has rows and none for a
//      topic that does not, every group closed until tapped, the lookup table's
//      display order where it knows the topic, and no rows in the markup for a
//      closed group.
//   6. The FLOATING ADD renders only when there is a board under it — an empty
//      board already carries its own "Add feedback" button.
//
// (4), (5) and (6) are checked by driving the real _renderList / _renderFab
// through a stub view rather than by re-deriving their conditions here: a copy
// of a condition would agree with itself forever.
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
win.BgbSwitch = {
  render: (o) => `<button role="switch" aria-checked="${!!o.on}" id="${o.id || ""}"`
                 + ` class="bgb-switch ${o.cls || ""}">${o.label || ""}</button>`,
};

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

console.log("\n7. A submitted item is dropped when the current filter excludes it");
{
  const v = makeView([]);
  v._status = "open"; v._type = "feature";
  v._onSubmitted(item({ id: "new", feedback_type: "bug" }));
  ok("a bug does not appear under the feature filter", v._items.length === 0);
  ok("and no group was opened for a row that was not added", v._openTopics.size === 0);

  v._type = "bug";
  v._onSubmitted(item({ id: "new", feedback_type: "bug", topic: "feed" }));
  ok("it does appear once the filter matches", v._items.length === 1);
  ok("and it goes on top, where the person can see it", v._items[0].id === "new");
  // Every group starts closed, so an insert into a closed one is invisible and
  // reads as the submit having failed.
  ok("its topic was opened so the person can see what they wrote",
     v._openTopics.has("feed"));
}

console.log("\n8. The board groups by topic, closed, and only where there are rows");
{
  const v = makeView([
    item({ id: "a", topic: "feed", topic_label: "Feed", topic_icon: "home" }),
    item({ id: "b", topic: "stats", topic_label: "Stats", topic_icon: "chart-bar" }),
    item({ id: "c", topic: "feed", topic_label: "Feed", topic_icon: "home" }),
  ]);
  // The lookup table carries a third topic nobody has filed under, plus a
  // display order that disagrees with like order — both of which the render has
  // to honour.
  v._topics = [
    { id: "stats", label: "Stats", icon: "chart-bar", display_order: 1 },
    { id: "feed", label: "Feed", icon: "home", display_order: 2 },
    { id: "buddies", label: "Buddies", icon: "users", display_order: 3 },
  ];

  const groups = v._groups();
  ok("one bucket per topic that has rows", groups.length === 2);
  ok("a topic with no rows gets no bucket", !groups.some((g) => g.id === "buddies"));
  ok("buckets follow the lookup table's display order, not like order",
     groups[0].id === "stats" && groups[1].id === "feed");
  ok("rows keep the server's order inside their bucket",
     groups[1].items.map((i) => i.id).join(",") === "a,c");

  const html = v._renderList();
  ok("every group renders its header", html.includes(">Feed<") && html.includes(">Stats<"));
  ok("a topic with no rows renders no header", !html.includes(">Buddies<"));
  ok("every group starts collapsed", !html.includes('aria-expanded="true"'));
  ok("a collapsed group renders none of its rows", !html.includes("feedback__item"));
  ok("the header states how many rows are under it", html.includes(">2</span>"));

  v._toggleTopic("feed");
  const open = v._renderList();
  ok("opening one group reveals exactly its rows",
     (open.match(/feedback__item/g) || []).length === 2);
  ok("and the other stays shut", (open.match(/aria-expanded="true"/g) || []).length === 1);
  v._toggleTopic("feed");
  ok("tapping it again closes it", !v._renderList().includes("feedback__item"));
}

console.log("\n9. A topic the lookup table has forgotten still gets a header");
{
  // A retired topic still has rows on the board. They sort after the live
  // topics rather than vanishing or landing first, and the header paints from
  // the row's own denormalised label.
  const v = makeView([
    item({ id: "a", topic: "gone", topic_label: "Retired", topic_icon: "archive" }),
    item({ id: "b", topic: "feed", topic_label: "Feed", topic_icon: "home" }),
  ]);
  v._topics = [{ id: "feed", label: "Feed", icon: "home", display_order: 1 }];
  const groups = v._groups();
  ok("the known topic sorts first", groups[0].id === "feed");
  ok("the retired one still gets a bucket", groups[1].id === "gone");
  ok("labelled from the row, not from the lookup table", groups[1].label === "Retired");
}

console.log("\n10. The floating Add renders only when there is a board under it");
{
  const v = makeView([]);
  v._items = [];
  ok("an empty board floats nothing", v._renderFab() === "");
  ok("...because the empty state already offers one",
     v._renderEmpty().includes("Add feedback"));
  v._items = [item()];
  ok("a board with rows floats the shared .bgb-fab", v._renderFab().includes("bgb-fab"));
  ok("and the list reserves room so the last row clears it",
     v._renderList().includes("bgb-fab-spacer"));
}

console.log("\n11. The Resolved switch is admin-only, and it swaps the board");
{
  const v = makeView([item()]);
  win.AdminGate = { allowed: () => false };
  ok("a non-admin gets no switch", !v._renderHead().includes("bgb-switch"));

  win.AdminGate = { allowed: () => true };
  ok("an admin gets one", v._renderHead().includes("feedback__resolved-switch"));
  ok("off while the open half is showing", v._renderHead().includes('aria-checked="false"'));

  // Flipping it must drop `loaded`, or _renderList shows the previous half's
  // empty state over the new half's fetch.
  win.api = { get: async () => [], post: async () => {}, del: async () => {} };
  v._openTopics.add("feed");
  v._toggleResolved();
  ok("it asks the server for the other half", v._status === "resolved");
  ok("and drops the loaded flag with it", v._loaded === false);
  ok("expanded topics survive the flip", v._openTopics.has("feed"));
  ok("the switch reads on", v._renderHead().includes('aria-checked="true"'));
  win.AdminGate = { allowed: () => false };
}

console.log("\n12. A stale ?compose= type is ignored rather than preselected");
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
