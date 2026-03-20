'use strict';

async function loadYesterdayData() {
  if (!activeGroupId) return;
  const cached = dwpCache.get('yesterday', activeGroupId);
  if (cached) {
    yesterdayData = cached;
    return;
  }
  // Cache miss — bulk-load all groups in parallel on first visit
  await _bulkLoadYesterday();
  yesterdayData = dwpCache.get('yesterday', activeGroupId) || null;
}

async function _bulkLoadYesterday() {
  await Promise.all(myGroups.map(async (g) => {
    if (dwpCache.get('yesterday', g.id)) return; // already cached
    try {
      const data = await apiFetch(`/groups/${g.id}/yesterday`);
      dwpCache.set('yesterday', g.id, data);
    } catch (_) {}
  }));
}

// Lightweight vote-count refresh for the active group. Called non-blocking on group switch.
async function _refreshVoteCounts(groupId) {
  try {
    const data = await apiFetch(`/groups/${groupId}/vote-counts`);
    dwpCache.updateVoteCounts(groupId, data.vote_counts, data.has_voted);
    // Only update global state if the group is still active when response arrives
    if (groupId === activeGroupId) {
      yesterdayData = dwpCache.get('yesterday', activeGroupId);
      renderPageContent();
      initPageListeners();
    }
  } catch (_) {
    // Silently fail — stale counts are acceptable
  }
}

function renderSentenceCard(s, has_voted, maxVotes, wordText) {
  const isWinner = has_voted && s.vote_count === maxVotes && maxVotes > 0;
  const cardClass = s.i_voted ? 'voted' : (isWinner ? 'winner' : '');

  return `
    <div class="sentence-card ${cardClass}" data-sentence-id="${s.id}">
      ${isWinner ? '<div class="winner-badge">🏆 Top pick</div>' : ''}
      <div class="sentence-card-text">"${wordText ? highlightWord(s.sentence, wordText) : escHtml(s.sentence)}"</div>
      <div class="sentence-card-footer">
        <span class="sentence-author">
          ${escHtml(s.display_name || s.username)}
          ${s.is_mine ? ' <span style="color:var(--text-muted)">(you)</span>' : ''}
        </span>
        <button
          class="vote-btn ${s.i_voted ? 'voted' : ''} ${s.is_mine ? 'mine' : ''}"
          data-vote-sentence="${s.id}"
          ${s.is_mine || has_voted ? 'disabled' : ''}
        >
          ${icons.thumbsUp}
          ${s.vote_count}
        </button>
      </div>
    </div>
  `;
}

function initVoteListeners() {
  document.querySelectorAll('[data-vote-sentence]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      if (btn.disabled) return;
      const sentenceId = btn.dataset.voteSentence;
      btn.disabled = true;
      try {
        await apiFetch(`/sentences/${sentenceId}/vote`, { method: 'POST' });
        // Optimistic in-place update — no re-fetch needed
        const updated = dwpCache.patchVoteOptimistic(activeGroupId, sentenceId);
        if (updated) {
          yesterdayData = updated;
        } else {
          // Cache miss fallback — full re-fetch
          await loadYesterdayData();
        }
        renderPageContent();
        initPageListeners();
      } catch (err) {
        const card = btn.closest('.sentence-card');
        if (card) {
          const errDiv = document.createElement('div');
          errDiv.innerHTML = renderError(err.message);
          card.appendChild(errDiv);
        }
        btn.disabled = false;
      }
    });
  });
}
