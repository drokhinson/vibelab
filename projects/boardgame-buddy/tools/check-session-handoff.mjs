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
//   6. And when the popup is BLOCKED, the redirect fallback replaces the
//      document — so a redirect that fails has no caller left to report to.
//      BgbAuth.consumeRedirectResult was written for that and never called,
//      so the user went to Google, came back, and got a login screen with no
//      error on it. The gating matters as much as the wiring: asking the SDK
//      when no redirect was started reaches for storage that ITP blocks on a
//      cross-origin authDomain, which would put an error in front of people
//      whose popup sign-in worked perfectly.
//
// AND THE BOUNDARY IS A PROPERTY OF THE SHELL, NOT OF A NAVIGATION (7):
//
//   7. Two halves of one report — "then to feed but with bottom bar missing.
//      And then i was able to do the back gesture and it returned me to the
//      initial login screen but with a functional bottom nav bar and header."
//      The chrome was computed only inside router.go(), off whatever `user`
//      happened to be at that instant, and init.js routes a valid session
//      forward before /bootstrap has answered rather than strand it on the
//      splash. So the feed painted with no nav, and the back press — a
//      navigation — was what finally turned it on. Meanwhile the login
//      screen's own history entry sat directly under the first screen of the
//      session, so one back gesture put a signed-in account on the login
//      form. Signing in spends that entry now, and a back press that would
//      cross the session boundary either way is refused.
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
function newWindow({ storageThrows = false } = {}) {
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
    // A real in-memory store: the redirect marker is read back through it.
    // The throwing variant is Safari private mode, where storage is not a
    // thing sign-in may depend on.
    sessionStorage: storageThrows
      ? {
          getItem() { throw new Error("storage disabled"); },
          setItem() { throw new Error("storage disabled"); },
          removeItem() { throw new Error("storage disabled"); },
        }
      : {
          _d: new Map(),
          getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
          setItem(k, v) { this._d.set(k, String(v)); },
          removeItem(k) { this._d.delete(k); },
        },
  };
  vm.createContext(sandbox);
  return { win, sandbox, el, fields, storage: sandbox.sessionStorage };
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

function newAuth(outcome, redirect = { err: null }) {
  const { win, sandbox, el, fields } = newWindow();
  vm.runInContext(fs.readFileSync(`${W}/domain/view.js`, "utf8"), sandbox,
                  { filename: "domain/view.js" });
  vm.runInContext(fs.readFileSync(`${W}/ui/oauth-buttons.js`, "utf8"), sandbox,
                  { filename: "ui/oauth-buttons.js" });
  vm.runInContext(fs.readFileSync(`${W}/views/auth-view.js`, "utf8"), sandbox,
                  { filename: "views/auth-view.js" });

  const calls = { popups: 0, routes: [], htmlDuringPopup: null, consumes: 0 };
  win.BgbIcons = { render() {} };
  // Not just a recorder: routing AWAY from the form unmounts it and coming
  // back mounts it again, which is what clears every transient field. The
  // handover now happens before the outcome is known, so a cancel returns
  // through a real navigation — and _backToForm has to re-apply the address
  // AFTER that mount, not before. A recorder-only router cannot tell the two
  // orderings apart.
  let view;
  win.router = {
    go: async (name) => {
      calls.routes.push(name);
      if (name === "auth") { await view.mount({}); return; }
      // Modelled on the real go(): the outgoing screen's unmount is a
      // FLOATING microtask, and only the awaited mount of the destination
      // guarantees it has landed by the time go() resolves. That unmount is
      // what clears this screen's fields, so the caller awaiting it is the
      // difference between the return trip being the last word and being
      // overwritten by it.
      Promise.resolve().then(() => view.unmount());
      await Promise.resolve();
    },
  };
  win.BgbAuth = {
    backend: "firebase",
    consumeRedirectResult() {
      calls.consumes++;
      return redirect.promise || Promise.resolve(redirect.err);
    },
    signInWithGoogle() {
      calls.popups++;
      // What the screen looks like while the popup is open.
      calls.htmlDuringPopup = el.innerHTML;
      return typeof outcome === "function" ? outcome() : Promise.resolve(outcome);
    },
  };
  view = new win.AuthView();
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
  // The handover happens when the popup OPENS, so a cancel is a return trip
  // now rather than a screen that never moved.
  ok("a shut popup puts the form back", calls.routes.join() === "splash,auth");
  ok("a shut popup says nothing", view._error === null);
  ok("a shut popup gives the button back", !googleDisabled(el.innerHTML));
}

{
  const err = Object.assign(new Error("nope"), { code: "auth/too-many-requests" });
  const { view, calls, el } = newAuth(() => Promise.reject(err));
  await view.oauth("google");
  ok("a real failure puts the form back", calls.routes.join() === "splash,auth");
  ok("a real failure is explained in our own words",
     view._error === "Too many attempts. Wait a minute, then try again.");
  ok("a real failure gives the button back", !googleDisabled(el.innerHTML));
}

{
  // THE REPORT: "when the google auth popup closes the app goes back to the
  // login screen instead of going to the animated buddy loading screen".
  // On Android the popup is a tab, so the app is visible again the moment it
  // closes — before the credential arrives. The form must already be gone.
  let release;
  const { view, calls } = newAuth(() => new Promise((r) => { release = r; }));
  const signIn = view.oauth("google");
  await Promise.resolve();
  ok("the loader is up while the popup is still open",
     calls.routes.join() === "splash");
  release("signed-in");
  await signIn;
  ok("...and stays up once the credential lands",
     calls.routes.join() === "splash");
}

{
  // And the popup must be opened in the tap's own task — a window.open one
  // task later is a blocked popup, i.e. every Google sign-in handed to the
  // redirect fallback.
  const { view, calls } = newAuth("signed-in");
  const signIn = view.oauth("google");
  ok("the popup is opened before anything is awaited", calls.popups === 1);
  await signIn;
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
  // The whole round trip with the lifecycle actually running, which is how
  // the app always calls this: mounted screen, handover, unmount, cancel,
  // navigate back, mount again. Every transient field is cleared twice in
  // there, so _backToForm has to re-apply AFTER the navigation, not before.
  const { view, fields } = newAuth("cancelled");
  await view.mount({});
  fields["auth-email"].value = "someone@example.com";
  await view.oauth("google");
  ok("a typed address survives a cancelled sign-in",
     view._email === "someone@example.com");
  ok("...and the screen comes back mounted", view._mounted === true);
  ok("...with its buttons live", view._oauthBusy === false);
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

// 6 ── A failed redirect sign-in is not silent ────────────────────────────────
console.log("\n6. the redirect fallback reports what happened to it");

/** The real domain/auth.js on its firebase backend, over a fake SDK. */
function newAuthLayer({ storageThrows = false, redirectResult = null } = {}) {
  const { win, sandbox, storage } = newWindow({ storageThrows });
  const calls = { getRedirect: 0, popups: 0, redirects: 0 };
  const fbAuth = {
    currentUser: null,
    signInWithPopup() {
      calls.popups++;
      // Every browser that reaches the fallback got here the same way.
      return Promise.reject(Object.assign(new Error("blocked"),
                                          { code: "auth/popup-blocked" }));
    },
    signInWithRedirect() { calls.redirects++; return Promise.resolve(); },
    getRedirectResult() {
      calls.getRedirect++;
      return typeof redirectResult === "function"
        ? redirectResult()
        : Promise.resolve(redirectResult);
    },
  };
  const auth = () => fbAuth;
  auth.GoogleAuthProvider = function GoogleAuthProvider() {};
  win.firebase = { initializeApp() {}, apps: [], auth };
  win.supabase = { createClient: () => ({}) };
  win.APP_CONFIG = {
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "anon",
    firebase: { apiKey: "k", authDomain: "auth.example.app", projectId: "p", appId: "a" },
  };
  vm.runInContext(fs.readFileSync(`${W}/domain/auth.js`, "utf8"), sandbox,
                  { filename: "domain/auth.js" });
  if (!win.BgbAuth.init()) throw new Error("harness: BgbAuth.init() refused");
  return { win, calls, storage };
}

{
  // THE REGRESSION THIS GUARDS: getRedirectResult touches the auth domain's
  // storage, which is what ITP blocks on a cross-origin authDomain. Asking it
  // after an ordinary popup sign-in could put a storage error on the screen of
  // someone who just signed in fine.
  const { win, calls } = newAuthLayer();
  ok("a tab that started no redirect answers null",
     (await win.BgbAuth.consumeRedirectResult()) === null);
  ok("...without asking the SDK at all", calls.getRedirect === 0);
}

{
  const err = Object.assign(new Error("nope"), { code: "auth/unauthorized-domain" });
  const { win, calls, storage } = newAuthLayer({ redirectResult: () => Promise.reject(err) });

  ok("a blocked popup falls back to redirect",
     (await win.BgbAuth.signInWithGoogle()) === "redirecting");
  ok("...having actually redirected", calls.redirects === 1);
  ok("...and marked the tab", storage.getItem("bgb.auth.redirectPending") === "1");

  // This is the report that did not exist: the document was replaced, so the
  // rejection had no caller left to tell.
  ok("the failure comes back to be worded",
     (await win.BgbAuth.consumeRedirectResult()) === err);
  ok("...the marker is spent", storage.getItem("bgb.auth.redirectPending") === null);
  ok("...and a second ask is free", (await win.BgbAuth.consumeRedirectResult()) === null
                                   && calls.getRedirect === 1);
}

{
  const { win } = newAuthLayer({ redirectResult: { user: { uid: "u1" } } });
  await win.BgbAuth.signInWithGoogle();
  ok("a redirect that WORKED reports no error",
     (await win.BgbAuth.consumeRedirectResult()) === null);
}

{
  // Safari private mode. Unmarkable, so unconsumable — back to the old
  // silence, which is worse than a message and better than a broken sign-in.
  const { win, calls } = newAuthLayer({ storageThrows: true, redirectResult: () => Promise.reject(new Error("x")) });
  ok("storage being unavailable does not break the redirect",
     (await win.BgbAuth.signInWithGoogle()) === "redirecting");
  ok("...and never reaches the SDK on the way back",
     (await win.BgbAuth.consumeRedirectResult()) === null && calls.getRedirect === 0);
}

// And the screen end of it: the sign-in screen is where the answer is shown.
const settle = () => new Promise((r) => setTimeout(r, 0));

{
  const err = Object.assign(new Error("raw firebase noise"),
                            { code: "auth/unauthorized-domain" });
  const { view, calls } = newAuth("signed-in", { err });
  await view.mount({});
  await settle();
  ok("mounting asks once whether a redirect failed", calls.consumes === 1);
  ok("a failed redirect is explained in our own words",
     view._error === "Sign-in is not enabled for this address yet.");
}

{
  const { view } = newAuth("signed-in", { err: null });
  await view.mount({});
  await settle();
  ok("a clean mount says nothing", view._error === null);
}

{
  // The answer can arrive after the user has given up and navigated away.
  let land;
  const { view } = newAuth("signed-in",
    { promise: new Promise((r) => { land = r; }) });
  await view.mount({});
  await view.unmount();
  land(Object.assign(new Error("late"), { code: "auth/too-many-requests" }));
  await settle();
  ok("a late answer does not repaint a screen they left", view._error === null);
}

// 7 ── The session boundary is a property of the SHELL, not of a navigation ──
console.log("\n7. the app chrome and the back stack cross the boundary");

/**
 * The real Router over a fake shell, a fake history and the REAL store.
 *
 * The store is the real one on purpose: what is under test is that the chrome
 * follows `user`, and a fake store's notification behaviour is the thing that
 * would make the test pass while the app stayed broken.
 */
function newRouter({ path = "/" } = {}) {
  const el = (dataset = {}) => {
    const classes = new Set();
    return {
      dataset,
      attrs: {},
      classList: {
        toggle(c, on) {
          if (on === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
          else if (on) classes.add(c);
          else classes.delete(c);
        },
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      get isHidden() { return classes.has("hidden"); },
    };
  };
  // The two [data-auth-only] nodes from index.html: the global header and the
  // bottom nav. Everything this section calls "the chrome" is these.
  const chrome = [el(), el()];
  const listeners = new Map();
  const win = {
    location: { pathname: path.split("?")[0], search: path.includes("?") ? "?" + path.split("?")[1] : "" },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    scrollTo() {},
    BgbIcons: { render() {} },
  };
  const fire = async (type, ev) => {
    for (const fn of listeners.get(type) || []) await fn(ev);
  };
  // A history that actually walks: entries, an index, and a popstate on back.
  const entries = [{ state: null, url: path }];
  let idx = 0;
  const apply = (url) => {
    const [p, q] = String(url).split("?");
    win.location.pathname = p;
    win.location.search = q ? "?" + q : "";
  };
  const history = {
    get urls() { return entries.map((e) => e.url); },
    get length() { return entries.length; },
    pushState(state, _t, url) {
      entries.splice(idx + 1);
      entries.push({ state, url });
      idx = entries.length - 1;
      apply(url);
    },
    replaceState(state, _t, url) { entries[idx] = { state, url }; apply(url); },
    async back() {
      if (idx === 0) return;
      idx--;
      apply(entries[idx].url);
      await fire("popstate", { state: entries[idx].state });
    },
  };
  const sandbox = {
    window: win, console, Date, Promise, Map, Set, URLSearchParams,
    setTimeout, clearTimeout, history,
    document: {
      addEventListener() {}, removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === "[data-auth-only]" ? chrome : []),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(`${W}/domain/store.js`, "utf8"), sandbox,
                  { filename: "domain/store.js" });
  vm.runInContext(fs.readFileSync(`${W}/domain/view.js`, "utf8"), sandbox,
                  { filename: "domain/view.js" });
  const router = win.router;
  for (const name of ["splash", "auth", "feed", "settings", "privacy"]) {
    router.register(name, {
      name,
      async mount() {}, async unmount() {},
      refreshIcons() {},
    });
  }
  return { win, router, store: win.store, history, chrome };
}

const chromeShown = (chrome) => chrome.every((n) => !n.isHidden);
const chromeHidden = (chrome) => chrome.every((n) => n.isHidden);

{
  // THE REPORT: "then to feed but with bottom bar missing … i was able to do
  // the back gesture and it returned me to the initial login screen but with
  // a functional bottom nav bar and header."
  //
  // Both halves are one fact: the chrome was only ever computed inside go(),
  // and init.js routes a valid session forward even when /bootstrap has not
  // answered yet. So the feed painted with no nav, and the next navigation —
  // the back press — was what finally turned it on.
  const { router, store, chrome } = newRouter();
  await router.go("splash", {}, { skipPush: true });
  ok("the splash shows no chrome", chromeHidden(chrome));

  await router.go("feed");
  ok("a feed reached before the profile landed shows no chrome yet",
     chromeHidden(chrome));

  store.set("user", { id: "u1" });
  ok("the profile landing turns the chrome on, with no navigation at all",
     chromeShown(chrome));

  await router.go("settings");
  ok("and it stays on across navigation", chromeShown(chrome));

  await router.go("auth");
  ok("the sign-in screen shows no chrome even with a user in the store",
     chromeHidden(chrome));

  await router.go("feed");
  ok("coming back off it restores the chrome", chromeShown(chrome));

  store.reset();
  ok("a sign-out takes the chrome with it", chromeHidden(chrome));
}

{
  // THE OTHER HALF OF THE REPORT: "when i'm logged in, i should not be able
  // to back into the login screen."
  const { router, store, history } = newRouter();
  await router.go("splash", {}, { skipPush: true });
  await router.go("auth");
  ok("the login screen has its own entry while it is the screen",
     history.urls.join() === "/,/auth");

  // Signing in: the form hands over to the splash (no URL of its own), and
  // the profile lands us on the feed. The /auth entry must be SPENT, not
  // buried — it is still the entry being stood on when the feed arrives.
  await router.go("splash");
  store.set("user", { id: "u1" });
  await router.go("feed");
  ok("signing in spends the login screen's entry",
     history.urls.join() === "/,/feed");
  ok("...and never puts it on the back stack",
     router.peekBack("feed") !== "auth");
}

{
  // Reading the privacy policy from the login screen is not signing in, so
  // that entry stays where it is — the document's × has to have somewhere to
  // go back to, and a signed-out stranger has to be able to read it.
  const { router, history } = newRouter();
  await router.go("splash", {}, { skipPush: true });
  await router.go("auth");
  await router.go("privacy");
  ok("walking off to the legal pages keeps the login screen underneath",
     history.urls.join() === "/,/auth,/privacy");
  await history.back();
  ok("...so back returns to it", router._current.name === "auth");
}

{
  // And once signed in, walking back down the stack never reaches it — this
  // is the reported gesture: one press from the first screen after sign-in.
  const { router, store, history } = newRouter();
  await router.go("splash", {}, { skipPush: true });
  await router.go("auth");
  await router.go("splash");
  store.set("user", { id: "u1" });
  await router.go("feed");
  await router.go("settings");

  await history.back();
  ok("back from a spoke lands on the screen under it",
     router._current.name === "feed");
  await history.back();
  ok("and back again cannot reach the login screen",
     router._current.name !== "auth");
}

{
  // The belt to that brace: entries pushState cannot reach. A mid-session
  // sign-out pushes /auth on top of the previous account's screens, and those
  // screens are still down there with a store that has been reset.
  const { router, store, history } = newRouter();
  await router.go("splash", {}, { skipPush: true });
  store.set("user", { id: "u1" });
  await router.go("feed");
  await router.go("settings");
  store.reset();                 // what handleLogout does
  await router.go("auth");
  ok("a sign-out leaves the login screen on top",
     history.urls.join() === "/,/feed,/settings,/auth");

  await history.back();
  ok("a back press cannot walk into the signed-out app",
     router._current.name === "auth");
  ok("...and the entry it refused is replaced, not stacked",
     history.urls[history.urls.length - 1] === "/auth");
}

{
  // The gate itself, both directions and the one case it must keep its hands
  // off: mid-boot, where `user` is null only because the session is still
  // being restored.
  const { router, store } = newRouter();
  await router.go("splash", {}, { skipPush: true });
  ok("mid-boot it honours whatever was popped",
     router._gateBack({ name: "feed", params: {} }).name === "feed");

  store.set("user", { id: "u1" });
  await router.go("feed");
  ok("signed in, the login screen is not a destination",
     router._gateBack({ name: "auth", params: {} }).name === "feed");
  ok("signed in, anything else is honoured",
     router._gateBack({ name: "settings", params: {} }).name === "settings");

  store.reset();
  await router.go("auth");
  ok("signed out, an app screen is not a destination",
     router._gateBack({ name: "settings", params: {} }).name === "auth");
  ok("signed out, the legal pages still resolve",
     router._gateBack({ name: "privacy", params: {} }).name === "privacy");
}

console.log(fails ? `\n${fails} FAILED\n` : "\nAll checks passed.\n");
process.exit(fails ? 1 : 0);
