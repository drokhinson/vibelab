// checkin.js — WealthMate check-in wizard

async function startNewCheckin() {
  checkinNewAccounts = {};
  showView("checkin");
  setCheckinStep(1);
  // Default to next month after last checkin, or current month
  if (wealthHistory.length > 0) {
    const last = wealthHistory[wealthHistory.length - 1].checkin_date;
    const d = new Date(last + "T00:00:00");
    d.setMonth(d.getMonth() + 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    document.getElementById("checkin-date").value = `${yyyy}-${mm}`;
  } else {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    document.getElementById("checkin-date").value = `${yyyy}-${mm}`;
  }
}

async function continueCheckin() {
  if (!activeCheckin) return;
  showView("checkin");
  try {
    showLoading(true);
    accounts = await apiFetch("/accounts");
    const checkinData = await apiFetch(`/checkins/${activeCheckin.id}`);
    activeCheckin = checkinData;
    await loadPreviousValues();
    showLoading(false);
    setCheckinStep(2);
    renderCheckinAccounts();
  } catch (err) {
    showLoading(false);
    alert("Error loading check-in: " + err.message);
  }
}

function setCheckinStep(step) {
  checkinStep = step;
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`checkin-step-${i}`);
    if (el) el.style.display = i === step ? "block" : "none";
  }
  document.querySelectorAll("#wizard-steps .step").forEach(s => {
    const n = parseInt(s.dataset.step);
    s.classList.remove("active", "done");
    if (n === step) s.classList.add("active");
    if (n < step) s.classList.add("done");
  });
}

async function checkinStep1Next() {
  const monthVal = document.getElementById("checkin-date").value;
  if (!monthVal) { alert("Please pick a month."); return; }
  const dateVal = monthVal + "-01";

  try {
    showLoading(true);
    if (!activeCheckin || !activeCheckin.id) {
      const data = await apiFetch("/checkins", { method: "POST", body: { checkin_date: dateVal } });
      activeCheckin = data.checkin || data;
      if (data.previous_values) {
        previousValues = {};
        (Array.isArray(data.previous_values) ? data.previous_values : []).forEach(pv => {
          previousValues[pv.account_id] = pv;
        });
      }
    }
    accounts = await apiFetch("/accounts");
    if (!Object.keys(previousValues).length) {
      await loadPreviousValues();
    }
    showLoading(false);
    setCheckinStep(2);
    renderCheckinAccounts();
  } catch (err) {
    showLoading(false);
    alert("Error: " + err.message);
  }
}

async function loadPreviousValues() {
  try {
    const checkinsList = await apiFetch("/checkins");
    if (Array.isArray(checkinsList) && checkinsList.length > 0) {
      const lastSubmitted = checkinsList[checkinsList.length - 1];
      if (lastSubmitted && lastSubmitted.id) {
        const detail = await apiFetch(`/checkins/${lastSubmitted.id}`);
        previousValues = {};
        const vals = detail.values || [];
        vals.forEach(v => {
          previousValues[v.account_id] = v;
        });
      }
    }
  } catch (e) {
    console.warn("Could not load previous values:", e);
  }
}

function renderCheckinAccounts() {
  const container = document.getElementById("checkin-accounts-list");
  const grouped = groupAccounts(accounts);
  const currentValues = (activeCheckin && activeCheckin.values) || [];
  const cvMap = {};
  currentValues.forEach(v => { cvMap[v.account_id] = v; });

  let html = "";

  const renderGroup = (label, accts) => {
    if (accts.length === 0) return "";
    let g = `<div class="checkin-account-group"><h5>${label}</h5>`;
    for (const a of accts) {
      const prev = previousValues[a.id];
      const cur = cvMap[a.id];
      const isLoan = isLoanType(a.account_type);
      const prevVal = prev ? prev.current_value : null;
      const prevOwed = prev ? prev.balance_owed : null;
      const curVal = cur ? cur.current_value : "";
      const curOwed = cur ? cur.balance_owed : "";

      g += `<div class="checkin-acct-card" data-account-id="${a.id}">
        <div class="checkin-acct-name">${a.name}</div>
        <div class="checkin-acct-type">${typeLabel(a.account_type)}</div>`;

      if (prev) {
        g += `<div class="checkin-acct-prev">Last: ${fmt(prevVal)}${isLoan && prevOwed != null ? ` | Owed: ${fmt(prevOwed)}` : ""}
          <button class="btn-use-prev" onclick="usePrevious('${a.id}')">Use Previous</button>
        </div>`;
      } else {
        g += `<div class="checkin-acct-prev">No previous value</div>`;
      }

      g += `<div class="checkin-acct-inputs">
        <div class="input-group">
          <label>${isLoan ? "Asset Value" : "Value"}</label>
          <input type="number" step="0.01" id="val-${a.id}" placeholder="0.00"
            value="${curVal !== null && curVal !== "" ? curVal : ""}"
            onchange="saveAccountValue('${a.id}')" />
        </div>`;

      if (isLoan) {
        g += `<div class="input-group">
          <label>Balance Owed</label>
          <input type="number" step="0.01" id="owed-${a.id}" placeholder="0.00"
            value="${curOwed !== null && curOwed !== "" ? curOwed : ""}"
            onchange="saveAccountValue('${a.id}')" />
        </div>`;
      }

      g += `</div>
        <span class="checkin-saved-indicator" id="saved-${a.id}">Saved</span>
      </div>`;
    }
    g += "</div>";
    return g;
  };

  html += renderGroup("Your Accounts", grouped.yours);
  html += renderGroup("Partner's Accounts", grouped.partner);
  html += renderGroup("Joint Accounts", grouped.joint);

  if (!grouped.yours.length && !grouped.partner.length && !grouped.joint.length) {
    html = '<div class="empty-state">No accounts yet. Add some in Step 3 or on the Accounts page.</div>';
  }

  container.innerHTML = html;
}

async function usePrevious(accountId) {
  const prev = previousValues[accountId];
  if (!prev) return;
  const valInput = document.getElementById(`val-${accountId}`);
  const owedInput = document.getElementById(`owed-${accountId}`);
  if (valInput && prev.current_value != null) valInput.value = prev.current_value;
  if (owedInput && prev.balance_owed != null) owedInput.value = prev.balance_owed;
  await saveAccountValue(accountId, "copied");
}

async function saveAccountValue(accountId, source = "manual") {
  if (!activeCheckin) return;
  const valInput = document.getElementById(`val-${accountId}`);
  const owedInput = document.getElementById(`owed-${accountId}`);
  const currentValue = valInput ? (valInput.value !== "" ? parseFloat(valInput.value) : null) : null;
  const balanceOwed = owedInput ? (owedInput.value !== "" ? parseFloat(owedInput.value) : null) : null;

  if (currentValue === null && balanceOwed === null) return;

  try {
    await apiFetch(`/checkins/${activeCheckin.id}/values/${accountId}`, {
      method: "PUT",
      body: { current_value: currentValue, balance_owed: balanceOwed, data_source: source },
    });
    const indicator = document.getElementById(`saved-${accountId}`);
    if (indicator) {
      indicator.classList.add("show");
      setTimeout(() => indicator.classList.remove("show"), 1500);
    }
  } catch (err) {
    console.error("Save error:", err);
  }
}

function checkinStep3AddAccount() {
  addAccountFromCheckin = true;
  openAddAccount();
}

function renderCheckinReview() {
  const container = document.getElementById("checkin-review-summary");
  const totalsEl = document.getElementById("checkin-review-totals");
  const grouped = groupAccounts(accounts);

  let totalAssets = 0;
  let totalLiabilities = 0;
  let html = "";
  let filledCount = 0;
  let totalAccounts = 0;
  const missingAccounts = [];

  const reviewGroup = (label, accts) => {
    if (accts.length === 0) return "";
    let g = `<div class="review-group"><h5>${label}</h5>`;
    for (const a of accts) {
      totalAccounts++;
      const isNew = !!checkinNewAccounts[a.id];
      let val, owed;

      if (isNew) {
        val = checkinNewAccounts[a.id].current_value;
        owed = checkinNewAccounts[a.id].balance_owed;
      } else {
        const valInput = document.getElementById(`val-${a.id}`);
        const owedInput = document.getElementById(`owed-${a.id}`);
        val = valInput && valInput.value !== "" ? parseFloat(valInput.value) : null;
        owed = owedInput && owedInput.value !== "" ? parseFloat(owedInput.value) : null;
      }
      const isLoan = isLoanType(a.account_type);

      const isFilled = val != null || (isLoan && owed != null);
      if (!isFilled) missingAccounts.push(a.name);

      if (val != null) { totalAssets += val; filledCount++; }
      if (owed != null) { totalLiabilities += owed; }

      const rowClass = isFilled ? "" : "review-row-missing";
      const newBadge = isNew ? ' <span class="badge badge-new">NEW</span>' : '';
      g += `<div class="review-row ${rowClass}">
        <span class="review-row-name">${a.name}${newBadge}${!isFilled ? ' ⚠' : ''}</span>
        <span class="review-row-value">${val != null ? fmt(val) : "--"}${owed != null ? ` / Owed: ${fmt(owed)}` : ""}</span>
      </div>`;
    }
    g += "</div>";
    return g;
  };

  html += reviewGroup("Your Accounts", grouped.yours);
  html += reviewGroup("Partner's Accounts", grouped.partner);
  html += reviewGroup("Joint Accounts", grouped.joint);

  container.innerHTML = html;

  const netWorth = totalAssets - totalLiabilities;
  const submitBtn = document.getElementById("checkin-submit");

  if (missingAccounts.length > 0) {
    totalsEl.innerHTML = `
      <div class="review-warning">You must enter a value for every account before submitting.</div>
      <p class="muted">${missingAccounts.length} of ${totalAccounts} account(s) missing values</p>
    `;
    submitBtn.disabled = true;
  } else {
    totalsEl.innerHTML = `
      <p>Assets: <strong>${fmt(totalAssets)}</strong> | Liabilities: <strong>${fmt(totalLiabilities)}</strong></p>
      <p class="review-total-nw">${fmt(netWorth)}</p>
      <p class="muted">${filledCount} account(s) updated</p>
    `;
    submitBtn.disabled = false;
  }
}

async function submitCheckin() {
  if (!activeCheckin) return;
  try {
    showLoading(true);
    await apiFetch(`/checkins/${activeCheckin.id}/submit`, { method: "POST" });
    showLoading(false);
    activeCheckin = null;
    previousValues = {};
    checkinNewAccounts = {};
    alert("Check-in submitted!");
    showView("dashboard");
  } catch (err) {
    showLoading(false);
    alert("Error submitting: " + err.message);
  }
}
