'use strict';

let leaderboardData = null;

async function loadLeaderboard() {
  if (!activeGroupId) return;
  try {
    leaderboardData = await apiFetch(`/groups/${activeGroupId}/leaderboard`);
  } catch (err) {
    leaderboardData = null;
  }
}

function renderLeaderboardView() {
  if (!activeGroupId) return renderNoGroupPrompt();

  return `
    ${renderGroupSwitcher()}
    <div class="section-header">
      <span class="section-title">🏆 Leaderboard</span>
    </div>
    ${!leaderboardData
      ? `<div class="loading" style="height:40vh"></div>`
      : renderLeaderboardContent()
    }
  `;
}

function renderLeaderboardContent() {
  const { group_name, group_code, leaderboard } = leaderboardData;

  if (!leaderboard.length) {
    return `<div class="empty-state text-muted text-center" style="padding:40px 0">No submissions yet — be the first to write a sentence!</div>`;
  }

  return `
    <div style="text-align:center; margin-bottom:20px;">
      <p class="text-muted" style="font-size:14px;">${escHtml(group_name)} · code: <strong style="font-family:monospace; letter-spacing:2px; color:var(--accent)">${group_code}</strong></p>
    </div>
    <div class="leaderboard-list">
      ${leaderboard.map(entry => renderLeaderboardEntry(entry)).join('')}
    </div>
  `;
}

function renderLeaderboardEntry(entry) {
  const rankClass = entry.rank <= 3 ? `top-${entry.rank}` : '';
  const rankEmoji = entry.rank === 1 ? '🥇' : entry.rank === 2 ? '🥈' : entry.rank === 3 ? '🥉' : entry.rank;
  const isMe = entry.user_id === currentUser?.id;

  return `
    <div class="leaderboard-entry ${rankClass}">
      <div class="rank-badge rank-${entry.rank <= 3 ? entry.rank : 'other'}">${rankEmoji}</div>
      <div class="lb-name">
        ${escHtml(entry.display_name || entry.username)}
        ${isMe ? ' <span style="font-size:11px; color:var(--accent)">(you)</span>' : ''}
        <div class="lb-username">@${escHtml(entry.username)}</div>
      </div>
      <div class="lb-votes">
        <strong>${entry.total_votes}</strong>
        votes
      </div>
    </div>
  `;
}

function initLeaderboardListeners() {
  // Group switcher — reload leaderboard when switching groups
  document.querySelectorAll('[data-group-switch]').forEach(btn => {
    btn.addEventListener('click', async () => {
      activeGroupId = btn.dataset.groupSwitch;
      setStoredActiveGroup(activeGroupId);
      leaderboardData = null;
      renderPageContent();
      if (activeGroupId) await loadLeaderboard();
      renderPageContent();
      initPageListeners();
    });
  });
}
