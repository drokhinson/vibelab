// init.js — SpotMe event listeners and startup

document.addEventListener("DOMContentLoaded", () => {
  // Auth forms
  document.getElementById("login-form").addEventListener("submit", handleLogin);
  document.getElementById("register-form").addEventListener("submit", handleRegister);
  document.getElementById("show-register").addEventListener("click", e => { e.preventDefault(); showView("register"); });
  document.getElementById("show-login").addEventListener("click", e => { e.preventDefault(); showView("login"); });
  document.getElementById("show-forgot-password").addEventListener("click", e => { e.preventDefault(); showView("forgot-password"); });
  document.getElementById("fp-back-to-login").addEventListener("click", e => { e.preventDefault(); showView("login"); });
  document.getElementById("forgot-password-form").addEventListener("submit", handleForgotPassword);

  // Recovery code dialog
  document.getElementById("recovery-dialog-close").addEventListener("click", () => document.getElementById("recovery-code-dialog").close());
  document.getElementById("recovery-dialog-done").addEventListener("click", () => document.getElementById("recovery-code-dialog").close());
  document.getElementById("recovery-code-copy").addEventListener("click", () => {
    const code = document.getElementById("recovery-code-value").textContent;
    navigator.clipboard.writeText(code).then(() => {
      document.getElementById("recovery-code-copy").textContent = "Copied!";
      setTimeout(() => { document.getElementById("recovery-code-copy").textContent = "Copy"; }, 2000);
    });
  });

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
  document.getElementById("btn-generate-recovery").addEventListener("click", handleGenerateRecoveryCode);

  // Init: check if logged in
  if (isLoggedIn()) {
    showView("profile");
  } else {
    showView("login");
  }
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
    clearToken();
    currentUser = null;
    showView("login");
  } catch (err) {
    alert(err.message);
  }
}

async function handleGenerateRecoveryCode() {
  try {
    const data = await apiFetch("/auth/recovery-code", { method: "POST" });
    showRecoveryCode(data.recovery_code);
  } catch (err) {
    alert(err.message);
  }
}
