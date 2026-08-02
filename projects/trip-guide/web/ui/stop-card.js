// ui/stop-card.js — canonical render function for the Stop object.
// Every stop uses this one standard card frame; colors come from the trip's
// palette (CSS vars set on the trip container). content_html is admin-authored
// and rendered as HTML on purpose. renderStopCard(stop, opts) → HTML string.
// opts: { index, isAdmin }.
(function () {
  function renderStopCard(stop, opts = {}) {
    const esc = window.escapeHtml;
    const num = (opts.index != null ? opts.index : 0) + 1;

    const dragHandle = opts.isAdmin
      ? `<button class="tg-stop-card__grip" data-drag-handle aria-label="Drag to reorder"><i data-lucide="grip-vertical"></i></button>`
      : "";
    const adminActions = opts.isAdmin
      ? `<div class="tg-stop-card__actions">
           <button class="btn btn-xs btn-ghost" data-edit-stop="${esc(stop.id)}" aria-label="Edit stop"><i data-lucide="pencil"></i></button>
           <button class="btn btn-xs btn-ghost tg-danger" data-delete-stop="${esc(stop.id)}" aria-label="Delete stop"><i data-lucide="trash-2"></i></button>
         </div>`
      : "";

    const content = (stop.content_html && stop.content_html.trim())
      ? `<div class="tg-stop-card__content tg-html">${stop.content_html}</div>`
      : "";

    return `
      <article class="tg-stop-card" data-stop-id="${esc(stop.id)}" ${opts.isAdmin ? 'draggable="true"' : ""}>
        <div class="tg-stop-card__rail" aria-hidden="true">
          <span class="tg-stop-card__num">${num}</span>
        </div>
        <div class="tg-stop-card__main">
          <header class="tg-stop-card__head">
            ${dragHandle}
            <div class="tg-stop-card__titles">
              <h3 class="tg-stop-card__name">${esc(stop.name)}</h3>
              ${stop.description ? `<p class="tg-stop-card__desc">${esc(stop.description)}</p>` : ""}
            </div>
            ${adminActions}
          </header>
          ${content}
        </div>
      </article>`;
  }

  window.renderStopCard = renderStopCard;
})();
