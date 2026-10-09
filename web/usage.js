/**
 * Usage chip — a session's tokens and estimated cost for the status bar, e.g.
 * "12.3k in · 1.1k out · ≈ $0.0123". Loaded as a classic script before app.js; the node
 * test (scripts/test-usage.mjs) executes this same source. Mirrors formatUsage() in
 * src/services/usage.ts.
 */
function formatUsageChip(u) {
  if (!u || !u.calls) return ''
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const parts = [`${k(u.promptTokens)} in`, `${k(u.completionTokens)} out`]
  if (u.cachedTokens) parts.push(`${k(u.cachedTokens)} cached`)
  if (typeof u.costUsd === 'number') parts.push(`${u.complete ? '≈' : '≥'} $${u.costUsd < 0.01 && u.costUsd > 0 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)}`)
  else parts.push('cost unknown')
  if (u.subagents) parts.push(`incl. ${u.subagents} subagent${u.subagents === 1 ? '' : 's'}`)
  return parts.join(' · ')
}
