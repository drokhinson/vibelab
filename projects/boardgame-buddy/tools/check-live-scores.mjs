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
const sandbox = { window: win, console, AbortSignal, Date, Number, Math, Map, Set, Promise };
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
  const captured = {};
  const thenable = (value) => ({ then: (f) => Promise.resolve(value).then(f) });
  return {
    captured,
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        abortSignal() { return thenable({ data: selectRows, error: selectError }); },
        upsert() {
          return { abortSignal: () => thenable({ data: null, error: upsertError }) };
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

console.log(fails ? `\n${fails} FAILED` : "\nall assertions passed");
process.exit(fails ? 1 : 0);
