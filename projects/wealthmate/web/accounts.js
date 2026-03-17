// accounts.js — WealthMate account management

async function loadAccounts() {
  const container = document.getElementById("accounts-list");
  container.innerHTML = '<div class="loading">Loading...</div>';
  try {
    accounts = await apiFetch("/accounts");
    renderAccountsList();
  } catch (err) {
    container.innerHTML = `<div class="error-banner">${err.message}</div>`;
  }
}

function renderAccountsList() {
  const container = document.getElementById("accounts-list");
  const grouped = groupAccounts(accounts);
  let html = "";

  let cardIndex = 0;
  const renderGroup = (label, accts) => {
    if (accts.length === 0) return "";
    let g = `<div class="account-group-label">${label}</div>`;
    for (const a of accts) {
      g += `<div class="account-card" onclick="openEditAccount('${a.id}')" style="--i:${cardIndex++}">
        <div class="account-card-info">
          <h5>${a.name}</h5>
          <span class="muted">${typeLabel(a.account_type)}</span>
        </div>
        <span class="account-card-arrow"><i data-lucide="chevron-right"></i></span>
      </div>`;
    }
    return g;
  };

  html += renderGroup("Your Accounts", grouped.yours);
  html += renderGroup("Partner's Accounts", grouped.partner);
  html += renderGroup("Joint Accounts", grouped.joint);

  if (!html) {
    html = '<div class="empty-state">No accounts yet. Tap + Add to create one.</div>';
  }

  container.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

function buildOwnerOptions() {
  const ownerSelect = document.getElementById("acct-owner");
  ownerSelect.innerHTML = '<option value="me">Mine</option>';
  if (coupleInfo && coupleInfo.members) {
    const partner = coupleInfo.members.find(m => m.user_id !== currentUser.id);
    if (partner) {
      const name = partner.display_name || partner.username;
      ownerSelect.innerHTML += `<option value="partner">${name}'s</option>`;
      ownerSelect.innerHTML += '<option value="joint">Joint</option>';
    }
  }
}

function openAddAccount() {
  editingAccountId = null;
  document.getElementById("account-dialog-title").textContent = "Add Account";
  document.getElementById("account-form").reset();
  document.getElementById("acct-close-btn").style.display = "none";
  document.getElementById("acct-delete-btn").style.display = "none";
  document.getElementById("acct-save-btn").disabled = false;
  document.getElementById("initial-value-section").style.display = "block";
  document.getElementById("account-form-error").style.display = "none";
  buildOwnerOptions();
  onCategoryChange();
  document.getElementById("account-dialog").showModal();
}

function openEditAccount(id) {
  const acct = accounts.find(a => a.id === id);
  if (!acct) return;
  editingAccountId = id;
  document.getElementById("account-dialog-title").textContent = "Edit Account";
  document.getElementById("account-form").reset();
  document.getElementById("acct-name").value = acct.name;
  document.getElementById("acct-url").value = acct.url || "";
  document.getElementById("acct-notes").value = acct.notes || "";
  document.getElementById("account-form-error").style.display = "none";

  const cat = typeToCategory(acct.account_type);
  document.getElementById("acct-category").value = cat;
  onCategoryChange();

  if (cat === "retirement") document.getElementById("acct-retirement-type").value = acct.account_type;
  if (cat === "property") document.getElementById("acct-property-type").value = acct.account_type;
  if (cat === "loan") document.getElementById("acct-loan-type").value = acct.account_type;

  buildOwnerOptions();
  const ownerSelect = document.getElementById("acct-owner");
  if (!acct.owner_user_id) {
    ownerSelect.value = "joint";
  } else if (acct.owner_user_id === currentUser.id) {
    ownerSelect.value = "me";
  } else {
    ownerSelect.value = "partner";
  }

  document.getElementById("initial-value-section").style.display = "none";

  if (acct.loan_details) {
    document.getElementById("acct-loan-amount").value = acct.loan_details.original_loan_amount || "";
    document.getElementById("acct-loan-rate").value = acct.loan_details.interest_rate || "";
    document.getElementById("acct-loan-term").value = acct.loan_details.loan_term_months || "";
    document.getElementById("acct-loan-lender").value = acct.loan_details.lender_name || "";
  }

  document.getElementById("acct-close-btn").style.display = "block";
  document.getElementById("acct-delete-btn").style.display = "block";
  document.getElementById("acct-save-btn").disabled = false;
  document.getElementById("account-dialog").showModal();
}

async function handleAccountSubmit(e) {
  e.preventDefault();
  const saveBtn = document.getElementById("acct-save-btn");
  saveBtn.disabled = true;
  const errEl = document.getElementById("account-form-error");
  errEl.style.display = "none";

  const ownerVal = document.getElementById("acct-owner").value;
  let ownerUserId = null;
  if (ownerVal === "me") ownerUserId = currentUser.id;
  else if (ownerVal === "partner" && coupleInfo && coupleInfo.members) {
    const partner = coupleInfo.members.find(m => m.user_id !== currentUser.id);
    ownerUserId = partner ? partner.user_id : null;
  }

  const category = document.getElementById("acct-category").value;
  const acctType = resolveAccountType(category);

  let notes = document.getElementById("acct-notes").value.trim() || "";
  const addr = document.getElementById("acct-property-address")?.value.trim();
  if (addr) notes = (notes ? notes + "\n" : "") + "Address: " + addr;
  const brokerage = document.getElementById("acct-brokerage")?.value.trim();
  if (brokerage) notes = (notes ? notes + "\n" : "") + "Provider: " + brokerage;

  const body = {
    name: document.getElementById("acct-name").value.trim(),
    account_type: acctType,
    owner_user_id: ownerUserId,
    url: document.getElementById("acct-url").value.trim() || null,
    notes: notes || null,
  };

  if (isLoanType(acctType)) {
    body.original_loan_amount = parseFloat(document.getElementById("acct-loan-amount").value) || null;
    body.interest_rate = parseFloat(document.getElementById("acct-loan-rate").value) || null;
    body.loan_term_months = parseInt(document.getElementById("acct-loan-term").value) || null;
    body.lender_name = document.getElementById("acct-loan-lender").value.trim() || null;
  }

  let initialValue = "";
  let initialOwed = "";
  if (category === "property") {
    initialValue = document.getElementById("acct-property-value").value;
    initialOwed = document.getElementById("acct-mortgage-owed").value;
  } else if (category === "loan") {
    initialOwed = document.getElementById("acct-loan-owed").value;
  } else if (category === "other_liability") {
    initialOwed = document.getElementById("acct-initial-value").value;
    initialValue = "";
  } else {
    initialValue = document.getElementById("acct-initial-value").value;
    initialOwed = document.getElementById("acct-initial-owed")?.value || "";
  }

  try {
    let created;
    if (editingAccountId) {
      await apiFetch(`/accounts/${editingAccountId}`, { method: "PUT", body });
    } else {
      created = await apiFetch("/accounts", { method: "POST", body });
      if (created && created.id && (initialValue || initialOwed)) {
        const active = await apiFetch("/checkins/active").catch(() => null);
        if (active && active.id) {
          await apiFetch(`/checkins/${active.id}/values/${created.id}`, {
            method: "PUT",
            body: {
              current_value: initialValue ? parseFloat(initialValue) : null,
              balance_owed: initialOwed ? parseFloat(initialOwed) : null,
              data_source: "manual",
            },
          }).catch(() => {});
        }
      }
    }
    document.getElementById("account-dialog").close();
    if (addAccountFromCheckin) {
      addAccountFromCheckin = false;
      if (created && created.id) {
        checkinNewAccounts[created.id] = {
          current_value: initialValue ? parseFloat(initialValue) : null,
          balance_owed: initialOwed ? parseFloat(initialOwed) : null,
        };
      }
      accounts = await apiFetch("/accounts");
    } else {
      loadAccounts();
    }
  } catch (err) {
    saveBtn.disabled = false;
    errEl.textContent = err.message;
    errEl.style.display = "block";
  }
}

async function closeAccount() {
  if (!editingAccountId) return;
  if (!confirm("Close this account? It will be hidden from future check-ins but historical data will be preserved.")) return;
  try {
    await apiFetch(`/accounts/${editingAccountId}`, { method: "DELETE" });
    document.getElementById("account-dialog").close();
    loadAccounts();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function deleteAccountPermanently() {
  if (!editingAccountId) return;
  if (!confirm("Permanently delete this account and ALL its check-in data? This cannot be undone.")) return;
  try {
    await apiFetch(`/accounts/${editingAccountId}/permanent`, { method: "DELETE" });
    document.getElementById("account-dialog").close();
    loadAccounts();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

// ── Account type change handler (show/hide loan fields) ───────────────────────
function onCategoryChange() {
  const cat = document.getElementById("acct-category").value;
  document.getElementById("retirement-sub").style.display = cat === "retirement" ? "block" : "none";
  document.getElementById("property-sub").style.display = cat === "property" ? "block" : "none";
  document.getElementById("loan-sub").style.display = cat === "loan" ? "block" : "none";
  document.getElementById("investment-details-section").style.display =
    (cat === "investment" || cat === "retirement") ? "block" : "none";
  document.getElementById("property-address-section").style.display = cat === "property" ? "block" : "none";
  document.getElementById("loan-extra-section").style.display = cat === "loan" ? "block" : "none";

  const heading = document.getElementById("init-value-heading");
  const owedSection = document.getElementById("init-owed-section");
  const initValueSection = document.getElementById("initial-value-section");

  if (cat === "property") {
    initValueSection.style.display = "none";
  } else if (cat === "loan") {
    initValueSection.style.display = "none";
  } else if (cat === "other_liability") {
    heading.textContent = "Amount Owed";
    owedSection.style.display = "none";
    initValueSection.style.display = "block";
  } else {
    heading.textContent = "Current Value";
    owedSection.style.display = "none";
    initValueSection.style.display = "block";
  }
}
