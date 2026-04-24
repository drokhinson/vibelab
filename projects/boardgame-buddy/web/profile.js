// profile.js — User profile screen: account info, delete account, become admin.

function renderProfile() {
  const container = document.getElementById("profile-content");
  if (!currentUser) {
    container.innerHTML = '<p class="text-sm text-base-content/60">Please log in.</p>';
    return;
  }

  const email = session?.user?.email || "";
  const isAdmin = !!currentUser.is_admin;

  container.innerHTML = `
    <div class="flex items-center gap-2 mb-3">
      <button class="btn btn-ghost btn-sm btn-square" onclick="showView('closet')" title="Back">
        <i data-lucide="arrow-left" class="w-4 h-4"></i>
      </button>
      <h2 class="text-xl font-bold font-display flex items-center gap-2">
        <i data-lucide="user" class="w-5 h-5"></i> Account
      </h2>
    </div>

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

    <!-- Become admin -->
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

    <!-- Future: BGG link + friends -->
    <div class="card bg-base-200 mb-3 opacity-70">
      <div class="card-body p-4">
        <h3 class="font-semibold flex items-center gap-2">
          <i data-lucide="link" class="w-4 h-4"></i> BoardGameGeek account
          <span class="badge badge-xs badge-ghost">coming soon</span>
        </h3>
        <p class="text-xs text-base-content/60">Link your BGG account to sync your collection and see your geek score.</p>
      </div>
    </div>
    <div class="card bg-base-200 mb-3 opacity-70">
      <div class="card-body p-4">
        <h3 class="font-semibold flex items-center gap-2">
          <i data-lucide="users" class="w-4 h-4"></i> Friends
          <span class="badge badge-xs badge-ghost">coming soon</span>
        </h3>
        <p class="text-xs text-base-content/60">See the game closets and play history of your linked friends.</p>
      </div>
    </div>

    <!-- Danger zone -->
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
    renderProfile();
  } catch (err) {
    showToast(err.message || "Could not verify admin key.", "error");
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
