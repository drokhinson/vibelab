#!/usr/bin/env node
// check-offline-recovery.mjs — assert the app can always get back OUT of
// offline mode.
//
//     node projects/boardgame-buddy/tools/check-offline-recovery.mjs
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the real domain/api.js and
// domain/net.js into a VM context against a fake fetch and a virtual clock, and
// checks the half of connectivity detection that has no user-visible symptom
// until it is catastrophic: LEAVING the latch.
//
// Entering is easy to see and easy to test by hand — two failed requests and the
// app knows. Leaving is a set of timers and a single-flight promise that nobody
// looks at, and when it breaks the app doesn't crash: it simply insists you are
// offline, on full bars, until you force-quit it.
//
// Written after exactly that, from a session whose logs are the reason the file
// looks the way it does. The app latched offline with a working connection; from
// that moment the server logged NOT ONE /health probe, while the analytics pings
// (fire-and-forget, so they bypass api._fetch and never see the latch) kept
// arriving 200 for another sixteen minutes. Both halves of recovery hung off one
// promise — probe() is single-flight, and the ladder armed its next rung when
// the previous probe settled — so a single fetch that never settled ended
// recovery for the life of the page. Scenario 3 is that bug.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const W = path.join(import.meta.dirname, "..", "web");
const API_BASE = "https://api.test";
const HEALTH = `${API_BASE}/api/v1/boardgame_buddy/health`;

let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};

// ── A virtual clock ──────────────────────────────────────────────────────────
// Real timers would make this a 5-minute test of a 5-second ladder, and the
// point of several scenarios is what happens 35 and 120 seconds in.
function boot() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  const setTimeoutV = (fn, ms) => {
    const id = ++seq;
    timers.set(id, { at: now + (ms || 0), fn });
    return id;
  };
  const clearTimeoutV = (id) => { timers.delete(id); };
  const drain = () => new Promise((r) => setImmediate(r));
  /** Advance the clock, firing due timers in order and draining microtasks. */
  async function tick(ms) {
    const end = now + ms;
    for (;;) {
      let pick = null;
      for (const [id, t] of timers) {
        if (t.at > end) continue;
        if (!pick || t.at < pick.t.at || (t.at === pick.t.at && id < pick.id)) pick = { id, t };
      }
      if (!pick) break;
      now = Math.max(now, pick.t.at);
      timers.delete(pick.id);
      pick.t.fn();
      await drain();
    }
    now = end;
    await drain();
  }

  class FakeDate extends Date { static now() { return now; } }

  // ── The fake network ───────────────────────────────────────────────────────
  // "ok"     — answers 200.
  // "fail"   — a dead network: fetch rejects with the bare TypeError browsers
  //            give, which is what BgbNet counts a strike for.
  // "stall"  — never answers, but DOES reject when its deadline aborts it.
  // "wedge"  — never settles at all, abort or no abort. The failure mode the
  //            whole of recovery has to survive: a socket the OS dropped, a
  //            connection pool full of them, a page thawing out of suspension.
  const requests = [];
  let behaviour = () => "ok";
  const response = () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "application/json" },
    json: async () => ({ project: "boardgame-buddy", status: "ok" }),
    text: async () => "{}",
  });
  const fetchV = (url, init) => {
    const kind = behaviour(String(url));
    requests.push({ url: String(url), method: (init && init.method) || "GET", at: now, kind });
    if (kind === "ok") return Promise.resolve(response());
    if (kind === "fail") return Promise.reject(new TypeError("Failed to fetch"));
    if (kind === "wedge") return new Promise(() => {});
    return new Promise((_resolve, reject) => {
      const sig = init && init.signal;
      if (!sig) return;
      const onAbort = () => {
        const e = new Error("The operation was aborted.");
        e.name = "AbortError";
        reject(e);
      };
      if (sig.aborted) onAbort();
      else sig.addEventListener("abort", onAbort, { once: true });
    });
  };

  const listeners = new Map();
  const addTo = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };
  const docListeners = new Map();
  const slots = {};
  const win = {
    APP_CONFIG: { apiBase: API_BASE },
    addEventListener: addTo(listeners),
    store: { set(k, v) { slots[k] = v; }, get(k) { return slots[k]; } },
    Outbox: { flushes: 0, flush() { this.flushes++; } },
  };
  const doc = { visibilityState: "visible", addEventListener: addTo(docListeners) };
  const nav = { onLine: true };
  const sandbox = {
    window: win,
    document: doc,
    navigator: nav,
    localStorage: { removeItem() {}, getItem: () => null, setItem() {} },
    setTimeout: setTimeoutV,
    clearTimeout: clearTimeoutV,
    fetch: fetchV,
    AbortController,
    URL,
    Date: FakeDate,
    console,
    Promise,
  };
  vm.createContext(sandbox);
  for (const f of ["domain/api.js", "domain/net.js"]) {
    vm.runInContext(fs.readFileSync(path.join(W, f), "utf8"), sandbox, { filename: f });
  }
  win.BgbNet.start();

  const fire = (type, map = listeners) => { for (const fn of map.get(type) || []) fn(); };
  return {
    win, doc, nav, slots, requests, tick,
    setBehaviour: (fn) => { behaviour = fn; },
    fireWindow: (type) => fire(type),
    fireDoc: (type) => fire(type, docListeners),
    healthCount: () => requests.filter((r) => r.url === HEALTH).length,
    now: () => now,
  };
}

/** Two strikes, spaced past FAILURE_BURST_MS so they count as two. */
async function latch(h) {
  h.setBehaviour(() => "fail");
  await h.win.api.get("/feed").catch(() => {});
  await h.tick(2000);
  await h.win.api.get("/feed").catch(() => {});
  await h.tick(0);
}

console.log("\n1. two spaced network failures latch the app offline");
{
  const h = boot();
  ok("starts online", h.win.BgbNet.isOffline() === false && h.slots.offline === false);
  h.setBehaviour(() => "fail");
  await h.win.api.get("/feed").catch(() => {});
  await h.tick(0);
  ok("one failure is not enough", h.win.BgbNet.isOffline() === false);
  await h.tick(2000);
  await h.win.api.get("/feed").catch(() => {});
  await h.tick(0);
  ok("two are", h.win.BgbNet.isOffline() === true);
  ok("and the store slot says so", h.slots.offline === true);
}

console.log("\n2. the ladder probes /health on its own and clears the latch");
{
  const h = boot();
  await latch(h);
  h.setBehaviour(() => "ok");
  ok("no probe before the first rung", h.healthCount() === 0);
  await h.tick(5000);
  ok("the first rung probed /health", h.healthCount() === 1);
  ok("back online with no user action", h.win.BgbNet.isOffline() === false);
  ok("the slot followed", h.slots.offline === false);
  ok("and the outbox was flushed on the edge", h.win.Outbox.flushes === 1);
}

console.log("\n3. a probe that NEVER SETTLES does not end recovery (the field bug)");
{
  const h = boot();
  await latch(h);
  h.setBehaviour((url) => (url === HEALTH ? "wedge" : "fail"));
  await h.tick(5000);
  ok("the first rung asked", h.healthCount() === 1);
  // Nothing about that request will ever come back. Under the chained ladder
  // this is where the app stopped asking, permanently.
  await h.tick(120000);
  ok("the ladder kept asking anyway", h.healthCount() > 1);
  const wedged = h.healthCount();
  h.setBehaviour(() => "ok");
  await h.tick(120000);
  ok("a fresh request went out once the slot came back", h.healthCount() > wedged);
  ok("and the app recovered", h.win.BgbNet.isOffline() === false);
  ok("the slot followed", h.slots.offline === false);
}

console.log("\n4. a blocked request is the user's retry tap, and is throttled");
{
  const h = boot();
  await latch(h);
  // A probe that answers "still dead" rather than one that wedges, so the slot
  // is free each time and what is being measured is the throttle alone.
  h.setBehaviour(() => "fail");
  const blocked = await h.win.api.get("/feed").then(() => null, (e) => e);
  await h.tick(0);
  ok("the request failed instantly, offline-shaped", blocked.offline === true && blocked.status === 0);
  ok("it never reached the network", h.requests.filter((r) => r.url.endsWith("/feed")).length === 2);
  ok("and it kicked a probe", h.healthCount() === 1);
  await h.win.api.get("/feed").catch(() => {});
  await h.tick(0);
  ok("a second tap in the same second does not", h.healthCount() === 1);
  // The ladder's own first rung is ATTEMPT_PROBE_MIN_MS away too, so step past
  // it and count from there rather than racing it.
  await h.tick(5000);
  const afterRung = h.healthCount();
  ok("the rung asked on its own", afterRung === 2);
  await h.tick(1);
  await h.win.api.get("/feed").catch(() => {});
  await h.tick(0);
  ok("a tap past the throttle asks again", h.healthCount() === afterRung + 1);
  ok("still offline, since every probe was refused", h.win.BgbNet.isOffline() === true);
}

console.log("\n5. navigator.onLine flipping with NO event still arms recovery");
{
  const h = boot();
  h.setBehaviour((url) => (url === HEALTH ? "wedge" : "ok"));
  // iOS moves this across a network change without always firing the event, so
  // the answer changes with nothing calling _publish().
  h.nav.onLine = false;
  ok("isOffline() moved", h.win.BgbNet.isOffline() === true);
  h.fireWindow("focus");
  await h.tick(0);
  ok("a resume republished the slot", h.slots.offline === true);
  ok("and probed", h.healthCount() === 1);
  h.nav.onLine = true;                 // again with no event
  await h.tick(65000);
  ok("the ladder noticed and stood down", h.win.BgbNet.isOffline() === false);
  ok("republishing as it went", h.slots.offline === false);
}

console.log("\n6. an abandoned probe records nothing (it proves nothing)");
{
  const h = boot();
  h.setBehaviour((url) => (url === HEALTH ? "wedge" : "ok"));
  h.nav.onLine = false;
  h.fireWindow("focus");
  await h.tick(40000);                  // past PROBE_DEADLINE_MS
  h.nav.onLine = true;
  ok("no strikes from the abandoned probes", h.win.BgbNet.isOffline() === false);
}

console.log("\n7. the page going away stops the ladder, coming back restarts it");
{
  const h = boot();
  await latch(h);
  h.setBehaviour(() => "ok");
  h.doc.visibilityState = "hidden";
  h.fireDoc("visibilitychange");
  await h.tick(120000);
  ok("a pocketed phone probes nothing", h.healthCount() === 0);
  h.doc.visibilityState = "visible";
  h.fireDoc("visibilitychange");
  await h.tick(0);
  ok("a resume probes at once", h.healthCount() === 1);
  ok("and recovers", h.win.BgbNet.isOffline() === false);
}

console.log("\n8. a network switch clears the latch outright — the user's workaround");
{
  const h = boot();
  await latch(h);
  h.setBehaviour((url) => (url === HEALTH ? "wedge" : "fail"));
  await h.tick(5000);
  ok("the ladder's probe is out and will never answer", h.healthCount() === 1);
  // Dropping Wi-Fi for mobile data was the one thing that got the app back
  // without a force-quit, and this is why: the `online` handler zeroes the
  // strikes rather than asking anything, so it clears a latch that the wedged
  // probe could not. Reported as "sometimes" — which is the other half of the
  // story, since iOS does not reliably fire the pair at all (scenario 5 is that
  // case: the same switch with no events, which used to recover from nothing).
  h.nav.onLine = false;
  h.fireWindow("offline");
  await h.tick(0);
  ok("the interface going down is published", h.slots.offline === true);
  h.nav.onLine = true;
  h.fireWindow("online");
  await h.tick(0);
  ok("coming back up clears the strikes", h.win.BgbNet.isOffline() === false);
  ok("without waiting on a probe", h.healthCount() === 1);
  ok("and drains the outbox on the edge", h.win.Outbox.flushes === 1);
}

console.log(fails ? `\n${fails} FAILED\n` : "\nAll offline-recovery contracts hold.\n");
process.exit(fails ? 1 : 0);
