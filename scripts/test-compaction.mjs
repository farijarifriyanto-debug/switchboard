/**
 * Compaction: old history becomes a summary (not dropped), tool pairs stay
 * intact, originals are archived, failures degrade to trimming and back off,
 * and /compact works through the API.
 *
 *   node scripts/test-compaction.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHost } from '../dist/index.js'
import { renderTranscript, SUMMARY_MARKER } from '../dist/services/compaction.js'

// ---- transcript rendering
const rendered = renderTranscript([
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(2000) },
])
assert.match(rendered, /^user: hi\nassistant called read_file\(\{"path":"a.txt"\}\)\ntool result: x+…\[\+1300 chars\]$/)

// ---- stub model: a summarizer persona and a plain chat persona
const calls = { summary: 0, chat: 0 }
let failSummary = false
let lastChat
const stub = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'stub' }] }))
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const isSummary = String(body.messages?.[0]?.content ?? '').includes('compress the earlier part')
  if (isSummary) {
    calls.summary += 1
    if (failSummary) {
      res.writeHead(500, { 'content-type': 'application/json' })
      return res.end('{"error":"boom"}')
    }
  } else {
    calls.chat += 1
    lastChat = body.messages
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const text = isSummary ? '## Goal\nSHIP THE THING\n## Facts to keep\nfile a.txt' : 'ok'
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))
const baseURL = `http://127.0.0.1:${stub.address().port}/v1`
const boot = (extra = {}) =>
  createHost({
    llm: { baseURL, defaultModel: 'stub', retries: 0 },
    metrics: { persist: '', load: false },
    sessions: { dir: '' },
    settings: { dir: '' },
    agent: { maxPromptTokens: 900, keepRecent: 4 },
    compaction: { keepRecent: 4 },
    web: { enabled: true, port: 0 },
    ...extra,
  })
const drain = async (stream) => {
  const events = []
  for await (const ev of stream) events.push(ev)
  return events
}
/** A long conversation with a tool call/result pair sitting right at the cut. */
const seedLong = (ctx) => {
  const s = ctx.sessions.create({ title: 'long' })
  for (let i = 0; i < 8; i += 1) {
    ctx.sessions.append(s.id, { role: 'user', content: `question ${i} ${'q'.repeat(300)}` })
    ctx.sessions.append(s.id, { role: 'assistant', content: `answer ${i} ${'a'.repeat(300)}` })
  }
  ctx.sessions.append(s.id, { role: 'user', content: 'now read the file' })
  ctx.sessions.append(s.id, { role: 'assistant', content: '', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] })
  ctx.sessions.append(s.id, { role: 'tool', tool_call_id: 'call_x', content: 'file contents' })
  ctx.sessions.append(s.id, { role: 'assistant', content: 'done reading' })
  return s
}

let host = await boot()
try {
  const { ctx } = host
  const s = seedLong(ctx)
  const before = ctx.sessions.get(s.id).messages.length

  // ---- automatic: the loop compacts before it has to drop anything
  const events = await drain(ctx.agent.stream('continue please', s.id))
  assert.equal(calls.summary, 1, 'one summarizer call')
  assert.ok(events.some((e) => e.type === 'notice' && /compacted \d+ older message/.test(e.notice)), 'the user is told')
  assert.ok(!events.some((e) => e.type === 'notice' && /trimmed/.test(e.notice)), 'nothing was dropped')
  const sent = lastChat.filter((m) => m.role !== 'system')
  assert.ok(sent[0].content.startsWith(SUMMARY_MARKER), 'the summary leads the history')
  assert.match(sent[0].content, /SHIP THE THING/)
  assert.ok(sent.length < before, `history shrank (${sent.length} < ${before})`)
  const ids = new Set(sent.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)))
  for (const m of sent.filter((x) => x.role === 'tool')) assert.ok(ids.has(m.tool_call_id), 'no orphaned tool result')
  assert.equal(sent.at(-1).content, 'continue please', 'the new prompt is last')
  const stored = ctx.sessions.get(s.id)
  assert.ok(stored.archived.length > 4, 'originals are archived')
  assert.ok(stored.archived.some((m) => m.content.startsWith('question 0')), 'the oldest original is in the archive')
  assert.ok(!stored.messages.some((m) => m.content.startsWith('question 0')), 'and gone from the live transcript')

  // ---- failure: falls back to trimming, and does not retry on every step
  failSummary = true
  const f = seedLong(ctx)
  const failed = await drain(ctx.agent.stream('go on', f.id))
  assert.equal(calls.summary, 2)
  assert.ok(failed.some((e) => e.type === 'notice' && /could not compact/.test(e.notice)))
  assert.ok(failed.some((e) => e.type === 'notice' && /trimmed/.test(e.notice)), 'the old trimming still protects the prompt')
  await drain(ctx.agent.stream('and again', f.id))
  assert.equal(calls.summary, 2, 'cooldown: no second attempt right after a failure')
  failSummary = false

  // ---- manual API
  const { url } = await ctx.web.ready()
  const post = (id, body = {}) => fetch(`${url}api/sessions/${id}/compact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const m = seedLong(ctx)
  const ok = await post(m.id, { focus: 'the file a.txt' })
  assert.equal(ok.status, 200)
  const done = await ok.json()
  assert.ok(done.summarized > 0 && done.after < done.before)
  assert.equal((await post(m.id)).status, 422, 'a conversation that is already short is refused')
  assert.equal((await post('missing')).status, 404)

  // ---- config off: nothing is summarized, old behaviour stays
  await host.dispose()
  host = await boot({ compaction: { enabled: false } })
  const off = seedLong(host.ctx)
  const before2 = calls.summary
  const offEvents = await drain(host.ctx.agent.stream('continue', off.id))
  assert.equal(calls.summary, before2, 'disabled: no summarizer call')
  assert.ok(offEvents.some((e) => e.type === 'notice' && /trimmed/.test(e.notice)))
  console.log('compaction: OK')
} finally {
  await host.dispose()
  stub.close()
  stub.closeAllConnections?.()
}
