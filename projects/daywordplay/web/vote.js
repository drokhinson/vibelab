'use strict';

async function loadYesterdayData() {
  if (!activeGroupId) return;
  try {
    yesterdayData = await apiFetch(`/groups/${activeGroupId}/yesterday`);
  } catch (err) {
    yesterdayData = null;
  }
}

function renderSentenceCard(s, has_voted, maxVotes) {
  const isWinner = has_voted && s.vote_count === maxVotes && maxVotes > 0;
  const cardClass = s.i_voted ? 'voted' : (isWinner ? 'winner' : '');

  return `
    <div class="sentence-card ${cardClass}" data-sentence-id="${s.id}">
      ${isWinner ? '<div class="winner-badge">🏆 Top pick</div>' : ''}
      <div class="sentence-card-text">"${escHtml(s.sentence)}"</div>
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
        await loadYesterdayData();
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
