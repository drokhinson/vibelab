#!/usr/bin/env node
// check-view-shell.mjs — every registered view has a container, and vice versa.
//
//     node projects/boardgame-buddy/tools/check-view-shell.mjs
//
// THE BUG THIS EXISTS FOR, and why it is worth a file of its own.
//
// A view is three independent declarations in three different files, and
// nothing makes them agree:
//
//   * `<main data-view="x">` in index.html — the container it paints into;
//   * `window.router.register("x", …)` in init.js — the name it answers to;
//   * a path row in domain/view.js — the URL that reaches it.
//
// Miss the FIRST one and the failure is silent and total. `View#container` is
// `document.querySelector('[data-view="<name>"]')`, so it answers null; the
// router's `_shell().views` is one `querySelectorAll("[data-view]")` taken off
// the static shell, so there is nothing to unhide; and the view's own render()
// throws on `null.innerHTML` from inside the router's navigation, where no
// user-facing error surfaces. The result is a **blank page** reached by a real
// link from a real screen — which is exactly what shipped for admin-rulebooks
// between 052 and this check: the spoke's view, its route, its path row, its
// script tag, its API client and its Settings entry were all present and
// correct, and the one `<main>` was not.
//
// Nothing in the app can catch this at runtime, because the shell is static
// markup and the register call is code — they never meet until somebody
// navigates. That is the definition of what a build-time check is for, and
// why this one is a plain text scan rather than a VM harness: the two facts it
// compares are declarations, not behaviour, and parsing them is the whole job.
//
// THE OTHER DIRECTION IS ALSO A BUG, just a cheaper one: a container with no
// registration is a dead `<main>` the bundler ships and `sw.js` precaches
// around, usually the residue of a deleted view (ui-object-design.md §5 —
// delete the function, the export, the script tag AND the markup).
import fs from "node:fs";

const W = "/home/user/vibelab/projects/boardgame-buddy/web";

let fails = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const html = fs.readFileSync(`${W}/index.html`, "utf8");
const init = fs.readFileSync(`${W}/init.js`, "utf8");
const view = fs.readFileSync(`${W}/domain/view.js`, "utf8");

// The shell's containers. Every [data-view] in index.html, which is precisely
// what Router._shell() collects at boot — same selector, so this cannot drift
// from what the router will actually find.
const containers = new Set([...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]));

// The registered views. `window.router.register("name", instance)` is the only
// way a name becomes reachable.
const registered = new Set(
  [...init.matchAll(/window\.router\.register\(\s*"([^"]+)"/g)].map((m) => m[1])
);

// The path table's rows, each as { name, alias }. Split on the row opener
// rather than matching a whole object literal: the rows are multi-line and a
// regex that tried to span one would have to know which brace closes it.
//
// An ALIAS row is not a view and must not be checked as one. Eight of them
// exist — /profile/wishlist is `collection` with a shelf param, /admin is
// `settings`, /settings/import-photos is `import-wizard` with a source — and
// what has to resolve is the alias TARGET, not the row's own name.
const routed = view
  .split(/\{\s*name:\s*"/)
  .slice(1)
  .map((chunk) => {
    // Stop at the row's own end so a later row's alias is not read as this
    // row's: rows are separated by `},` and none of them nests an object
    // before its alias.
    const end = chunk.indexOf("},");
    const row = end === -1 ? chunk : chunk.slice(0, end);
    return {
      name: chunk.slice(0, chunk.indexOf('"')),
      alias: (row.match(/alias:\s*"([^"]+)"/) || [])[1] || null,
      // `pattern:` is what makes a row a route, and it drops any unrelated
      // `{ name: "…" }` literal elsewhere in the file.
      isRoute: row.includes("pattern:"),
    };
  })
  .filter((r) => r.isRoute);

console.log("every registered view can paint");
const noContainer = [...registered].filter((n) => !containers.has(n)).sort();
ok(
  `all ${registered.size} registered views have a <main data-view> in index.html`,
  noContainer.length === 0,
  noContainer.length ? `missing container for: ${noContainer.join(", ")}` : ""
);

console.log("no dead containers");
const unregistered = [...containers].filter((n) => !registered.has(n)).sort();
ok(
  `all ${containers.size} containers belong to a registered view`,
  unregistered.length === 0,
  unregistered.length ? `no register() for: ${unregistered.join(", ")}` : ""
);

console.log("every route reaches a view");
// What a route must resolve to: its alias target where it has one, its own
// name otherwise. A miss here is a dead DEEP LINK — the router logs
// "Unknown view:" and leaves the user where they were — which is milder than
// a blank page but just as invisible in review.
const unrouted = routed
  .filter((r) => !registered.has(r.alias || r.name))
  .map((r) => (r.alias ? `${r.name} → ${r.alias}` : r.name))
  .sort();
ok(
  `all ${routed.length} path-table routes resolve to a registered view`,
  unrouted.length === 0,
  unrouted.length ? `unresolvable: ${unrouted.join(", ")}` : ""
);

// The alias rows are the reason the check above is not a plain set difference,
// so assert that some exist. If a refactor turned them into something this
// parser cannot see, the check above would go back to passing vacuously on the
// rows it silently dropped.
const aliased = routed.filter((r) => r.alias);
ok(`the ${aliased.length} alias rows were recognised as aliases`, aliased.length >= 5,
   `found ${aliased.length}`);

// A sanity floor on the scan itself. A regex that stops matching — because
// index.html reformats, or register() grows an argument — would otherwise make
// this file pass loudly while checking nothing at all, which is worse than not
// having it.
console.log("the scan actually found something");
ok("containers were parsed", containers.size > 20, `found ${containers.size}`);
ok("registrations were parsed", registered.size > 20, `found ${registered.size}`);
ok("path rows were parsed", routed.length > 20, `found ${routed.length}`);

console.log(fails ? `\n${fails} FAILED` : "\nall assertions passed");
process.exit(fails ? 1 : 0);
