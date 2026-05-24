'use strict';

// Canonical Sauce row component. Used by Browse, Saucebook, the meal-flow
// Sauce Selector, and the Sauce Manager → Sauces list. The visual is the
// flat `.admin-sauce-row` shell (color dot + name + author subline + optional
// right-slot pill / action). Per-screen extras (saucebook swipe wrapping,
// sauce-manager type pill / merge tags, browse "+ Saucebook" CTA) are passed
// in via `opts` so the helper itself stays neutral.
//
// `sauce` is a sauce envelope (ingredients optional — Browse rows are slim).
// Options:
//   subline       — overrides the default "by &lt;Author&gt;" line.
//   variantBadge  — pre-rendered HTML appended after the name (e.g. the
//                   git-branch chip used by Sauce Selector / Sauce Manager).
//   rightSlot     — pre-rendered HTML inserted before the action button
//                   (sauce-type pill, missing badge, merge tag, …).
//   actionLabel / actionHandler / actionDisabled — Browse "+ Saucebook" CTA.
//   onClick       — JS expression for the row's tap handler.
//   rowClass      — extra classes on the row (`unavailable`,
//                   `admin-sauce-row--variant`, …).
function renderSauceRow(sauce, opts = {}) {
  const author = sauce.authorName || (sauce.createdBy ? 'Unknown' : 'SauceBoss');
  const subline = opts.subline != null ? opts.subline : `by ${escapeHtml(author)}`;
  const variantBadge = opts.variantBadge || '';
  const rightSlot = opts.rightSlot || '';
  const actionBtn = opts.actionLabel
    ? `<button class="admin-sauce-row__action ${opts.actionDisabled ? 'admin-sauce-row__action--added' : ''}"
                ${opts.actionDisabled ? 'disabled' : ''}
                onclick="${opts.actionHandler || ''}">${opts.actionLabel}</button>`
    : '';
  const onClickAttr = opts.onClick ? ` onclick="${opts.onClick}"` : '';
  const cls = `admin-sauce-row${opts.rowClass ? ' ' + opts.rowClass : ''}`;
  return `
    <div class="${cls}"${onClickAttr}>
      <span class="sauce-dot" style="background:${sauce.color || 'var(--accent)'}"></span>
      <div class="admin-sauce-info">
        <div class="admin-sauce-name">${escapeHtml(sauce.name)}${variantBadge}</div>
        <div class="admin-sauce-meta">${subline}</div>
      </div>
      ${rightSlot}
      ${actionBtn}
    </div>
  `;
}
