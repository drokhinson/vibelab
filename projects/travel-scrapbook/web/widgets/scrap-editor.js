// widgets/scrap-editor.js — modal for editing a scrap's place fields.
// City/country/region are read-only reflections of the place's pin (the
// Google Maps URL / geocoded point it was captured from), not typed fields —
// the only way to move a place is to paste a different Maps link.
'use strict';

const ScrapEditor = {
  _scrap: null,
  _tripId: null,
  _onSaved: null,

  open(scrap, tripId, { onSaved } = {}) {
    this._scrap = scrap;
    this._tripId = tripId;
    this._onSaved = onSaved || null;
    this._render();
  },

  close() {
    document.getElementById('scrap-editor-modal')?.remove();
    this._scrap = null;
  },

  _render() {
    // Drop any stale modal DOM but keep _scrap — close() nulls _scrap, which
    // would leave `s` null here (the bug this replaced).
    document.getElementById('scrap-editor-modal')?.remove();
    const s = this._scrap;
    if (!s) return;
    const categories = window.store.get('categories') || [];
    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'scrap-editor-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="ScrapEditor.close()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Edit place">
        <button class="ts-modal__close" onclick="ScrapEditor.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">Edit this place</h2>
        ${(s.sources || []).length ? `
          <div class="scrap-card__row" style="margin-top:0.2rem;">
            ${(s.sources || []).map((src) => `
              <a class="source-badge" href="${escapeAttr(src.url)}" target="_blank" rel="noopener"
                 title="${escapeAttr(src.og_title || src.url)}">
                <i data-lucide="link-2"></i>${escapeHtml(src.source_domain || 'link')}
              </a>`).join('')}
          </div>` : ''}
        <form id="scrap-editor-form">
          <label class="ts-label" for="se-name">Place name</label>
          <input class="ts-input" id="se-name" value="${escapeAttr(s.place_name || '')}" placeholder="e.g. Ichiran Ramen" />
          <label class="ts-label">Location</label>
          <div style="display:flex;gap:0.6rem;">
            ${[['City', s.place_city], ['Country', s.place_country], ['Region', s.place_region]].map(([lbl, val]) => `
              <div style="flex:1;">
                <span style="display:block;font-size:0.7rem;font-weight:600;opacity:0.55;text-transform:uppercase;letter-spacing:0.03em;">${lbl}</span>
                <span style="display:block;font-size:0.92rem;font-weight:600;">${val ? escapeHtml(val) : '—'}</span>
              </div>`).join('')}
          </div>
          <label class="ts-label" for="se-category">Category</label>
          <select class="ts-select" id="se-category">
            ${categories.map((c) => `<option value="${escapeAttr(c.slug)}" ${c.slug === s.category ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
          </select>
          <label class="ts-label" for="se-notes">Notes</label>
          <textarea class="ts-textarea" id="se-notes" rows="2" placeholder="why you saved it…">${escapeHtml(s.notes || '')}</textarea>
          <label class="ts-label" for="se-maps-url">Google Maps link</label>
          <input class="ts-input" id="se-maps-url" value="${escapeAttr(s.maps_url || '')}"
                 placeholder="paste a maps.app.goo.gl or google.com/maps link" />
          <p class="confidence-hint" style="margin-top:0.3rem;">Paste a Maps link to pin the exact spot — city, country &amp; region fill in from it.</p>
          ${s.geocode_display_name ? `
            <p class="confidence-hint" style="margin-top:0.7rem;">
              Pinned as: ${escapeHtml(s.geocode_display_name)}
            </p>` : `
            <p class="confidence-hint" style="margin-top:0.7rem;">Not on the map yet.</p>`}
          <div style="display:flex;gap:0.6rem;margin-top:1.1rem;">
            <button class="ts-btn ts-btn--mint" type="submit" style="flex:1;"><i data-lucide="check"></i>Save</button>
            <button class="ts-btn ts-btn--danger" type="button" id="se-delete" aria-label="Delete place"><i data-lucide="trash-2"></i></button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });

    modal.querySelector('#scrap-editor-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fields = {
        place_name: modal.querySelector('#se-name').value.trim() || null,
        category: modal.querySelector('#se-category').value,
        notes: modal.querySelector('#se-notes').value.trim() || null,
      };
      // Only send maps_url when the user actually changed it — an unchanged
      // (often auto-generated) link shouldn't trigger a re-parse/geocode on save.
      const mapsUrl = modal.querySelector('#se-maps-url').value.trim();
      if (mapsUrl !== (s.maps_url || '')) fields.maps_url = mapsUrl || null;
      try {
        await window.ScrapDomain.update(s.id, this._tripId, fields);
        toast('Saved');
        this._onSaved?.();
        this.close();
      } catch (err) {
        toast(err.message || 'Save failed', { error: true });
      }
    });

    modal.querySelector('#se-delete').addEventListener('click', async () => {
      if (!confirmDestructive('Delete this place completely? It leaves every trip — including as a checkpoint — and the community pool, and this can\'t be undone.')) return;
      try {
        await window.ScrapDomain.remove(s.id, this._tripId);
        toast('Scrap deleted');
        this._onSaved?.();
        this.close();
      } catch (err) {
        toast(err.message || 'Delete failed', { error: true });
      }
    });
  },
};
window.ScrapEditor = ScrapEditor;
