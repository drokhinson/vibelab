'use strict';

// Emoji renderer with flag-emoji fallback. Some Windows browsers don't render
// regional-indicator pairs as country flags; we detect support at load time
// and fall back to PNG flag images from flagcdn.com so the cuisine emoji
// always shows up. Pure presentation utility; safe to call anywhere.

const FLAG_SUPPORTED = (() => {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '32px Arial';
    const flagW = ctx.measureText('\u{1F1EB}\u{1F1F7}').width; // 🇫🇷
    const charW = ctx.measureText('FR').width;
    return flagW !== charW;
  } catch { return true; }
})();

function flagEmojiToCode(emoji) {
  const codePoints = [...emoji].map(c => c.codePointAt(0));
  if (codePoints.length === 2 && codePoints.every(cp => cp >= 0x1F1E6 && cp <= 0x1F1FF)) {
    return String.fromCharCode(codePoints[0] - 0x1F1E6 + 65, codePoints[1] - 0x1F1E6 + 65).toLowerCase();
  }
  return null;
}

function renderEmoji(emoji) {
  if (FLAG_SUPPORTED) return emoji;
  const code = flagEmojiToCode(emoji);
  if (code) return `<img src="https://flagcdn.com/w40/${code}.png" alt="${emoji}" class="flag-img">`;
  return emoji;
}
