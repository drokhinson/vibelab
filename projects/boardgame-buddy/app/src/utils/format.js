// src/utils/format.js — small formatting helpers shared across screens.
// Ported from the date logic in web/ui/game-card.js + play-card.js so
// Today/Yesterday labels don't drift across UTC boundaries (Y-M-D parsed local).

function parseLocalDate(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m
    ? new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))
    : new Date(iso);
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

// "Today" / "Yesterday" / "Mar 7".
export function formatPlayedAt(iso) {
  const d = parseLocalDate(iso);
  if (!d) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// "Mar 7" — plain short date (no Today/Yesterday).
export function formatShortDate(iso) {
  const d = parseLocalDate(iso);
  if (!d) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Player count + playtime summary line: "2–4P · 45m".
export function gameMeta(game) {
  if (!game) return '';
  const players = game.min_players
    ? `${game.min_players}${game.max_players && game.max_players !== game.min_players ? '–' + game.max_players : ''}P`
    : '';
  const time = game.playing_time ? `${game.playing_time}m` : '';
  return [players, time].filter(Boolean).join(' · ');
}

// 1–2 letter initials (matches web BgbBadge.initialsOf).
export function initialsOf(name) {
  const parts = String(name || '').trim().split(/[\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] || '?').slice(0, 2).toUpperCase();
}
