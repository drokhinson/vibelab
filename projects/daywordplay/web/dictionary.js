'use strict';

async function loadAllWords() {
  try {
    const data = await apiFetch('/words/all');
    allWords = data.words || [];
  } catch (err) {
    allWords = [];
  }
}

async function loadPlayedWords() {
  try {
    const data = await apiFetch('/words/played');
    playedWords = data.words || [];
  } catch (err) {
    playedWords = [];
  }
}

function renderDictionaryView() {
  const isLoaded = dictFilter === 'played' ? playedWords.length > 0 : allWords.length > 0;
  const filtered = dictFilter === 'played' ? playedWords : allWords;

  return `
    <div class="dict-sticky-header">
      <div class="section-header" style="display:flex; align-items:center; justify-content:space-between; padding-right:16px;">
        <span class="section-title">📚 Dictionary</span>
        <button class="propose-word-btn" id="propose-word-btn">+ Propose word</button>
      </div>
      <div class="dict-filter-row">
        <button class="dict-filter-btn ${dictFilter === 'played' ? 'active' : ''}" id="dict-filter-played">Played</button>
        <button class="dict-filter-btn ${dictFilter === 'all' ? 'active' : ''}" id="dict-filter-all">All Words</button>
      </div>
    </div>
    <div class="dict-scroll-area">
      ${!isLoaded
        ? `<div class="loading" style="height:40vh"></div>`
        : filtered.length === 0
          ? `<div class="text-muted text-center" style="padding:40px 0;">
              <div style="font-size:40px; margin-bottom:12px;">${dictFilter === 'played' ? '✍️' : '📖'}</div>
              <p>${dictFilter === 'played' ? 'No played words yet — submit a sentence to see them here.' : 'No words in the dictionary yet.'}</p>
            </div>`
          : renderDictionaryAlpha(filtered)
      }
      <div id="propose-modal-container"></div>
    </div>
  `;
}

function renderDictionaryAlpha(words) {
  const groups = {};
  for (const w of words) {
    const letter = w.word[0].toUpperCase();
    if (!groups[letter]) groups[letter] = [];
    groups[letter].push(w);
  }

  const letters = Object.keys(groups).sort();
  return `
    <div class="dictionary-container">
      <div class="dictionary-list">
        ${letters.map(letter => `
          <div class="dict-letter-section" id="dict-letter-${letter}">
            <div class="dict-letter-header">${letter}</div>
            ${groups[letter].map(w => renderDictCard(w)).join('')}
          </div>
        `).join('')}
      </div>
      ${letters.length > 0 ? `
        <div class="alpha-index" id="alpha-index">
          ${letters.map(l => `<button class="alpha-index-letter" data-scroll-letter="${l}">${l}</button>`).join('')}
        </div>
      ` : ''}
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
      ${w.is_played && w.my_sentence ? `
        <div class="dict-my-sentence">
          <div class="dict-my-sentence-label">✍️ Your sentence</div>
          "${highlightWord(w.my_sentence, w.word)}"
        </div>
      ` : ''}
      ${w.winning_sentence ? `
        <div class="dict-winning-sentence">
          <div class="dict-winning-label">🏆 Best sentence</div>
          <div class="dict-winning-text">"${highlightWord(w.winning_sentence, w.word)}"</div>
          ${w.winning_author ? `<div class="dict-winning-author">— ${escHtml(w.winning_author)}</div>` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function renderProposeModal() {
  return `
    <div class="modal-overlay" id="propose-modal-overlay">
      <div class="modal-sheet" role="dialog" aria-modal="true" aria-label="Propose a word">
        <div style="display:flex; align-items:center; justify-content:space-between;">
          <div class="modal-title">Propose a Word</div>
          <button class="modal-close-btn" id="propose-modal-close" aria-label="Close">&times;</button>
        </div>
        <p style="font-size:13px; color:var(--text-muted); margin:0 0 20px;">
          Suggest a word for the dictionary. An admin will review it before it enters rotation.
        </p>
        <div class="modal-form-group">
          <input id="propose-word" type="text" placeholder="Word *" style="width:100%; box-sizing:border-box;" />
          <input id="propose-pos" type="text" placeholder="Part of speech * (e.g. noun)" style="width:100%; box-sizing:border-box;" />
          <textarea id="propose-def" placeholder="Definition *" rows="2" style="width:100%; box-sizing:border-box; resize:vertical;"></textarea>
          <input id="propose-pron" type="text" placeholder="Pronunciation (optional)" style="width:100%; box-sizing:border-box;" />
          <textarea id="propose-etym" placeholder="Etymology (optional)" rows="2" style="width:100%; box-sizing:border-box; resize:vertical;"></textarea>
        </div>
        <div id="propose-modal-msg"></div>
        <button class="btn-primary" id="propose-submit-btn" style="width:100%; margin-top:8px;">Submit Proposal</button>
      </div>
    </div>
  `;
}

function initDictionaryListeners() {
  // iPhone-style touch/mouse scrubbing on alphabet index
  const alphaIndex = document.getElementById('alpha-index');
  if (alphaIndex) {
    let scrubbing = false;

    function scrubToLetter(clientY) {
      const el = document.elementFromPoint(alphaIndex.getBoundingClientRect().left + 5, clientY);
      if (!el || !el.dataset.scrollLetter) return;
      const letter = el.dataset.scrollLetter;
      // Clear previous active
      alphaIndex.querySelectorAll('.alpha-index-letter').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      const section = document.getElementById(`dict-letter-${letter}`);
      if (section) {
        scrollToSection(section);
      }
    }

    function scrollToSection(section) {
      const pageContent = document.querySelector('.page-content');
      if (!pageContent) return;
      const stickyHeader = document.querySelector('.dict-sticky-header');
      const headerH = stickyHeader ? stickyHeader.offsetHeight : 0;
      const sectionTop = section.getBoundingClientRect().top + pageContent.scrollTop - pageContent.getBoundingClientRect().top;
      pageContent.scrollTop = sectionTop - headerH;
    }


    function endScrub() {
      scrubbing = false;
      alphaIndex.querySelectorAll('.alpha-index-letter').forEach(b => b.classList.remove('active'));
    }

    // Touch events
    alphaIndex.addEventListener('touchstart', (e) => {
      e.preventDefault();
      scrubbing = true;
      const touch = e.touches[0];
      scrubToLetter(touch.clientY);
    }, { passive: false });

    alphaIndex.addEventListener('touchmove', (e) => {
      if (!scrubbing) return;
      e.preventDefault();
      const touch = e.touches[0];
      scrubToLetter(touch.clientY);
    }, { passive: false });

    alphaIndex.addEventListener('touchend', endScrub);
    alphaIndex.addEventListener('touchcancel', endScrub);

    // Mouse events (for desktop)
    alphaIndex.addEventListener('mousedown', (e) => {
      e.preventDefault();
      scrubbing = true;
      scrubToLetter(e.clientY);
    });

    document.addEventListener('mousemove', (e) => {
      if (!scrubbing) return;
      scrubToLetter(e.clientY);
    });

    document.addEventListener('mouseup', () => {
      if (scrubbing) endScrub();
    });
  }

  // Click fallback for individual letters
  document.querySelectorAll('[data-scroll-letter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const letter = btn.dataset.scrollLetter;
      const section = document.getElementById(`dict-letter-${letter}`);
      if (section) {
        const pageContent = document.querySelector('.page-content');
        if (pageContent) {
          const stickyHeader = document.querySelector('.dict-sticky-header');
          const headerH = stickyHeader ? stickyHeader.offsetHeight : 0;
          const sectionTop = section.getBoundingClientRect().top + pageContent.scrollTop - pageContent.getBoundingClientRect().top;
          pageContent.scrollTo({ top: sectionTop - headerH, behavior: 'smooth' });
        }
      }
    });
  });

  // Filter toggle — lazy-load data on first selection
  document.getElementById('dict-filter-all')?.addEventListener('click', async () => {
    if (dictFilter === 'all') return;
    dictFilter = 'all';
    renderPageContent();
    initPageListeners();
    if (allWords.length === 0) {
      await loadAllWords();
      renderPageContent();
      initPageListeners();
    }
  });

  document.getElementById('dict-filter-played')?.addEventListener('click', async () => {
    if (dictFilter === 'played') return;
    dictFilter = 'played';
    renderPageContent();
    initPageListeners();
    if (playedWords.length === 0) {
      await loadPlayedWords();
      renderPageContent();
      initPageListeners();
    }
  });

  // Propose word modal
  document.getElementById('propose-word-btn')?.addEventListener('click', () => {
    const container = document.getElementById('propose-modal-container');
    if (container) {
      container.innerHTML = renderProposeModal();
      initProposeModalListeners();
    }
  });
}

function initProposeModalListeners() {
  // Close on overlay click or close button
  document.getElementById('propose-modal-close')?.addEventListener('click', closeProposeModal);
  document.getElementById('propose-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'propose-modal-overlay') closeProposeModal();
  });

  document.getElementById('propose-submit-btn')?.addEventListener('click', async () => {
    const wordEl = document.getElementById('propose-word');
    const posEl = document.getElementById('propose-pos');
    const defEl = document.getElementById('propose-def');
    const pronEl = document.getElementById('propose-pron');
    const etymEl = document.getElementById('propose-etym');
    const msgEl = document.getElementById('propose-modal-msg');

    const word = wordEl?.value.trim().toLowerCase();
    const pos = posEl?.value.trim();
    const def = defEl?.value.trim();
    const pron = pronEl?.value.trim() || null;
    const etym = etymEl?.value.trim() || null;

    if (!word || !pos || !def) {
      if (msgEl) msgEl.innerHTML = renderError('Word, part of speech, and definition are required.');
      return;
    }

    // Client-side duplicate check (only when full word list is loaded; server also validates)
    if (allWords.length > 0) {
      const alreadyExists = allWords.some(w => w.word.toLowerCase() === word);
      if (alreadyExists) {
        if (msgEl) msgEl.innerHTML = renderError(`"${escHtml(word)}" is already in the dictionary.`);
        return;
      }
    }

    const btn = document.getElementById('propose-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    try {
      await apiFetch('/words/propose', {
        method: 'POST',
        body: JSON.stringify({ word, part_of_speech: pos, definition: def, pronunciation: pron, etymology: etym }),
      });
      if (msgEl) msgEl.innerHTML = renderSuccess(`"${escHtml(word)}" submitted! An admin will review it.`);
      // Clear form on success
      [wordEl, posEl, defEl, pronEl, etymEl].forEach(el => { if (el) el.value = ''; });
      btn.textContent = 'Submitted ✓';
    } catch (err) {
      if (msgEl) msgEl.innerHTML = renderError(err.message);
      btn.disabled = false;
      btn.textContent = 'Submit Proposal';
    }
  });
}

function closeProposeModal() {
  const container = document.getElementById('propose-modal-container');
  if (container) container.innerHTML = '';
}
