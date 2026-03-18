'use strict';

async function loadTodayWord() {
  if (!activeGroupId) return;
  try {
    todayData = await apiFetch(`/groups/${activeGroupId}/today`);
  } catch (err) {
    todayData = null;
  }
}

async function loadReusableSentences() {
  if (!activeGroupId || !todayData || todayData.submitted) {
    reusableSentences = [];
    return;
  }
  try {
    const data = await apiFetch(`/groups/${activeGroupId}/today/reusable-sentences`);
    reusableSentences = data.reusable_sentences || [];
  } catch (_) {
    reusableSentences = [];
  }
}

function renderReusablePills() {
  if (!reusableSentences.length) return '';
  return `
    <div class="reusable-sentences">
      <p class="reusable-label">Reuse a sentence from another group:</p>
      <div class="reusable-pills">
        ${reusableSentences.map((s, i) => `
          <button class="reusable-pill" data-reuse-idx="${i}">"${escHtml(s.sentence)}"</button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderHomeView() {
  if (!activeGroupId) {
    return renderNoGroupPrompt();
  }

  if (!todayData) {
    return `
      ${renderGroupSwitcher()}
      <div class="section-header" style="padding-top:16px;">
        <span class="section-title">Word of the Day</span>
      </div>
      <div class="loading" style="height:60vh"></div>
    `;
  }

  const { word, submitted, my_sentence, submission_count, member_count, bookmarked } = todayData;
  const hasYesterday = true; // always show vote option

  return `
    ${renderGroupSwitcher()}
    <div class="section-header" style="padding-top:16px;">
      <span class="section-title">Word of the Day</span>
    </div>
    ${renderWordDisplay(word)}
    ${word.etymology ? renderEtymologyCard(word.etymology) : ''}
    ${renderSentenceSection(submitted, my_sentence, word.word)}
    <div class="text-muted text-center mt-16" style="font-size:13px; margin-bottom:16px;">
      ${submission_count} of ${member_count} members submitted today
    </div>
    ${hasYesterday ? `
      <button class="icon-btn full-width mt-8" id="vote-tab-btn" style="justify-content:center; margin-bottom:24px;">
        Vote on yesterday's sentences ${icons.chevronRight}
      </button>
    ` : ''}
  `;
}

function renderNoGroupPrompt() {
  return `
    <div class="no-group-prompt">
      <div class="emoji">👥</div>
      <h2>Join a Group</h2>
      <p>You need to be in a group to see the word of the day. Search for a group or create your own!</p>
      <button class="btn-primary" id="go-groups-btn">Find or Create a Group</button>
    </div>
  `;
}

function renderGroupSwitcher() {
  if (myGroups.length <= 1) return '';
  return `
    <div class="group-switcher">
      ${myGroups.map(g => `
        <button class="group-chip ${g.id === activeGroupId ? 'active' : ''}" data-group-switch="${g.id}">
          ${escHtml(g.name)}
        </button>
      `).join('')}
    </div>
  `;
}

function renderWordDisplay(word) {
  return `
    <div class="word-display">
      <div class="word-main">${escHtml(word.word)}</div>
      <div class="word-definition">
        <span class="word-pos">${escHtml(word.part_of_speech)}.</span>
        ${escHtml(word.definition)}
      </div>
    </div>
  `;
}

function renderEtymologyCard(etymology) {
  return `
    <div class="etymology-card">
      <strong>Etymology:</strong> ${escHtml(etymology)}
    </div>
  `;
}

function renderSentenceSection(submitted, my_sentence, wordText) {
  if (submitted) {
    return `
      <div class="submitted-card">
        <div class="checkmark">✅</div>
        <p style="font-weight:600; font-size:15px; color:var(--text-secondary);">Your sentence for today</p>
        <div class="submitted-sentence-text">"${escHtml(my_sentence.sentence)}"</div>
        <p class="text-muted">Come back tomorrow to vote on your group's sentences!</p>
      </div>
    `;
  }

  return `
    <div class="sentence-section">
      <h3>Write your sentence</h3>
      <div class="sentence-input-wrap">
        ${renderReusablePills()}
        <textarea id="sentence-input" placeholder='Use "${wordText}" in a sentence…' rows="3"></textarea>
        <div class="sentence-submit-row">
          <button class="btn-primary" id="submit-sentence-btn">Submit</button>
        </div>
      </div>
      <div id="sentence-error"></div>
    </div>
  `;
}

function initHomeListeners() {
  // Group switcher
  document.querySelectorAll('[data-group-switch]').forEach(btn => {
    btn.addEventListener('click', async () => {
      activeGroupId = btn.dataset.groupSwitch;
      setStoredActiveGroup(activeGroupId);
      todayData = null;
      reusableSentences = [];
      renderPageContent();
      initHomeListeners(); // re-attach so group chips stay clickable during loading
      await loadTodayWord();
      await loadReusableSentences();
      renderPageContent();
      initPageListeners();
    });
  });

  // Reusable sentence pill clicks — populate textarea
  document.querySelectorAll('[data-reuse-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.reuseIdx, 10);
      const sentence = reusableSentences[idx]?.sentence || '';
      const input = document.getElementById('sentence-input');
      if (input) input.value = sentence;
    });
  });

  // No-group prompt — navigate to profile to join/create
  document.getElementById('go-groups-btn')?.addEventListener('click', () => {
    currentView = 'profile';
    renderPageContent();
    initPageListeners();
    updateTabBar();
  });

  // Sentence submission
  document.getElementById('submit-sentence-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('sentence-input');
    const errEl = document.getElementById('sentence-error');
    const sentence = input?.value.trim();
    if (!sentence || sentence.length < 5) {
      if (errEl) errEl.innerHTML = renderError('Please write a longer sentence.');
      return;
    }
    const btn = document.getElementById('submit-sentence-btn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    try {
      await apiFetch(`/groups/${activeGroupId}/sentences`, {
        method: 'POST',
        body: JSON.stringify({ sentence }),
      });
      await loadTodayWord();
      renderPageContent();
      initPageListeners();
    } catch (err) {
      if (errEl) errEl.innerHTML = renderError(err.message);
      btn.disabled = false;
      btn.textContent = 'Submit';
    }
  });

  // Vote tab shortcut
  document.getElementById('vote-tab-btn')?.addEventListener('click', async () => {
    currentView = 'vote';
    renderPageContent();
    await loadYesterdayData();
    renderPageContent();
    initPageListeners();
    updateTabBar();
  });
}
