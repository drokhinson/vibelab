// ui/markdown.js — minimal markdown renderer shared by chapter views.
//
// Supports the subset used by reference-guide chapters:
// - ## / ### / #### headings
// - GitHub-style pipe tables (with header separator row)
// - * / - bulleted lists
// - **bold**, *italic*, `inline code`
// - <span style="color:#hex">…</span> for colored inline labels
// - paragraphs (blank-line separated)
// All input is HTML-escaped before formatting so user content is safe; the
// color span pattern is the one exception, and only the hex value is
// reintroduced into the live attribute — the inner text stays escaped.

(function () {
  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function splitRow(s) {
    return s.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  }

  function renderInline(s) {
    return escape(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<![*])\*([^*\n]+)\*(?![*])/g, "<em>$1</em>")
      // [text](url) links. escape() only encodes & < > " ' so the bracket /
      // paren syntax survives intact. Only http(s), mailto, and root-relative
      // URLs are allowed through — anything else (e.g. javascript:) is left as
      // literal text so the markdown can't smuggle an unsafe href.
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) =>
        /^(https?:\/\/|mailto:|\/)/i.test(url)
          ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
          : m)
      // Re-allow color spans after escape: only hex colors are accepted, and
      // the inner text is already escaped so wrapping it in a real <span> is
      // safe. Anything that doesn't match (named colors, other attributes,
      // event handlers, other tags) stays escaped as literal text.
      .replace(
        /&lt;span style=(?:&quot;|&#39;)color:\s*(#[0-9a-fA-F]{3,8})\s*;?\s*(?:&quot;|&#39;)&gt;([\s\S]*?)&lt;\/span&gt;/g,
        '<span style="color:$1">$2</span>'
      );
  }

  function renderTable(headers, rows) {
    return `
      <table class="guide-table">
        <thead><tr>${headers.map((h) => `<th>${renderInline(h)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    `;
  }

  function renderMarkdown(src) {
    const lines = String(src || "").split(/\r?\n/);
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const h = /^(#{2,4})\s+(.*)$/.exec(line);
      if (h) {
        const level = h[1].length;
        blocks.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
        i++; continue;
      }
      // Pipe table: a header row + a separator row (---) + body rows.
      if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
        const headers = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        blocks.push(renderTable(headers, rows));
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          items.push(renderInline(lines[i].replace(/^[-*]\s+/, "")));
          i++;
        }
        blocks.push(`<ul>${items.map((it) => `<li>${it}</li>`).join("")}</ul>`);
        continue;
      }
      // Paragraph: gather until blank line or next heading.
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^#{2,4}\s/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      blocks.push(`<p>${renderInline(para.join(" "))}</p>`);
    }
    return blocks.join("");
  }

  window.renderMarkdown = renderMarkdown;
})();
