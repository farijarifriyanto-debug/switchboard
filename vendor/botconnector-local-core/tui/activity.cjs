// Turns raw agent-loop event text into human-friendly activity lines.
// Pure function — the loop keeps emitting its own event text (untouched);
// this is the presentation boundary that hides engineering internals.
'use strict';

const HIDE = [/^●\s*Building context/i, /^●\s*Routing\s*→/i];

function humanize(lines, { debug = false } = {}) {
  if (debug) return lines.slice();
  const out = [];
  for (const raw of lines) {
    const t = String(raw == null ? '' : raw);
    if (HIDE.some((re) => re.test(t))) continue;
    let s = t;
    s = s.replace(/^●\s*Result received.*$/i, '✓ Response ready');
    s = s.replace(/^○\s*Waiting for approval\s*\([^)]*\)\s*$/i, '○ Waiting for approval');
    s = s.replace(/^●\s*Querying local model\s*\([^)]*\)…?\s*$/i, '● Thinking…');
    out.push(s);
  }
  return out;
}

module.exports = { humanize };
