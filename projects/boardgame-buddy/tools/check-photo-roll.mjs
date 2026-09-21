#!/usr/bin/env node
// check-photo-roll.mjs — assert that an in-app camera shot can still reach the
// user's camera roll.
//
//     node projects/boardgame-buddy/tools/check-photo-roll.mjs
//
// THE BUG THIS EXISTS FOR, which is a platform fact and therefore permanent:
//
// A photo taken through `<input type="file" accept="image/*">` → "Take Photo"
// on iOS is handed to the page and to NOWHERE else. WebKit never writes it to
// the Photos library, no attribute asks it to, and an installed PWA behaves
// exactly like a Safari tab. So a host who frames a shot at the end of a game,
// logs the play and later goes looking for the picture in Photos finds nothing
// — and reads that as BoardgameBuddy having lost their photo.
//
// `navigator.share({ files })` is the only route a web page has to the camera
// roll: the iOS share sheet's "Save Image" writes there, `<a download>` reaches
// Files instead, and a canvas copy reaches neither. Three things keep that
// route open, and every one of them fails silently on its own — there is no
// error, no console warning, just a photo that is not in Photos:
//
//   1. ui/save-to-photos.js SHARES THE USER'S OWN FILE, not the upload copy.
//      helpers.js downscales to 1920px and re-encodes at q=0.85 for the bucket;
//      hand *that* to Photos and the camera roll quietly gets a thumbnail of a
//      12MP original. The prepared copy is the fallback only.
//   2. BOTH PHOTO CALL SITES RETAIN that source file and RENDER the control.
//      A draft that drops the source file, or a preview with no plate on it,
//      takes the route away without changing anything a reader would notice.
//   3. THE SOURCE FILE NEVER LEAVES THE DEVICE. It is the un-stripped original
//      — EXIF, GPS and all — and the whole point of the re-encode is that the
//      bucket gets the scrubbed copy. A future upload path that reaches for
//      "the better file" would turn a camera-roll fix into a privacy leak.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const W = path.join(HERE, "..", "web");

let fails = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`  PASS ${name}`);
  else { fails++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const read = (rel) => fs.readFileSync(path.join(W, rel), "utf8");

const MODULE = read("ui/save-to-photos.js");

// ── The module, against a fake platform ─────────────────────────────────────

const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Safari";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/124 Mobile";

/**
 * Instantiate SaveToPhotos over a stub navigator.
 *
 * @param {{ios?: boolean, takes?: (f: any) => boolean, share?: (d: any) => Promise<any>}} opts
 */
function load(opts) {
  const o = opts || {};
  const toasts = [];
  const shared = [];
  class File {
    constructor(name, type) { this.name = name; this.type = type; }
  }
  const navigator = {
    userAgent: o.ios === false ? ANDROID_UA : IOS_UA,
    maxTouchPoints: o.ios === false ? 0 : 5,
    canShare: (d) => (o.takes || (() => true))(d.files[0]),
    share: (d) => {
      shared.push(d.files[0]);
      return o.share ? o.share(d) : Promise.resolve();
    },
  };
  const sandbox = { navigator, File, showToast: (m, t) => toasts.push([m, t]) };
  sandbox.window = sandbox;
  vm.runInContext(MODULE, vm.createContext(sandbox));
  return { S: sandbox.SaveToPhotos, File, toasts, shared };
}

const abort = () => {
  const e = new Error("dismissed");
  e.name = "AbortError";
  return Promise.reject(e);
};

console.log("\nthe control is offered exactly where the gap is");
{
  const { S, File } = load({});
  ok("iOS, with a capture in hand", S.offered(new File("image.jpg", "image/jpeg"), null));
}
{
  // Chrome hands the capture to the system camera app, which writes to the
  // gallery itself. An affordance here would only mint duplicates.
  const { S, File } = load({ ios: false });
  ok("...but never on Android",
     S.offered(new File("image.jpg", "image/jpeg"), null) === false);
}
{
  const { S } = load({});
  ok("...and never for a photo that is only a url",
     S.offered(null, null) === false,
     "an already-uploaded photo has no local file to hand over");
}
{
  const { S, File } = load({ takes: () => false });
  ok("...and never where the platform refuses every file",
     S.offered(new File("image.jpg", "image/jpeg"),
               new File("image.jpg", "image/jpeg")) === false);
}

console.log("\nit hands over the shot the user actually took");
{
  const { S, File, shared } = load({});
  const source = new File("IMG_4821.jpg", "image/jpeg");
  const prepared = new File("IMG_4821.jpg", "image/jpeg");
  await S.save(source, prepared);
  ok("the source file, not the 1920px upload copy", shared[0] === source,
     "sharing the prepared copy puts a thumbnail in the camera roll");
}
{
  // An HEIC straight off the camera is the case canShare answers false on,
  // and the prepared JPEG beside it is the whole reason there is a fallback.
  const { S, File, shared } = load({ takes: (f) => f.type === "image/jpeg" });
  const source = new File("IMG_4821.heic", "image/heic");
  const prepared = new File("IMG_4821.jpg", "image/jpeg");
  ok("...but falls back when the platform won't take it", S.offered(source, prepared));
  await S.save(source, prepared);
  ok("...and the fallback is the prepared copy", shared[0] === prepared);
}

console.log("\nit speaks only when something went wrong");
{
  const { S, File, toasts } = load({});
  const r = await S.save(new File("image.jpg", "image/jpeg"), null);
  ok("a completed sheet is silent", r === "shared" && toasts.length === 0,
     "share() resolving means iOS took the file, not that Save Image was the "
     + "action picked — so nothing may claim the photo was saved");
}
{
  const { S, File, toasts } = load({ share: abort });
  const r = await S.save(new File("image.jpg", "image/jpeg"), null);
  ok("a dismissed sheet is silent too", r === "cancelled" && toasts.length === 0,
     "backing out is a decision, not a failure");
}
{
  const { S, File, toasts } = load({ share: () => Promise.reject(new Error("nope")) });
  const r = await S.save(new File("image.jpg", "image/jpeg"), null);
  ok("a real failure says so", r === "failed" && toasts.length === 1);
}
{
  const { S, toasts } = load({});
  const r = await S.save(null, null);
  ok("nothing to save says so", r === "unsupported" && toasts.length === 1);
}

// ── The wiring, against the real files ──────────────────────────────────────

console.log("\nthe module is in the shell");
{
  const html = read("index.html");
  ok("index.html loads ui/save-to-photos.js",
     /<script src="ui\/save-to-photos\.js"><\/script>/.test(html),
     "sw.js derives its precache list from these src= attributes, so a module "
     + "missing here is also missing offline");
  ok("...after install-prompt.js, whose isIOS() it borrows",
     html.indexOf("ui/install-prompt.js") < html.indexOf("ui/save-to-photos.js"));
}

console.log("\nboth photo call sites keep the route open");
for (const [label, rel, host] of [
  ["Settle Up", "views/play-flow-view.js", "playFlowView"],
  ["the play editor", "widgets/play-detail-edit.js", "PlayDetailPopup"],
]) {
  const src = read(rel);
  ok(`${label} retains the source file`, /photoSourceFile = file;/.test(src),
     "without the untouched capture there is only the downscaled copy to save");
  ok(`${label} asks SaveToPhotos whether to draw the control`,
     /SaveToPhotos/.test(src) && /\.offered\(/.test(src));
  ok(`${label} renders it inside the preview`,
     /(\$\{this\._renderPhotoSave\(\)\}|\$\{renderPhotoSave\(\)\})/.test(src));
  ok(`${label} exposes the tap handler on window.${host}`,
     new RegExp(`window\\.${host}\\._savePhotoToRoll\\(\\)`).test(src),
     "share() needs transient activation, so the call has to come from a tap");
  // Whatever tears the pending photo down has to take all of it: a stale
  // source file behind a cleared preview would offer to save the wrong shot.
  const clears = [...src.matchAll(/photoFile = null;/g)].length;
  const clearsSource = [...src.matchAll(/photoSourceFile = null;/g)].length;
  ok(`${label} clears both files together`, clears === clearsSource,
     `${clears} photoFile teardown(s) vs ${clearsSource} for the source`);
}
{
  const ps = read("domain/play-session.js");
  ok("PlaySession.clear() drops the source file too",
     /photoSourceFile = null;/.test(ps));
  const snapshot = ps.slice(ps.indexOf("const snapshot = {"),
                            ps.indexOf("localStorage.setItem(LS_KEY"));
  ok("...and persist() never writes it to disk",
     !/photoSourceFile|photoFile/.test(snapshot),
     "a File does not survive JSON, and the draft is explicitly in-memory");
}

console.log("\nthe original never leaves the device");
for (const rel of ["views/play-flow-view.js", "widgets/play-detail-edit.js"]) {
  const src = read(rel);
  // The source file is the un-stripped original — EXIF, GPS and all. Only the
  // re-encoded copy is cleared for the bucket (see helpers.js#preparePhotoForUpload
  // and domain/exif.js), so the only things allowed to read photoSourceFile are
  // the two SaveToPhotos calls and its own assignment and teardown.
  const reads = [...src.matchAll(/^.*photoSourceFile.*$/gm)].map((m) => m[0].trim());
  const stray = reads.filter((l) =>
    !/photoSourceFile = (file|null),?;?$/.test(l)
    && !/SaveToPhotos|S\.(offered|save)\(|photoSourceFile: null,/.test(l));
  ok(`${rel} reads the original only to save it locally`, stray.length === 0,
     stray.join(" | "));
}

console.log("\nthe plates are styled");
{
  const css = read("styles.css");
  for (const sel of [".cascade-photo__save", ".play-detail__edit-photo-save"]) {
    ok(`${sel} has a rule`, css.includes(sel + " {"));
    ok(`${sel} has a grown hit area`,
       css.includes(sel + '::before { content: ""'),
       "both plates are well under the 44px tap floor on their own");
  }
}

console.log(fails ? `\n${fails} check(s) failed.\n` : "\nAll checks passed.\n");
process.exit(fails ? 1 : 0);
