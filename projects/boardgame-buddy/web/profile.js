// profile.js — Account page: tab bar (Account | Buddies) and account-tab content.
// Buddies tab is rendered by buddies.js (renderBuddiesTab).

// Cached BGG sync status for the current account-tab render. Reset on tab open.
let bggStatus = null;
let bggSyncing = false;
let bggPollTimer = null;

function renderProfile() {
  const container = document.getElementById("profile-content");
  if (!currentUser) {
    container.innerHTML = '<p class="text-sm text-base-content/60">Please log in.</p>';
    return;
  }

  container.innerHTML = `
    <div class="flex items-center gap-2 mb-3">
      <button class="btn btn-ghost btn-sm btn-square" onclick="showView('closet')" title="Back">
        <i data-lucide="arrow-left" class="w-4 h-4"></i>
      </button>
      <h2 class="text-xl font-bold font-display flex items-center gap-2">
        <i data-lucide="user" class="w-5 h-5"></i> Account
      </h2>
    </div>

    <div role="tablist" class="tabs tabs-boxed mb-3">
      <button role="tab" id="profile-tab-account" class="tab" onclick="switchProfileTab('account')">
        <i data-lucide="user" class="w-4 h-4 mr-1"></i> Account
      </button>
      <button role="tab" id="profile-tab-buddies" class="tab" onclick="switchProfileTab('buddies')">
        <i data-lucide="users" class="w-4 h-4 mr-1"></i> Buddies
      </button>
    </div>

    <div id="profile-tab-content"></div>
  `;

  switchProfileTab(profileTab || "account");
}

function switchProfileTab(tab) {
  profileTab = tab;
  document.getElementById("profile-tab-account")?.classList.toggle("tab-active", tab === "account");
  document.getElementById("profile-tab-buddies")?.classList.toggle("tab-active", tab === "buddies");
  if (tab === "buddies") {
    stopBggPolling();
    renderBuddiesTab();
  } else {
    renderAccountTab();
    // Fire-and-forget; the card re-renders itself when the status comes back.
    refreshBggStatus();
  }
  if (window.lucide) window.lucide.createIcons();
}

function renderAccountTab() {
  const container = document.getElementById("profile-tab-content");
  const email = session?.user?.email || "";
  const isAdmin = !!currentUser.is_admin;

  container.innerHTML = `
    <div class="card bg-base-200 mb-3">
      <div class="card-body p-4">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-xs text-base-content/60 uppercase tracking-wide">Display name</div>
            <div class="font-semibold">${escapeHtml(currentUser.display_name || "")}</div>
          </div>
          ${isAdmin ? '<span class="badge badge-primary badge-sm">admin</span>' : ""}
        </div>
        ${email ? `
          <div class="mt-3">
            <div class="text-xs text-base-content/60 uppercase tracking-wide">Email</div>
            <div class="text-sm">${escapeHtml(email)}</div>
          </div>
        ` : ""}
      </div>
    </div>

    ${isAdmin ? "" : `
      <div class="card bg-base-200 mb-3">
        <div class="card-body p-4">
          <h3 class="font-semibold flex items-center gap-2">
            <i data-lucide="shield" class="w-4 h-4"></i> Become admin
          </h3>
          <p class="text-xs text-base-content/60">Enter the shared admin key to unlock direct guide imports and the review queue.</p>
          <div class="flex gap-2 mt-2">
            <input type="password" id="profile-admin-key" class="input input-bordered input-sm flex-1" placeholder="Admin key" />
            <button class="btn btn-primary btn-sm" onclick="handleBecomeAdmin()">Promote</button>
          </div>
        </div>
      </div>
    `}

    <div class="card bg-base-200 mb-3" id="profile-bgg-card">
      ${renderBggCard()}
    </div>

    <div class="card bg-base-200 border border-error/30">
      <div class="card-body p-4">
        <h3 class="font-semibold flex items-center gap-2 text-error">
          <i data-lucide="alert-triangle" class="w-4 h-4"></i> Delete account
        </h3>
        <p class="text-xs text-base-content/60">
          Permanently removes your profile, collection, plays, and buddies. This cannot be undone.
        </p>
        <button class="btn btn-error btn-sm mt-2 self-start" onclick="handleDeleteAccount()">
          <i data-lucide="trash-2" class="w-4 h-4"></i> Delete my account
        </button>
      </div>
    </div>
  `;

  if (window.lucide) window.lucide.createIcons();
}

async function handleBecomeAdmin() {
  const input = document.getElementById("profile-admin-key");
  const key = input?.value.trim();
  if (!key) {
    showToast("Enter an admin key first.", "warning");
    return;
  }
  try {
    const updated = await apiFetch("/profile/become-admin", {
      method: "POST",
      body: { admin_key: key },
    });
    currentUser = updated;
    showToast("You're now an admin.", "success");
    renderAccountTab();
  } catch (err) {
    showToast(err.message || "Could not verify admin key.", "error");
  }
}

// ── BoardGameGeek account linking ────────────────────────────────────────────

function renderBggCard() {
  const status = bggStatus;
  const authState = status?.auth_state || (status?.bgg_username ? "linked" : "unlinked");
  const linked = authState === "linked";
  const relinkRequired = authState === "relink_required";
  const pending = status?.pending_count || 0;
  const errored = status?.errored_count || 0;
  const lastAt = status?.last_completed_at;

  if (!status) {
    return `
      <div class="card-body p-4">
        <h3 class="font-semibold flex items-center gap-2">
          <i data-lucide="link" class="w-4 h-4"></i> BoardGameGeek account
        </h3>
        <p class="text-xs text-base-content/60">Loading…</p>
      </div>
    `;
  }

  if (!linked) {
    // Two cases share this layout: no link yet, OR an old username-only link
    // that needs the user to enter a password before sync can run.
    const heading = relinkRequired
      ? `BoardGameGeek account <span class="badge badge-xs badge-warning">re-link required</span>`
      : `BoardGameGeek account`;
    const helper = relinkRequired
      ? `BGG now requires a password to sync your collection. Re-enter your BGG credentials below — we'll keep them encrypted so future syncs are seamless.`
      : `Link your BGG account to import your collection (owned + wishlist) and play history. Your password is encrypted and only used to authenticate to BoardGameGeek.`;
    const usernameValue = relinkRequired ? escapeHtml(status.bgg_username || "") : "";
    const usernameDisabled = relinkRequired ? "readonly" : "";
    return `
      <div class="card-body p-4">
        <h3 class="font-semibold flex items-center gap-2">
          <i data-lucide="link" class="w-4 h-4"></i> ${heading}
        </h3>
        <p class="text-xs text-base-content/60">${helper}</p>
        <div class="flex flex-col gap-2 mt-2">
          <input type="text" id="profile-bgg-username" class="input input-bordered input-sm"
            placeholder="BGG username" autocomplete="username" value="${usernameValue}" ${usernameDisabled} />
          <input type="password" id="profile-bgg-password" class="input input-bordered input-sm"
            placeholder="BGG password" autocomplete="current-password" />
          <button class="btn btn-primary btn-sm self-start" onclick="handleLinkBgg()">
            ${relinkRequired ? "Re-link" : "Link"}
          </button>
        </div>
      </div>
    `;
  }

  const syncing = bggSyncing || pending > 0;
  const lastLine = lastAt
    ? `Last imported: ${new Date(lastAt).toLocaleString()}`
    : "Click sync to import your collection and plays.";
  const progressLine = syncing && pending > 0
    ? `<div class="text-xs text-info mt-1">Importing ${pending} missing game${pending === 1 ? "" : "s"} from BGG…</div>`
    : "";
  const errorLine = errored > 0
    ? `<div class="text-xs text-error mt-1 flex items-center gap-1">
         <i data-lucide="alert-triangle" class="w-3 h-3"></i>
         ${errored} import${errored === 1 ? "" : "s"} failed.
         <button class="link link-hover" onclick="handleRetryPending()">Retry</button>
       </div>`
    : "";

  return `
    <div class="card-body p-4">
      <h3 class="font-semibold flex items-center gap-2">
        <i data-lucide="link" class="w-4 h-4"></i> BoardGameGeek account
        <span class="badge badge-xs badge-success">linked</span>
      </h3>
      <div class="flex items-center justify-between mt-1">
        <div class="text-sm font-mono">${escapeHtml(status.bgg_username)}</div>
        <button class="btn btn-ghost btn-xs" onclick="handleUnlinkBgg()" ${syncing ? "disabled" : ""}>
          Unlink
        </button>
      </div>
      <p class="text-xs text-base-content/60 mt-1">${escapeHtml(lastLine)}</p>
      ${progressLine}
      ${errorLine}
      <button class="btn btn-primary btn-sm mt-2 self-start" onclick="handleSyncBgg()" ${syncing ? "disabled" : ""}>
        ${syncing
          ? `<span class="loading loading-spinner loading-xs"></span> Syncing…`
          : `<i data-lucide="refresh-cw" class="w-4 h-4"></i> Sync from BGG`}
      </button>
    </div>
  `;
}

function rerenderBggCard() {
  const card = document.getElementById("profile-bgg-card");
  if (!card) return;
  card.innerHTML = renderBggCard();
  if (window.lucide) window.lucide.createIcons();
}

async function refreshBggStatus() {
  try {
    bggStatus = await apiFetch("/bgg/sync/status");
  } catch (err) {
    bggStatus = { bgg_username: null, auth_state: "unlinked", pending_count: 0, errored_count: 0 };
  }
  rerenderBggCard();
  // Auto-poll while imports are draining so the user sees "Importing N…" tick down.
  if (bggStatus?.pending_count > 0) {
    startBggPolling();
  } else {
    stopBggPolling();
  }
}

function startBggPolling() {
  if (bggPollTimer) return;
  bggPollTimer = setInterval(refreshBggStatus, 3000);
}

function stopBggPolling() {
  if (bggPollTimer) {
    clearInterval(bggPollTimer);
    bggPollTimer = null;
  }
}

async function handleLinkBgg() {
  const usernameInput = document.getElementById("profile-bgg-username");
  const passwordInput = document.getElementById("profile-bgg-password");
  const username = usernameInput?.value.trim();
  const password = passwordInput?.value || "";
  if (!username) {
    showToast("Enter your BGG username first.", "warning");
    return;
  }
  if (!password) {
    showToast("Enter your BGG password to authorize syncing.", "warning");
    return;
  }
  try {
    await apiFetch("/bgg/link", { method: "POST", body: { username, password } });
    if (passwordInput) passwordInput.value = "";
    showToast(`Linked BGG account: ${username}`, "success");
    await refreshBggStatus();
  } catch (err) {
    showToast(err.message || "Could not link BGG account.", "error");
  }
}

async function handleUnlinkBgg() {
  if (!confirm("Unlink this BGG account? Already-imported games and plays will stay.")) {
    return;
  }
  try {
    await apiFetch("/bgg/link", { method: "DELETE" });
    showToast("BGG account unlinked.", "info");
    bggStatus = { bgg_username: null, auth_state: "unlinked", pending_count: 0, errored_count: 0 };
    rerenderBggCard();
  } catch (err) {
    showToast(err.message || "Could not unlink.", "error");
  }
}

async function handleSyncBgg() {
  bggSyncing = true;
  rerenderBggCard();
  try {
    const summary = await apiFetch("/bgg/sync", { method: "POST" });
    const importedTotal = summary.collection_imported + summary.plays_imported;
    const pendingTotal = summary.collection_pending + summary.plays_pending;
    if (pendingTotal > 0) {
      showToast(
        `Imported ${importedTotal}. Importing ${pendingTotal} missing game${pendingTotal === 1 ? "" : "s"}…`,
        "info",
      );
    } else {
      showToast(`Imported ${importedTotal} item${importedTotal === 1 ? "" : "s"} from BGG.`, "success");
    }
  } catch (err) {
    showToast(err.message || "BGG sync failed.", "error");
  } finally {
    bggSyncing = false;
    await refreshBggStatus();
  }
}

async function handleRetryPending() {
  try {
    await apiFetch("/bgg/sync/process-pending", { method: "POST" });
    showToast("Retried pending imports.", "info");
    await refreshBggStatus();
  } catch (err) {
    showToast(err.message || "Retry failed.", "error");
  }
}

async function handleDeleteAccount() {
  const confirmation = prompt('Type "DELETE" to confirm permanent account deletion:');
  if (confirmation !== "DELETE") {
    showToast("Account deletion cancelled.", "info");
    return;
  }
  try {
    await apiFetch("/profile", { method: "DELETE" });
    showToast("Account deleted.", "info");
    if (supabaseClient) {
      await supabaseClient.auth.signOut();
    }
    session = null;
    currentUser = null;
    showAuthView();
  } catch (err) {
    showToast("Delete failed: " + err.message, "error");
  }
}
