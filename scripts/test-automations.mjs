/**
 * Automations: validation, scheduling with a fake clock, unattended runs,
 * delivery, failure handling, missed slots, persistence and the API.
 *
 *   node scripts/test-automations.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
import { validateAutomation } from '../dist/services/automations.js'

// ---- validation
const ok = { id: 'daily', name: 'Daily', schedule: '0 9 * * *', prompt: 'summarize' }
assert.equal(validateAutomation(ok).preset, 'reviewer', 'default preset is read-only')
assert.throws(() => validateAutomation({ ...ok, schedule: '* * * * *' }), /more often than every 5 minutes/)
assert.throws(() => validateAutomation({ ...ok, schedule: '*/2 * * * *' }), /more often/)
assert.doesNotThrow(() => validateAutomation({ ...ok, schedule: '*/5 * * * *' }))
assert.throws(() => validateAutomation({ ...ok, schedule: 'nope' }), /Bad schedule/)
assert.throws(() => validateAutomation({ ...ok, id: 'Bad Id' }), /id must be/)
assert.throws(() => validateAutomation({ ...ok, prompt: '' }), /needs a prompt/)
assert.throws(() => validateAutomation({ ...ok, deliver: { type: 'telegram', chatId: 'x' } }), /Telegram user id/)
assert.throws(() => validateAutomation({ ...ok, deliver: { type: 'email' } }), /console.*telegram/)

// ---- model stub: plain, tool-calling, or failing
let mode = 'plain'
const prompts = []
const stub = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'stub' }] }))
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  prompts.push(body.messages.filter((m) => m.role === 'user').at(-1)?.content)
  if (mode === 'fail') {
    res.writeHead(500, { 'content-type': 'application/json' })
    return res.end('{"error":"boom"}')
  }
  const last = body.messages.at(-1)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  if (mode === 'tool' && last.role !== 'tool') {
    send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'run_command', arguments: '{"command":"echo should-not-run"}' } }] } }] })
    send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  } else {
    send({ choices: [{ delta: { content: last.role === 'tool' ? `tool said: ${last.content}` : 'report body' } }] })
    send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
  }
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))
const dir = await mkdtemp(path.join(tmpdir(), 'sbx-auto-'))
const boot = () =>
  createHost({
    llm: { baseURL: `http://127.0.0.1:${stub.address().port}/v1`, defaultModel: 'stub', retries: 0 },
    metrics: { persist: '', load: false },
    sessions: { dir: '' },
    settings: { dir },
    web: { enabled: true, port: 0 },
  })

let host = await boot()
try {
  const { ctx } = host
  const delivered = []
  ctx.reflect.provide('telegram', { send: async (chatId, text) => void delivered.push({ chatId, text }) })
  const at = (h, m = 0, d = 10) => new Date(2026, 9, d, h, m, 0) // local time, 2026-10-d
  const T0 = at(8)

  // ---- create + next run
  const made = await ctx.automations.create({ ...ok, deliver: { type: 'telegram', chatId: 77 } }, T0)
  assert.equal(new Date(made.nextRun).getHours(), 9, 'first run is the next 09:00')
  await assert.rejects(ctx.automations.create(ok, T0), /already exists/)
  await assert.rejects(ctx.automations.create({ ...ok, id: 'other', preset: 'nope' }, T0), /No preset/)

  // ---- scheduling with a fake clock
  assert.deepEqual(await ctx.automations.tick(at(8, 59)), { ran: [], missed: [] }, 'not due yet')
  const sessionsBefore = ctx.sessions.list().length
  const first = await ctx.automations.tick(at(9, 0))
  assert.deepEqual(first.ran, ['daily'])
  assert.equal(prompts.at(-1), 'summarize')
  const after = ctx.automations.get('daily')
  assert.equal(after.runs[0].status, 'success')
  assert.equal(after.runs[0].output, 'report body')
  assert.equal(new Date(after.nextRun).getDate(), 11, 'next run is tomorrow')
  assert.equal(ctx.sessions.list().length, sessionsBefore, 'run sessions are cleaned up')
  assert.deepEqual(delivered, [{ chatId: 77, text: '⏰ Daily\n\nreport body' }], 'result delivered to Telegram')
  assert.deepEqual((await ctx.automations.tick(at(9, 1))).ran, [], 'does not run twice')

  // ---- unattended: tools that need approval are refused, not run
  mode = 'tool'
  await ctx.automations.create({ id: 'shelly', name: 'Shelly', schedule: '30 9 * * *', prompt: 'do it', preset: 'default' }, at(9, 2))
  const t = await ctx.automations.tick(at(9, 30))
  assert.deepEqual(t.ran, ['shelly'])
  const shelly = ctx.automations.get('shelly')
  assert.equal(shelly.runs[0].output, 'tool said: Error: the operator rejected this tool call.', 'the command never ran; the model was told it was refused')
  mode = 'plain'

  // ---- failures: recorded, delivered, and the automation switches itself off
  mode = 'fail'
  await ctx.automations.create({ id: 'flaky', name: 'Flaky', schedule: '0 10 * * *', prompt: 'x', deliver: { type: 'telegram', chatId: 77 } }, at(9, 31))
  for (let i = 0; i < 5; i += 1) await ctx.automations.tick(at(10, 0, 10 + i))
  const flaky = ctx.automations.get('flaky')
  assert.equal(flaky.runs[0].status, 'failed')
  assert.equal(flaky.enabled, false, 'disabled after five failures in a row')
  assert.match(flaky.runs[0].error, /disabled after 5 failures/)
  assert.equal(flaky.nextRun, undefined)
  assert.ok(delivered.some((d) => /Flaky failed/.test(d.text)), 'failures are delivered too')
  mode = 'plain'
  const reenabled = await ctx.automations.update('flaky', { ...ok, id: 'flaky', name: 'Flaky', enabled: true, prompt: 'x', schedule: '0 10 * * *' }, at(12))
  assert.equal(reenabled.failures, 0, 're-enabling resets the counter')

  // ---- missed slots are recorded and skipped
  await ctx.automations.create({ id: 'late', name: 'Late', schedule: '0 11 * * *', prompt: 'x' }, at(10, 30, 20))
  const missed = await ctx.automations.tick(at(20, 0, 21)) // a day and then some later
  assert.ok(missed.missed.includes('late') && !missed.ran.includes('late'))
  assert.equal(ctx.automations.get('late').runs[0].status, 'missed')

  // ---- run now, API, persistence
  const now = await ctx.automations.runNow('daily')
  assert.equal(now.status, 'success')
  const { url } = await ctx.web.ready()
  const api = (route, method = 'GET', body) => fetch(`${url}api/${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const listed = await (await api('automations')).json()
  assert.ok(listed.automations.find((a) => a.id === 'daily').lastRun)
  assert.equal((await api('automations', 'POST', { ...ok, id: 'viaapi', schedule: '* * * * *' })).status, 400)
  assert.equal((await api('automations', 'POST', { ...ok, id: 'viaapi' })).status, 201)
  assert.equal((await api('automations/viaapi/run', 'POST')).status, 200)
  assert.equal((await (await api('automations/viaapi/runs')).json()).runs.length, 1)
  assert.equal((await api('automations/viaapi', 'DELETE')).status, 200)
  assert.equal((await api('automations/missing', 'DELETE')).status, 404)

  await host.dispose()
  host = await boot()
  await host.ctx.automations.ready()
  assert.ok(host.ctx.automations.get('daily'), 'automations survive a restart')
  assert.equal(host.ctx.automations.get('viaapi'), undefined)
  console.log('automations: OK')
} finally {
  await host.dispose()
  stub.close()
  stub.closeAllConnections?.()
  await rm(dir, { recursive: true, force: true })
}
