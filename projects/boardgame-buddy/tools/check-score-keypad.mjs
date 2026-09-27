// check-score-keypad.mjs — the score a cell's text stands for.
//
// widgets/score-keypad.js lets a scoring-grid cell hold a sum while it is
// typed ("12+7-3") and hands the host only the result. These pin that
// arithmetic and the (−) flip, which act on whole cells, not on the term under
// the caret. Loaded into a VM with no document, the way check-team-scoring.mjs
// loads the grid.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const WEB = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "web");
const win = {};
const sandbox = { window: win, console, String, Number, Math, Array, parseInt, document: undefined };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(WEB, "widgets/score-keypad.js"), "utf8"), sandbox,
  { filename: "widgets/score-keypad.js" });
const K = win.ScoreKeypad;

let fails = 0;
const eq = (name, got, want) => {
  if (got === want) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}\n         got: ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`); }
};

console.log("evaluate: what the host is told");
eq("empty", K.evaluate(""), "");
eq("plain number", K.evaluate("12"), "12");
eq("negative", K.evaluate("-12"), "-12");
eq("a lone sign waits for digits", K.evaluate("-"), "-");
eq("a sum", K.evaluate("12+7"), "19");
eq("a sum with a minus", K.evaluate("12+7-3"), "16");
eq("a sum that goes negative", K.evaluate("3-10"), "-7");
eq("a trailing operator is ignored", K.evaluate("12+"), "12");
eq("stacked operators keep the last", K.evaluate("5+-3"), "2");
eq("a leading plus is dropped", K.evaluate("+5"), "5");
eq("leading zeros", K.evaluate("007"), "7");
eq("letters and dots are stripped", K.evaluate("1a.2"), "12");

// A stand-in for the <input>: the keypad reads value/selection and fires input.
const cell = (value, caret = value.length) => {
  const el = {
    value, selectionStart: caret, selectionEnd: caret, fired: 0,
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    dispatchEvent() { this.fired++; },
  };
  return el;
};
sandbox.Event = class { constructor(t) { this.type = t; } };

console.log("\n(−) flips the whole cell");
for (const [from, to] of [["", "-"], ["-", ""], ["12", "-12"], ["-12", "12"], ["12+7", "-19"], ["3-10", "7"]]) {
  const el = cell(from);
  K.toggleSign(el);
  eq(`${JSON.stringify(from)} → ${JSON.stringify(to)}`, el.value, to);
}
{
  const el = cell("12");
  K.toggleSign(el);
  eq("and the host hears it", el.fired, 1);
}

console.log("\n+ and − go in at the caret");
{
  const el = cell("12"); K.insertOp(el, "+");
  eq("after a number", el.value, "12+");
  K.insertOp(el, "-");
  eq("a second operator swaps the first", el.value, "12-");
  const empty = cell(""); K.insertOp(empty, "+");
  eq("no leading plus", empty.value, "");
  const mid = cell("1234", 2); K.insertOp(mid, "+");
  eq("mid-number", mid.value, "12+34");
  eq("caret lands after it", mid.selectionStart, 3);
}

if (fails) { console.log(`\n${fails} failed`); process.exit(1); }
console.log("\nall passed");
