// check-score-keypad.mjs — the score pad's (−) key and its Σ Sum mode.
//
// widgets/score-keypad.js is the app's own number pad for a score cell. Its
// (−) flips the whole cell; these pin what that does to each state a cell can
// be in, including the half-typed "-" sanitizeRoundScore keeps. Σ Sum
// (widgets/score-sum.js) stacks several numbers into one cell; these pin the
// running total, reopening and removing a stacked number, and what the cell
// shows. Loaded into a VM with no document, the way check-team-scoring.mjs
// loads the grid.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const WEB = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "web");
const win = {};
const sandbox = { window: win, console, Date, Number, Math, Map, Set, String, Array,
                  Object, JSON, Promise, URL, document: undefined, localStorage: undefined };
vm.createContext(sandbox);
for (const f of ["helpers.js", "ui/team-colors.js", "widgets/round-score-grid.js",
                 "widgets/score-sum.js", "widgets/score-keypad.js"]) {
  vm.runInContext(fs.readFileSync(path.join(WEB, f), "utf8"), sandbox, { filename: f });
}
const K = win.ScoreKeypad;
const S = win.ScoreSum;

let fails = 0;
const eq = (name, got, want) => {
  if (got === want) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}\n         got: ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`); }
};

console.log("(−) flips the whole cell");
for (const [from, to] of [["", "-"], ["-", ""], ["12", "-12"], ["-12", "12"], ["0", "-0"]]) {
  eq(`${JSON.stringify(from)} → ${JSON.stringify(to)}`, K.flipSign(from), to);
}

// A stand-in for the <input>: the keypad writes value and fires input.
sandbox.Event = class { constructor(t) { this.type = t; } };
const el = {
  value: "7", fired: 0, selectionStart: 1,
  setSelectionRange(a) { this.selectionStart = a; },
  dispatchEvent() { this.fired++; },
};
K.toggleSign(el);
eq("the cell reads negative", el.value, "-7");
eq("the caret sits at the end", el.selectionStart, 2);
eq("and the host hears it", el.fired, 1);

console.log("\nkeys typed into a cell");
eq("a digit appends", S.typeKey("1", "2"), "12");
eq("a leading zero is replaced", S.typeKey("0", "7"), "7");
eq("after a sign too", S.typeKey("-0", "7"), "-7");
eq("back deletes one", S.typeKey("-12", "back"), "-1");
eq("six digits is the cap", S.typeKey("123456", "7"), "123456");
eq("a minus-signed cell keeps its six", S.typeKey("-12345", "6"), "-123456");
eq("anything else is ignored", S.typeKey("4", "x"), "4");
eq(". starts the decimals", S.typeKey("12", "."), "12.");
eq(". on an empty number reads 0.", S.typeKey("", "."), "0.");
eq("and after a sign, -0.", S.typeKey("-", "."), "-0.");
eq("a second . is ignored", S.typeKey("1.5", "."), "1.5");
eq("two decimal places is the cap", S.typeKey("1.25", "7"), "1.25");

console.log("\nwhat a cell stores");
const clean = win.sanitizeRoundScore;
eq("a decimal is kept", clean("12.5"), "12.5");
eq("a half-typed point is kept", clean("12."), "12.");
eq("a second point is dropped", clean("1.2.3"), "1.23");
eq("past two places is cut", clean("-3.14159"), "-3.14");
eq("letters are stripped", clean("7a.5b"), "7.5");
eq("a lone point reads as empty", win.parseRoundScore("."), null);
eq("12. reads as 12", win.parseRoundScore("12."), 12);
eq("a sum of decimals has no float noise", win.roundScoreSum(0.1 + 0.2), 0.3);

const run = (s, keys) => { for (const k of keys) S.key(s, k); return s; };

console.log("\nΣ Sum stacks numbers");
let s = run(S.create(null), ["5", "+", "3", "+", "2", "-", "4"]);
eq("5 + 3 + 2 − 4", S.total(s), 6);
eq("the cell shows the running total", S.cellText(s), "6");
eq("three are stacked, one is being typed", `${s.terms.length}/${s.entry}`, "3/4");
eq("an empty sum leaves the cell blank", S.cellText(S.create(null)), "");
eq("the cell's own score is the first number", S.total(run(S.create(12), ["+", "3"])), 15);
eq("a negative score seeds a minus", S.total(run(S.create(-2), ["+", "5"])), 3);
eq("a trailing + adds nothing", S.total(run(S.create(null), ["9", "+"])), 9);

s = run(S.create(null), ["2", ".", "5", "+", "0", ".", "2", "5", "+", "1", "."]);
eq("2.5 + 0.25 + 1.", S.total(s), 3.75);
S.key(s, "+");
eq("a trailing point is dropped when it stacks", s.terms[2].v, "1");
eq("0.1 + 0.2 is 0.3", S.total(run(S.create(null), [".", "1", "+", ".", "2"])), 0.3);
eq("the cell's decimal score seeds the sum", S.total(run(S.create(-1.5), ["+", "2"])), 0.5);

console.log("\ntapping a stacked number reopens it");
s = run(S.create(null), ["5", "+", "3", "+", "2", "+"]);
S.tap(s, 1);
run(s, ["back", "7"]);
eq("3 changed to 7 counts at once", S.total(s), 14);
S.key(s, "-");
eq("− gives it a minus and closes it", `${S.total(s)} ${s.edit}`, "0 null");
S.tap(s, 0);
run(s, ["back", "back"]);
eq("back on an emptied number removes it", `${s.terms.length} ${s.edit} ${S.total(s)}`, "2 null -5");
S.tap(s, 1);
S.remove(s, 1);
eq("× removes the open one", `${s.terms.length} ${s.edit} ${S.total(s)}`, "1 null -7");
S.tap(s, 0);
S.tap(s, 0);
eq("a second tap closes it unchanged", `${s.edit} ${S.total(s)}`, "null -7");
s = run(S.create(null), ["5", "+", "3", "+", "back"]);
eq("back with nothing typed reopens the last one", `${s.edit} ${s.editVal}`, "1 3");
S.tap(s, 0);
eq("opening another closes the first", `${s.edit} ${s.terms.map((t) => t.v).join(",")}`, "0 5,3");
S.remove(s, 0);
S.remove(s, 0);
eq("with everything removed the cell is blank again", S.cellText(s), "");

if (fails) { console.log(`\n${fails} failed`); process.exit(1); }
console.log("\nall passed");
