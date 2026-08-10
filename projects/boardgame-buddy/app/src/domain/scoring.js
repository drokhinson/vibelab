// @ts-check
// Score-cell string handling + winner auto-selection, shared by the host
// cascade and the joiner viewer. Cells live as sanitized strings so a leading
// "-" survives while typing; parse to number only at resolution time.
// Ported from web helpers (sanitizeRoundScore / parseRoundScore /
// nextSignToggle) + play-flow-view._autoSelectWinners.

/** Keep digits and a single leading minus. "" and "-" are legal mid-typing. */
export function sanitizeRoundScore(value) {
  const s = String(value ?? '');
  const neg = s.trimStart().startsWith('-');
  const digits = s.replace(/[^0-9]/g, '');
  return (neg ? '-' : '') + digits;
}

/** String cell → number|null ("" and "-" resolve to null). */
export function parseRoundScore(value) {
  if (value == null) return null;
  const s = String(value);
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

/** '' → '-', '-' → '', '-5' → '5', '5' → '-5'. */
export function nextSignToggle(v) {
  const s = v == null ? '' : String(v);
  if (s === '') return '-';
  if (s === '-') return '';
  return s.charAt(0) === '-' ? s.slice(1) : '-' + s;
}

/**
 * Auto-select winners from totals (mutates players' is_winner). No-op in coop
 * or when every total is 0. Team mode groups by the free-text team tag.
 * @param {Array<Object>} players
 * @param {(playerIdx: number) => number} totalOf
 * @param {'competitive'|'cooperative'|'team'|string} mode
 * @returns {boolean} whether anything changed
 */
export function autoSelectWinners(players, totalOf, mode) {
  if (!players.length || mode === 'cooperative' || mode === 'coop') return false;
  const totals = players.map((_, i) => totalOf(i));
  if (totals.every((t) => t === 0)) return false;
  let changed = false;
  if (mode === 'team') {
    const groupKey = (p, i) => ((p.team || '').trim().toLowerCase()) || `__solo_${i}`;
    const groupTotals = new Map();
    players.forEach((p, i) => {
      const key = groupKey(p, i);
      groupTotals.set(key, (groupTotals.get(key) || 0) + totals[i]);
    });
    const max = Math.max(...groupTotals.values());
    players.forEach((p, i) => {
      const win = groupTotals.get(groupKey(p, i)) === max;
      if (p.is_winner !== win) changed = true;
      p.is_winner = win;
    });
  } else {
    const max = Math.max(...totals);
    players.forEach((p, i) => {
      const win = totals[i] === max;
      if (p.is_winner !== win) changed = true;
      p.is_winner = win;
    });
  }
  return changed;
}
