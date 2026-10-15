'use strict';

// Conversation viewport helpers. The offset is the zero-based rendered-line
// index at the top of the visible window, not a message index. A viewport at
// the bottom follows new rendered output; a non-bottom viewport stays anchored
// while new output accumulates below it.

function clampOffset(offset, maxStart) {
  return Math.min(Math.max(0, Number(offset) || 0), Math.max(0, Number(maxStart) || 0));
}

function move(current = {}, action, maxStart, pageRows) {
  maxStart = Math.max(0, Number(maxStart) || 0);
  pageRows = Math.max(1, Number(pageRows) || 1);
  const base = current.atBottom ? maxStart : clampOffset(current.offset, maxStart);
  let offset = base;
  let atBottom = !!current.atBottom;
  if (action === 'up') { offset = Math.max(0, base - pageRows); atBottom = false; }
  else if (action === 'down') { offset = Math.min(maxStart, base + pageRows); atBottom = offset >= maxStart; }
  else if (action === 'home') { offset = 0; atBottom = maxStart === 0; }
  else if (action === 'end') { offset = maxStart; atBottom = true; }
  return { offset, atBottom };
}

function parseMouseWheel(chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
  const moves = [];
  const sgr = /\x1b\[<(64|65);\d+;\d+[mM]/g;
  let match;
  while ((match = sgr.exec(text))) moves.push(match[1] === '64' ? 'up' : 'down');
  return moves;
}

module.exports = { clampOffset, move, parseMouseWheel };
