'use strict';

async function loadWordHistory() {
  try {
    const data = await apiFetch('/words/history');
    wordHistory = data.words || [];
  } catch (err) {
    wordHistory = [];
  }
}

function renderDictionaryView() {
  return `
    <div class="section-header">
      <span class="section-title">📚 Dictionary</span>
    </div>
    ${wordHistory.length === 0
      ? `<div class="text-muted text-center" style="padding:40px 0;">
          <div style="font-size:40px; margin-bottom:12px;">📖</div>
          <p>No past words yet — come back after your groups play!</p>
        </div>`
      : renderDictionaryAlpha()
    }
  `;
}

function renderDictionaryAlpha() {
  // Group words by first letter
  const groups = {};
  for (const w of wordHistory) {
    const letter = w.word[0].toUpperCase();
    if (!groups[letter]) groups[letter] = [];
    groups[letter].push(w);
  }

  const letters = Object.keys(groups).sort();
  return `
    <div class="dictionary-list">
      ${letters.map(letter => `
        <div class="dict-letter-section">
          <div class="dict-letter-header">${letter}</div>
          ${groups[letter].map(w => renderDictCard(w)).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

function renderDictCard(w) {
  return `
    <div class="dict-card">
      <div class="dict-word">${escHtml(w.word)}</div>
      ${w.pronunciation ? `<div class="dict-pronunciation">${escHtml(w.pronunciation)}</div>` : ''}
      <div class="dict-pos">${escHtml(w.part_of_speech)}</div>
      <div class="dict-def">${escHtml(w.definition)}</div>
      ${w.etymology ? `<div class="dict-def" style="font-size:13px; color:var(--text-muted); margin-top:8px;"><strong>Origin:</strong> ${escHtml(w.etymology)}</div>` : ''}
      ${w.winning_sentence ? `
        <div class="dict-winning-sentence">
          <div class="dict-winning-label">🏆 Best sentence</div>
          <div class="dict-winning-text">"${escHtml(w.winning_sentence)}"</div>
          ${w.winning_author ? `<div class="dict-winning-author">— ${escHtml(w.winning_author)}</div>` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function initDictionaryListeners() {
  // No interactive elements in history-based dictionary
}
