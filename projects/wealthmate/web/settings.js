// settings.js — WealthMate settings, invites, CSV, recovery, theme

async function loadSettings() {
  document.getElementById("settings-display-name").textContent = currentUser?.display_name || "--";
  document.getElementById("settings-username").textContent = currentUser?.username || "--";
  document.getElementById("settings-email").value = currentUser?.email || "";

  const coupleEl = document.getElementById("settings-couple-info");
  const inviteSection = document.getElementById("settings-invite-section");

  try {
    coupleInfo = await apiFetch("/couple").catch(() => null);
  } catch (e) { /* ignore */ }

  if (coupleInfo && coupleInfo.members) {
    const members = coupleInfo.members || [];
    const partner = members.find(m => m.user_id !== currentUser.id);
    coupleEl.innerHTML = partner
      ? `<p>Finances merged with <strong>${partner.display_name || partner.username}</strong></p>`
      : `<p>Tracking solo. Invite a partner below to merge finances!</p>`;
    inviteSection.style.display = partner ? "none" : "block";
  } else {
    coupleEl.innerHTML = "<p>Tracking solo. Invite a partner below to merge finances!</p>";
    inviteSection.style.display = "block";
  }

  await loadPendingInvites();
}

async function loadPendingInvites() {
  const container = document.getElementById("settings-pending-invites");
  try {
    const invites = await apiFetch("/couple/invites");
    if (!Array.isArray(invites) || invites.length === 0) {
      container.innerHTML = "";
      return;
    }
    container.innerHTML = "<h5 style='margin-top:1rem;'>Pending Invitations</h5>" +
      invites.filter(i => i.status === "pending").map(i => `
        <div class="invite-card">
          <span>From: <strong>${i.from_username || i.from_user_id}</strong></span>
          <div class="invite-actions">
            <button onclick="respondInvite('${i.id}', 'accept')" class="btn-sm">Accept</button>
            <button onclick="respondInvite('${i.id}', 'decline')" class="btn-sm btn-danger">Decline</button>
          </div>
        </div>
      `).join("");
  } catch (e) {
    container.innerHTML = "";
  }
}

async function respondInvite(id, action) {
  try {
    showLoading(true);
    await apiFetch(`/couple/invite/${id}/respond`, { method: "POST", body: { action } });
    showLoading(false);
    loadSettings();
  } catch (err) {
    showLoading(false);
    alert("Error: " + err.message);
  }
}

async function handleInvite(e) {
  e.preventDefault();
  const errEl = document.getElementById("invite-error");
  const sucEl = document.getElementById("invite-success");
  errEl.style.display = "none";
  sucEl.style.display = "none";

  const username = document.getElementById("invite-username").value.trim();
  if (!username) return;

  try {
    await apiFetch("/couple/invite", { method: "POST", body: { to_username: username } });
    sucEl.textContent = `Invitation sent to ${username}!`;
    sucEl.style.display = "block";
    document.getElementById("invite-username").value = "";
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  }
}

function handleEmailInvite(e) {
  e.preventDefault();
  const email = document.getElementById("invite-email").value.trim();
  if (!email) return;
  const appUrl = window.location.origin + window.location.pathname;
  const displayName = currentUser?.display_name || currentUser?.username || "Your partner";
  const subject = encodeURIComponent(`${displayName} invited you to WealthMate`);
  const body = encodeURIComponent(
    `Hey!\n\n${displayName} wants to merge finances with you on WealthMate — a simple app to track your wealth together.\n\n` +
    `Sign up here: ${appUrl}\n\n` +
    `Once you create an account, share your username with ${displayName} so they can link your accounts.`
  );
  window.open(`mailto:${email}?subject=${subject}&body=${body}`, "_blank");
  document.getElementById("invite-email").value = "";
}

async function deleteAccount() {
  const confirmed = confirm(
    "Are you sure you want to delete your account and ALL your data?\n\n" +
    "This will permanently remove your accounts, check-ins, expense groups, and profile.\n\n" +
    "This cannot be undone."
  );
  if (!confirmed) return;

  const doubleConfirm = confirm("This is your last chance. Type OK to confirm you understand all data will be lost.");
  if (!doubleConfirm) return;

  try {
    showLoading(true);
    await apiFetch("/auth/me", { method: "DELETE" });
    showLoading(false);
    clearToken();
    currentUser = null;
    coupleInfo = null;
    alert("Your account and all data have been deleted.");
    showView("login");
  } catch (err) {
    showLoading(false);
    alert("Error deleting account: " + err.message);
  }
}

function logout() {
  clearToken();
  currentUser = null;
  coupleInfo = null;
  activeCheckin = null;
  previousValues = {};
  accounts = [];
  wealthHistory = [];
  showView("login");
}

// ── Data Management (CSV export/import) ──────────────────────────────────────

async function downloadCSV(endpoint, fallbackName) {
  const token = getToken();
  try {
    const res = await fetch(`${API}${BASE}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Download failed: " + err.message);
  }
}

async function handleExportCSV() {
  const btn = document.getElementById("btn-export-csv");
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;
  await downloadCSV("/checkins/export", "wealthmate-export.csv");
  btn.removeAttribute("aria-busy");
  btn.disabled = false;
}

async function handleDownloadTemplate() {
  const btn = document.getElementById("btn-download-template");
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;
  await downloadCSV("/checkins/export/template", "wealthmate-template.csv");
  btn.removeAttribute("aria-busy");
  btn.disabled = false;
}

async function handleImportCSV() {
  const fileInput = document.getElementById("csv-import-file");
  const btn = document.getElementById("btn-import-csv");
  const resultEl = document.getElementById("import-result");
  const file = fileInput.files[0];
  if (!file) return;

  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;
  resultEl.style.display = "none";

  try {
    const formData = new FormData();
    formData.append("file", file);

    const token = getToken();
    const res = await fetch(`${API}${BASE}/checkins/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const errMsg = data.detail?.errors
        ? data.detail.errors.join("\n")
        : (typeof data.detail === "string" ? data.detail : "Import failed");
      resultEl.className = "error-banner";
      resultEl.textContent = errMsg;
      resultEl.style.display = "block";
      resultEl.style.whiteSpace = "pre-line";
      return;
    }

    let msg = `Imported ${data.checkins_created} check-in(s) with ${data.values_created} value(s).`;
    if (data.accounts_created?.length) {
      msg += `\nNew accounts created: ${data.accounts_created.join(", ")}`;
    }
    if (data.skipped_dates?.length) {
      msg += `\nSkipped (already exist): ${data.skipped_dates.join(", ")}`;
    }
    resultEl.className = "success-banner";
    resultEl.textContent = msg;
    resultEl.style.display = "block";
    resultEl.style.whiteSpace = "pre-line";

    fileInput.value = "";
    btn.disabled = true;
    loadDashboard();
  } catch (err) {
    resultEl.className = "error-banner";
    resultEl.textContent = "Import failed: " + err.message;
    resultEl.style.display = "block";
  } finally {
    btn.removeAttribute("aria-busy");
  }
}

// ── Recovery Code ─────────────────────────────────────────────────────────────
function showRecoveryCode(code) {
  document.getElementById("recovery-code-value").textContent = code;
  document.getElementById("recovery-code-dialog").showModal();
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const btn = document.getElementById("fp-btn");
  const errEl = document.getElementById("fp-error");
  errEl.style.display = "none";
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;

  try {
    const newPass = document.getElementById("fp-new-password").value;
    const confirmPass = document.getElementById("fp-confirm-password").value;
    if (newPass !== confirmPass) {
      throw new Error("Passwords do not match");
    }
    const body = {
      username: document.getElementById("fp-username").value.trim(),
      recovery_code: document.getElementById("fp-recovery-code").value.trim(),
      new_password: newPass,
    };
    const res = await fetch(`${API}${BASE}/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

    document.getElementById("forgot-password-form").reset();
    showView("login");
    if (data.new_recovery_code) {
      showRecoveryCode(data.new_recovery_code);
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  } finally {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
  }
}

async function handleGenerateRecoveryCode() {
  const btn = document.getElementById("btn-generate-recovery");
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;

  try {
    const data = await apiFetch("/auth/recovery-code", { method: "POST" });
    if (data.recovery_code) {
      showRecoveryCode(data.recovery_code);
    }
  } catch (err) {
    alert(err.message);
  } finally {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
  }
}

async function handleSaveEmail() {
  const btn = document.getElementById("btn-save-email");
  const email = document.getElementById("settings-email").value.trim();
  if (!email) return;
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;
  try {
    await apiFetch("/auth/email", { method: "PUT", body: { email } });
    currentUser.email = email;
    btn.textContent = "Saved!";
    setTimeout(() => { btn.textContent = "Save"; }, 2000);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
  }
}
