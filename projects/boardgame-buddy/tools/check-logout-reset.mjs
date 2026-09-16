#!/usr/bin/env node
// check-logout-reset.mjs — assert that signing out leaves nothing behind.
//
//     node projects/boardgame-buddy/tools/check-logout-reset.mjs
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the real modules into a VM
// context and checks the two things that a sign-out got wrong.
//
// THE SHAPE OF BOTH BUGS IS THE SAME, and it is worth naming because it will
// come back: every view and every ui/ module is constructed ONCE per tab
// (init.js), and logging out is a route change, not a reload. So anything held
// on an instance or in a module closure survives the sign-out and greets
// whoever signs in next. store.reset() clears the STORE; it does not clear the
// objects that read from it.
//
//   1. Settings' `_deleting` latch. Set between the confirm and the sign-out
//      that follows a successful delete, and on that path it was never
//      cleared — there was nothing left to clear it FOR, the reasoning went,
//      since the account is gone. But the view object is not gone: a new
//      account signing in on the same tab opened Settings to a disabled
//      "Deleting…" button and a Log out it could not click.
//   2. The push card's `_readState`. It runs from a `user` subscriber, and
//      store.reset() fires every subscriber — so signing out kicked off a read
//      of /push/config with no token left to send it, and a guaranteed 401 in
//      the console. The gate that would have stopped it (_shouldShow's
//      _authed()) runs after the fetch resolves.
import fs from "node:fs";
import vm from "node:vm";

const W = "/home/user/vibelab/projects/boardgame-buddy/web";

let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};

/** A window with just enough of the DOM for these modules to load. */
function newWindow() {
  const win = {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
  };
  const sandbox = {
    window: win,
    console,
    Date,
    Promise,
    Map,
    Set,
    setTimeout,
    clearTimeout,
    document: {
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
  };
  vm.createContext(sandbox);
  return { win, sandbox };
}

/** A store that records its subscribers so a test can fire them by hand. */
function fakeStore() {
  const subs = new Map();
  let user = null;
  return {
    get: (k) => (k === "user" ? user : null),
    set() {},
    subscribe(key, fn) {
      if (!subs.has(key)) subs.set(key, new Set());
      subs.get(key).add(fn);
      return () => subs.get(key).delete(fn);
    },
    /** What store.reset() does to subscribers: fire them all with nothing. */
    signOut() {
      user = null;
      for (const set of subs.values()) for (const fn of set) fn(null, null);
    },
    signIn(u) {
      user = u;
      for (const fn of subs.get("user") || []) fn(u, null);
    },
  };
}

// 1 ── The push card must not read /push/config for nobody ────────────────────
console.log("\n1. push-prompt reads its state only for a signed-in account");
{
  const { win, sandbox } = newWindow();
  vm.runInContext(fs.readFileSync(`${W}/ui/push-prompt.js`, "utf8"), sandbox,
                  { filename: "ui/push-prompt.js" });

  let reads = 0;
  win.BgbPush = {
    state() {
      reads++;
      return Promise.resolve({
        supported: true, standaloneOk: true, permission: "default",
        tier: "none", subscribed: false, configEnabled: true,
      });
    },
  };
  const store = fakeStore();
  win.store = store;
  win.BgbPushPrompt.init();

  ok("no read at init, before any account exists", reads === 0);

  store.signIn({ id: "user-a" });
  await Promise.resolve();
  ok("one read when an account signs in", reads === 1);

  // The bug: store.reset() on logout fires this same subscriber.
  store.signOut();
  await Promise.resolve();
  ok("NO read on sign-out (this was the 401)", reads === 1);

  store.signIn({ id: "user-b" });
  await Promise.resolve();
  ok("reads again for the next account", reads === 2);
}

// 2 ── Settings' delete latch ─────────────────────────────────────────────────
console.log("\n2. Settings' delete latch does not outlive the sign-out");

function newSettings() {
  const { win, sandbox } = newWindow();
  vm.runInContext(fs.readFileSync(`${W}/domain/view.js`, "utf8"), sandbox,
                  { filename: "domain/view.js" });
  vm.runInContext(fs.readFileSync(`${W}/views/settings-view.js`, "utf8"), sandbox,
                  { filename: "views/settings-view.js" });
  const view = new win.SettingsView();
  // The markup is not what is under test here and painting it would need most
  // of the app; _renderAccountActions() below is the part that reads the latch.
  view.render = () => {};
  return { win, view };
}

const busy = (html) => html.includes("disabled") && html.includes("Deleting…");

{
  const { win, view } = newSettings();
  ok("fresh view: buttons live", !busy(view._renderAccountActions()));

  view._deleting = true;
  ok("mid-delete: buttons disabled and labelled", busy(view._renderAccountActions()));
}

{
  const { win, view } = newSettings();
  let deletes = 0, logouts = 0, busyDuringWrite = null;
  win.PolaroidPopup = { confirm: () => Promise.resolve(true), alert: () => Promise.resolve() };
  win.User = {
    deleteAccount() {
      deletes++;
      // The whole point of the latch: it is set while this is in flight.
      busyDuringWrite = busy(view._renderAccountActions());
      return Promise.resolve();
    },
  };
  win.handleLogout = () => { logouts++; return Promise.resolve(); };

  await view._confirmDeleteAccount();
  ok("the delete was sent", deletes === 1);
  ok("the button showed progress while it was in flight", busyDuringWrite === true);
  ok("the sign-out followed it", logouts === 1);
  ok("the latch is clear afterwards", view._deleting === false);
  ok("a new account would find live buttons", !busy(view._renderAccountActions()));
}

{
  const { win, view } = newSettings();
  let alerts = 0, logouts = 0;
  win.PolaroidPopup = {
    confirm: () => Promise.resolve(true),
    alert: () => { alerts++; return Promise.resolve(); },
  };
  win.User = { deleteAccount: () => Promise.reject(new Error("nope")) };
  win.handleLogout = () => { logouts++; return Promise.resolve(); };

  await view._confirmDeleteAccount();
  ok("a failed delete says so", alerts === 1);
  ok("a failed delete does NOT sign the user out", logouts === 0);
  ok("a failed delete releases the latch", view._deleting === false);
}

{
  const { win, view } = newSettings();
  let deletes = 0;
  win.PolaroidPopup = { confirm: () => Promise.resolve(false), alert: () => Promise.resolve() };
  win.User = { deleteAccount: () => { deletes++; return Promise.resolve(); } };
  win.handleLogout = () => Promise.resolve();

  await view._confirmDeleteAccount();
  ok("declining the confirm deletes nothing", deletes === 0);
  ok("declining the confirm leaves the latch clear", view._deleting === false);
}

// 3 ── and neither does the rest of the screen's account-scoped state ─────────
console.log("\n3. Settings drops one account's data on the way out");
{
  const { view } = newSettings();
  view._bgg = { bgg_username: "account-a" };
  view._imports = [{ batch_id: "b1" }];
  view._push = { tier: "all" };
  view._pushBusy = true;
  view._deleting = true;
  view._adminFormOpen = true;
  view.onUnmount();
  ok("the BGG link is dropped", view._bgg === null);
  ok("the import history is dropped", view._imports === null);
  ok("the push read is dropped", view._push === null);
  ok("in-flight latches are dropped", view._pushBusy === false && view._deleting === false);
  ok("the admin form is closed", view._adminFormOpen === false);
}

console.log(fails ? `\n${fails} FAILED\n` : "\nAll checks passed.\n");
process.exit(fails ? 1 : 0);
