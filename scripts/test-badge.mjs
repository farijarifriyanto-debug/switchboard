/**
 * UI badge/status logic tests — stopReason badge + MCP status summary, rendered
 * as plain text (never color-only, never innerHTML). Loads the real source from
 * web/badge.js the same way test-gauge.mjs loads gauge.js.
 *
 *   node scripts/test-badge.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const src = await readFile(new URL('../web/badge.js', import.meta.url), 'utf8').catch(() => '')
assert.ok(src.trim(), 'web/badge.js should exist and be non-empty')
const factory = new Function(`${src}\n;return { stopBadge, mcpSummary, runOutcome }`)
const { stopBadge, mcpSummary, runOutcome } = factory()
assert.equal(typeof stopBadge, 'function', 'web/badge.js should define stopBadge')
assert.equal(typeof mcpSummary, 'function', 'web/badge.js should define mcpSummary')

// --- stopBadge: only stopReasons the agent actually yields today render a badge.
assert.deepEqual(stopBadge('answer'), { text: 'answered', tone: 'ok' })
assert.deepEqual(stopBadge('step_limit'), { text: 'step limit reached', tone: 'warn' })

// Missing / unknown values must never render a badge.
assert.equal(stopBadge(undefined), null, 'missing stopReason renders no badge')
assert.equal(stopBadge(null), null)
assert.equal(stopBadge(''), null)
assert.equal(stopBadge('done'), null, 'unknown stopReason renders no badge')
assert.equal(stopBadge('budgetExceeded'), null)
assert.equal(stopBadge({}), null)

// The badge text itself carries the meaning (colour is only a secondary cue).
assert.match(stopBadge('answer').text, /answer/i)
assert.match(stopBadge('step_limit').text, /step limit/i)
assert.notEqual(stopBadge('answer').text, stopBadge('step_limit').text)

// --- mcpSummary: distinguish "not configured" vs "unavailable" vs "no servers".
assert.deepEqual(mcpSummary(undefined), { text: 'MCP: not configured', tone: 'dim' })
assert.deepEqual(mcpSummary(null), { text: 'MCP: not configured', tone: 'dim' })
assert.deepEqual(mcpSummary({ configured: false }), { text: 'MCP: not configured', tone: 'dim' })
assert.deepEqual(mcpSummary({ configured: true, servers: null }), { text: 'MCP: unavailable', tone: 'warn' })
assert.deepEqual(mcpSummary({ configured: true, servers: [] }), { text: 'MCP: no servers', tone: 'dim' })

// Server names/states come through as plain text data (safe to assign via textContent).
const mixed = mcpSummary({
  configured: true,
  servers: [
    { name: 'mem', state: 'up', attempts: 1 },
    { name: 'bad', state: 'down', attempts: 3, lastError: 'spawn failed' },
  ],
})
assert.equal(mixed.text, 'MCP: 1/2 up (bad: down)')
assert.equal(mixed.tone, 'warn')

const allUp = mcpSummary({ configured: true, servers: [{ name: 'mem', state: 'up', attempts: 1 }] })
assert.equal(allUp.text, 'MCP: 1/1 up')
assert.equal(allUp.tone, 'ok')

// Degenerate input never throws and never renders [object Object].
const junk = mcpSummary({ configured: true, servers: [{ name: { a: 1 }, state: null }] })
assert.equal(typeof junk.text, 'string')
assert.ok(!junk.text.includes('[object Object]'), 'server data renders as coerced text, not raw objects')

// An SSE stream ending does not imply that the task succeeded.
assert.deepEqual(runOutcome({ error: true }), { kind: 'failed', label: 'Failed' })
assert.deepEqual(runOutcome({ cancelled: true }), { kind: 'cancelled', label: 'Stopped' })
assert.deepEqual(runOutcome({ stopReason: 'step_limit' }), { kind: 'limited', label: 'Step limit reached' })
assert.deepEqual(runOutcome({ stopReason: 'answer' }), { kind: 'completed', label: 'Completed' })
assert.deepEqual(runOutcome({}), { kind: 'failed', label: 'Response interrupted' })
assert.deepEqual(runOutcome({ error: true, stopReason: 'answer' }), { kind: 'failed', label: 'Failed' })

// Regression: exercise the real state-loading boundary. Helper-only tests
// previously passed while loadState silently discarded the API's MCP block.
const appSource = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const loadSource = appSource.slice(appSource.indexOf('async function loadState()'), appSource.indexOf('\nfunction setWorkspace('))
const state = {}
const ui = Object.fromEntries(['tools', 'runtimeServices', 'metricsBox'].map(key => [key, { innerHTML: '' }]))
let renderedMcp
const noop = () => {}
const makeLoader = new Function('fetch', 'state', 'ui', 'renderModelPicker', 'renderModelCapabilities', 'showConnectionNotice', 'renderPluginCapabilities', 'setWorkspace', 'renderAudit', 'renderApprovalGate', 'renderSessions', 'esc', 'loadPresets', `${loadSource}; return loadState`)
const apiMcp = { configured: true, servers: [{ name: 'workspace', state: 'up', attempts: 1 }] }
const load = makeLoader(async () => ({ ok: true, json: async () => ({ models: [{ id: 'stub' }], model: 'stub', mcp: apiMcp }) }), state, ui, noop, () => { renderedMcp = mcpSummary(state.mcp) }, noop, noop, noop, noop, noop, noop, String, noop)
await load()
assert.deepEqual(state.mcp, apiMcp, 'MCP survives the API-to-UI boundary')
assert.equal(renderedMcp.text, 'MCP: 1/1 up', 'MCP is available when model status renders')

console.log('test-badge: all checks passed')
