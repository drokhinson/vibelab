#!/usr/bin/env node
// check-team-colors.mjs — one answer to "which side is which colour".
//
//     node projects/boardgame-buddy/tools/check-team-colors.mjs
//
// Two widgets read ui/team-colors.js — the play-detail popup's banded player
// list and the scoring grid's column headers — and they are in the SAME modal,
// inches apart. If they ever disagreed about which side is which colour, the
// error would be invisible in the code and glaring on screen.
//
// The load-bearing agreement is with PlaySession.applyTeamTag, which settles a
// side's win flags by trimmed, case-folded tag. If the grouping here folded
// differently, "Red" and "red" would be crowned together and painted apart.
//
// There is no test runner for web/ (the authoring model is ~121 script tags,
// see .claude/rules/web-frontend.md), so this loads the real modules into a VM
// context, the way tools/check-play-outcome.mjs does.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const WEB = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "web");
const win = {};
const sandbox = { window: win, console, Date, Number, Math, Map, Set, String, Array,
                  Object, JSON, Promise, URL };
vm.createContext(sandbox);
for (const f of ["helpers.js", "domain/play.js", "domain/play-session.js",
                 "ui/team-colors.js"]) {
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

const T = win.BgbTeams;
const seat = (name, o = {}) =>
  Object.assign({ user_id: null, name, is_winner: false, score: null, team: null }, o);

console.log("\na roster with no sides renders as it always did:");
{
  const flat = [seat("Ana", { score: 90 }), seat("Bo", { score: 40 })];
  ok("indexMap is null", T.indexMap(flat) === null);
  ok("bands is null — the signal to take the flat branch", T.bands(flat) === null);
  // The cleared tag is "" on the draft and null on a saved row. Neither is a side.
  ok("an empty tag is not a side", T.indexMap([seat("Ana", { team: "" }),
                                               seat("Bo", { team: "  " })]) === null);
}

console.log("\nthe tag folds exactly the way applyTeamTag folds it:");
{
  // If these two ever disagreed, one side would be crowned together and
  // painted apart — see the header.
  const players = [
    seat("Ana", { team: "Red" }),
    seat("Bo", { team: " red " }),
    seat("Cy", { team: "RED" }),
  ];
  eq("three spellings, one slot", [...T.indexMap(players).values()], [1]);
  // applyTeamTag's own comparison, on the same input: tagging Bo into Ana's
  // side must find Ana, which is the behaviour keyOf has to mirror.
  const draft = [
    { name: "Ana", is_winner: true, team: "Red" },
    { name: "Bo", is_winner: false, team: "" },
  ];
  ok("applyTeamTag agrees case-insensitively",
     win.PlaySession.applyTeamTag(draft, 1, " RED ") === true && draft[1].is_winner);
}

console.log("\nthe winning side is slot 1:");
{
  // bands() takes an already-RANKED roster and never sorts, so "order of first
  // appearance" is "sides ordered by their best seat" for free.
  const ranked = win.Play.rankPlayers([
    seat("Cy", { team: "Blue", score: 300 }),
    seat("Ana", { team: "Red", score: 640, is_winner: true }),
    seat("Di", { team: "Blue", score: 300 }),
    seat("Bo", { team: "Red", score: 640, is_winner: true }),
  ]);
  const bands = T.bands(ranked);
  eq("two sides, winners first", bands.map((b) => [b.label, b.index]),
     [["Red", 1], ["Blue", 2]]);
  eq("seats keep their ranked order inside a band",
     bands[0].players.map((p) => p.name), ["Ana", "Bo"]);
}

console.log("\nthe label keeps the spelling the host typed:");
{
  const bands = T.bands([seat("Ana", { team: " Reds " }), seat("Bo", { team: "reds" })]);
  eq("first seat's casing wins", bands[0].label, "Reds");
}

console.log("\nuntagged seats trail, bare:");
{
  const bands = T.bands([
    seat("Ana", { team: "Red" }),
    seat("Bo"),
    seat("Cy", { team: "Red" }),
  ]);
  eq("one side plus a remainder", bands.map((b) => b.key), ["red", null]);
  eq("the remainder holds the untagged seat",
     bands[1].players.map((p) => p.name), ["Bo"]);
  ok("...and carries no label to print", bands[1].label === "");
}

console.log("\na seventh side wraps rather than losing its colour:");
{
  const players = "abcdefg".split("").map((t, i) => seat(`P${i}`, { team: t }));
  const slots = [...T.indexMap(players).values()];
  eq("slots cycle through the six", slots, [1, 2, 3, 4, 5, 6, 1]);
  ok("no side is left uncoloured", slots.every((n) => n >= 1 && n <= T.TEAM_SLOTS));
}

console.log(fails ? `\n${fails} check(s) failed.\n` : "\nAll checks passed.\n");
process.exit(fails ? 1 : 0);
