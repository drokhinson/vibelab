// dashboard.js — WealthMate dashboard

async function loadDashboard() {
  try {
    const [me, couple, active, history] = await Promise.all([
      apiFetch("/auth/me"),
      apiFetch("/couple").catch(() => null),
      apiFetch("/checkins/active").catch(() => null),
      apiFetch("/wealth/history").catch(() => []),
    ]);

    currentUser = me;
    coupleInfo = couple;
    activeCheckin = active;
    wealthHistory = Array.isArray(history) ? history : [];

    document.getElementById("header-user").textContent = currentUser.display_name || currentUser.username;

    renderCoupleBar();

    try {
      const invites = await apiFetch("/couple/invites");
      renderDashboardInvites(invites);
    } catch (e) { /* ignore */ }

    // Net worth card
    if (wealthHistory.length > 0) {
      const latest = wealthHistory[wealthHistory.length - 1];
      document.getElementById("nw-value").textContent = fmt(latest.net_worth);
      document.getElementById("nw-assets").textContent = fmt(latest.gross_assets);
      document.getElementById("nw-liabilities").textContent = fmt(latest.total_liabilities);
      document.getElementById("nw-date").textContent = `As of ${fmtDate(latest.checkin_date)}`;
    } else {
      document.getElementById("nw-value").textContent = "--";
      document.getElementById("nw-assets").textContent = "--";
      document.getElementById("nw-liabilities").textContent = "--";
      document.getElementById("nw-date").textContent = "No check-ins yet";
    }

    // Active checkin button
    const contBtn = document.getElementById("btn-continue-checkin");
    if (activeCheckin && activeCheckin.id) {
      contBtn.style.display = "block";
      contBtn.textContent = `Continue Check-In (${fmtDate(activeCheckin.checkin_date)})`;
    } else {
      contBtn.style.display = "none";
    }

    // Recent check-ins
    const recentList = document.getElementById("dash-recent-list");
    if (wealthHistory.length > 0) {
      recentList.innerHTML = wealthHistory.slice(-5).reverse().map(h => `
        <div class="recent-card">
          <span class="recent-card-date">${fmtDate(h.checkin_date)}</span>
          <span class="recent-card-nw">${fmt(h.net_worth)}</span>
        </div>
      `).join("");
    } else {
      recentList.innerHTML = '<div class="empty-state">No check-ins yet. Start your first one above!</div>';
    }
  } catch (err) {
    console.error("Dashboard load error:", err);
  }
}

function renderCoupleBar() {
  const el = document.getElementById("couple-status-bar");
  const members = (coupleInfo && coupleInfo.members) || [];
  const partner = members.find(m => m.user_id !== currentUser.id);
  if (partner) {
    el.innerHTML = `<div class="couple-bar">Merged with <strong>${partner.display_name || partner.username}</strong></div>`;
  } else {
    el.innerHTML = '<div class="couple-bar couple-bar-solo">Tracking solo — merge finances with a partner in Settings!</div>';
  }
}

function renderDashboardInvites(invites) {
  const el = document.getElementById("dash-pending-invites");
  if (!el) return;
  const pending = (Array.isArray(invites) ? invites : []).filter(i => i.status === "pending");
  if (pending.length === 0) { el.innerHTML = ""; return; }
  el.innerHTML = pending.map(i => `
    <article class="invite-banner">
      <p><strong>${i.from_display_name || i.from_username || "Someone"}</strong> wants to merge finances with you!</p>
      <div class="invite-actions">
        <button onclick="respondInvite('${i.id}', 'accept')" class="btn-sm">Accept</button>
        <button onclick="respondInvite('${i.id}', 'decline')" class="btn-sm btn-danger">Decline</button>
      </div>
    </article>
  `).join("");
}
