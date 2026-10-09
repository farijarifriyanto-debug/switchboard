/**
 * Subagent budgets: workers per session, total tokens/cost of a session's workers, and a per-worker
 * token ceiling that stops one runaway worker without touching its siblings.
 *
 *   node scripts/test-subagent-budget.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost, SUBAGENT_DEFAULTS } from '../dist/index.js'
import { validateSubagent } from '../dist/config.js'

// ---- config
assert.equal(SUBAGENT_DEFAULTS.maxWorkers, 12)
assert.equal(SUBAGENT_DEFAULTS.maxTokens, 1_000_000)
assert.equal(SUBAGENT_DEFAULTS.maxWorkerTokens, 300_000)
assert.equal(validateSubagent({ maxTokens: 0 }, () => {}).maxTokens, 0, '0 turns a budget off')
assert.equal(validateSubagent({ maxCostUsd: 2.5 }, () => {}).maxCostUsd, 2.5)
assert.equal(validateSubagent({}, () => {}).maxCostUsd, undefined)
assert.throws(() => validateSubagent({ maxTokens: -1 }, () => {}), /"maxTokens" must be an integer >= 0/)
assert.throws(() => validateSubagent({ maxWorkerTokens: 1.5 }, () => {}), /"maxWorkerTokens" must be an integer >= 0/)
assert.throws(() => validateSubagent({ maxCostUsd: 0 }, () => {}), /"maxCostUsd" must be a number > 0/)
assert.throws(() => validateSubagent({ maxWorkers: 0 }, () => {}), /"maxWorkers" must be an integer >= 1/)

// ---- stub model: a worker whose description says LOOP keeps calling a tool; others answer at once
const sse = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}
let promptTokens = 100
const stub = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'stub', botconnector_pricing: { input: 1000, output: 1000 } }] }))
  }
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const text = JSON.stringify(body.messages)
  const usage = { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 }
  if (text.includes('LOOP')) {
    return sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2, 8)}`, function: { name: 'list_dir', arguments: '{"path":"."}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage },
    ])
  }
  sse(res, [{ choices: [{ delta: { content: 'done' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, { choices: [], usage }])
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))
const baseURL = `http://127.0.0.1:${stub.address().port}/v1`
const ws = await mkdtemp(path.join(tmpdir(), 'sbx-budget-'))
const boot = (subagent) =>
  createHost({
    llm: { baseURL, defaultModel: 'stub', retries: 0 },
    metrics: { persist: '', load: false },
    sessions: { dir: '', load: false },
    settings: { dir: '' },
    workspace: { root: ws, remember: false },
    approval: { mode: 'off' },
    subagent,
  })
const run = async (ctx, parent, tasks) => ctx.tools.call('task', { tasks }, { sessionId: parent.id })

// ---- worker count: all-or-nothing, counted per parent session
{
  const host = await boot({ maxWorkers: 2 })
  try {
    const { ctx } = host
    const a = ctx.sessions.create({ title: 'a' })
    const b = ctx.sessions.create({ title: 'b' })
    assert.match(await run(ctx, a, [{ description: '1' }, { description: '2' }, { description: '3' }]), /^Error: task: worker limit — this session already started 0 worker\(s\) and asked for 3 more \(subagent\.maxWorkers is 2\)/)
    assert.equal(ctx.sessions.list().filter((s) => s.kind === 'subagent').length, 0, 'a refused batch starts nothing')
    assert.match(await run(ctx, a, [{ description: '1' }, { description: '2' }]), /"status": "ok"/)
    assert.match(await run(ctx, a, [{ description: '3' }]), /worker limit — this session already started 2 worker\(s\)/)
    assert.match(await run(ctx, b, [{ description: 'other session' }]), /"status": "ok"/, 'another session has its own allowance')
  } finally {
    await host.dispose()
  }
}

// ---- token budget over all workers of a session; workers' tokens fold into the parent's usage
{
  promptTokens = 600
  const host = await boot({ maxTokens: 1000 })
  try {
    const { ctx } = host
    const p = ctx.sessions.create({ title: 'p' })
    assert.match(await run(ctx, p, [{ description: 'one' }]), /"status": "ok"/)
    assert.match(await run(ctx, p, [{ description: 'two' }]), /"status": "ok"/, '610 of 1000 used: still allowed')
    const refused = await run(ctx, p, [{ description: 'three' }])
    assert.match(refused, /^Error: task: token budget used — this session's workers already used 1,220 tokens \(subagent\.maxTokens is 1,000\)/)
    assert.equal(ctx.usage.summary(p.id, { workersOnly: true }).calls, 2)
    assert.equal(ctx.usage.summary(p.id).subagents, 2)
  } finally {
    await host.dispose()
  }
}
{
  promptTokens = 600
  const host = await boot({ maxTokens: 0 })
  try {
    const { ctx } = host
    const p = ctx.sessions.create({ title: 'p' })
    for (let i = 0; i < 4; i++) assert.match(await run(ctx, p, [{ description: `t${i}` }]), /"status": "ok"/)
  } finally {
    await host.dispose()
  }
}

// ---- cost budget (prices from the endpoint: $1000 per 1M tokens => $0.61 per call)
{
  promptTokens = 600
  await new Promise((r) => setTimeout(r, 5))
  const host = await boot({ maxCostUsd: 0.5, maxTokens: 0 })
  try {
    const { ctx } = host
    await ctx.usage.refresh()
    const p = ctx.sessions.create({ title: 'p' })
    assert.match(await run(ctx, p, [{ description: 'one' }]), /"status": "ok"/)
    assert.match(await run(ctx, p, [{ description: 'two' }]), /^Error: task: cost budget used — .* about \$0\.61 \(subagent\.maxCostUsd is \$0\.5\)/)
  } finally {
    await host.dispose()
  }
}

// ---- one runaway worker is stopped alone
{
  promptTokens = 200
  const host = await boot({ maxWorkerTokens: 500, maxTokens: 0, maxParallel: 3 })
  try {
    const { ctx } = host
    const p = ctx.sessions.create({ title: 'p' })
    const out = JSON.parse(await run(ctx, p, [{ description: 'LOOP forever' }, { description: 'quick one' }]))
    assert.equal(out[0].status, 'failed')
    assert.match(out[0].error, /^worker stopped: it used 630 tokens \(subagent\.maxWorkerTokens is 500\)/)
    assert.equal(out[1].status, 'ok', 'a sibling is not affected')
    assert.equal(out[1].result, 'done')
  } finally {
    await host.dispose()
  }
}
stub.close()
console.log('subagent-budget: OK')
