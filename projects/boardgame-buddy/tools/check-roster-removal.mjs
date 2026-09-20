#!/usr/bin/env node
// check-roster-removal.mjs — assert a seat the host removed stays removed.
//
//     node projects/boardgame-buddy/tools/check-roster-removal.mjs
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the real modules into a VM
// context and drives the Gather roster the way the reports do.
//
// THE REPORT: a table of four — the host and three ghosts — where the host took
// one ghost off and added a real account in its place. The scoring grid showed
// four columns. The play saved FIVE seats, and Full Table ("5 or more players
// at the table", metric `biggest_table` in bgb_sync_achievements) unlocked on a
// four-person game.
//
// Nothing server-side invented the fifth seat: bgb_log_play writes exactly the
// roster the payload hands it, and the payload is `_ps.players`. The extra seat
// was put back on the draft by the Gather poll, which reads the lobby every two
// seconds and seats every participant it does not recognise. Three ways that
// happens, all of them covered below:
//
//   1. A tick whose fetch was ALREADY IN FLIGHT when the host tapped remove.
//      _pendingDeletes was read before the fetch and never again, so the tick
//      merged a bundle that predated the removal.
//   2. A ghost removed before POST /participants answered: there was no
//      participant_id to DELETE, so nothing ever deleted the row, and the next
//      tick seated it.
//   3. A DELETE that simply failed. _withLobby swallows everything that is not
//      a definitive 404/410, so the row survives and so did the resurrection.
//
// The resurrected seat lands at the END of the roster — the rightmost column of
// a scoring grid on a phone, off the edge of the screen — which is why the host
// could look at the grid all evening and count four.
//
// What must KEEP working, and is checked here too: the swap itself. Taking the
// ghost "Dave" off and putting Dave's account on is the sequence that produced
// the report, and a fix that refused the account's lobby row would be the same
// bug with the sign flipped.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const WEB = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "web");

let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const eq = (name, got, want) => {
  if (same(got, want)) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}\n         got: ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`); }
};

const ME = { id: "u-me", display_name: "Host", avatar: null };

// ── The smallest shell the two modules need ──────────────────────────────────
//
// view.js reaches for document.querySelector (its `container` getter) and
// play-flow-view.js reaches for window.store; both are answered with the least
// that keeps the real code on its real path. render() and refreshIcons() are
// stubbed per instance below — painting the cascade would pull in every widget
// in the app and none of it is what this file is about.
function boot() {
  const store = new Map([["user", ME]]);
  const el = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
  const win = {
    store: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), subscribe: () => () => {} },
    Geo: { countryForPlay: () => null },
    // view.js constructs the Router at load time, which wires popstate and
    // reads the URL. Neither matters here; both have to exist.
    addEventListener: () => {},
    location: { hash: "", pathname: "/", search: "" },
    history: { pushState: () => {}, replaceState: () => {}, state: null },
  };
  const sandbox = {
    window: win, console, Date, Number, Math, Map, Set, String, Array, Object, JSON,
    Promise, URL, setTimeout, clearTimeout,
    document: { hidden: false, querySelector: () => el, querySelectorAll: () => [] },
    localStorage: (() => {
      const mem = new Map();
      return {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: (k) => mem.delete(k),
      };
    })(),
  };
  vm.createContext(sandbox);
  // The grid widget comes along because _removePlayer re-derives the winners
  // through it (_autoSelectWinners → _playerTotal), and a stub would be a
  // second opinion about what a column adds up to.
  for (const f of ["helpers.js", "widgets/round-score-grid.js", "domain/view.js",
                   "domain/play-session.js", "views/play-flow-view.js"]) {
    vm.runInContext(fs.readFileSync(path.join(WEB, f), "utf8"), sandbox, { filename: f });
  }
  return win;
}

// One host flow mid-Gather, with a lobby whose roster matches the draft.
// `calls` records every /sessions write the view makes, so a DELETE that never
// went out is as visible as one that did.
function table(win, { ghosts = ["Amy", "Ben", "Cal"] } = {}) {
  const calls = { added: [], removed: [] };
  let nextId = 0;
  const pid = () => `part-${++nextId}`;

  const view = new win.PlayFlowView();
  view.render = () => {};
  view.refreshIcons = () => {};
  view._ps = new win.PlaySession({ gameId: "g1", phase: "gather", code: "ABCDE" });
  view._offline = false;

  const participants = [{ id: pid(), user_id: ME.id, display_name: ME.display_name }];
  view._ps.players.push({
    name: ME.display_name, user_id: ME.id, avatar: null, is_winner: false, score: null,
    participant_id: participants[0].id, roundScores: [],
  });
  for (const g of ghosts) {
    const row = { id: pid(), user_id: null, display_name: g };
    participants.push(row);
    view._ps.players.push({
      name: g, user_id: null, avatar: null, is_winner: false, score: null,
      participant_id: row.id, roundScores: [],
    });
  }
  view._lobby = { code: "ABCDE", phase: "gather", participants: participants.slice() };

  // The lobby, as the server would hold it. `fetchLobby` answers from here, so
  // a bundle handed to a tick can be made stale on purpose by resolving it late.
  const server = {
    participants: participants.slice(),
    bundle() { return { code: "ABCDE", phase: "gather", participants: this.participants.slice() }; },
  };
  win.PlaySession.fetchLobby = async () => server.bundle();
  win.PlaySession.addParticipant = async (code, { userId, displayName }) => {
    const row = { id: pid(), user_id: userId || null, display_name: displayName };
    server.participants.push(row);
    calls.added.push(row);
    return server.bundle();
  };
  win.PlaySession.removeParticipant = async (code, id) => {
    calls.removed.push(id);
    server.participants = server.participants.filter((p) => p.id !== id);
    return server.bundle();
  };
  // Mirrors the real _withLobby's contract for everything that is not a
  // definitive 404/410: the write's result, or null when it failed.
  view._withLobby = async (fn) => { try { return await fn("ABCDE"); } catch (_) { return null; } };

  const names = () => view._ps.players.map((p) => p.name);
  return { view, server, calls, names, seatOf: (n) => view._ps.players.find((p) => p.name === n) };
}

const tick = (view) => view._lobbyPollTick();
const settle = () => new Promise((r) => setTimeout(r, 0));

console.log("\na removed ghost does not come back:");
{
  const win = boot();
  const { view, server, calls, names } = table(win);
  const cal = view._ps.players[3];

  // The tick that was already in flight when the tap landed, and the bundle it
  // is holding: a SNAPSHOT of the lobby as the server answered it, before the
  // removal. This is the case _pendingDeletes cannot cover — by the time the
  // fetch resolves the DELETE has been and gone and the counter is back to
  // zero, while the bundle in hand still lists four ghosts.
  let release;
  win.PlaySession.fetchLobby = () => {
    const snapshot = server.bundle();
    return new Promise((r) => { release = () => r(snapshot); });
  };
  const inflight = tick(view);
  await settle();

  view._removePlayer(3);
  eq("the tap takes the seat off the draft", names(), ["Host", "Amy", "Ben"]);
  eq("and asks the server to drop its row", calls.removed, [cal.participant_id]);

  release();
  await inflight;
  eq("the stale bundle does not seat it again", names(), ["Host", "Amy", "Ben"]);

  // And the tick AFTER the delete has settled, with the row genuinely gone.
  win.PlaySession.fetchLobby = async () => server.bundle();
  await tick(view);
  eq("nor does the next tick", names(), ["Host", "Amy", "Ben"]);
}

console.log("\na DELETE that failed does not un-remove the seat:");
{
  const win = boot();
  const { view, server, calls, names } = table(win);
  win.PlaySession.removeParticipant = async (code, id) => {
    calls.removed.push(id);              // asked for, and refused
    throw new Error("502");
  };

  view._removePlayer(3);          // Cal
  await settle();
  ok("the row is still on the lobby", server.participants.some((p) => p.display_name === "Cal"));

  eq("the removal asked once and was refused", calls.removed.length, 1);

  await tick(view);
  eq("the poll leaves the roster alone", names(), ["Host", "Amy", "Ben"]);
  eq("and re-asks for the stale row", calls.removed.length, 2);

  await tick(view);
  eq("but only once — a refusal is not retried every tick", calls.removed.length, 2);
}

console.log("\na ghost removed before its POST answered is cleaned up:");
{
  const win = boot();
  const { view, calls, names, seatOf } = table(win, { ghosts: ["Amy", "Ben"] });

  // The host types a ghost and takes it straight back off — inside the round
  // trip, so _removePlayer has no participant_id to name.
  let release;
  const real = win.PlaySession.addParticipant;
  win.PlaySession.addParticipant = (code, body) =>
    new Promise((r) => { release = () => r(real(code, body)); });

  view._addPlayer({ name: "Cal", user_id: null, avatar: null });
  eq("seated optimistically", names(), ["Host", "Amy", "Ben", "Cal"]);
  ok("with no participant_id yet", !seatOf("Cal").participant_id);

  view._removePlayer(3);
  eq("removed again", names(), ["Host", "Amy", "Ben"]);
  eq("nothing to delete yet", calls.removed, []);

  release();
  await settle();
  await settle();
  eq("the row the POST created is deleted", calls.removed, [calls.added[0].id]);

  win.PlaySession.addParticipant = real;
  await tick(view);
  eq("and the poll never seats it", names(), ["Host", "Amy", "Ben"]);
}

console.log("\nthe swap in the report still works:");
{
  const win = boot();
  const { view, calls, names, seatOf } = table(win);

  view._removePlayer(3);                                   // the ghost "Cal"
  view._addPlayer({ name: "Cal", user_id: "u-cal", avatar: null });   // Cal's account
  await settle();
  eq("the account takes the seat", names(), ["Host", "Amy", "Ben", "Cal"]);

  await tick(view);
  eq("the roster is four, not five", view._ps.players.length, 4);
  eq("and the account's lobby row is adopted, not refused",
     seatOf("Cal").participant_id, calls.added[0].id);
  ok("the account seat carries its user_id", seatOf("Cal").user_id === "u-cal");

  // The payload is what bgb_log_play writes, and `biggest_table` counts those
  // rows. Four seats in, four seats stored, Full Table stays locked.
  eq("the saved play has four seats", view._ps.toPlayCreate().players.length, 4);
}

console.log("\nre-typing a removed ghost seats it again:");
{
  const win = boot();
  const { view, names, seatOf, calls } = table(win);

  view._removePlayer(3);
  await settle();
  view._addPlayer({ name: "Cal", user_id: null, avatar: null });
  await settle();
  eq("back on the roster", names(), ["Host", "Amy", "Ben", "Cal"]);
  eq("with the new lobby row adopted", seatOf("Cal").participant_id, calls.added[0].id);
  await tick(view);
  eq("and no duplicate column", view._ps.players.length, 4);
}

console.log("\nthe removal survives a refresh:");
{
  const win = boot();
  const { view, server, names } = table(win);
  view._removePlayer(3);
  await settle();

  // A reload builds a fresh draft off the persisted snapshot, and re-reads the
  // same lobby. If the DELETE had failed before the reload, this is the only
  // thing standing between the host and a fifth seat.
  server.participants.push({ id: "part-zombie", user_id: null, display_name: "Cal" });
  const reloaded = win.PlaySession.load();
  ok("the tombstone was persisted", reloaded.removedSeats.length === 1);
  ok("and still refuses the row",
     reloaded.isRemovedParticipant({ id: "part-zombie", user_id: null, display_name: "Cal" }));

  view._ps = reloaded;
  await tick(view);
  eq("so the poll seats nobody", names(), ["Host", "Amy", "Ben"]);
}

console.log(fails === 0 ? "\nAll roster-removal checks passed.\n"
                        : `\n${fails} roster-removal check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
