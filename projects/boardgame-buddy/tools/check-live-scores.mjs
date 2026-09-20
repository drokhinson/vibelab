#!/usr/bin/env node
// check-live-scores.mjs — assert the live-score channel's failure behaviour.
//
//     node projects/boardgame-buddy/tools/check-live-scores.mjs
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the real domain modules
// into a VM context against a fake Supabase client and checks the three
// things that are invisible when they break:
//
//   1. `lastEventAt()` moves ONLY when the Realtime channel delivers a row —
//      never on a backfill or a poll-driven refresh. session-viewer-view
//      stands its poll down on this value, so a self-stamp means the poll
//      vouching for the channel it exists to cover for.
//   2. `isRealtimeDead()` follows the subscribe status. Nothing read that
//      status before, so a channel that never connected looked exactly like
//      one that was connected and quiet.
//   3. `onWriteDenied` fires once per session for a PERMANENT refusal (an RLS
//      42501, a rejected JWT) and never for a transient one (a timeout).
//   4. `canWrite` gates the SEND, not just the report: in a phase the scores
//      table will not accept a write in, nothing leaves the module and nothing
//      is reported. The write policy takes the host only while the session row
//      reads phase='play', and the host's phase is a local flip a background
//      PATCH catches up to — so Gather, Settle and the round trip between them
//      are windows where a perfectly healthy session refuses writes.
//   5. `syncGrid` publishes the host's WHOLE grid, which includes pruning the
//      rounds the host no longer has — a removeRoundAt whose DELETE never went
//      out otherwise leaves spectators a phantom trailing round.
//
// Written after a live session where the host's writes were refused with
// `42501 new row violates row-level security policy` on every keystroke and
// NOTHING said so: the host's own grid painted from the local intent map, and
// every spectator watched a grid that never filled in. The 42501 case below
// is that exact error.
import fs from "node:fs";
import vm from "node:vm";

const W = "/home/user/vibelab/projects/boardgame-buddy/web";
const win = {};
const sandbox = { window: win, console, AbortSignal, Date, Number, Math, Map, Set, Promise, Array };
// The one helper live-scores.js borrows from the grid widget, which is a DOM
// module and not loadable here. Same body as round-score-grid.js.
win.parseRoundScore = (v) => {
  if (v == null || v === "" || v === "-") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
vm.createContext(sandbox);
for (const f of ["domain/score-write-queue.js", "domain/live-scores.js"]) {
  vm.runInContext(fs.readFileSync(`${W}/${f}`, "utf8"), sandbox, { filename: f });
}

let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};

function fakeClient({ selectRows = [], selectError = null, upsertError = null } = {}) {
  // upserts / deletes: every write this client was ASKED to make. A gate that
  // only silenced the toast would still fill these.
  const captured = { upserts: [], deletes: [] };
  const thenable = (value) => ({ then: (f) => Promise.resolve(value).then(f) });
  return {
    captured,
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        abortSignal() { return thenable({ data: selectRows, error: selectError }); },
        upsert(rows) {
          captured.upserts.push(rows);
          return { abortSignal: () => thenable({ data: null, error: upsertError }) };
        },
        delete() {
          const filters = {};
          const chain = {
            eq(col, val) { filters[col] = val; return chain; },
            gte(col, val) { filters[`${col}>=`] = val; return chain; },
            abortSignal() {
              captured.deletes.push(filters);
              return thenable({ data: null, error: null });
            },
          };
          return chain;
        },
      };
    },
    channel() {
      const ch = {
        on(_evt, _cfg, cb) { captured.onChange = cb; return ch; },
        subscribe(cb) { captured.onStatus = cb; return ch; },
      };
      return ch;
    },
    removeChannel() { return Promise.resolve(); },
  };
}

console.log("\n1. lastEventAt() moves only on a real channel delivery");
{
  const client = fakeClient({ selectRows: [] });
  win.supabaseClient = client;
  const ls = new win.LiveScores({ sessionId: "s1", isHost: false });
  let emits = 0;
  ls.subscribe(() => emits++);
  await ls.start();                                  // backfill + its two emits
  ok("emits fired during start", emits > 0);
  ok("lastEventAt still 0 after backfill emits", ls.lastEventAt() === 0);
  await ls.refresh();                                // a poll-style re-read
  ok("lastEventAt still 0 after a poll refresh", ls.lastEventAt() === 0);
  client.captured.onChange({ eventType: "INSERT",
    new: { participant_id: "p1", round_index: 0, score: 7 } });
  ok("lastEventAt set by a postgres_changes payload", ls.lastEventAt() > 0);
}

console.log("\n2. isRealtimeDead() reflects the subscribe status");
{
  const client = fakeClient();
  win.supabaseClient = client;
  const ls = new win.LiveScores({ sessionId: "s2", isHost: false });
  await ls.start();
  ok("healthy by default", ls.isRealtimeDead() === false);
  client.captured.onStatus("CHANNEL_ERROR");
  ok("dead after CHANNEL_ERROR", ls.isRealtimeDead() === true);
  client.captured.onStatus("SUBSCRIBED");
  ok("recovers on SUBSCRIBED", ls.isRealtimeDead() === false);
  client.captured.onStatus("TIMED_OUT");
  ok("dead after TIMED_OUT", ls.isRealtimeDead() === true);
}

console.log("\n3. onWriteDenied: once, and only for a permanent refusal");
{
  // The exact error the Supabase log showed.
  const rls = { code: "42501",
    message: 'new row violates row-level security policy for table "boardgamebuddy_play_session_scores"' };
  win.supabaseClient = fakeClient({ upsertError: rls });
  let calls = 0;
  const ls = new win.LiveScores({ sessionId: "s3", isHost: true,
    onWriteDenied: () => calls++ });
  await ls.start();
  await ls._sendRows([{ participant_id: "p1", round_index: 0, score: 3 }]).catch(() => {});
  ok("reported for 42501", calls === 1);
  await ls._sendRows([{ participant_id: "p1", round_index: 0, score: 4 }]).catch(() => {});
  await ls._sendRows([{ participant_id: "p2", round_index: 1, score: 9 }]).catch(() => {});
  ok("still exactly once after more refusals", calls === 1);
  ok("the error still rejects (queue keeps the intent)",
     await ls._sendRows([{ participant_id: "p1", round_index: 0, score: 5 }])
       .then(() => false, () => true));
}
{
  const timeout = { message: "signal timed out" };   // transient
  win.supabaseClient = fakeClient({ upsertError: timeout });
  let calls = 0;
  const ls = new win.LiveScores({ sessionId: "s4", isHost: true,
    onWriteDenied: () => calls++ });
  await ls.start();
  await ls._sendRows([{ participant_id: "p1", round_index: 0, score: 3 }]).catch(() => {});
  ok("NOT reported for a timeout", calls === 0);
}
{
  const jwt = { code: "PGRST301", message: "JWT expired" };
  win.supabaseClient = fakeClient({ upsertError: jwt });
  let calls = 0;
  const ls = new win.LiveScores({ sessionId: "s5", isHost: true,
    onWriteDenied: () => calls++ });
  await ls.start();
  await ls._sendRows([{ participant_id: "p1", round_index: 0, score: 3 }]).catch(() => {});
  ok("reported for PGRST301 (rejected token)", calls === 1);
}

console.log("\n4. canWrite gates the send, not just the report");
{
  // The exact error a write off-phase comes back with — the one the Supabase
  // log showed twice during a team night that had otherwise saved fine.
  const rls = { code: "42501",
    message: 'new row violates row-level security policy for table "boardgamebuddy_play_session_scores"' };
  const client = fakeClient({ upsertError: rls });
  win.supabaseClient = client;
  let calls = 0;
  let phase = "gather";
  const ls = new win.LiveScores({ sessionId: "s6", isHost: true,
    onWriteDenied: () => calls++, canWrite: () => phase === "play" });
  await ls.start();

  await ls.setAnyScore("p1", 0, 5);
  ok("no request made while the session is in Gather", client.captured.upserts.length === 0);
  ok("nothing reported for a write that was never sent", calls === 0);
  ok("the host's own cell keeps the value anyway", ls.getScore("p1", 0) === 5);

  phase = "play";
  await ls.setAnyScore("p1", 1, 7);
  ok("the write goes out once the phase opens", client.captured.upserts.length === 1);
  ok("and a real refusal there IS reported", calls === 1);

  // Leaving Play closes it again — the second half of the same incident, where
  // a queued write landed just after Wrap up.
  const before = client.captured.upserts.length;
  phase = "settle";
  await ls.setAnyScore("p1", 2, 9);
  ok("no request made after Wrap up", client.captured.upserts.length === before);
}
{
  // A refusal collected as the window closes under an in-flight request must
  // not spend the one-per-session report either.
  const rls = { code: "42501", message: "new row violates row-level security policy" };
  win.supabaseClient = fakeClient({ upsertError: rls });
  let calls = 0;
  let phase = "play";
  const ls = new win.LiveScores({ sessionId: "s7", isHost: true,
    onWriteDenied: () => calls++, canWrite: () => phase === "play" });
  await ls.start();
  const inflight = ls._sendRows([{ participant_id: "p1", round_index: 0, score: 3 }])
    .catch(() => {});
  phase = "settle";                                  // the host taps Wrap up
  await inflight;
  ok("a refusal that races the phase is not reported", calls === 0);
}
{
  // A spectator passes no predicate; the default must not gate anything off.
  win.supabaseClient = fakeClient();
  const ls = new win.LiveScores({ sessionId: "s8", isHost: true });
  await ls.start();
  await ls.setAnyScore("p1", 0, 4);
  ok("no predicate means writes still go out", win.supabaseClient.captured.upserts.length === 1);
}

console.log("\n5. syncGrid publishes the whole grid, prune included");
{
  const client = fakeClient();
  win.supabaseClient = client;
  const ls = new win.LiveScores({ sessionId: "s9", isHost: true, canWrite: () => true });
  await ls.start();
  await ls.syncGrid([
    { participant_id: "p1", roundScores: ["3", "4"] },
    { participant_id: "p2", roundScores: ["5", ""] },
  ]);
  ok("one upsert for the whole grid", client.captured.upserts.length === 1);
  ok("four cells published", client.captured.upserts[0].length === 4);
  ok("every row carries the session", client.captured.upserts[0].every((r) => r.session_id === "s9"));
  ok("blank cells publish as null",
     client.captured.upserts[0].some((r) => r.participant_id === "p2" && r.round_index === 1
       && r.score === null));
  ok("rounds past the host's last one are pruned",
     client.captured.deletes.length === 1
     && client.captured.deletes[0]["round_index>="] === 2
     && client.captured.deletes[0].session_id === "s9");
}
{
  const client = fakeClient();
  win.supabaseClient = client;
  const ls = new win.LiveScores({ sessionId: "s10", isHost: true, canWrite: () => true });
  await ls.start();
  // Roster rows whose participant_id hasn't landed yet: nothing to publish, so
  // nothing to prune either — a prune here would wipe the live grid.
  await ls.syncGrid([{ roundScores: ["3", "4"] }]);
  ok("a grid with no ids publishes nothing", client.captured.upserts.length === 0);
  ok("and prunes nothing", client.captured.deletes.length === 0);
}
{
  const client = fakeClient();
  win.supabaseClient = client;
  let phase = "gather";
  const ls = new win.LiveScores({ sessionId: "s11", isHost: true,
    canWrite: () => phase === "play" });
  await ls.start();
  await ls.syncGrid([{ participant_id: "p1", roundScores: ["3"] }]);
  ok("syncGrid in Gather sends nothing at all",
     client.captured.upserts.length === 0 && client.captured.deletes.length === 0);
  ok("but the host's overlay still holds the cell", ls.getScore("p1", 0) === 3);
  await ls.removeRoundAt(0);
  ok("removeRoundAt off-phase makes no partial write",
     client.captured.deletes.length === 0 && client.captured.upserts.length === 0);
}

console.log(fails ? `\n${fails} FAILED` : "\nall assertions passed");
process.exit(fails ? 1 : 0);
