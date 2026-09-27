// check-score-keypad.mjs — the (−) key on the score keypad.
//
// widgets/score-keypad.js docks a bar on the iOS number pad, which has no
// sign key. Its (−) flips the whole cell; these pin what that does to each
// state a cell can be in, including the half-typed "-" sanitizeRoundScore
// keeps. Loaded into a VM with no document, the way check-team-scoring.mjs
// loads the grid.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const WEB = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "web");
const win = {};
const sandbox = { window: win, console, String, document: undefined };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(WEB, "widgets/score-keypad.js"), "utf8"), sandbox,
  { filename: "widgets/score-keypad.js" });
const K = win.ScoreKeypad;

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

if (fails) { console.log(`\n${fails} failed`); process.exit(1); }
console.log("\nall passed");
