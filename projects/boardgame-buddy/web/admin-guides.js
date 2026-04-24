// admin-guides.js — Admin view for uploading agent-generated guide bundles.
// Accessed via ?admin=1 in the URL. Uses the ADMIN_API_KEY (not the user session).

const ADMIN_VIEW = "admin-guides";

let adminPendingBundle = null;

function isAdminMode() {
  return new URLSearchParams(window.location.search).get("admin") === "1";
}

function getAdminKey() {
  let key = sessionStorage.getItem("bgbAdminKey");
  if (!key) {
    key = window.prompt("Admin API key:");
    if (key) sessionStorage.setItem("bgbAdminKey", key);
  }
  return key;
}

function clearAdminKey() {
  sessionStorage.removeItem("bgbAdminKey");
}

function renderAdminGuides() {
  const view = document.querySelector('[data-view="admin-guides"]');
  if (!view) return;
  adminPendingBundle = null;
  view.innerHTML = `
    <div class="flex items-center gap-2 mb-3">
      <button class="btn btn-ghost btn-sm btn-square" onclick="showView('closet')" title="Back">
        <i data-lucide="arrow-left" class="w-4 h-4"></i>
      </button>
      <h2 class="text-lg font-bold flex items-center gap-2">
        <i data-lucide="upload-cloud" class="w-5 h-5"></i> Import Guide Bundle
      </h2>
    </div>
    <p class="text-sm text-base-content/70 mb-4">
      Upload a JSON bundle produced by <code class="text-xs">/guide-from-rulebook</code>.
      Requires the admin API key.
    </p>

    <div class="form-control mb-3">
      <label class="label"><span class="label-text">Guide JSON file</span></label>
      <input type="file" id="admin-guide-file" accept="application/json"
             class="file-input file-input-bordered file-input-sm w-full" />
    </div>

    <label class="label cursor-pointer justify-start gap-2 mb-3">
      <input type="checkbox" id="admin-guide-force" class="checkbox checkbox-sm" />
      <span class="label-text">Replace existing seed chunks (keeps user chunks)</span>
    </label>

    <div id="admin-guide-preview" class="mb-3"></div>

    <div class="flex gap-2">
      <button id="admin-guide-submit" class="btn btn-primary btn-sm" disabled>
        <i data-lucide="upload" class="w-4 h-4"></i> Import
      </button>
      <button class="btn btn-ghost btn-sm" onclick="clearAdminKey(); showToast('Admin key cleared', 'info')">
        Forget key
      </button>
    </div>
  `;
  if (window.lucide) window.lucide.createIcons();

  document.getElementById("admin-guide-file").addEventListener("change", handleAdminFileSelect);
  document.getElementById("admin-guide-submit").addEventListener("click", handleAdminUpload);
}

async function handleAdminFileSelect(e) {
  const file = e.target.files?.[0];
  const preview = document.getElementById("admin-guide-preview");
  const submit = document.getElementById("admin-guide-submit");
  if (!file) {
    adminPendingBundle = null;
    preview.innerHTML = "";
    submit.disabled = true;
    return;
  }
  try {
    const text = await file.text();
    const bundle = JSON.parse(text);
    if (!bundle.game?.bgg_id || !Array.isArray(bundle.chunks)) {
      throw new Error("Missing required fields: game.bgg_id and chunks[]");
    }
    adminPendingBundle = bundle;
    preview.innerHTML = renderBundlePreview(bundle);
    if (window.lucide) window.lucide.createIcons();
    submit.disabled = false;
  } catch (err) {
    adminPendingBundle = null;
    preview.innerHTML = `<div class="alert alert-error text-sm"><i data-lucide="alert-circle" class="w-4 h-4"></i> ${err.message}</div>`;
    if (window.lucide) window.lucide.createIcons();
    submit.disabled = true;
  }
}

function renderBundlePreview(bundle) {
  const missing = bundle.source?.missing || [];
  const chunkRows = bundle.chunks.map(c => `
    <tr>
      <td class="text-xs"><span class="badge badge-sm badge-ghost">${escapeHtml(c.chunk_type)}</span></td>
      <td class="text-sm">${escapeHtml(c.title)}</td>
      <td class="text-xs text-base-content/60">${(c.content || "").length} chars</td>
    </tr>
  `).join("");
  return `
    <div class="card bg-base-200 p-3">
      <div class="flex items-center justify-between mb-2">
        <div>
          <div class="font-bold">${escapeHtml(bundle.game.name)}</div>
          <div class="text-xs text-base-content/60">BGG #${bundle.game.bgg_id} · ${bundle.chunks.length} chunks</div>
        </div>
        ${missing.length ? `<span class="badge badge-warning badge-sm">missing: ${missing.join(", ")}</span>` : ""}
      </div>
      <div class="overflow-x-auto">
        <table class="table table-xs">
          <thead><tr><th>Type</th><th>Title</th><th>Size</th></tr></thead>
          <tbody>${chunkRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

async function handleAdminUpload() {
  if (!adminPendingBundle) return;
  const key = getAdminKey();
  if (!key) return;
  const force = document.getElementById("admin-guide-force").checked;
  const submit = document.getElementById("admin-guide-submit");
  submit.disabled = true;
  submit.classList.add("loading");

  try {
    const res = await fetch(
      `${API}${PREFIX}/guides/import?force=${force ? "true" : "false"}`,
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(adminPendingBundle),
      },
    );
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) clearAdminKey();
      throw new Error(body.detail || res.statusText);
    }
    showToast(
      `Imported ${body.chunks_inserted} chunk(s), skipped ${body.chunks_skipped}`,
      "success",
    );
  } catch (err) {
    showToast("Import failed: " + err.message, "error");
  } finally {
    submit.classList.remove("loading");
    submit.disabled = false;
  }
}
