// widgets/scrap-editor.js — modal for editing a scrap's place fields.
// Shows Nominatim's resolved address so mis-geocodes are visible, with a
// "re-pin on map" action that re-runs geocoding on the edited fields.
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
    this.close();
    const s = this._scrap;
    const categories = window.store.get('categories') || [];
    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'scrap-editor-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="ScrapEditor.close()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Edit scrap">
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
          <div style="display:flex;gap:0.6rem;">
            <div style="flex:1;">
              <label class="ts-label" for="se-city">City</label>
              <input class="ts-input" id="se-city" value="${escapeAttr(s.place_city || '')}" />
            </div>
            <div style="flex:1;">
              <label class="ts-label" for="se-region">Region</label>
              <input class="ts-input" id="se-region" value="${escapeAttr(s.place_region || '')}" placeholder="state / province" />
            </div>
          </div>
          <label class="ts-label" for="se-country">Country</label>
          <input class="ts-input" id="se-country" value="${escapeAttr(s.place_country || '')}" />
          <label class="ts-label" for="se-category">Category</label>
          <select class="ts-select" id="se-category">
            ${categories.map((c) => `<option value="${escapeAttr(c.slug)}" ${c.slug === s.category ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
          </select>
          <label class="ts-label" for="se-notes">Notes</label>
          <textarea class="ts-textarea" id="se-notes" rows="2" placeholder="why you saved it…">${escapeHtml(s.notes || '')}</textarea>
          ${s.geocode_display_name ? `
            <p class="confidence-hint" style="margin-top:0.7rem;">
              Pinned as: ${escapeHtml(s.geocode_display_name)}
            </p>` : `
            <p class="confidence-hint" style="margin-top:0.7rem;">Not on the map yet.</p>`}
          <label style="display:flex;align-items:center;gap:0.5rem;margin-top:0.7rem;font-size:0.85rem;font-weight:700;">
            <input type="checkbox" id="se-visited" ${s.visited_at ? 'checked' : ''} style="width:18px;height:18px;" />
            I've been here (visited)
          </label>
          <label style="display:flex;align-items:center;gap:0.5rem;margin-top:0.5rem;font-size:0.85rem;font-weight:700;">
            <input type="checkbox" id="se-regeocode" checked style="width:18px;height:18px;" />
            Re-pin on the map from these fields
          </label>
          <div style="display:flex;gap:0.6rem;margin-top:1.1rem;">
            <button class="ts-btn ts-btn--mint" type="submit" style="flex:1;"><i data-lucide="check"></i>Save</button>
            <button class="ts-btn ts-btn--danger" type="button" id="se-delete" aria-label="Delete scrap"><i data-lucide="trash-2"></i></button>
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
        place_city: modal.querySelector('#se-city').value.trim() || null,
        place_region: modal.querySelector('#se-region').value.trim() || null,
        place_country: modal.querySelector('#se-country').value.trim() || null,
        category: modal.querySelector('#se-category').value,
        notes: modal.querySelector('#se-notes').value.trim() || null,
        visited: modal.querySelector('#se-visited').checked,
        regeocode: modal.querySelector('#se-regeocode').checked,
      };
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
      if (!confirmDestructive('Delete this scrap? This can\'t be undone.')) return;
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
