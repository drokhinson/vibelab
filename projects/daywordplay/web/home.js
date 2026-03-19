'use strict';

async function loadTodayWord() {
  if (!activeGroupId) return;
  try {
    todayData = await apiFetch(`/groups/${activeGroupId}/today`);
    cachedDailyWord = todayData.word;
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
  const groupNames = {};
  for (const g of myGroups) groupNames[g.id] = g.name;

  // Deduplicate by sentence text — collect all group names per unique sentence
  const uniqueMap = new Map();
  for (let i = 0; i < reusableSentences.length; i++) {
    const s = reusableSentences[i];
    const key = s.sentence.toLowerCase();
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, { sentence: s.sentence, idx: i, groups: [] });
    }
    uniqueMap.get(key).groups.push(groupNames[s.group_id] || 'another group');
  }

  const wordText = todayData?.word?.word || '';

  return `
    <div class="reusable-sentences">
      <div class="reusable-header">
        <span class="reusable-icon">${icons.share}</span>
        <p class="reusable-label">Reuse from another group</p>
      </div>
      <div class="reusable-pills">
        ${[...uniqueMap.values()].map(entry => `
            <button class="reusable-pill" data-reuse-idx="${entry.idx}">
              <span class="reusable-pill-text">"${highlightWord(entry.sentence, wordText)}"</span>
              <span class="reusable-pill-source">from ${entry.groups.map(g => escHtml(g)).join(', ')}</span>
            </button>
          `).join('')}
      </div>
    </div>
  `;
}

function renderWordTabs() {
  return `
    <div class="word-tabs">
      <button class="word-tab-btn ${activeWordTab === 'today' ? 'active' : ''}" id="sub-tab-today">Word of the Day</button>
      <button class="word-tab-btn ${activeWordTab === 'vote' ? 'active' : ''}" id="sub-tab-vote">Vote</button>
    </div>
  `;
}

function renderHomeView() {
  if (!activeGroupId) {
    return renderNoGroupPrompt();
  }

  return `
    ${renderGroupSwitcher()}
    ${renderWordTabs()}
    ${activeWordTab === 'today' ? renderTodayTab() : renderVoteTab()}
  `;
}

function renderTodayTab() {
  if (!todayData) {
    return `<div class="loading" style="height:60vh"></div>`;
  }

  const { word, submitted, my_sentence, submission_count, member_count, _loading } = todayData;

  return `
    ${renderWordDisplay(word)}
    ${word.etymology ? renderEtymologyCard(word.etymology) : ''}
    ${_loading
      ? '<div style="display:flex;justify-content:center;padding:32px 0;"><div class="loading-spinner" style="width:20px;height:20px;"></div></div>'
      : renderSentenceSection(submitted, my_sentence, word.word)}
    ${!_loading ? `<div class="text-muted text-center mt-16" style="font-size:13px; margin-bottom:24px;">
      ${submission_count} of ${member_count} members submitted today
    </div>` : ''}
  `;
}

function renderVoteTab() {
  if (!yesterdayData) {
    return `<div class="loading" style="height:60vh"></div>`;
  }

  const { word, sentences, has_voted, date } = yesterdayData;

  if (!word || !sentences.length) {
    return `
      <div class="text-muted" style="font-size:15px; padding:40px 20px; text-align:center;">
        No sentences to vote on yet — come back after everyone submits for today!
      </div>
    `;
  }

  const maxVotes = Math.max(...sentences.map(s => s.vote_count), 0);

  return `
    ${renderWordDisplay(word)}
    <div class="vote-date">${formatDate(date)} — vote for the best sentence</div>
    ${has_voted ? renderSuccess('You voted! Results below.') : '<p class="text-muted" style="margin-top:8px; font-size:14px; text-align:center;">Tap ❤️ to vote for your favourite sentence.</p>'}
    <div class="sentence-cards">
      ${sentences.map(s => renderSentenceCard(s, has_voted, maxVotes, word.word)).join('')}
    </div>
    <div style="margin-bottom:24px;"></div>
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
        <div class="submitted-sentence-text">"${highlightWord(my_sentence.sentence, wordText)}"</div>
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
        <div class="submit-hint" id="submit-hint">Include the word <em>${escHtml(wordText)}</em> to unlock submit</div>
        <div class="sentence-submit-row">
          <button class="btn-primary" id="submit-sentence-btn" disabled>Submit</button>
        </div>
      </div>
      <div id="sentence-error"></div>
    </div>
  `;
}

function initHomeListeners() {
  // Sub-tab switching
  document.getElementById('sub-tab-today')?.addEventListener('click', () => {
    activeWordTab = 'today';
    renderPageContent();
    initPageListeners();
  });

  document.getElementById('sub-tab-vote')?.addEventListener('click', async () => {
    activeWordTab = 'vote';
    renderPageContent();
    initPageListeners();
    if (!yesterdayData && activeGroupId) {
      await loadYesterdayData();
      renderPageContent();
      initPageListeners();
    }
  });

  // Group switcher
  document.querySelectorAll('[data-group-switch]').forEach(btn => {
    btn.addEventListener('click', async () => {
      activeGroupId = btn.dataset.groupSwitch;
      setStoredActiveGroup(activeGroupId);
      // Keep word visible during switch (same word for all groups)
      if (cachedDailyWord) {
        todayData = { word: cachedDailyWord, submitted: false, my_sentence: null, submission_count: 0, member_count: 0, bookmarked: false, _loading: true };
      } else {
        todayData = null;
      }
      yesterdayData = null;
      reusableSentences = [];
      renderPageContent();
      initHomeListeners();
      if (activeWordTab === 'today') {
        await loadTodayWord();
        await loadReusableSentences();
      } else {
        await loadYesterdayData();
      }
      renderPageContent();
      initPageListeners();
    });
  });

  // Reusable sentence pill clicks — populate textarea and trigger word check
  document.querySelectorAll('[data-reuse-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.reuseIdx, 10);
      const sentence = reusableSentences[idx]?.sentence || '';
      const input = document.getElementById('sentence-input');
      if (input) {
        input.value = sentence;
        input.dispatchEvent(new Event('input'));
      }
    });
  });

  // No-group prompt — navigate to profile to join/create
  document.getElementById('go-groups-btn')?.addEventListener('click', () => {
    currentView = 'profile';
    renderPageContent();
    initPageListeners();
    updateTabBar();
  });

  // Live word-presence check — enable/disable submit button
  const sentenceInput = document.getElementById('sentence-input');
  const submitBtn = document.getElementById('submit-sentence-btn');
  const hintEl = document.getElementById('submit-hint');
  const wordText = todayData?.word?.word || '';

  if (sentenceInput && submitBtn) {
    sentenceInput.addEventListener('input', () => {
      const val = sentenceInput.value;
      const hasWord = wordText && val.toLowerCase().includes(wordText.toLowerCase());
      submitBtn.disabled = !hasWord;
      if (hintEl) hintEl.style.display = hasWord ? 'none' : '';
    });
  }

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

  // Vote listeners are always attached since vote tab may be visible
  initVoteListeners();
}
