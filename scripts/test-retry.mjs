/**
 * Verifies the LLM retry policy against a mock endpoint.
 *
 *   node scripts/test-retry.mjs
 *
 * Case A: two 429s then a 200  -> succeeds, two retries observed.
 * Case B: a 400                -> fails immediately, no retry.
 */
import http from 'node:http'
import assert from 'node:assert/strict'
import { createHost } from '../dist/index.js'

function sse(body) {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: body } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}`,
    'data: [DONE]',
    '',
  ].join('\n\n')
}

async function runCase({ statuses, label }) {
  let calls = 0
  const server = http.createServer((req, res) => {
    const status = statuses[Math.min(calls, statuses.length - 1)]
    calls += 1
    if (status !== 200) {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `mock ${status}` } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse('ok'))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  const retries = []
  const host = await createHost({
    llm: {
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test',
      defaultModel: 'mock',
      retries: 3,
      retryDelayMs: 10,
    },
    metrics: { persist: '', load: false },
    sessions: { dir: '', load: false },
  })
  host.ctx.on('llm/retry', (payload) => retries.push(payload))

  try {
    try {
      const r = await host.ctx.llm.generate({ messages: [{ role: 'user', content: 'hi' }] })
      console.log(`${label}: content=${JSON.stringify(r.content)} calls=${calls} retries=${retries.length}`)
      return { ok: true, calls, retries: retries.length, content: r.content }
    } catch (error) {
      console.log(`${label}: failed=${error.message} calls=${calls} retries=${retries.length}`)
      return { ok: false, calls, retries: retries.length, error: error.message }
    }
  } finally {
    await host.dispose()
    server.close()
  }
}

const a = await runCase({ statuses: [429, 429, 200], label: 'A 429x2 then 200' })
assert.equal(a.ok, true, 'A should eventually succeed')
assert.equal(a.calls, 3, 'A should have made 3 attempts')
assert.equal(a.retries, 2, 'A should report 2 retries')
assert.equal(a.content, 'ok')

const b = await runCase({ statuses: [400], label: 'B 400' })
assert.equal(b.ok, false, 'B should fail')
assert.equal(b.calls, 1, 'B must not retry a client error')
assert.equal(b.retries, 0)
assert.match(b.error, /HTTP 400/)

// 503 is retryable; exhausting retries must surface the last error.
const c = await runCase({ statuses: [503], label: 'C 503 always' })
assert.equal(c.ok, false)
assert.equal(c.calls, 4, 'C should try 1 + 3 retries')
assert.equal(c.retries, 3)
assert.match(c.error, /HTTP 503/)

console.log('retry: OK')
