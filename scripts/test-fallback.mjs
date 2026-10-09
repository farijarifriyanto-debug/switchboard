/**
 * Fallback orchestrator: a call that fails before any output moves to the next target.
 *
 *   node scripts/test-fallback.mjs
 */
import http from 'node:http'
import assert from 'node:assert/strict'
import { createHost } from '../dist/index.js'

const sse = (text) => [
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}`,
  'data: [DONE]',
  '',
].join('\n\n')

/** model -> status|'ok'|'midfail'; records the model of every request. */
async function mock(plan) {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const model = JSON.parse(body).model
      seen.push(model)
      const how = plan[model] ?? 'ok'
      if (how === 'ok') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        return res.end(sse(`from-${model}`))
      }
      if (how === 'midfail') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial text that is long enough to be flushed at once by the reasoning splitter. '.repeat(4) } }] })}\n\n`)
        return setTimeout(() => res.destroy(), 150)
      }
      res.writeHead(how, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `mock ${how}` } }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, seen, url: `http://127.0.0.1:${server.address().port}/v1` }
}

async function host(url, extra = {}) {
  return createHost({
    llm: { baseURL: url, apiKey: 't', defaultModel: 'a', retries: 2, retryDelayMs: 5, ...extra },
    metrics: { persist: '', load: false },
    sessions: { dir: '', load: false },
  })
}
const ask = (h, opts = {}) => h.ctx.llm.generate({ messages: [{ role: 'user', content: 'hi' }], ...opts })

// 1. 429 on the primary -> the fallback answers; only ONE try is spent on the primary.
{
  const m = await mock({ a: 429 })
  const h = await host(m.url, { fallbacks: [{ model: 'b' }] })
  const events = []
  h.ctx.on('llm/fallback', (e) => events.push(e))
  const r = await ask(h)
  assert.equal(r.content, 'from-b')
  assert.equal(r.model, 'b', 'the result names the model that really answered')
  assert.deepEqual(m.seen, ['a', 'a', 'b'], 'primary: first try + 1 retry (capped), then the fallback')
  assert.equal(events.length, 1)
  assert.match(events[0].error, /429/)
  m.server.close()
}

// 2. cooldown: the next call skips the failing primary.
{
  const m = await mock({ a: 503 })
  const h = await host(m.url, { fallbacks: [{ model: 'b' }], fallbackCooldownMs: 60_000 })
  await ask(h)
  m.seen.length = 0
  const r = await ask(h)
  assert.equal(r.content, 'from-b')
  assert.deepEqual(m.seen, ['b'], 'cooling target is skipped')
  m.server.close()
}

// 3. a 400 (request problem) still falls back, but does NOT start a cooldown.
{
  const m = await mock({ a: 400 })
  const h = await host(m.url, { fallbacks: [{ model: 'b' }] })
  await ask(h)
  m.seen.length = 0
  await ask(h)
  assert.deepEqual(m.seen, ['a', 'b'], '400 is not a health signal')
  m.server.close()
}

// 4. everything fails -> one error naming every target.
{
  const m = await mock({ a: 429, b: 500 })
  const h = await host(m.url, { fallbacks: [{ model: 'b' }] })
  await assert.rejects(ask(h), (e) => /all 2 targets failed/.test(e.message) && /default:a/.test(e.message) && /default:b/.test(e.message))
  m.server.close()
}

// 5. output already streamed -> never switch (would duplicate text).
{
  const m = await mock({ a: 'midfail' })
  const h = await host(m.url, { fallbacks: [{ model: 'b' }] })
  const got = []
  try {
    for await (const ev of h.ctx.llm.stream({ messages: [{ role: 'user', content: 'hi' }] })) if (ev.type === 'delta') got.push(ev)
    assert.fail('a cut stream must surface as an error')
  } catch (e) {
    assert.match(e.message, /terminated|aborted/i)
  }
  assert.ok(got.length > 0 && /^partial/.test(got[0].text ?? ''), 'partial output reached the caller')
  assert.ok(!m.seen.includes('b'), 'no fallback after partial output')
  m.server.close()
}

// 6. no fallbacks configured: unchanged behaviour (full retry budget, original error).
{
  const m = await mock({ a: 429 })
  const h = await host(m.url)
  await assert.rejects(ask(h), (e) => /HTTP 429/.test(e.message) && !/targets failed/.test(e.message))
  assert.equal(m.seen.length, 3, 'initial + 2 retries')
  m.server.close()
}

console.log('test-fallback: all checks passed')
