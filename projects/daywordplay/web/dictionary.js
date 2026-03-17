'use strict';

async function loadBookmarks() {
  try {
    const data = await apiFetch('/words/bookmarks');
    bookmarks = data.bookmarks || [];
  } catch (err) {
    bookmarks = [];
  }
}

function renderDictionaryView() {
  return `
    <div class="section-header">
      <span class="section-title">📚 Dictionary</span>
    </div>
    ${bookmarks.length === 0
      ? `<div class="text-muted text-center" style="padding:40px 0;">
          <div style="font-size:40px; margin-bottom:12px;">📖</div>
          <p>Bookmark words you want to remember — they'll appear here.</p>
        </div>`
      : `<div class="dictionary-list">
          ${bookmarks.map(b => renderDictCard(b)).join('')}
        </div>`
    }
  `;
}

function renderDictCard(b) {
  return `
    <div class="dict-card">
      <div class="dict-word">${escHtml(b.word)}</div>
      ${b.pronunciation ? `<div class="dict-pronunciation">${escHtml(b.pronunciation)}</div>` : ''}
      <div class="dict-pos">${escHtml(b.part_of_speech)}</div>
      <div class="dict-def">${escHtml(b.definition)}</div>
      ${b.etymology ? `<div class="dict-def" style="font-size:13px; color:var(--text-muted); margin-top:8px;"><strong>Origin:</strong> ${escHtml(b.etymology)}</div>` : ''}
      <button class="unbookmark-btn" data-unbookmark="${b.id}">Remove</button>
    </div>
  `;
}

function initDictionaryListeners() {
  document.querySelectorAll('[data-unbookmark]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const wordId = btn.dataset.unbookmark;
      btn.disabled = true;
      btn.textContent = 'Removing…';
      try {
        await apiFetch(`/words/${wordId}/bookmark`, { method: 'DELETE' });
        bookmarks = bookmarks.filter(b => b.id !== wordId);
        if (todayData && todayData.word.id === wordId) todayData.bookmarked = false;
        renderPageContent();
        initPageListeners();
        // Update header count
        const pill = document.querySelector('.bookmark-pill span');
        if (pill) pill.textContent = `${bookmarks.length}/5+`;
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Remove';
      }
    });
  });
}
