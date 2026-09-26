#!/usr/bin/env node
// check-team-scoring.mjs — a side is one column, and one column is one score.
//
//     node projects/boardgame-buddy/tools/check-team-scoring.mjs
//
// A team play's seats share ONE cell per round now
// (widgets/round-score-grid.js#roundGridColumns): the host types into it once,
// the write fans out, and every seat saves the side's number as its own score.
// Three things have to hold for that to be true rather than merely to look it,
// and each has a failure that is invisible in the code:
//
//   * THE FAN-OUT. The grid hands a host the column's FIRST seat. A host that
//     wrote only that index would show the side's score on screen and save the
//     rest of the side as zeroes — a play that reads right in the app and
//     wrong in every stat derived from it.
//   * THE TOTAL. A merged column's total is the SIDE's, not the sum of its
//     seats. Summing the seats reads N times too big on a side of N, and hands
//     a 3v2 game to whichever side has three people on it.
//   * THE SPLIT. A merged cell shows one number, so it may only exist where
//     the seats hold one. Plays scored seat by seat (team mode has existed
//     since migration 007) must keep their columns, or the detail popup prints
//     one member's score over everybody's.
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the real modules into a VM
// context, the way tools/check-team-colors.mjs does.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const WEB = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "web");
const win = {};
const sandbox = { window: win, console, Date, Number, Math, Map, Set, String, Array,
                  Object, JSON, Promise, URL, document: undefined, localStorage: undefined };
vm.createContext(sandbox);
for (const f of ["helpers.js", "domain/play.js", "domain/play-session.js",
                 "ui/team-colors.js", "widgets/round-score-grid.js"]) {
  vm.runInContext(fs.readFileSync(path.join(WEB, f), "utf8"), sandbox, { filename: f });
}

let fails = 0;
const ok = (name, cond) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}`); }
};
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}\n         got: ${g}\n        want: ${w}`); }
};

const seat = (name, team, rounds) => ({
  name, user_id: null, is_winner: false, score: null,
  team: team || null, roundScores: rounds || [],
});
// The shape of a column, as the assertions below want to read it.
const shape = (cols) => cols.map((c) => `${c.merged ? c.label : c.players[0].name}:${c.indexes.join("+")}`);
const columns = (players, mode, n) => win.roundGridColumns(players, mode, n, null);

console.log("\noutside team mode nothing merges:");
{
  const roster = [seat("Ana", "Red", [10]), seat("Bo", "Red", [10])];
  eq("competitive is one column per seat",
     shape(columns(roster, "competitive", 1)), ["Ana:0", "Bo:1"]);
  eq("co-op too", shape(columns(roster, "coop", 1)), ["Ana:0", "Bo:1"]);
  // The mode is the gate, and this is why the lobby publishes it (migration
  // 050): a mirror reading tags alone would merge a grid the host un-merged.
  eq("team does", shape(columns(roster, "team", 1)), ["Red:0+1"]);
}

console.log("\na side of one keeps its own column:");
{
  const roster = [seat("Ana", "Red", [10]), seat("Bo", "Blue", [7])];
  eq("two sides of one are two columns",
     shape(columns(roster, "team", 1)), ["Ana:0", "Bo:1"]);
  // ...and still carries the side's colour, which is the whole of migration 048.
  // Red and Blue are palette circles, so each wears its own token (5 and 1).
  eq("both keep their tint", columns(roster, "team", 1).map((c) => c.slot), [5, 1]);
}

console.log("\na side takes the position of its first seat:");
{
  // Interleaved sides pull each side's later seats up to its first, so the
  // column order is still derived from the roster order both ends share.
  const roster = [seat("Ana", "Red"), seat("Bo", "Blue"), seat("Cy", "Red")];
  // Blue is a side of ONE, so it stays a seat column and reads as its player —
  // there is nothing to merge it with, and a column labelled "Blue" holding
  // one person would be the grid claiming a side the table does not have.
  eq("Red pulls Cy up; Blue stays a seat",
     shape(columns(roster, "team", 0)), ["Red:0+2", "Bo:1"]);
}

console.log("\nan untagged seat is its own column, bare:");
{
  const roster = [seat("Ana", "Red"), seat("Bo", "Red"), seat("Cy")];
  const cols = columns(roster, "team", 0);
  eq("the side, then the loose seat", shape(cols), ["Red:0+1", "Cy:2"]);
  ok("...and the loose seat carries no tint", cols[2 - 1].slot === 0);
}

console.log("\nthe split: a side that holds two numbers keeps two columns:");
{
  // A play scored seat by seat — every team play saved before merged cells.
  const roster = [seat("Ana", "Red", [10]), seat("Bo", "Red", [7])];
  eq("two different numbers, two columns",
     shape(columns(roster, "team", 1)), ["Ana:0", "Bo:1"]);
  eq("and both keep the side's colour",
     columns(roster, "team", 1).map((c) => c.slot), [5, 5]);
}

console.log("\n...but a blank is not a disagreement:");
{
  // The spectator's case: the host's fan-out is three Realtime rows, so for a
  // few ms the side genuinely holds one number and two blanks. Counting that
  // as a disagreement would re-shape the mirror's grid mid-keystroke.
  const roster = [seat("Ana", "Red", [40]), seat("Bo", "Red", [null]), seat("Cy", "Red", [])];
  const cols = columns(roster, "team", 1);
  eq("still one column", shape(cols), ["Red:0+1+2"]);
  eq("showing the number that has landed",
     win.roundGridColumnValue(cols[0], 0, null), "40");
}

console.log("\na number typed two ways is one number:");
{
  const roster = [seat("Ana", "Red", ["05"]), seat("Bo", "Red", ["5"])];
  eq("compared as parsed values, not strings",
     shape(columns(roster, "team", 1)), ["Red:0+1"]);
}

console.log("\nthe total under a merged column is the SIDE's:");
{
  const roster = [seat("Ana", "Red", [40, 10]), seat("Bo", "Red", [40, 10]),
                  seat("Cy", "Blue", [45, 20])];
  const cols = columns(roster, "team", 2);
  eq("Red 50, Blue 65 — not Red 100",
     cols.map((c) => win.roundGridColumnTotal(c, 2, null)), [50, 65]);
  // The trap this exists to catch: summing the seats would make the bigger
  // side win a game it lost.
  const seatSum = roster.filter((p) => p.team === "Red")
    .reduce((t, p) => t + win.roundGridTotal(p, 2), 0);
  ok("summing the seats would have said 100", seatSum === 100);
}

console.log("\nthe fan-out: which seats does one cell write to?");
{
  const roster = [seat("Ana", "Red"), seat("Bo", "Blue"), seat("Cy", "Red")];
  eq("the cell on Red covers both Red seats",
     win.roundGridSeatsFor(roster, "team", 0, null, 0), [0, 2]);
  // Asked about a seat that is NOT the column's first: the grid never emits
  // that index, but a stale paint or the console can still reach the handler.
  eq("...asked about either of them", win.roundGridSeatsFor(roster, "team", 0, null, 2), [0, 2]);
  eq("a side of one covers itself", win.roundGridSeatsFor(roster, "team", 0, null, 1), [1]);
  eq("competitive covers itself", win.roundGridSeatsFor(roster, "competitive", 0, null, 0), [0]);
}

console.log("\n...and a split side writes only the seat that was typed in:");
{
  const roster = [seat("Ana", "Red", [10]), seat("Bo", "Red", [7])];
  eq("no fan-out across a disagreement",
     win.roundGridSeatsFor(roster, "team", 1, null, 0), [0]);
}

console.log("\na seat joining a side takes the numbers it is already showing:");
{
  const roster = [seat("Ana", "Red", [40, 10]), seat("Bo", "Red", [40, 10]), seat("Cy", null, [])];
  ok("the tag lands", win.PlaySession.applyTeamTag(roster, 2, "Red") === false);
  ok("and the numbers follow", win.PlaySession.adoptTeamScores(roster, 2) === true);
  eq("the new seat holds the side's cells", roster[2].roundScores, [40, 10]);
  // Which is the whole point: every seat SAVES the side's score as its own.
  eq("so every seat totals the same",
     roster.map((p) => win.roundGridTotal(p, 2)), [50, 50, 50]);
}

console.log("\n...but a seat that was already scored keeps its own numbers:");
{
  // Overwriting here is the same mistake applyTeamTag's docstring is a
  // monument to — throwing away something already recorded because a tag was
  // typed. The grid splits the side instead and shows both numbers.
  const roster = [seat("Ana", "Red", [40]), seat("Bo", "Red", [40]), seat("Cy", "Red", [9])];
  ok("nothing is adopted", win.PlaySession.adoptTeamScores(roster, 2) === false);
  eq("the seat keeps what it had", roster[2].roundScores, [9]);
  eq("and the side shows all three", shape(columns(roster, "team", 1)),
     ["Ana:0", "Bo:1", "Cy:2"]);
}

console.log("\nnothing is adopted where there is nothing to adopt:");
{
  const lone = [seat("Ana", "Red", []), seat("Bo", "Blue", [5])];
  ok("a side of one", win.PlaySession.adoptTeamScores(lone, 0) === false);
  const untagged = [seat("Ana", null, []), seat("Bo", "Red", [5])];
  ok("an untagged seat", win.PlaySession.adoptTeamScores(untagged, 0) === false);
}

console.log("\nthe header of a merged column: badges by default, tag AND roster on tap:");
{
  // Rendered for real, because the thing under test is what the header SAYS —
  // the column model above cannot see it. The VM has no document and no
  // localStorage, which is exactly the state this asserts against: no stored
  // preference, so every grid opens on its own default.
  const render = (roster, mode, headerNames) =>
    win.renderRoundGrid(roster, "checkHost", { playMode: mode, editable: false, headerNames });
  const side = [seat("Ana", "Red", [10]), seat("Bo", "Red", [10]),
                seat("Cy", "Blue", [7]), seat("Di", "Blue", [7])];

  // The live play screens pass headerNames: true — names are what you scan
  // mid-game — and a team grid overrides it: a side's badges are the only
  // thing on screen that says who is on it.
  const teamHtml = render(side, "team", true);
  ok("a team grid opens on the badges even where the surface asked for names",
     teamHtml.indexOf("scoring-head is-named") === -1);
  ok("...and says so, so one tap moves team headers only",
     teamHtml.indexOf('data-rg-scope="team"') !== -1);
  ok("the tap flips it toward names", teamHtml.indexOf("toggleAll(false, 'team')") !== -1);
  // A side picked from the colour circles IS its tint, so its text state is
  // the roster alone — "Red" over a red column says it twice.
  ok("a colour side's text state is the roster, no tag",
     teamHtml.indexOf('<span class="scoring-head__roster">Ana, Bo</span>') !== -1
     && teamHtml.indexOf('<span class="scoring-head__team">Red</span>') === -1
     && teamHtml.indexOf('<span class="scoring-head__team">Blue</span>') === -1);
  // A custom name carries what the tint cannot, so it is drawn as two lines —
  // the tag over the roster, the tag underlined by CSS — because a ~4.3rem
  // column broke the one-line form wherever the box ran out.
  const customHtml = render([seat("Ana", "Owls", [10]), seat("Bo", "Owls", [10]),
                             seat("Cy", "Cats", [7]), seat("Di", "Cats", [7])], "team", true);
  ok("a custom side's text state draws the tag over the roster",
     customHtml.indexOf('<span class="scoring-head__team">Owls</span>'
                        + '<span class="scoring-head__roster">Ana, Bo</span>') !== -1
     && customHtml.indexOf('<span class="scoring-head__team">Cats</span>'
                           + '<span class="scoring-head__roster">Cy, Di</span>') !== -1);
  // Flat for the tooltip and the button's accessible name, where a sentence is
  // what a hover and a screen reader want.
  ok("...and says it in one line where it has to be one line",
     teamHtml.indexOf('title="Red: Ana, Bo"') !== -1
     && teamHtml.indexOf("Blue: Cy, Di — show player names") !== -1);
  ok("...and the badges are still there under it, one per seat",
     (teamHtml.match(/data-head-seat=/g) || []).length === 4);

  // Nothing about a grid with no sides changes: same default, same scope, and
  // a seat column still reads as one name.
  const soloHtml = render(side, "competitive", true);
  ok("a competitive grid still opens where its surface asked",
     soloHtml.indexOf("scoring-head is-named") !== -1);
  ok("...in its own scope", soloHtml.indexOf('data-rg-scope="solo"') !== -1);
  ok("...and a seat column reads as its player alone",
     soloHtml.indexOf("Red: Ana") === -1 && soloHtml.indexOf(">Ana<") !== -1);

  // A side the grid had to SPLIT (two numbers, above) is seats again, so it
  // takes the seat default rather than the badge one — the column is one
  // person and its name says so.
  const split = [seat("Ana", "Red", [10]), seat("Bo", "Red", [7])];
  const splitHtml = render(split, "team", true);
  ok("a split side is a solo grid", splitHtml.indexOf('data-rg-scope="solo"') !== -1);

  // A side of one is a seat column too (see above), so a team play whose sides
  // are all of one never claims the team scope.
  const ones = [seat("Ana", "Red", [10]), seat("Bo", "Blue", [7])];
  ok("...and so is a table of one-person sides",
     render(ones, "team", true).indexOf('data-rg-scope="solo"') !== -1);
}

// Not a team fact, but this is the one harness that renders the real grid, and
// the thing it pins is the same width a merged column is competing for: every
// px the row-header column holds is a px off the score columns beside it.
console.log("\nthe row-header column reserves what it draws and no more:");
{
  const roster = [seat("Ana", "A", [null]), seat("Bo", "B", [null])];
  const grid = (rounds, opts) => win.renderRoundGrid(
    roster.map((p) => ({ ...p, roundScores: new Array(rounds).fill(null) })),
    "checkHost", { playMode: "team", editable: true, minRounds: 1, ...(opts || {}) });

  // The Play screen's opening state: one round, which is the one it refuses to
  // go below, so there is no remove × on the table.
  const opening = grid(1);
  ok("five characters, for Total", opening.indexOf("--rg-label-ch: 5") !== -1);
  ok("...and no room reserved for an × that is not drawn",
     opening.indexOf("rg--removable") === -1);

  // Press Next round and the × appears, so now it is paid for.
  ok("a second round brings the × and its room", grid(2).indexOf("rg--removable") !== -1);
  // A template's rows carry no × at all, however many there are.
  ok("a template's rows never draw one",
     grid(2, { rowLabels: [{ label: "Prosperity" }, { label: "Events" }] })
       .indexOf("rg--removable") === -1);
  ok("...and size the column to the longest of them",
     grid(2, { rowLabels: [{ label: "Prosperity" }, { label: "Events" }] })
       .indexOf("--rg-label-ch: 10") !== -1);
  // A read-only mirror can never remove a round.
  ok("a read-only grid reserves nothing",
     grid(3, { editable: false }).indexOf("rg--removable") === -1);
}

console.log(fails ? `\n${fails} check(s) failed.\n` : "\nAll checks passed.\n");
process.exit(fails ? 1 : 0);
