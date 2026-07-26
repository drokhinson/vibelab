// domain/scoring-template.js — scoring-template helpers.
//
// A "scoring template" is not its own object — it's a reference-guide Chapter
// with chapter_type='scoring_template' and layout='scoring_template' whose
// `content` holds the ordered named rows as JSON: {"rows":["Cats","Baskets"]}.
// This module is the single source of truth for that content shape so the
// builder's rows editor, the guide display, and every scoring-grid consumer
// serialize / parse it the same way. It piggybacks on the Chapter API surface
// (pool / adopt / create) — no new endpoints.

(function () {
  const TYPE = "scoring_template";   // chapter_type id (DB lookup row)
  const LAYOUT = "scoring_template"; // guide_chapters.layout flag

  const ScoringTemplate = {
    TYPE,
    LAYOUT,

    isTemplate(chapter) {
      return !!chapter && (chapter.layout === LAYOUT || chapter.chapter_type === TYPE);
    },

    // Safe parse of a chapter's (or raw content string's) row names. Always
    // returns an array of non-empty trimmed strings; never throws.
    parseRows(chapterOrContent) {
      const raw =
        chapterOrContent && typeof chapterOrContent === "object"
          ? chapterOrContent.content
          : chapterOrContent;
      if (raw == null || raw === "") return [];
      try {
        const parsed = JSON.parse(raw);
        const rows = parsed && Array.isArray(parsed.rows) ? parsed.rows : [];
        return rows.map((r) => String(r == null ? "" : r).trim()).filter(Boolean);
      } catch (_) {
        return [];
      }
    },

    // Serialize an editor rows array into the stored content string. Drops
    // blank/whitespace-only rows so an unfilled trailing input isn't saved.
    serializeRows(rows) {
      const clean = (Array.isArray(rows) ? rows : [])
        .map((r) => String(r == null ? "" : r).trim())
        .filter(Boolean);
      return JSON.stringify({ rows: clean });
    },

    // Every scoring template that exists for a game (community pool). Each row
    // carries popularity + in_my_guide like any pool chapter.
    templatesForGame(gameId, { expansionIds } = {}) {
      return window.Chapter.pool(gameId, { chapterType: TYPE, expansionIds })
        .then((rows) => (rows || []).filter((c) => ScoringTemplate.isTemplate(c)));
    },

    // The caller's ADOPTED scoring templates for a game (their user_chapters
    // rows of this type) — the set the scoring screen offers by default.
    adoptedTemplates(gameId, { expansionIds } = {}) {
      return window.Chapter.myChapters(gameId, { expansionIds })
        .then((rows) => (rows || []).filter((c) => ScoringTemplate.isTemplate(c)));
    },

    // Compact read-only HTML for a template's rows — used by the guide-scroll
    // display and the browse-pool expanded preview so a scoring_template
    // chapter shows its named rows instead of raw JSON.
    renderRowsList(rowsOrChapter) {
      const rows = Array.isArray(rowsOrChapter)
        ? rowsOrChapter
        : ScoringTemplate.parseRows(rowsOrChapter);
      if (!rows.length) {
        return `<p class="tmpl-list__empty">No rows in this template.</p>`;
      }
      return `<ol class="tmpl-list">${rows
        .map((r) => `<li class="tmpl-list__row">${esc(r)}</li>`)
        .join("")}</ol>`;
    },
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  window.ScoringTemplate = ScoringTemplate;
})();
