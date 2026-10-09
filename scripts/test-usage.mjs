/**
 * Token + cost accounting: per-session totals from llm/metrics, prices from the endpoint's model list
 * (BotConnector and OpenRouter shapes) or config, free models cost 0, unknown prices are never "free",
 * subagent sessions fold into their parent.
 *
 *   node scripts/test-usage.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHost, costOf, priceFromModel, formatUsage } from '../dist/index.js'

// --- pure price math
assert.equal(costOf({ calls: 1, promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }, { input: 2, output: 8 }), 2)
// prompt includes cached + cache-write tokens: 600k fresh, 300k cached, 100k written
assert.equal(
  costOf({ calls: 1, promptTokens: 1_000_000, completionTokens: 500_000, cachedTokens: 300_000, cacheWriteTokens: 100_000 }, { input: 1, output: 4, cachedInput: 0.1, cacheWrite: 2 }),
  0.6 + 0.03 + 0.2 + 2,
)
assert.deepEqual(priceFromModel({ id: 'a', botconnector_pricing: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 } }), { input: 4, output: 20, cachedInput: 0.2, cacheWrite: 5 })
assert.deepEqual(priceFromModel({ id: 'b', pricing: { prompt: '0.000001', completion: '0.000004' } }), { input: 1, output: 4 })
assert.deepEqual(priceFromModel({ id: 'c', botconnector_access: 'free', botconnector_pricing: null }), { input: 0, output: 0 })
assert.equal(priceFromModel({ id: 'd', botconnector_pricing: null }), undefined, 'no price is unknown, not free')

// --- service against a stub /models endpoint
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ data: [
    { id: 'paid-model', botconnector_pricing: { input: 2, output: 10 } },
    { id: 'free-model', botconnector_access: 'free', botconnector_pricing: null },
    { id: 'mystery' },
  ] }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const host = await createHost({
  llm: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, defaultModel: 'paid-model', retries: 0 },
  metrics: { persist: '', load: false },
  sessions: { dir: '' },
  settings: { dir: '' },
  approval: { mode: 'off' },
  usage: { pricing: { 'config-model': { input: 1, output: 1 } } },
})
try {
  const { ctx } = host
  const s = ctx.sessions.create({ title: 'usage' })
  const emit = (sessionId, model, usage) => ctx.emit('llm/metrics', { model, sessionId, content: '', reasoning: '', toolCalls: [], finishReason: 'stop', usage, ttftMs: 1, totalMs: 1, tokensPerSec: 1 })

  emit(s.id, 'paid-model', { promptTokens: 1_000_000, completionTokens: 100_000, cachedTokens: 0 })
  await ctx.usage.refresh()
  let u = ctx.usage.summary(s.id)
  assert.equal(u.calls, 1)
  assert.equal(u.promptTokens, 1_000_000)
  assert.ok(Math.abs(u.costUsd - 3) < 1e-9, `2 + 1 = $3, got ${u.costUsd}`)
  assert.equal(u.complete, true)
  assert.match(formatUsage(u), /1\.0M in · 100\.0k out · ≈ \$3\.00/)

  emit(s.id, 'free-model', { promptTokens: 5000, completionTokens: 500 })
  emit(s.id, 'config-model', { promptTokens: 1_000_000, completionTokens: 0 })
  u = ctx.usage.summary(s.id)
  assert.ok(Math.abs(u.costUsd - 4) < 1e-9, `free adds 0, config adds 1, got ${u.costUsd}`)
  assert.equal(u.complete, true)

  emit(s.id, 'mystery', { promptTokens: 10, completionTokens: 10 })
  u = ctx.usage.summary(s.id)
  assert.deepEqual(u.unpriced, ['mystery'])
  assert.equal(u.complete, false, 'an unpriced model makes the cost a lower bound')
  assert.match(formatUsage(u), /≥ \$4\.00/)

  // events without a session are ignored; a deleted session cannot crash the handler
  emit(undefined, 'paid-model', { promptTokens: 1 })
  emit('s-gone', 'paid-model', { promptTokens: 1 })

  // subagent sessions fold into the parent
  const child = ctx.sessions.create({ title: 'worker', kind: 'subagent', parentSessionId: s.id })
  emit(child.id, 'paid-model', { promptTokens: 1_000_000, completionTokens: 0 })
  u = ctx.usage.summary(s.id)
  assert.equal(u.subagents, 1)
  assert.ok(Math.abs(u.costUsd - 6) < 1e-9, `child adds $2, got ${u.costUsd}`)
  assert.match(formatUsage(u), /incl\. 1 subagent$/)
  assert.equal(ctx.usage.summary(child.id).subagents, 0)

  // a session with nothing recorded
  assert.equal(formatUsage(ctx.usage.summary(ctx.sessions.create({ title: 'empty' }).id)), 'no model calls yet')
  // the totals are stored with the session (so they survive a restart)
  assert.equal(ctx.sessions.get(s.id).usage.byModel['paid-model'].calls, 1)

  // web/usage.js renders the same text as the server
  const src = await readFile(new URL('../web/usage.js', import.meta.url), 'utf8')
  const formatUsageChip = new Function(`${src}\n;return formatUsageChip`)()
  assert.equal(formatUsageChip(null), '')
  assert.equal(formatUsageChip(ctx.usage.summary(s.id)), formatUsage(ctx.usage.summary(s.id)))
} finally {
  await host.dispose()
  server.close()
}
console.log('usage: OK')
