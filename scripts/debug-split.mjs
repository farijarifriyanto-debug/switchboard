/**
 * Verifies inline-reasoning splitting against a mock SSE endpoint.
 * The mock streams  thinking...</think> inside `content`, split across chunks.
 */
import http from 'node:http'
import assert from 'node:assert/strict'
import { createHost } from '../dist/index.js'

const CHUNKS = ['<thi', 'nk>\nlet me think\n</thi', 'nk>\n\n', 'The answer is 42.']

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const c of CHUNKS) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 9 } })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

const host = await createHost({
  llm: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test', defaultModel: 'mock' },
  metrics: { persist: '', load: false },
})

try {
  const result = await host.ctx.llm.generate({ messages: [{ role: 'user', content: 'hi' }] })
  const esc = (s) => Buffer.from(s, 'utf8').toString('base64')
  console.log('content b64 :', esc(result.content))
  console.log('reasoning b64:', esc(result.reasoning))
  console.log('hasOpenTag :', result.content.includes('<' + 'thinking>'))
  console.log('hasCloseTag:', result.content.includes('</' + 'thinking>'))
  console.log('reasoningLen:', result.reasoning.length)
  assert.ok(!/think/i.test(result.content), 'content must not contain think tags')
  assert.match(result.reasoning, /let me think/, 'reasoning must capture the think block')
  assert.match(result.content, /answer is 42/, 'content must keep the real answer')
  console.log('split: OK')
} finally {
  await host.dispose()
  server.close()
}
