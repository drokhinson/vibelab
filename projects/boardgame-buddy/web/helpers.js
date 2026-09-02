// helpers.js — small utilities shared across the OOP frontend.
// The legacy apiFetch / showView / trackEvent / state-coupled helpers have
// moved to the domain layer (api.js, view.js) and to the individual views.

// Warm the TLS connections to the two origins every boot hits: the API
// (Railway) and Supabase auth. This file is the second script in the document,
// so the handshakes overlap with the ~50 script fetches still to come instead
// of starting cold when the first request finally fires. Lives here rather
// than as static <link>s in index.html because both origins come from
// APP_CONFIG, which build.sh generates per environment.
(function preconnectApiOrigins() {
  const cfg = window.APP_CONFIG || {};
  for (const url of [cfg.apiBase, cfg.supabaseUrl]) {
    if (!url) continue;
    let origin;
    try { origin = new URL(url).origin; } catch (_) { continue; }
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = origin;
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  }
})();

function computeInitials(name) {
  const parts = (name || "").trim().split(/[\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] || "?").slice(0, 2).toUpperCase();
}

// Drop a leading base-game name from an expansion's name, for surfaces where
// the base game is already the surrounding context — a game page's expansion
// reel, the host's Gather picker, the guide's expansion chips, a play's
// expansion list. "Carcassonne: Abbey & Mayor" reads as "Abbey & Mayor" there.
//
// Display only: the stored name is untouched, so the expansion's own detail
// page, the collection grid, search and the feed still show it in full.
//
// Mirrors the backend's _strip_base_prefix at
// shared-backend/routes/boardgame_buddy/expansion_routes.py — keep in sync.
// Falls back to the original when the base name isn't a prefix, or when
// stripping it would leave nothing behind.
function stripBaseGameName(name, baseName) {
  const raw = String(name ?? "").trim();
  const base = String(baseName ?? "").trim();
  if (!raw || !base) return raw;
  // Escape the base name — real titles carry regex metacharacters
  // ("7 Wonders (Duel)", "Brass: Birmingham").
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = raw.replace(new RegExp(`^${escaped}\\s*[:\\-–—,]\\s*`, "i"), "").trim();
  return stripped || raw;
}

// Pick a game's artwork URL at the resolution the surface actually needs.
//
// Every game carries two re-hosted images: `image_url` is BGG's full-size box
// art (commonly 800-1200px) and `thumbnail_url` is BGG's <thumbnail>, which is
// only ~150-200px on its long edge. Tiles that crop with `object-fit: cover`
// are 110-145 CSS px wide, so on any 2-3x display the thumbnail is being
// upscaled — that is the blur. Anything that size or larger asks for "card".
//
// "chip" is for the <=48px marks (finder rows, game chips, list thumbs) where
// the full-size art would be pure wasted bandwidth.
//
// Either size falls back to the other: `image_url` is null for games whose
// Storage upload failed, and payloads cached before the API started sending it
// have no such key at all.
function gameArtSrc(game, size) {
  const g = game || {};
  const full = g.image_url || "";
  const thumb = g.thumbnail_url || "";
  return (size === "chip" ? (thumb || full) : (full || thumb)) || "";
}

// Progressive upgrade for "card" surfaces: paint the thumbnail, then swap in
// the full art once it has decoded.
//
// Measured on a throttled 12-tile grid (the collection grid's first screen):
// going straight to the full art left the boxes empty for 7.4s on slow 4G and
// 1.3s on fast 4G. Painting the thumbnail first cuts that to ~0.7s / ~0.15s —
// roughly 10x — for about 8% more bytes and 8% longer to reach fully sharp.
//
// Kicked off from the thumbnail's own load event rather than firing both
// requests at once: on a bandwidth-bound link the two are within noise of each
// other, and this way the browser's lazy-loading still gates BOTH requests, so
// an off-screen tile costs nothing.
function upgradeGameArt(img) {
  const hi = img && img.getAttribute("data-hi");
  if (!hi) return;
  img.removeAttribute("data-hi");   // once only — the swap re-fires onload
  const full = new Image();
  full.decoding = "async";
  full.onload = () => {
    // Decode before swapping so the paint is a straight substitution rather
    // than a blank frame. Older browsers have no decode(); swap directly.
    const swap = () => { img.src = hi; };
    if (full.decode) full.decode().then(swap, swap);
    else swap();
  };
  full.src = hi;
}
window.upgradeGameArt = upgradeGameArt;

// One <img> for a game's artwork. Returns "" when the game has no art at all,
// so callers can fall back to their own placeholder.
//
// For "card" it emits the thumbnail as src with the full art in data-hi, and
// an inline onload that promotes it (matching this codebase's inline-handler
// style — there is no post-render hook every view goes through). When the
// thumbnail is missing, or is the only image, src is just gameArtSrc and no
// upgrade is scheduled. onerror covers a thumbnail that 404s: go straight to
// the full art rather than leaving a broken tile.
function gameArtImg(game, size, { cls = "", alt = "", width = null, height = null, eager = false } = {}) {
  const g = game || {};
  const full = g.image_url || "";
  const thumb = g.thumbnail_url || "";
  const src = gameArtSrc(g, size);
  if (!src) return "";
  const upgrade = size !== "chip" && full && thumb && full !== thumb;
  const a = [
    cls ? `class="${escapeAttr(cls)}"` : "",
    `src="${escapeAttr(upgrade ? thumb : src)}"`,
    upgrade ? `data-hi="${escapeAttr(full)}"` : "",
    upgrade ? `onload="window.upgradeGameArt(this)"` : "",
    upgrade ? `onerror="this.onerror=null;this.src=this.getAttribute('data-hi')||this.src"` : "",
    `alt="${escapeAttr(alt)}"`,
    width != null ? `width="${width}"` : "",
    height != null ? `height="${height}"` : "",
    eager ? "" : `loading="lazy"`,
    `decoding="async"`,
  ].filter(Boolean);
  return `<img ${a.join(" ")} />`;
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

// HTML-escape for any untrusted text interpolated into a template literal.
// Every module used to carry its own copy of this; they all delegate here now
// so the escaping rules live in exactly one place.
const ESCAPE_MAP = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

// Same escaping, named for the attribute-value case so call sites read as
// intended. Quotes are already covered, so one implementation serves both.
function escapeAttr(s) {
  return escapeHtml(s);
}

// JS-string escape for text embedded inside an inline handler.
//
// This is ONE of the two layers such a handler needs, and it is the inner one:
// it closes the JS string literal. The handler is itself written inside a
// double-quoted HTML attribute, and jsStr deliberately does NOT escape a
// double quote — so the whole handler must also go through escapeAttr():
//
//   onclick="${escapeAttr(`…go('game-detail',{gameName:'${jsStr(name)}'})`)}"
//
// The browser decodes the entities before the JS parser ever sees the string,
// so the value arrives intact. Skipping the outer layer means any name
// containing a double quote ends the attribute early — which is a rendering
// bug for text the user typed themselves, and an injection for text somebody
// else typed.
function jsStr(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n");
}

// Bouncing-buddy loader. Returns an HTML fragment views can drop into
// any "Loading…" slot. The SVG already animates itself (transform-based
// bounce + head bob), so this is just a sized <img> wrapper that
// centres the mark and optionally captions it.
function buddyLoader({ size = 96, label = null, padded = true } = {}) {
  const safe = String(label || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  return `
    <div class="buddy-loader ${padded ? "buddy-loader--padded" : ""}">
      <img src="assets/illustrations/bgb-loading.svg" alt="Loading"
           class="buddy-loader__mark"
           style="width:${size}px;height:${size}px;" />
      ${label ? `<div class="buddy-loader__label">${safe}</div>` : ""}
    </div>
  `;
}

// Game-art loader. Same surround as buddyLoader, but the mark is the board
// game's own cover/thumbnail (with a gentle breathing pulse) so a guide that's
// loading chapters shows the game being loaded. Falls back to the bouncing
// buddy when no image is available (e.g. a game with no art).
function gameLoader({ image, size = 96, label = null, padded = true } = {}) {
  if (!image) return buddyLoader({ size, label, padded });
  const safeLabel = String(label || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  const safeSrc = String(image).replace(/"/g, "&quot;");
  return `
    <div class="buddy-loader game-loader ${padded ? "buddy-loader--padded" : ""}">
      <img src="${safeSrc}" alt="Loading"
           class="game-loader__mark"
           style="width:${size}px;height:${size}px;" />
      ${label ? `<div class="buddy-loader__label">${safeLabel}</div>` : ""}
    </div>
  `;
}

function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.className = `toast toast-end toast-top`;
  toast.innerHTML = `<div class="alert alert-${type}"><span>${message}</span></div>`;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3000);
}

// Photo prep. Mirrors the backend's _MAX_PHOTO_BYTES + MIME whitelist at
// shared-backend/routes/boardgame_buddy/play_routes.py — keep in sync.
// iPhone 12MP shots regularly come in at 6–10 MB and iOS Safari can hand
// HEIC straight through, both of which the backend rejects. Re-encoding to
// a 1920px-edge JPEG via canvas drops them under the cap and normalizes
// HEIC to a format the backend accepts.
window.MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MiB
const _ALLOWED_PHOTO_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const _PHOTO_MAX_EDGE = 1920;
const _PHOTO_JPEG_QUALITY = 0.85;
const _PHOTO_FAST_PATH_BYTES = 1024 * 1024; // 1 MiB

/**
 * The second caller's budget: a photographed NOTE, read by the model and then
 * thrown away, rather than a play photo kept forever. Different numbers for
 * different reasons — a bigger edge because the thing being preserved is
 * legible handwriting rather than a nice picture, a tighter byte cap because
 * four of these ride inline in one JSON request as base64 (which inflates them
 * by a third), and no GIF because the parse endpoint's own MIME list has none.
 * Mirrors MAX_IMPORT_IMAGE_BYTES in the backend's constants.py.
 */
window.IMPORT_PHOTO_OPTS = {
  maxEdge: 2000,
  quality: 0.8,
  maxBytes: 4 * 1024 * 1024,
  allowedTypes: ["image/jpeg", "image/png", "image/webp"],
};

/**
 * @typedef {{ ok: true, file: File, originalSize: number, compressedSize: number, compressed: boolean }
 *        | { ok: false, error: string }} PreparedPhoto
 */

function _loadImageViaTag(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/**
 * Prepare a user-picked photo for upload. Small allowed formats pass through
 * untouched; everything else is decoded, downscaled to a max edge, and
 * re-encoded as JPEG so the upload stays under the backend cap.
 *
 * `opts` exists because the two callers are photographing different things for
 * different lifetimes — see IMPORT_PHOTO_OPTS. Omitted, the defaults are the
 * play-photo ones this function was written for, so its original call site
 * reads exactly as it did.
 * @param {File} file
 * @param {{maxEdge?: number, quality?: number, maxBytes?: number, allowedTypes?: string[]}} [opts]
 * @returns {Promise<PreparedPhoto>}
 */
async function preparePhotoForUpload(file, opts) {
  if (!file) return { ok: false, error: "No file selected." };
  const o = opts || {};
  const maxEdge = o.maxEdge || _PHOTO_MAX_EDGE;
  const quality = o.quality || _PHOTO_JPEG_QUALITY;
  const maxBytes = o.maxBytes || window.MAX_PHOTO_BYTES;
  const allowed = o.allowedTypes ? new Set(o.allowedTypes) : _ALLOWED_PHOTO_MIME;

  if (file.size < _PHOTO_FAST_PATH_BYTES && allowed.has(file.type)) {
    return { ok: true, file, originalSize: file.size, compressedSize: file.size, compressed: false };
  }

  let source = null;
  try { source = await createImageBitmap(file); } catch (_) { /* fall through */ }
  if (!source) source = await _loadImageViaTag(file);
  if (!source) return { ok: false, error: "Couldn't read that photo — try a JPG or PNG." };

  const srcW = source.width || source.naturalWidth;
  const srcH = source.height || source.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, error: "Couldn't compress that photo — try a different one." };
  ctx.drawImage(source, 0, 0, w, h);

  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  if (!blob) return { ok: false, error: "Couldn't compress that photo — try a different one." };
  if (blob.size > maxBytes) {
    const mb = (blob.size / 1048576).toFixed(1);
    const cap = Math.round(maxBytes / 1048576);
    return { ok: false, error: `Photo is ${mb} MB after compression — max is ${cap} MB.` };
  }

  const baseName = (file.name || "photo").replace(/\.[^.]+$/, "");
  const out = new File([blob], baseName + ".jpg", { type: "image/jpeg", lastModified: Date.now() });
  return { ok: true, file: out, originalSize: file.size, compressedSize: out.size, compressed: true };
}
window.preparePhotoForUpload = preparePhotoForUpload;

/**
 * A prepared file as bare base64 — no `data:` prefix, which is what an API
 * body wants and what the play importer's parse endpoint validates. Rejects
 * rather than resolving empty, so a caller cannot post an empty image and get
 * a model error back instead of a read error.
 * @param {File|Blob} file
 * @returns {Promise<string>}
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const comma = text.indexOf(",");
      const data = comma === -1 ? "" : text.slice(comma + 1);
      if (data) resolve(data);
      else reject(new Error("Couldn't read that photo."));
    };
    reader.onerror = () => reject(new Error("Couldn't read that photo."));
    reader.readAsDataURL(file);
  });
}
window.fileToBase64 = fileToBase64;
