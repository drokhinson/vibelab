// widgets/affiliate-partner-editor.js — editing ONE affiliate partner.
//
// The seam with views/admin-affiliates-view.js is the release-notices one:
// that file owns the SCREEN (route, gate, list, refresh, the enable switch),
// this one owns ONE PARTNER (the form, the saved-link preview). Inline on the
// spoke rather than a modal for the reason release-notice-editor.js gives — a
// form inside a centred card fights the software keyboard, and overlays.md §5
// forbids focusing a field on open.
//
// THE PREVIEW SHOWS THE SAVED ROW, NOT THE DRAFT. The link is built by exactly
// one function, server-side (affiliate_service.build_url), and the preview
// calls it through GET …/preview. Mirroring that function here for a
// live-typing preview would be a second writer that drifts — so the preview
// refreshes after Save, and the caption says so. Save is cheap and the row is
// never live until the switch is thrown anyway.
//
// Form chrome reuses the .rel-ed__* family (label, input, textarea, hint,
// actions): it is the app's admin form vocabulary, not release-notices'. A
// rename to admin-form__* is a sweep for the day a third editor lands.

(function () {
  const HOST = "window.adminAffiliatesView";
  const MAX_TAG = 100;
  const MAX_TEMPLATE = 500;
  const MAX_DISCLOSURE = 300;

  function _val(sel) {
    const el = document.querySelector(sel);
    return el ? el.value : "";
  }

  function render(partner, preview) {
    const p = partner || {};
    const status = p.live ? "Live" : p.enabled ? "Enabled, no credential" : "Off";
    return `
      <div class="rel-ed aff-ed">
        <div class="rel-ed__head">
          <h3 class="rel-ed__heading font-display">${escapeHtml(p.label || p.id || "Partner")}</h3>
          <p class="rel-ed__note">
            ${escapeHtml(status)}. Nothing changes for readers until you press
            <strong>Enable</strong> on the list, and Enable refuses a row with no
            tracking tag and no wrapper link.
          </p>
        </div>

        ${p.notes ? `<div class="aff-ed__hint">
          <i data-icon="info" class="w-4 h-4"></i>
          <span>${escapeHtml(p.notes)}</span>
        </div>` : ""}

        <label class="rel-ed__label" for="aff-ed-label">Label on the pill</label>
        <input class="rel-ed__input" id="aff-ed-label" type="text" maxlength="60"
               value="${escapeAttr(p.label || "")}" />

        <label class="rel-ed__label" for="aff-ed-tag">Tracking tag</label>
        <input class="rel-ed__input" id="aff-ed-tag" type="text" maxlength="${MAX_TAG}"
               autocapitalize="off" autocorrect="off" spellcheck="false"
               placeholder="e.g. bgbuddy-20 — substituted into {tag}"
               value="${escapeAttr(p.tracking_tag || "")}" />

        <label class="rel-ed__label" for="aff-ed-wrapper">Wrapper link</label>
        <input class="rel-ed__input" id="aff-ed-wrapper" type="url" maxlength="${MAX_TEMPLATE}"
               autocapitalize="off" autocorrect="off" spellcheck="false"
               placeholder="e.g. https://x.sjv.io/c/1/2/3?u={url} — the store link goes in {url}"
               value="${escapeAttr(p.wrapper_template || "")}" />
        <div class="rel-ed__hint">
          A network redirect wrapped around the store link. Leave empty for a
          program that only issues a tag.
        </div>

        <label class="rel-ed__label" for="aff-ed-template">Store URL template</label>
        <input class="rel-ed__input" id="aff-ed-template" type="text" maxlength="${MAX_TEMPLATE}"
               autocapitalize="off" autocorrect="off" spellcheck="false"
               value="${escapeAttr(p.url_template || "")}" />
        <div class="rel-ed__hint">
          <code>{query}</code> is the game's name, URL-encoded. <code>{tag}</code>
          is the tracking tag. A <code>tag=</code> left empty is dropped.
        </div>

        <label class="rel-ed__label" for="aff-ed-disclosure">Required disclosure</label>
        <textarea class="rel-ed__textarea" id="aff-ed-disclosure" rows="2"
                  maxlength="${MAX_DISCLOSURE}"
                  placeholder="A sentence the program makes you show beside its links, if any">${escapeHtml(p.disclosure || "")}</textarea>

        <div class="rel-ed__previewhead">Link preview (as last saved)</div>
        <div class="aff-ed__preview" id="aff-ed-preview">${renderPreview(preview)}</div>

        <div class="rel-ed__actions">
          <button class="btn btn-ghost" onclick="${HOST}._cancelEdit()">Cancel</button>
          <button class="btn btn-primary" onclick="${HOST}._saveEdit()">Save</button>
        </div>
      </div>
    `;
  }

  function renderPreview(preview) {
    if (!preview) return `<span class="aff-ed__preview-muted">Save to build a preview.</span>`;
    return `
      <span class="aff-ed__preview-game">For <strong>${escapeHtml(preview.game_name)}</strong>:</span>
      <a class="aff-ed__preview-url" href="${escapeAttr(preview.url)}" target="_blank"
         rel="noopener nofollow">${escapeHtml(preview.url)}</a>
    `;
  }

  /** Patch just the preview host after a save; never re-render the form. */
  function paintPreview(preview) {
    const host = document.querySelector("#aff-ed-preview");
    if (!host) return;
    host.innerHTML = renderPreview(preview);
    window.BgbIcons.render(host);
  }

  /**
   * Read the form and build the PATCH body. Clearing a credential is a flag,
   * not a blank string, because the server reads an absent key as "leave it".
   */
  function collect(original) {
    const label = _val("#aff-ed-label").trim();
    const tag = _val("#aff-ed-tag").trim();
    const wrapper = _val("#aff-ed-wrapper").trim();
    const template = _val("#aff-ed-template").trim();
    const disclosure = _val("#aff-ed-disclosure").trim();
    if (!label) { showToast("Give the pill a label", "error"); return null; }
    if (!template || !template.includes("{query}")) {
      showToast("The store URL template needs {query} in it", "error");
      return null;
    }
    if (wrapper && !/^https?:\/\//i.test(wrapper)) {
      showToast("The wrapper link must start with https://", "error");
      return null;
    }
    const o = original || {};
    const patch = { label, url_template: template };
    if (tag) patch.tracking_tag = tag; else if (o.tracking_tag) patch.clear_tag = true;
    if (wrapper) patch.wrapper_template = wrapper; else if (o.wrapper_template) patch.clear_wrapper = true;
    if (disclosure) patch.disclosure = disclosure; else if (o.disclosure) patch.clear_disclosure = true;
    return patch;
  }

  window.AffiliatePartnerEditor = { render, paintPreview, collect };
})();
