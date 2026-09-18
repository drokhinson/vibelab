#!/usr/bin/env node
// check-play-outcome.mjs — assert a play card states the result the roster
// actually holds.
//
//     node projects/boardgame-buddy/tools/check-play-outcome.mjs
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the real modules into a VM
// context and checks the caption — the one line on the card that makes a claim
// a person can catch being wrong.
//
// Written after a team night came back as "We lost" on a game the table had
// won. Three things had to line up for that, and all three are pinned here:
//
//   1. The caption read `winner_display_name`, the aggregate the feed RPC
//      computes at fetch time, while `outcomeUnrecorded` read the roster
//      beside it. Any patch that moved one without the other — a saved edit
//      through Play.mergeIntoCard, a hand-built card — left the card stating
//      a result its own scoreboard contradicted. The roster wins now.
//   2. Play.mergeIntoCard rewrote the roster and left the aggregate alone, so
//      crowning a winner from the edit popup changed the scoreboard on the
//      back of the card and nothing on the front.
//   3. PlaySession.applyTeamTag (then PlayFlowView._setTeam) overwrote a seat's
//      win with its new teammates', so naming a team AFTER crowning it cleared
//      the win — and the play SAVED that way. A caption can be re-rendered; a
//      play logged with nobody flagged is gone.
//
// A team play also has no all-or-nothing shape to fall back on: the winner
// list is half the table by construction, which is why the viewer's own seat
// decides what "we" did.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const WEB = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "web");
const win = {};
const sandbox = { window: win, console, Date, Number, Math, Map, Set, String, Array,
                  Object, JSON, Promise, URL };
vm.createContext(sandbox);
for (const f of ["helpers.js", "domain/play.js", "domain/play-session.js", "ui/play-card.js"]) {
  vm.runInContext(fs.readFileSync(path.join(WEB, f), "utf8"), sandbox, { filename: f });
}

let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};
const eq = (name, got, want) => {
  if (got === want) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}\n         got: ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`); }
};

const ME = { id: "u-me", display_name: "You" };
const seat = (name, o = {}) => Object.assign(
  { user_id: null, name, is_winner: false, score: null }, o);

// A feed card as bgb_feed_page emits one: the roster, plus the two aggregates
// beside it. `winner_display_name` is built here so every fixture starts
// CONSISTENT — the stale-aggregate cases below make it disagree on purpose.
function card(players, extra = {}) {
  const winners = players.filter((p) => p.is_winner).map((p) => p.name).sort();
  return Object.assign({
    kind: "play",
    play_id: "p1",
    play_mode: "competitive",
    players,
    participants: players.filter((p) => p.user_id)
      .map((p) => ({ user_id: p.user_id, display_name: p.name })),
    participant_count: players.length,
    winner_display_name: winners.length ? winners.join(", ") : null,
    user: { id: "u-me", display_name: "You" },
    game: { id: "g1", name: "500" },
  }, extra);
}
const caption = (c, me = ME) => win.BgbPlayCard.buildWinnerBlock(c, me);
const text = (html) => html.replace(/<[^>]*>/g, "").trim();

console.log("\nteam plays read as the viewer's own side:");
{
  // The night in the bug report: a team game, the viewer's side won, and the
  // winner list is half the table.
  const won = card([
    seat("You", { user_id: "u-me", is_winner: true, score: 520 }),
    seat("Britt", { user_id: "u-b", is_winner: true, score: 520 }),
    seat("Dana", { user_id: "u-d", score: 310 }),
  ], { play_mode: "team" });
  eq("viewer's side won", text(caption(won)), "We won!");
  ok("winning side is styled as a win", caption(won).includes('class="win"'));

  const lost = card([
    seat("You", { user_id: "u-me", score: 310 }),
    seat("Britt", { user_id: "u-b", is_winner: true, score: 520 }),
    seat("Dana", { user_id: "u-d", is_winner: true, score: 520 }),
  ], { play_mode: "team" });
  eq("viewer's side lost", text(caption(lost)), "We lost");
  ok("losing side is styled as a loss", caption(lost).includes('class="win-loss"'));

  // A spectator has no side, so the names are the only useful thing to say.
  // They come out in ROSTER order (winners first, then score) — the order the
  // scoreboard on the back of the same card uses.
  eq("spectator sees the winners named", text(caption(won, { id: "u-x", display_name: "Sam" })),
     "Won byYou, Britt");
}

console.log("\nthe roster is the source of truth, not the aggregate:");
{
  // Exactly the shape Play.mergeIntoCard used to leave behind: the play was
  // edited to crown the table's winners, the roster says so, and the
  // fetch-time aggregate still says nobody won.
  const stale = card([
    seat("You", { user_id: "u-me", is_winner: true, score: 520 }),
    seat("Britt", { user_id: "u-b", is_winner: true, score: 520 }),
    seat("Dana", { user_id: "u-d", score: 310 }),
  ], { play_mode: "team", winner_display_name: null, participant_count: 0 });
  eq("a stale null aggregate cannot turn a win into a loss",
     text(caption(stale)), "We won!");

  // ...and the other way: the aggregate remembers a winner the edit removed.
  const cleared = card([
    seat("You", { user_id: "u-me", score: 310 }),
    seat("Britt", { user_id: "u-b", score: 520 }),
  ], { winner_display_name: "Britt" });
  eq("a stale winner name is not reported over an uncrowned roster",
     text(caption(cleared)), "No winner recorded");

  // A payload with no roster at all (pre-015, or an adapter that omits it)
  // still has to work off the aggregate — that is the whole fallback.
  const legacy = { play_mode: "competitive", winner_display_name: "Ana",
                   participant_count: 3, user: { id: "u-x" } };
  eq("a rosterless card falls back to the aggregate", text(caption(legacy)), "Won byAna");
}

console.log("\nthe other buckets still say what they said:");
{
  const coopLoss = card([
    seat("You", { user_id: "u-me", score: 0 }),
    seat("Britt", { user_id: "u-b", score: 0 }),
  ], { play_mode: "coop" });
  eq("a co-op table that lost", text(caption(coopLoss)), "We lost");

  const coopWin = card([
    seat("You", { user_id: "u-me", is_winner: true, score: 42 }),
    seat("Britt", { user_id: "u-b", is_winner: true, score: 42 }),
  ], { play_mode: "coop" });
  eq("a co-op table that won", text(caption(coopWin)), "We won!");

  const unrecorded = card([
    seat("You", { user_id: "u-me" }),
    seat("Britt", { user_id: "u-b" }),
  ]);
  eq("nobody won and nobody scored says nothing", caption(unrecorded), "");

  // The distinction the co-op loss above turns on: outside co-op, an
  // uncrowned board is a missing answer, not a defeat. The card never tells
  // people who were there that they lost on the strength of a blank field.
  const uncrowned = card([
    seat("You", { user_id: "u-me", score: 310 }),
    seat("Britt", { user_id: "u-b", score: 520 }),
  ]);
  eq("a competitive board nobody was crowned on",
     text(caption(uncrowned)), "No winner recorded");
  eq("...and the same on a team play",
     text(caption(Object.assign({}, uncrowned, { play_mode: "team" }))),
     "No winner recorded");

  const solo = card([
    seat("You", { user_id: "u-me", is_winner: true, score: 71 }),
    seat("Britt", { user_id: "u-b", score: 60 }),
  ]);
  eq("a competitive win by the viewer", text(caption(solo)), "Won byYou71");

  const tie = card([
    seat("Ana", { user_id: "u-a", is_winner: true, score: 71 }),
    seat("Britt", { user_id: "u-b", is_winner: true, score: 71 }),
    seat("Dana", { user_id: "u-d", score: 60 }),
  ]);
  eq("a tie names both and claims neither score",
     text(caption(tie, { id: "u-x", display_name: "Sam" })), "Won byAna, Britt");

  const run = card([
    seat("You", { user_id: "u-me", is_winner: true, score: 71 }),
    seat("Britt", { user_id: "u-b", is_winner: true, score: 71 }),
  ], { group_count: 5, play_mode: "coop" });
  eq("a run of identical plays", text(win.BgbPlayCard.stackOutcome(run, ME, 5)), "We won all 5");
}

console.log("\nan edit carries the aggregates with it (Play.mergeIntoCard):");
{
  const c = card([
    seat("You", { user_id: "u-me", score: 310 }),
    seat("Britt", { user_id: "u-b", score: 520 }),
  ], { play_mode: "team" });
  eq("before the edit", text(caption(c)), "No winner recorded");
  // What the PUT echoes back once the play is crowned from the edit popup.
  win.Play.mergeIntoCard(c, {
    id: "p1",
    game_id: "g1",
    game_name: "500",
    played_at: "2026-09-18",
    play_mode: "team",
    players: [
      { user_id: "u-me", name: "You", is_winner: true, score: 520 },
      { user_id: "u-b", name: "Britt", is_winner: true, score: 520 },
    ],
  });
  eq("the aggregate follows the roster", c.winner_display_name, "Britt, You");
  eq("so does the seat count", c.participant_count, 2);
  eq("and the card now says what happened", text(caption(c)), "We won!");
}

console.log("\nnaming a team never drops a recorded win (PlaySession.applyTeamTag):");
{
  const PS = win.PlaySession;
  // The order that lost the win: crown the winners, THEN type the team names.
  const players = [
    { name: "You", is_winner: true, team: "" },
    { name: "Britt", is_winner: true, team: "" },
    { name: "Dana", is_winner: false, team: "" },
    { name: "Sam", is_winner: false, team: "" },
  ];
  // Each tag either agrees with the side already or has nothing to say, so
  // nothing moves at any point — which is exactly the property that broke.
  eq("tagging the first seat of a side settles nothing yet",
     PS.applyTeamTag(players, 0, "Dickaloo"), false);
  ok("...and leaves its win alone", players[0].is_winner === true);
  eq("tagging its teammate settles nothing either", PS.applyTeamTag(players, 1, "Dickaloo"), false);
  ok("...with both of them still winners", players[0].is_winner && players[1].is_winner);
  eq("tagging the losing side changes nothing", PS.applyTeamTag(players, 2, "Otters"), false);
  eq("nor does its second seat", PS.applyTeamTag(players, 3, "Otters"), false);
  ok("...and neither of them is crowned", !players[2].is_winner && !players[3].is_winner);
  ok("...so the play saves with the side that won still flagged",
     players.filter((p) => p.is_winner).length === 2);

  // The half-crowned table: only one of the two was flagged before the tags
  // went in (the trophy row crowns a seat with no tag on its own). Naming the
  // side is what makes them a side, so the win spreads across it.
  const half = [
    { name: "You", is_winner: true, team: "" },
    { name: "Britt", is_winner: false, team: "" },
    { name: "Dana", is_winner: false, team: "" },
  ];
  eq("first tag, nothing to settle", PS.applyTeamTag(half, 0, "Dickaloo"), false);
  eq("second tag spreads the win across the side",
     PS.applyTeamTag(half, 1, "Dickaloo"), true);
  ok("...to both seats and no further",
     half[0].is_winner && half[1].is_winner && !half[2].is_winner);

  // The other direction: a seat joining a side that already won inherits it.
  const joiners = [
    { name: "Ana", is_winner: true, team: "red" },
    { name: "Kim", is_winner: false, team: "" },
  ];
  eq("joining a winning side", PS.applyTeamTag(joiners, 1, "RED"), true);
  ok("...crowns the joiner (tag matching ignores case)", joiners[1].is_winner === true);

  // Clearing a tag says nothing about anyone's result.
  const cleared = [
    { name: "Ana", is_winner: true, team: "red" },
    { name: "Kim", is_winner: true, team: "red" },
  ];
  eq("clearing a tag settles nothing", PS.applyTeamTag(cleared, 1, ""), false);
  ok("...and leaves both wins standing", cleared[0].is_winner && cleared[1].is_winner);
  eq("...and the tag is gone", cleared[1].team, "");
}

console.log(fails === 0 ? "\nAll checks passed.\n" : `\n${fails} check(s) FAILED.\n`);
process.exit(fails === 0 ? 0 : 1);
