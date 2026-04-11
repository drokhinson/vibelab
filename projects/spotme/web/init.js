// init.js — SpotMe event listeners and startup

document.addEventListener("DOMContentLoaded", async () => {
  // Auth forms
  document.getElementById("login-form").addEventListener("submit", handleLogin);
  document.getElementById("register-form").addEventListener("submit", handleRegister);
  document.getElementById("show-register").addEventListener("click", e => { e.preventDefault(); showView("register"); });
  document.getElementById("show-login").addEventListener("click", e => { e.preventDefault(); showView("login"); });

  // Bottom nav
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });

  // Add hobby dialog
  document.getElementById("add-hobby-form").addEventListener("submit", handleAddHobby);
  document.getElementById("add-hobby-dialog-close").addEventListener("click", () => document.getElementById("add-hobby-dialog").close());

  // Edit hobby dialog
  document.getElementById("edit-hobby-form").addEventListener("submit", handleEditHobby);
  document.getElementById("edit-hobby-dialog-close").addEventListener("click", () => document.getElementById("edit-hobby-dialog").close());

  // Settings
  document.getElementById("btn-logout").addEventListener("click", logout);
  document.getElementById("btn-delete-account").addEventListener("click", deleteAccount);

  // Check for existing Supabase session
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    try {
      currentUser = await apiFetch("/auth/me");
      showView("profile");
    } catch (err) {
      await sb.auth.signOut();
      showView("login");
    }
  } else {
    showView("login");
  }

  // Listen for auth state changes
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      currentUser = null;
      showView("login");
    }
  });

  // Init Lucide icons for static HTML elements (nav, header)
  if (window.lucide) lucide.createIcons();
});

// ── Settings functions ──────────────────────────────────────────────────────

function loadSettings() {
  // Nothing async needed — just show static buttons
}

async function deleteAccount() {
  if (!confirm("Are you sure you want to delete your account? This cannot be undone.")) return;
  if (!confirm("This will permanently delete all your data. Type 'delete' mentally and click OK.")) return;
  try {
    await apiFetch("/auth/me", { method: "DELETE" });
    await sb.auth.signOut();
    currentUser = null;
    showView("login");
  } catch (err) {
    alert(err.message);
  }
}
