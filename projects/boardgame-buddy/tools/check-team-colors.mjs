#!/usr/bin/env node
// check-team-colors.mjs — one answer to "which side is which colour".
//
//     node projects/boardgame-buddy/tools/check-team-colors.mjs
//
// Three surfaces read ui/team-colors.js — the play-detail popup's banded player
// list and the scoring grid's column headers, which are in the SAME modal,
// inches apart; and the spectator's live mirror (migration 050), which is not
// in the room at all but is looking at the same table from another phone. If
// any two disagreed about which side is which colour, the error would be
// invisible in the code and glaring on screen.
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
  eq("three spellings, one slot", [...T.indexMap(players).values()], [5]);
  // applyTeamTag's own comparison, on the same input: tagging Bo into Ana's
  // side must find Ana, which is the behaviour keyOf has to mirror.
  const draft = [
    { name: "Ana", is_winner: true, team: "Red" },
    { name: "Bo", is_winner: false, team: "" },
  ];
  ok("applyTeamTag agrees case-insensitively",
     win.PlaySession.applyTeamTag(draft, 1, " RED ") === true && draft[1].is_winner);
}

console.log("\na colour tag always paints its own colour:");
{
  const slotOf = (tag) => T.indexMap([seat("Ana", { team: tag })]).get(T.keyOf(tag));
  eq("each circle maps to its token", T.TEAM_COLORS.map((c) => slotOf(c.label)),
     [5, 2, 3, 1, 4, 6]);
  eq("old spellings land on the colour they name",
     ["grey", "Violet", "crimson", "slate"].map(slotOf), [6, 4, 5, 6]);
  ok("a custom name is not a colour", T.colorOf("Owls") === null);
  eq("colorOf folds like keyOf", T.colorOf(" BLUE ").label, "Blue");
}

console.log("\na custom side takes the lowest slot no colour is using:");
{
  const map = T.indexMap([
    seat("Ana", { team: "Owls" }),     // first, but Blue owns slot 1
    seat("Bo", { team: "Blue" }),
    seat("Cy", { team: "Orange" }),
    seat("Di", { team: "Cats" }),
  ]);
  eq("pinned colours first, customs fill the gaps",
     [...map.entries()], [["owls", 3], ["blue", 1], ["orange", 2], ["cats", 4]]);
}

console.log("\nthe winning side leads the bands, whatever its colour:");
{
  // bands() takes an already-RANKED roster and keeps first appearance, so the
  // bands read best side first even though Red's slot is 5 and Blue's is 1.
  const ranked = win.Play.rankPlayers([
    seat("Cy", { team: "Blue", score: 300 }),
    seat("Ana", { team: "Red", score: 640, is_winner: true }),
    seat("Di", { team: "Blue", score: 300 }),
    seat("Bo", { team: "Red", score: 640, is_winner: true }),
  ]);
  const bands = T.bands(ranked);
  eq("two sides, winners first", bands.map((b) => [b.label, b.index, b.isColor]),
     [["Red", 5, true], ["Blue", 1, true]]);
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

console.log("\na seventh custom side wraps rather than losing its colour:");
{
  const players = "abcdefg".split("").map((t, i) => seat(`P${i}`, { team: t }));
  const slots = [...T.indexMap(players).values()];
  eq("slots cycle through the six", slots, [1, 2, 3, 4, 5, 6, 1]);
  ok("no side is left uncoloured", slots.every((n) => n >= 1 && n <= T.TEAM_SLOTS));
}

// ── The spectator reads the same sides as the host (migration 050) ──────────
//
// Two DIFFERENT rosters describe one table. The host's screens are handed
// `ps.players` off the local draft; a spectator's mirror is handed the
// session bundle's `participants`, whose seats are a different shape with a
// different name field. Both go through indexMap, and if they disagreed the
// two phones at the same table would paint the same side two colours — the
// exact failure this file exists to prevent, one wire further out.
//
// The agreement rests on one thing: both arrays are in the SAME ORDER. The
// bundle sorts by `position NULLS LAST, joined_at` (migration 056) and the
// host's list IS that order — it is what the host dragged and what the order
// write published. Slots are assigned by order of first appearance, so equal
// order plus equal tags is equal colours, with neither side told which slot a
// side got.
console.log("\nthe spectator's roster lands on the host's colours:");
{
  // What the host's grid is handed.
  const draft = [
    seat("Ana", { team: "Red" }),
    seat("Bo", { team: "Blue" }),
    seat("Cy", { team: "red" }),     // same side, host typed it differently
  ];
  // What the same table looks like in the bundle: display_name, not name, and
  // the tag read straight off boardgamebuddy_play_session_participants.team.
  const participants = [
    { id: "p-1", display_name: "Ana", team: "Red" },
    { id: "p-2", display_name: "Bo", team: "Blue" },
    { id: "p-3", display_name: "Cy", team: "red" },
  ];
  const host = T.indexMap(draft);
  const spectator = T.indexMap(participants);
  eq("same sides, same slots",
     [...spectator.entries()], [...host.entries()]);
  eq("and the mirror's seats resolve to the host's columns",
     participants.map((p) => spectator.get(T.keyOf(p.team))),
     draft.map((p) => host.get(T.keyOf(p.team))));
}

console.log("\na lobby whose host has not named any side is untinted:");
{
  // Every participant row written before migration 050 has no team key at all,
  // and the bundle RPC deploys separately from the web build that reads it.
  // Both have to read as "no sides", which is the untinted grid this screen
  // rendered before — not as one anonymous side every seat shares.
  ok("a roster with no team key at all",
     T.indexMap([{ id: "p-1", display_name: "Ana" },
                 { id: "p-2", display_name: "Bo" }]) === null);
  ok("a roster whose tags are all null",
     T.indexMap([{ id: "p-1", display_name: "Ana", team: null },
                 { id: "p-2", display_name: "Bo", team: null }]) === null);
}

console.log(fails ? `\n${fails} check(s) failed.\n` : "\nAll checks passed.\n");
process.exit(fails ? 1 : 0);
