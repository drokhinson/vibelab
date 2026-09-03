// .github/scripts/bgb-bundle.mjs — deploy-artifact-only bundler for boardgame-buddy.
//
// WHY THIS EXISTS
// ---------------
// index.html loads ~120 vanilla <script src> tags. That is the project's
// authoring model on purpose (.claude/rules/web-frontend.md: no npm, no
// bundler, no build step) and it is genuinely nice to work in — but shipped
// verbatim it means every visitor fetches ~120 files and ~1.9 MB of
// unminified JS, 39% of which is comments, before a single line of the app
// can run. That wait IS the loading screen users were reporting.
//
// So the repo keeps its 120 tags and local dev is untouched; this rewrites the
// CHECKOUT that `vercel deploy` uploads, and nothing is committed back. That
// is the same move the Tailwind precompile step already makes for the
// DaisyUI/Tailwind CDN pair, and it lives here rather than as a heredoc in the
// workflow so the two deploy workflows share one copy instead of drifting.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
// * No `esbuild --bundle`. These are classic scripts sharing one global scope,
//   not modules. Bundling would wrap them and change the scoping of every
//   top-level let/const/class.
// * No `--minify-identifiers`. The bytes are in the comments, not the names;
//   mangling adds a few percent and is the only part with real risk, given
//   inline onclick="window.router.go('feed')" handlers and dynamic global
//   lookups like window[host]._setRoundScore(...).
// * config.js is left out and stays first. It is generated per-environment by
//   build.sh and read by the inline preconnect block right after it.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const WEB = process.argv[2] || ".";
// Fail rather than ship a bundle that has quietly grown. Gzipped, because that
// is what crosses the wire. Raise deliberately, with a reason.
const GZIP_BUDGET = Number(process.env.BGB_JS_GZIP_BUDGET || 450 * 1024);

const die = (msg) => { console.error("bgb-bundle: " + msg); process.exit(1); };
const rel = (p) => path.join(WEB, p);
const sha8 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);

const htmlPath = rel("index.html");
let html = fs.readFileSync(htmlPath, "utf8");

// ── 1. The script list, in document order ────────────────────────────────────
// index.html IS the manifest — the same property sw.js relies on for its
// precache sweep. A module added as a tag is picked up here automatically, so
// there is no second list to keep in step.
const TAG = /^[ \t]*<script src="([^"]+)"><\/script>[ \t]*\n?/gm;
const tags = [...html.matchAll(TAG)];
const sources = tags
  .map((m) => m[1])
  .filter((s) => !/^https?:/.test(s) && s !== "config.js");

if (sources.length < 50) die(`only ${sources.length} script tags found — index.html has drifted`);
for (const s of sources) {
  if (!fs.existsSync(rel(s))) die(`index.html references ${s}, which does not exist`);
}

// ── 2. Concatenate ───────────────────────────────────────────────────────────
// The "\n;\n" separator is load-bearing. A file whose last statement has no
// semicolon, followed by one that opens with "(function () {", parses as a
// call on the previous expression rather than as a new IIFE — and this
// codebase is ~120 IIFEs in a row.
const combined = sources
  .map((s) => `/*<< ${s} >>*/\n` + fs.readFileSync(rel(s), "utf8"))
  .join("\n;\n");

// Output lands at the SITE ROOT, beside the hashed stylesheet — deliberately
// not in build/ or dist/ or out/. Those are output-directory names Vercel's
// zero-config framework detection knows, and a static project that suddenly
// grows one risks having it treated as the deploy root, which would serve the
// bundle and 404 everything else. bgb-*.<sha>.* has no convention attached.
const rawPath = rel("bgb-app.raw.js");
fs.writeFileSync(rawPath, combined);

// ── 3. Minify ────────────────────────────────────────────────────────────────
const esbuild = process.env.ESBUILD_BIN || "npx";
const esbuildArgs = process.env.ESBUILD_BIN
  ? []
  : ["--yes", "esbuild@0.25.10"];
const minPath = rel("bgb-app.min.js");
execFileSync(esbuild, [
  ...esbuildArgs,
  rawPath,
  "--minify-whitespace",
  "--minify-syntax",
  "--target=es2019",
  "--sourcemap",
  "--legal-comments=none",
  `--outfile=${minPath}`,
], { stdio: "inherit" });

// ── 4. Gate before naming ────────────────────────────────────────────────────
// A syntax error here means the concatenation produced something that is not
// valid JS at all. Fail the deploy loudly rather than shipping a shell whose
// every screen is a blank page — the same posture as the Tailwind step's
// `grep -q ".btn-primary"` check.
try {
  execFileSync(process.execPath, ["--check", minPath], { stdio: "pipe" });
} catch (err) {
  die("the bundle is not valid JS:\n" + String(err.stderr || err));
}

const minBuf = fs.readFileSync(minPath);
const gz = gzipSync(minBuf, { level: 9 }).length;
if (gz > GZIP_BUDGET) {
  die(`bundle is ${(gz / 1024).toFixed(0)} KB gzipped, over the ${(GZIP_BUDGET / 1024).toFixed(0)} KB budget. ` +
      "Take something off the boot path, or raise BGB_JS_GZIP_BUDGET with a reason.");
}

const jsHash = sha8(minBuf);
const jsName = `bgb-app.${jsHash}.js`;
fs.renameSync(minPath, rel(jsName));
fs.renameSync(minPath + ".map", rel(jsName + ".map"));
// The sourcemap comment esbuild wrote names the pre-rename file.
fs.writeFileSync(
  rel(jsName),
  fs.readFileSync(rel(jsName), "utf8")
     .replace(/\/\/# sourceMappingURL=bgb-app\.min\.js\.map/, `//# sourceMappingURL=${jsName}.map`),
);
fs.unlinkSync(rawPath);

// ── 5. The stylesheet ────────────────────────────────────────────────────────
// Also at the root, and for a second reason beyond the Vercel one above:
// styles.css has no url() today, but a stylesheet moved into a subdirectory
// would resolve a future url(assets/…) against that subdirectory and 404
// silently. Staying at the root makes that class of bug impossible.
// sw.js reads this file's name out of the shell rather than hardcoding it, so
// the hash can change every deploy without stranding the precache.
const cssRaw = fs.readFileSync(rel("styles.css"));
const cssTmp = rel("styles.min.css");
execFileSync(esbuild, [
  ...esbuildArgs, rel("styles.css"), "--minify", "--loader:.css=css", `--outfile=${cssTmp}`,
], { stdio: "inherit" });
const cssBuf = fs.readFileSync(cssTmp);
const cssName = `bgb-${sha8(cssBuf)}.css`;
fs.renameSync(cssTmp, rel(cssName));

// ── 6. Rewrite index.html ────────────────────────────────────────────────────
// The first bundled tag becomes the bundle; the rest are dropped. Replacing in
// place rather than appending keeps document order intact — config.js and the
// inline preconnect block that reads window.APP_CONFIG both sit above the
// first bundled tag and must stay there.
let replaced = false;
html = html.replace(TAG, (whole, src) => {
  if (/^https?:/.test(src) || src === "config.js") return whole;
  if (replaced) return "";
  replaced = true;
  return `  <script src="${jsName}"></script>\n`;
});
if (!replaced) die("no script tag was replaced — index.html has drifted");

const cssLink = /<link rel="stylesheet" href="styles\.css"\s*\/?>/;
if (!cssLink.test(html)) die("styles.css <link> not found in index.html");
html = html.replace(cssLink, `<link rel="stylesheet" href="${cssName}" />`);

fs.writeFileSync(htmlPath, html);

// styles.css itself is left in the artifact on purpose. Nothing references it
// any more, so it is never fetched; deleting it would only add a way for a
// stale shell to 404 on the one file it needs to render anything.

const rawKB = (Buffer.byteLength(combined) / 1024).toFixed(0);
console.log(
  `bgb-bundle: ${sources.length} files, ${rawKB} KB raw -> ` +
  `${(minBuf.length / 1024).toFixed(0)} KB min, ${(gz / 1024).toFixed(0)} KB gzipped ` +
  `(budget ${(GZIP_BUDGET / 1024).toFixed(0)} KB)\n` +
  `            ${jsName} + ${cssName} ` +
  `(css ${(cssRaw.length / 1024).toFixed(0)} -> ${(cssBuf.length / 1024).toFixed(0)} KB)`,
);
