// widgets/note-popup.js — view/edit a place's note in a popup. The card shows
// only a note chip (filled when a note exists); the text itself lives here.
'use strict';

const NotePopup = {
  open(scrap, { onSaved } = {}) {
    this.close();
    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'note-popup-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="NotePopup.close()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Note">
        <button class="ts-modal__close" onclick="NotePopup.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">${escapeHtml(scrap.place_name || 'This place')}</h2>
        <form id="note-form">
          <label class="ts-label" for="note-text">Your note</label>
          <textarea class="ts-input" id="note-text" rows="4" maxlength="2000"
                    placeholder="why you saved it, what to order, who told you…">${escapeHtml(scrap.notes || '')}</textarea>
          <button class="ts-btn ts-btn--mint" type="submit" style="width:100%;margin-top:0.9rem;">
            <i data-lucide="check"></i>Save note
          </button>
          ${scrap.notes ? `
            <button class="ts-btn ts-btn--ghost" type="button" id="note-remove" style="width:100%;margin-top:0.6rem;">
              <i data-lucide="eraser"></i>Remove note
            </button>` : ''}
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });
    const textarea = modal.querySelector('#note-text');
    textarea.focus();

    // Close + toast in the same frame the button is pressed; the caller persists
    // optimistically (via ScrapDomain.saveNote) and surfaces any write error.
    // `onSaved` receives the new note value (string, or null when cleared).
    const save = (notes) => {
      this.close();
      toast(notes ? 'Note saved' : 'Note removed');
      onSaved?.(notes);
    };
    modal.querySelector('#note-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      save(textarea.value.trim() || null);
    });
    modal.querySelector('#note-remove')?.addEventListener('click', () => save(null));
  },

  close() {
    document.getElementById('note-popup-modal')?.remove();
  },
};
window.NotePopup = NotePopup;
