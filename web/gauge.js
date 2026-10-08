/**
 * Context gauge — prompt tokens vs the model context window, formatted as
 * "used / window · pct%". Loaded as a classic script before app.js; the node
 * test (scripts/test-gauge.mjs) executes this same source.
 */
function formatContextGauge(used, window) {
  const win = Number(window)
  if (!win || win <= 0) return ''
  if (used === undefined || used === null || used === '') return ''
  const usedTokens = Math.max(0, Number(used) || 0)
  const pct = Math.round((usedTokens * 100) / win)
  return `${usedTokens.toLocaleString('en-US')} / ${win.toLocaleString('en-US')} · ${pct}%`
}
