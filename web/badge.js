/**
 * Badge/status helpers for the console — return plain-text values only;
 * app.js assigns them with createElement + textContent (never innerHTML from
 * server data). Loaded as a classic script before app.js; the node test
 * (scripts/test-badge.mjs) executes this same source.
 *
 * stopBadge covers exactly the stopReasons the agent yields today ('answer'
 * and 'step_limit' — see src/plugins/agent.ts). Missing or unknown values
 * return null so the UI never renders a misleading badge.
 */
function stopBadge(stopReason) {
  if (stopReason === 'answer') return { text: 'answered', tone: 'ok' }
  if (stopReason === 'step_limit') return { text: 'step limit reached', tone: 'warn' }
  return null
}

/** Terminal SSE state: completion is reported only after a final answer. */
function runOutcome({ cancelled = false, error = false, stopReason } = {}) {
  if (cancelled) return { kind: 'cancelled', label: 'Stopped' }
  if (error) return { kind: 'failed', label: 'Failed' }
  if (stopReason === 'step_limit') return { kind: 'limited', label: 'Step limit reached' }
  if (stopReason === 'answer') return { kind: 'completed', label: 'Completed' }
  return { kind: 'failed', label: 'Response interrupted' }
}

/** Coerce server-provided scalars to safe display text (objects never leak). */
function mcpLabel(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return '?'
}

/**
 * One-line MCP status for the model-info status bar. Distinguishes the API
 * states: no mcp block -> not configured; configured but service missing ->
 * unavailable; configured with an empty list -> no servers; otherwise counts
 * and names the servers that are not up.
 */
function mcpSummary(mcp) {
  if (!mcp || mcp.configured !== true) return { text: 'MCP: not configured', tone: 'dim' }
  if (!Array.isArray(mcp.servers)) return { text: 'MCP: unavailable', tone: 'warn' }
  if (!mcp.servers.length) return { text: 'MCP: no servers', tone: 'dim' }
  const servers = mcp.servers.filter(Boolean)
  const up = servers.filter((s) => s.state === 'up').length
  const bad = servers.filter((s) => s.state !== 'up').map((s) => `${mcpLabel(s.name)}: ${mcpLabel(s.state)}`)
  const text = bad.length ? `MCP: ${up}/${servers.length} up (${bad.join(', ')})` : `MCP: ${up}/${servers.length} up`
  return { text, tone: bad.length ? 'warn' : 'ok' }
}
