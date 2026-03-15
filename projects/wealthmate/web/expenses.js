// expenses.js — WealthMate cost tracker (big purchases + monthly bills)

const FREQ_LABEL = { weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };
const CAT_LABEL = { housing: "Housing", subscription: "Subscription", insurance: "Insurance", utilities: "Utilities", transportation: "Transport", food: "Food", other: "Other" };

function switchCostTool(tool) {
  currentCostTool = tool;
  document.querySelectorAll(".cost-tool").forEach(btn => {
    btn.classList.toggle("active", btn.id === `tool-${tool}`);
  });
  document.getElementById("cost-big-purchases").style.display = tool === "big-purchases" ? "block" : "none";
  document.getElementById("cost-monthly-bills").style.display = tool === "monthly-bills" ? "block" : "none";

  if (tool === "big-purchases") loadExpenseGroups();
  if (tool === "monthly-bills") loadBills();
}

// ── Big Purchases ─────────────────────────────────────────────────────────────

async function loadExpenses() {
  switchCostTool(currentCostTool);
}

async function loadExpenseGroups() {
  const container = document.getElementById("expense-groups-list");
  const detail = document.getElementById("expense-detail");
  detail.style.display = "none";
  container.style.display = "block";
  document.getElementById("big-purchases-header").style.display = "flex";
  container.innerHTML = '<div class="loading">Loading...</div>';

  try {
    expenseGroups = await apiFetch("/expenses");
    if (!Array.isArray(expenseGroups)) expenseGroups = [];
    renderExpenseGroups();
  } catch (err) {
    container.innerHTML = `<div class="error-banner">${err.message}</div>`;
  }
}

function renderExpenseGroups() {
  const container = document.getElementById("expense-groups-list");
  if (expenseGroups.length === 0) {
    container.innerHTML = '<div class="empty-state">No groups yet. Tap "+ New Group" to track a big expense like surgery, travel, or renovations.</div>';
    return;
  }

  container.innerHTML = expenseGroups.map(g => {
    const total = g.total || 0;
    return `<div class="expense-group-card" onclick="openExpenseGroup('${g.id}')">
      <h5>${g.name}</h5>
      <p class="muted">${g.description || "No description"}</p>
      <span class="expense-group-total">${fmt(total)}</span>
    </div>`;
  }).join("");
}

async function openExpenseGroup(id) {
  try {
    showLoading(true);
    currentExpenseGroup = await apiFetch(`/expenses/${id}`);
    showLoading(false);
    renderExpenseDetail();
  } catch (err) {
    showLoading(false);
    alert("Error: " + err.message);
  }
}

function renderExpenseDetail() {
  if (!currentExpenseGroup) return;
  document.getElementById("expense-groups-list").style.display = "none";
  document.getElementById("big-purchases-header").style.display = "none";
  const detail = document.getElementById("expense-detail");
  detail.style.display = "block";

  document.getElementById("expense-detail-name").textContent = currentExpenseGroup.name;
  document.getElementById("expense-detail-desc").textContent = currentExpenseGroup.description || "";

  const items = currentExpenseGroup.items || [];
  const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  document.getElementById("expense-detail-total").textContent = fmt(total);

  const list = document.getElementById("expense-items-list");
  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state">No items yet.</div>';
  } else {
    list.innerHTML = items.map(i => `<div class="expense-item-row">
      <div>
        <strong>${i.description}</strong>
        ${i.item_date ? `<span class="muted"> - ${fmtDate(i.item_date)}</span>` : ""}
      </div>
      <div>
        <span>${fmt(i.amount)}</span>
        <button class="expense-item-delete" onclick="deleteExpenseItem('${currentExpenseGroup.id}', '${i.id}')">&times;</button>
      </div>
    </div>`).join("");
  }
}

async function handleExpenseItemSubmit(e) {
  e.preventDefault();
  if (!currentExpenseGroup) return;
  const body = {
    description: document.getElementById("ei-desc").value.trim(),
    amount: parseFloat(document.getElementById("ei-amount").value),
    item_date: document.getElementById("ei-date").value || null,
  };
  if (!body.description || isNaN(body.amount)) return;

  try {
    showLoading(true);
    await apiFetch(`/expenses/${currentExpenseGroup.id}/items`, { method: "POST", body });
    currentExpenseGroup = await apiFetch(`/expenses/${currentExpenseGroup.id}`);
    showLoading(false);
    renderExpenseDetail();
    document.getElementById("expense-item-form").reset();
  } catch (err) {
    showLoading(false);
    alert("Error: " + err.message);
  }
}

async function deleteExpenseItem(groupId, itemId) {
  if (!confirm("Delete this item?")) return;
  try {
    await apiFetch(`/expenses/${groupId}/items/${itemId}`, { method: "DELETE" });
    currentExpenseGroup = await apiFetch(`/expenses/${groupId}`);
    renderExpenseDetail();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

function backToExpenseGroups() {
  currentExpenseGroup = null;
  document.getElementById("expense-detail").style.display = "none";
  document.getElementById("expense-groups-list").style.display = "block";
  document.getElementById("big-purchases-header").style.display = "flex";
}

async function handleExpenseGroupSubmit(e) {
  e.preventDefault();
  const errEl = document.getElementById("expense-group-error");
  errEl.style.display = "none";
  const body = {
    name: document.getElementById("eg-name").value.trim(),
    description: document.getElementById("eg-desc").value.trim() || null,
  };
  if (!body.name) return;

  try {
    await apiFetch("/expenses", { method: "POST", body });
    document.getElementById("expense-group-dialog").close();
    document.getElementById("expense-group-form").reset();
    loadExpenseGroups();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  }
}

// ── Monthly Bills ─────────────────────────────────────────────────────────────

async function loadBills() {
  const container = document.getElementById("bills-list");
  container.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const data = await apiFetch("/recurring-expenses");
    recurringExpenses = data.items || [];
    document.getElementById("monthly-total").textContent = fmt(data.monthly_total);
    document.getElementById("yearly-total").textContent = fmt(data.yearly_total);
    renderBills();
  } catch (err) {
    container.innerHTML = `<div class="error-banner">${err.message}</div>`;
  }
}

function renderBills() {
  const container = document.getElementById("bills-list");
  if (recurringExpenses.length === 0) {
    container.innerHTML = '<div class="empty-state">No bills yet. Tap "+ Add Bill" to track a recurring expense.</div>';
    return;
  }

  container.innerHTML = recurringExpenses.map(b => `
    <div class="bill-card" onclick="openEditBill('${b.id}')">
      <div class="bill-card-info">
        <h5>${b.name}<span class="bill-category-badge">${CAT_LABEL[b.category] || b.category}</span></h5>
        ${b.notes ? `<p class="muted">${b.notes}</p>` : ""}
      </div>
      <div class="bill-card-amount">
        <div class="amount">${fmt(b.amount)}</div>
        <div class="freq">${FREQ_LABEL[b.frequency] || b.frequency}</div>
      </div>
    </div>
  `).join("");
}

function openAddBill() {
  editingBillId = null;
  document.getElementById("bill-dialog-title").textContent = "Add Bill";
  document.getElementById("bill-form").reset();
  document.getElementById("bill-delete-btn").style.display = "none";
  document.getElementById("bill-form-error").style.display = "none";
  document.getElementById("bill-dialog").showModal();
}

function openEditBill(id) {
  const bill = recurringExpenses.find(b => b.id === id);
  if (!bill) return;
  editingBillId = id;
  document.getElementById("bill-dialog-title").textContent = "Edit Bill";
  document.getElementById("bill-name").value = bill.name;
  document.getElementById("bill-amount").value = bill.amount;
  document.getElementById("bill-frequency").value = bill.frequency || "monthly";
  document.getElementById("bill-category").value = bill.category || "other";
  document.getElementById("bill-notes").value = bill.notes || "";
  document.getElementById("bill-delete-btn").style.display = "inline-block";
  document.getElementById("bill-form-error").style.display = "none";
  document.getElementById("bill-dialog").showModal();
}

async function handleBillSubmit(e) {
  e.preventDefault();
  const errEl = document.getElementById("bill-form-error");
  errEl.style.display = "none";

  const body = {
    name: document.getElementById("bill-name").value.trim(),
    amount: parseFloat(document.getElementById("bill-amount").value),
    frequency: document.getElementById("bill-frequency").value,
    category: document.getElementById("bill-category").value,
    notes: document.getElementById("bill-notes").value.trim() || null,
  };
  if (!body.name || isNaN(body.amount)) return;

  try {
    if (editingBillId) {
      await apiFetch(`/recurring-expenses/${editingBillId}`, { method: "PUT", body });
    } else {
      await apiFetch("/recurring-expenses", { method: "POST", body });
    }
    document.getElementById("bill-dialog").close();
    loadBills();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  }
}

async function deleteBill() {
  if (!editingBillId) return;
  if (!confirm("Remove this bill?")) return;
  try {
    await apiFetch(`/recurring-expenses/${editingBillId}`, { method: "DELETE" });
    document.getElementById("bill-dialog").close();
    loadBills();
  } catch (err) {
    alert("Error: " + err.message);
  }
}
