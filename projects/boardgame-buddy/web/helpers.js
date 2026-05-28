// helpers.js — small utilities shared across the OOP frontend.
// The legacy apiFetch / showView / trackEvent / state-coupled helpers have
// moved to the domain layer (api.js, view.js) and to the individual views.

function bggImg(url) {
  if (!url) return null;
  if (url.startsWith("//")) return "https:" + url;
  return url;
}

function computeInitials(name) {
  const parts = (name || "").trim().split(/[\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] || "?").slice(0, 2).toUpperCase();
}

function playerRange(min, max) {
  if (!min && !max) return "";
  if (min === max) return `${min}P`;
  return `${min || "?"}–${max || "?"}P`;
}

function formatTime(minutes) {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h${m}m` : `${h}h`;
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

// JS-string escape for safely embedding text inside inline onclicks
// (e.g. `onclick="...router.go('game-detail',{gameName:'${jsStr(name)}'})"`).
// Handles backslashes, single quotes, and newlines — that's enough for
// every place we use it today.
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
 * untouched; everything else is decoded, downscaled to a 1920px max edge, and
 * re-encoded as JPEG so the upload stays under the backend cap.
 * @param {File} file
 * @returns {Promise<PreparedPhoto>}
 */
async function preparePhotoForUpload(file) {
  if (!file) return { ok: false, error: "No file selected." };

  if (file.size < _PHOTO_FAST_PATH_BYTES && _ALLOWED_PHOTO_MIME.has(file.type)) {
    return { ok: true, file, originalSize: file.size, compressedSize: file.size, compressed: false };
  }

  let source = null;
  try { source = await createImageBitmap(file); } catch (_) { /* fall through */ }
  if (!source) source = await _loadImageViaTag(file);
  if (!source) return { ok: false, error: "Couldn't read that photo — try a JPG or PNG." };

  const srcW = source.width || source.naturalWidth;
  const srcH = source.height || source.naturalHeight;
  const scale = Math.min(1, _PHOTO_MAX_EDGE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, error: "Couldn't compress that photo — try a different one." };
  ctx.drawImage(source, 0, 0, w, h);

  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", _PHOTO_JPEG_QUALITY));
  if (!blob) return { ok: false, error: "Couldn't compress that photo — try a different one." };
  if (blob.size > window.MAX_PHOTO_BYTES) {
    const mb = (blob.size / 1048576).toFixed(1);
    return { ok: false, error: `Photo is ${mb} MB after compression — max is 5 MB.` };
  }

  const baseName = (file.name || "photo").replace(/\.[^.]+$/, "");
  const out = new File([blob], baseName + ".jpg", { type: "image/jpeg", lastModified: Date.now() });
  return { ok: true, file: out, originalSize: file.size, compressedSize: out.size, compressed: true };
}
window.preparePhotoForUpload = preparePhotoForUpload;
