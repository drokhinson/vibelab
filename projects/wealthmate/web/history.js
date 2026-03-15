// history.js — WealthMate history page

function switchHistoryTab(tab) {
  historyTab = tab;
  document.getElementById("tab-overview").classList.toggle("active", tab === "overview");
  document.getElementById("tab-accounts").classList.toggle("active", tab === "accounts");
  document.getElementById("history-overview").style.display = tab === "overview" ? "block" : "none";
  document.getElementById("history-accounts").style.display = tab === "accounts" ? "block" : "none";
  if (tab === "accounts" && !acctHistoryData) {
    loadAccountHistory();
  }
}

async function loadHistory() {
  try {
    wealthHistory = await apiFetch("/wealth/history");
    if (!Array.isArray(wealthHistory)) wealthHistory = [];
    renderHistoryChart();
    renderHistoryTable();
    acctHistoryData = null;
    if (historyTab === "accounts") loadAccountHistory();
  } catch (err) {
    console.error("History load error:", err);
  }
}

function renderHistoryChart() {
  const canvas = document.getElementById("nw-chart");
  if (nwChart) {
    nwChart.destroy();
    nwChart = null;
  }

  if (wealthHistory.length === 0) return;

  const labels = wealthHistory.map(h => fmtDate(h.checkin_date));
  const nwData = wealthHistory.map(h => h.net_worth || 0);
  const assetsData = wealthHistory.map(h => h.gross_assets || 0);
  const liabData = wealthHistory.map(h => h.total_liabilities || 0);

  nwChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Net Worth",
          data: nwData,
          borderColor: "#10b981",
          backgroundColor: "rgba(16, 185, 129, 0.1)",
          fill: true,
          tension: 0.3,
          pointRadius: 4,
        },
        {
          label: "Assets",
          data: assetsData,
          borderColor: "#34d399",
          borderDash: [5, 3],
          tension: 0.3,
          pointRadius: 2,
          fill: false,
        },
        {
          label: "Liabilities",
          data: liabData,
          borderColor: "#ef4444",
          borderDash: [5, 3],
          tension: 0.3,
          pointRadius: 2,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: "#9ca3af", font: { size: 11 } } },
      },
      scales: {
        x: { ticks: { color: "#6b7280", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
        y: {
          ticks: {
            color: "#6b7280",
            font: { size: 10 },
            callback: v => "$" + (v / 1000).toFixed(0) + "k",
          },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });
}

function renderHistoryTable() {
  const tbody = document.getElementById("history-tbody");
  if (wealthHistory.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state">No check-in history yet.</td></tr>';
    return;
  }

  let html = "";
  for (let i = wealthHistory.length - 1; i >= 0; i--) {
    const h = wealthHistory[i];
    const prev = i > 0 ? wealthHistory[i - 1] : null;
    const change = prev ? (h.net_worth || 0) - (prev.net_worth || 0) : null;
    const changeClass = change > 0 ? "change-positive" : change < 0 ? "change-negative" : "";
    const changeStr = change != null ? (change >= 0 ? "+" : "") + fmt(change) : "--";

    html += `<tr>
      <td>${fmtDate(h.checkin_date)}</td>
      <td>${fmt(h.net_worth)}</td>
      <td class="${changeClass}">${changeStr}</td>
    </tr>`;
  }
  tbody.innerHTML = html;
}

// ── Account History ───────────────────────────────────────────────────────────
const ACCT_COLORS = [
  "#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];

async function loadAccountHistory() {
  try {
    acctHistoryData = await apiFetch("/wealth/accounts");
    if (!acctHistoryData || !acctHistoryData.dates) {
      acctHistoryData = { dates: [], accounts: [] };
    }
    selectedAcctIds = new Set(acctHistoryData.accounts.map(a => a.id));
    renderAcctToggles();
    renderAcctChart();
    renderAcctTable();
  } catch (err) {
    console.error("Account history load error:", err);
  }
}

function renderAcctToggles() {
  const container = document.getElementById("acct-toggle-list");
  container.innerHTML = acctHistoryData.accounts.map((a, i) => {
    const color = ACCT_COLORS[i % ACCT_COLORS.length];
    const checked = selectedAcctIds.has(a.id) ? "checked" : "";
    return `<label class="acct-toggle" style="--acct-color:${color}">
      <input type="checkbox" ${checked} onchange="toggleAcct('${a.id}')" />
      <span class="acct-toggle-swatch" style="background:${color}"></span>
      ${a.name}
    </label>`;
  }).join("");
}

function toggleAcct(id) {
  if (selectedAcctIds.has(id)) selectedAcctIds.delete(id);
  else selectedAcctIds.add(id);
  renderAcctChart();
  renderAcctTable();
}

function getAcctNetValue(v) {
  if (!v) return null;
  return (v.value || 0) - (v.owed || 0);
}

function renderAcctChart() {
  const canvas = document.getElementById("acct-chart");
  if (acctChart) { acctChart.destroy(); acctChart = null; }
  if (!acctHistoryData || acctHistoryData.dates.length === 0) return;

  const labels = acctHistoryData.dates.map(d => fmtDate(d));
  const datasets = [];

  acctHistoryData.accounts.forEach((a, i) => {
    if (!selectedAcctIds.has(a.id)) return;
    const color = ACCT_COLORS[i % ACCT_COLORS.length];
    const data = a.values.map(v => {
      if (!v) return null;
      return isLoanType(a.account_type) ? -(v.owed || 0) : (v.value || 0);
    });
    datasets.push({
      label: a.name,
      data,
      borderColor: color,
      backgroundColor: color + "18",
      tension: 0.3,
      pointRadius: 3,
      fill: false,
      spanGaps: true,
    });
  });

  acctChart = new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#9ca3af", font: { size: 11 }, boxWidth: 12 } },
      },
      scales: {
        x: { ticks: { color: "#6b7280", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
        y: {
          ticks: {
            color: "#6b7280",
            font: { size: 10 },
            callback: v => "$" + (v / 1000).toFixed(0) + "k",
          },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });
}

function renderAcctTable() {
  const tbody = document.getElementById("acct-history-tbody");
  if (!acctHistoryData || acctHistoryData.dates.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state">No data yet.</td></tr>';
    return;
  }

  const selected = acctHistoryData.accounts.filter(a => selectedAcctIds.has(a.id));
  let html = "";

  for (let di = acctHistoryData.dates.length - 1; di >= 0; di--) {
    const date = acctHistoryData.dates[di];
    let isFirstRow = true;
    for (const a of selected) {
      const v = a.values[di];
      const prev = di > 0 ? a.values[di - 1] : null;
      const curNet = v ? (isLoanType(a.account_type) ? -(v.owed || 0) : (v.value || 0)) : null;
      const prevNet = prev ? (isLoanType(a.account_type) ? -(prev.owed || 0) : (prev.value || 0)) : null;
      const change = curNet != null && prevNet != null ? curNet - prevNet : null;
      const changeClass = change > 0 ? "change-positive" : change < 0 ? "change-negative" : "";
      const changeStr = change != null ? (change >= 0 ? "+" : "") + fmt(change) : "--";

      html += `<tr>
        <td>${isFirstRow ? fmtDate(date) : ""}</td>
        <td>${a.name}: ${curNet != null ? fmt(curNet) : "--"}</td>
        <td class="${changeClass}">${changeStr}</td>
      </tr>`;
      isFirstRow = false;
    }
    if (di > 0) html += '<tr class="table-divider"><td colspan="3"></td></tr>';
  }
  tbody.innerHTML = html;
}
