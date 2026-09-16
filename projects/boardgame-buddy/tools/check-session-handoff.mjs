#!/usr/bin/env node
// check-session-handoff.mjs — assert what the app does at a session boundary.
//
//     node projects/boardgame-buddy/tools/check-session-handoff.mjs
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the real modules into a VM
// context and checks the two halves of signing in and out. Every bug it covers
// was reported from the live app.
//
// ONE FACT EXPLAINS ALL OF THEM: every view and ui/ module is constructed once
// per tab (init.js), and signing in or out is a route change, not a reload. So
// anything held on an instance or in a module closure survives the boundary,
// and store.reset() clears the STORE, never the objects reading from it.
//
// SIGNING OUT MUST LEAVE NOTHING BEHIND (sections 1–3):
//
//   1. The push card's `_readState` runs from a `user` subscriber, and
//      store.reset() fires every subscriber — so signing out kicked off a read
//      of /push/config with no token left to send it, and a guaranteed 401 in
//      the console. The gate that would have stopped it (_shouldShow's
//      _authed()) runs after the fetch resolves.
//   2. Settings' `_deleting` latch, set between the confirm and the sign-out
//      that follows a successful delete and never cleared on that path —
//      there was nothing left to clear it FOR, the reasoning went, since the
//      account is gone. But the view object is not gone: a new account signing
//      in on the same tab opened Settings to a disabled "Deleting…" button and
//      a Log out it could not click.
//   3. The rest of that screen's account-scoped reads, which painted the
//      PREVIOUS account's BGG handle and import history for a frame.
//
// SIGNING IN MUST HAND OVER TO THE LOADER (sections 4–5):
//
//   4. signInWithPopup resolves when the credential arrives; the auth listener
//      then waits on /bootstrap for any account this device has not cached —
//      which is every new signup. Nothing filled that gap, so the popup shut
//      and the login form was simply still there, live button and all. It
//      reads as a failure, and pressing the button again is the one response
//      that actually breaks the sign-in: the second popup cancels the first.
//   5. The email form's own immediate-session branch had the same gap, on the
//      longest wait in the app in front of the person least able to read it.
//
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
  // The one container every view in this harness paints into, plus the form
  // fields a handler may read back out of the DOM.
  const el = { innerHTML: "", childElementCount: 0, querySelector: () => null };
  const fields = {
    "auth-email": { value: "" },
    "auth-password": { value: "" },
    "auth-submit": { disabled: false, classList: { add() {}, remove() {} } },
  };
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
      // Views reach their container through document.querySelector. One fake
      // element serves every [data-view], which is all these checks need.
      querySelector: () => el,
      querySelectorAll: () => [],
      getElementById: (id) => fields[id] || null,
    },
    // Online, so _authErrorMessage takes its normal branch rather than
    // rewriting every failure as "you're offline".
    navigator: { onLine: true },
    // helpers.js globals, free variables inside the view files.
    escapeHtml: (v) => String(v == null ? "" : v),
    escapeAttr: (v) => String(v == null ? "" : v),
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
  };
  vm.createContext(sandbox);
  return { win, sandbox, el, fields };
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

// 4 ── The sign-in screen hands over to the loader ────────────────────────────
console.log("\n4. a closed Google popup is not a sign-in screen");

function newAuth(outcome) {
  const { win, sandbox, el, fields } = newWindow();
  vm.runInContext(fs.readFileSync(`${W}/domain/view.js`, "utf8"), sandbox,
                  { filename: "domain/view.js" });
  vm.runInContext(fs.readFileSync(`${W}/ui/oauth-buttons.js`, "utf8"), sandbox,
                  { filename: "ui/oauth-buttons.js" });
  vm.runInContext(fs.readFileSync(`${W}/views/auth-view.js`, "utf8"), sandbox,
                  { filename: "views/auth-view.js" });

  const calls = { popups: 0, routes: [], htmlDuringPopup: null };
  win.BgbIcons = { render() {} };
  win.router = { go: (name) => calls.routes.push(name) };
  win.BgbAuth = {
    backend: "firebase",
    signInWithGoogle() {
      calls.popups++;
      // What the screen looks like while the popup is open.
      calls.htmlDuringPopup = el.innerHTML;
      return typeof outcome === "function" ? outcome() : Promise.resolve(outcome);
    },
  };
  const view = new win.AuthView();
  win.authView = view;
  return { win, view, calls, el, fields };
}

const googleDisabled = (html) =>
  /auth-oauth-google[^>]*disabled/.test(html.replace(/\n/g, " "));

{
  const { view, calls, el } = newAuth("signed-in");
  view.render();
  ok("the button starts live", !googleDisabled(el.innerHTML));

  await view.oauth("google");
  ok("the popup was opened", calls.popups === 1);
  ok("the button was dead while the popup was open",
     googleDisabled(calls.htmlDuringPopup));
  // The bug: this used to be [] and the user was left looking at the form.
  ok("a credential hands over to the loader", calls.routes.join() === "splash");
}

{
  const { view, calls, el } = newAuth("cancelled");
  await view.oauth("google");
  ok("a shut popup routes nowhere", calls.routes.length === 0);
  ok("a shut popup says nothing", view._error === null);
  ok("a shut popup gives the button back", !googleDisabled(el.innerHTML));
}

{
  const err = Object.assign(new Error("nope"), { code: "auth/too-many-requests" });
  const { view, calls, el } = newAuth(() => Promise.reject(err));
  await view.oauth("google");
  ok("a real failure routes nowhere", calls.routes.length === 0);
  ok("a real failure is explained in our own words",
     view._error === "Too many attempts. Wait a minute, then try again.");
  ok("a real failure gives the button back", !googleDisabled(el.innerHTML));
}

{
  // A second tap while the first popup is open is what Firebase answers with
  // auth/cancelled-popup-request — it kills the sign-in already running.
  let release;
  const { view, calls } = newAuth(() => new Promise((r) => { release = r; }));
  const first = view.oauth("google");
  await view.oauth("google");
  ok("a second tap while busy opens no second popup", calls.popups === 1);
  release("signed-in");
  await first;
  ok("the first tap still lands", calls.routes.join() === "splash");
}

{
  const { view, fields } = newAuth("cancelled");
  fields["auth-email"].value = "someone@example.com";
  await view.oauth("google");
  ok("a typed address survives the busy repaint",
     view._email === "someone@example.com");
}

{
  const { view } = newAuth("signed-in");
  view._oauthBusy = true;
  view._email = "someone@example.com";
  view._error = "stale";
  view._mode = "signup";
  view.onUnmount();
  ok("leaving the screen releases the buttons", view._oauthBusy === false);
  ok("leaving the screen forgets the address", view._email === "");
  ok("leaving the screen drops a stale error", view._error === null);
  ok("leaving the screen returns to Log In", view._mode === "login");
}

// 5 ── and so does the email form, on the same reasoning ─────────────────────
console.log("\n5. the email form hands over too");
{
  const { win, view, calls, fields } = newAuth("signed-in");
  win.BgbAuth.signUp = () => Promise.resolve({ existing: false, session: { ok: 1 } });
  view._mode = "signup";
  fields["auth-email"].value = "new@example.com";
  fields["auth-password"].value = "hunter22";
  await view.submit({ preventDefault() {} });
  // A brand-new signup is the longest wait in the app and the least
  // experienced person waiting it out.
  ok("a completed signup hands over to the loader", calls.routes.join() === "splash");
  ok("a completed signup leaves no error behind", view._error === null);
}
{
  const { win, view, calls } = newAuth("signed-in");
  win.BgbAuth.signUp = () => Promise.resolve({ existing: true, session: null });
  view._mode = "signup";
  await view.submit({ preventDefault() {} });
  ok("an address that already has an account stays put", calls.routes.length === 0);
  ok("...and flips to Log In", view._mode === "login");
  ok("...saying why", /already exists/.test(view._error || ""));
}
{
  const { win, view, calls } = newAuth("signed-in");
  win.BgbAuth.signUp = () => Promise.resolve({ existing: false, session: null });
  view._mode = "signup";
  await view.submit({ preventDefault() {} });
  ok("an unconfirmed signup stays put", calls.routes.length === 0);
  ok("...and says to check the mail", /Check your email/.test(view._error || ""));
}
{
  const { win, view, calls } = newAuth("signed-in");
  win.BgbAuth.signInWithPassword = () => Promise.resolve({});
  await view.submit({ preventDefault() {} });
  ok("a password login hands over to the loader", calls.routes.join() === "splash");
}

console.log(fails ? `\n${fails} FAILED\n` : "\nAll checks passed.\n");
process.exit(fails ? 1 : 0);
