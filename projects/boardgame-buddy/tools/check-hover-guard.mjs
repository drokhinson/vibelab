#!/usr/bin/env node
// check-hover-guard.mjs — every :hover rule in web/styles.css sits inside
// @media (hover: hover).
//
//     node projects/boardgame-buddy/tools/check-hover-guard.mjs
//
// A touch browser applies :hover to whatever was last tapped and keeps it
// there until something else is tapped, so an unguarded hover lift or tint
// stays stuck on a card after the finger has left it
// (.claude/rules/mobile-web.md §5). The guard turns hover off for every
// device that cannot really hover, and leaves a mouse untouched.
//
// Walks the stylesheet's blocks with comments and strings skipped, and fails
// with the line of each style rule whose selector names :hover while no
// enclosing at-rule is a (hover: hover) query.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "..", "web", "styles.css");
const src = fs.readFileSync(file, "utf8");

const lineOf = (i) => src.slice(0, i).split("\n").length;
const bad = [];
const stack = []; // preludes of the open blocks
let seg = 0;

for (let i = 0; i < src.length; i++) {
  const c = src[i];
  if (c === "/" && src[i + 1] === "*") {
    i = src.indexOf("*/", i + 2) + 1;
    seg = i + 1;
    continue;
  }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (src[j] !== c) j += src[j] === "\\" ? 2 : 1;
    i = j;
    continue;
  }
  if (c === "{") {
    const prelude = src.slice(seg, i).trim();
    if (!prelude.startsWith("@") && prelude.includes(":hover")) {
      const guarded = stack.some((p) => /^@media\b.*\(\s*hover\s*:\s*hover\s*\)/.test(p));
      if (!guarded) bad.push(`  line ${lineOf(i)}: ${prelude.replace(/\s+/g, " ")}`);
    }
    stack.push(prelude);
    seg = i + 1;
  } else if (c === "}") {
    stack.pop();
    seg = i + 1;
  } else if (c === ";") {
    seg = i + 1;
  }
}

if (bad.length) {
  console.error(`FAIL ${bad.length} :hover rule(s) outside @media (hover: hover):\n${bad.join("\n")}`);
  process.exit(1);
}
console.log("PASS every :hover rule is inside @media (hover: hover)");
