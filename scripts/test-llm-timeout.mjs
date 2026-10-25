/**
 * A provider timeout must be reported as a failure, not as the user pressing
 * Stop: they must be able to tell "it gave up" from "I cancelled it" and the
 * run must not silently discard a billed partial answer (audit #10).
 *
 *   node scripts/test-llm-timeout.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHost } from '../dist/index.js'

const server = http.createServer(async (req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end('{"data":[{"id":"stub"}]}')
  }
  await new Promise((resolve) => setTimeout(resolve, 400))
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"content":"late"}}]}\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

const host = await createHost({
  llm: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, defaultModel: 'stub', retries: 0, timeoutMs: 100 },
  sessions: { dir: '', load: false },
  metrics: { persist: '', load: false },
  workspace: { root: process.cwd(), remember: false },
  web: { enabled: false },
})
try {
  const events = []
  for await (const event of host.ctx.agent.stream('please answer slowly')) events.push(event)
  const session = host.ctx.sessions.list()[0]
  assert.equal(session.status, 'failed', 'a timeout is a failure, not a user cancellation')
  assert.ok(events.some((event) => event.type === 'error' && /timed out/i.test(event.error)), 'the run reports a timeout')
  assert.ok(!events.some((event) => event.type === 'final'), 'no answer is invented from a timeout')
  assert.equal(session.messages.filter((message) => message.role === 'assistant').length, 0, 'nothing is committed')
  console.log('llm timeout: OK')
} finally {
  await host.dispose()
  server.close()
  server.closeAllConnections?.()
}
