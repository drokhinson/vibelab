// Date + text helpers shared across web and native.

export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

export function pluralize(count, singular, plural) {
  return count === 1 ? singular : (plural || `${singular}s`);
}

// Splits a sentence into [text, isHighlighted] tuples around occurrences of `word`.
// Used by the native renderer to mark up word-of-the-day occurrences.
export function tokenizeWithWord(sentence, word) {
  if (!sentence) return [];
  if (!word) return [{ text: sentence, highlight: false }];
  const escapedWord = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escapedWord})`, 'gi');
  const out = [];
  let lastIdx = 0;
  let match;
  while ((match = re.exec(sentence)) !== null) {
    if (match.index > lastIdx) {
      out.push({ text: sentence.slice(lastIdx, match.index), highlight: false });
    }
    out.push({ text: match[0], highlight: true });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < sentence.length) {
    out.push({ text: sentence.slice(lastIdx), highlight: false });
  }
  return out;
}
