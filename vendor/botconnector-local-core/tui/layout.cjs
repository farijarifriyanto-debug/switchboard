// Width-aware text layout helpers. No dependency on any TUI framework —
// plain string math so the app stays a single lightweight Node process.
'use strict';

function width() {
  const w = process.stdout && process.stdout.columns;
  return w && w > 0 ? w : 80;
}

function isNarrow() { return width() < 72; }

function truncate(s, w) {
  s = String(s == null ? '' : s);
  if (w <= 0) return '';
  if (s.length <= w) return s;
  if (w === 1) return '…';
  return s.slice(0, w - 1) + '…';
}

function pad(s, w) {
  s = String(s == null ? '' : s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

// Left text + right text on one row, right-aligned, truncating the left
// side first if the row would overflow the terminal width.
function spread(left, right, w = width()) {
  left = String(left == null ? '' : left);
  right = String(right == null ? '' : right);
  if (!right) return truncate(left, w);
  const gap = 2;
  const maxLeft = Math.max(0, w - right.length - gap);
  const l = truncate(left, maxLeft);
  const space = Math.max(1, w - l.length - right.length);
  return l + ' '.repeat(space) + right;
}

function bar(pct, w = 12) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round((p / 100) * w);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, w - filled));
}

module.exports = { width, isNarrow, truncate, pad, spread, bar };
