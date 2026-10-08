/**
 * Adapter + discovery tests: the three tested protocols only (spec §5).
 *
 * Covers request shape per protocol (URL, auth scheme, body conversion),
 * streaming parse (text + reasoning + tool calls + usage + finish map),
 * HTTP 401 recovery hints, mid-stream abort propagation, and discovery.
 *
 * Run:
 *   node scripts/test-adapters.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { buildRequest, parseStream, adapterError } from '../dist/llm/adapters.js'
import { listModels } from '../dist/llm/discovery.js'

/** Stub endpoint: captures the last request, replies with `handler`-produced bytes. */
function stub(handler) {
  const seen = { url: '', headers: null, body: '' }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', async () => {
      seen.url = req.url
      seen.headers = req.headers
      seen.body = Buffer.concat(chunks).toString('utf8')
      await handler(req, res, seen)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        seen,
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

function sse(res, lines) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const line of lines) res.write(`${line}\n`)
  res.end('data: [DONE]\n\n')
}

/** Drains parseStream to its typed return summary. */
async function drain(res, profile) {
  const iter = parseStream(res, profile)
  const events = []
  let step = await iter.next()
  while (!step.done) {
    events.push(step.value)
    step = await iter.next()
  }
  return { events, summary: step.value }
}

function post(request) {
  return fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
  })
}

const HISTORY = [
  { role: 'system', content: 'be brief' },
  { role: 'user', content: 'hi', attachments: [{ name: 'a.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,QUJD' }] },
  {
    role: 'assistant',
    content: 'sure',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'result1' },
  { role: 'user', content: 'again' },
]

// ---------------------------------------------------- openai-chat: request

{
  const server = await stub((req, res) =>
    sse(res, ['data: {"choices":[{"delta":{"content":"ok"}}],"finish_reason":"stop"}']),
  )
  const profile = { id: 'stub-chat', baseURL: `${server.base}/v1`, protocol: 'openai-chat', apiKey: 'k1', headers: { 'x-team': 'blue' }, extraBody: { routing: 'cost' } }
  const request = buildRequest(profile, { model: 'm1', messages: HISTORY.slice(0, 2), tools: [{ type: 'function', function: { name: 'read', description: 'r', parameters: { type: 'object' } } }], temperature: 0.2, maxTokens: 64 })
  assert.equal(request.url, `${server.base}/v1/chat/completions`)
  assert.equal(request.headers.authorization, 'Bearer k1')
  assert.equal(request.headers['x-team'], 'blue')
  assert.equal(request.headers['content-type'], 'application/json')
  assert.equal(request.headers.accept, 'text/event-stream')
  const body = request.body
  assert.equal(body.model, 'm1')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.temperature, 0.2)
  assert.equal(body.max_tokens, 64)
  assert.equal(body.routing, 'cost', 'extraBody merged')
  assert.deepEqual(body.tools[0].function.name, 'read')
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].content[0].text, 'hi')
  assert.equal(body.messages[1].content[1].image_url.url, 'data:image/png;base64,QUJD')

  const res = await post(request)
  const { summary } = await drain(res, profile)
  assert.equal(summary.content, 'ok')
  assert.equal(server.seen.url, '/v1/chat/completions')
  await server.close()
  console.log('openai-chat request/stream: OK')
}

// ------------------------------------------------- openai-chat: stream parse

{
  const server = await stub((req, res) =>
    sse(res, [
      'data: {"choices":[{"delta":{"reasoning_content":"think1"}}]}',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"p\\":1}"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"list","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4}}}',
    ]),
  )
  const profile = { id: 'stub-chat', baseURL: server.base, protocol: 'openai-chat' }
  const request = buildRequest(profile, { model: 'm1', messages: [{ role: 'user', content: 'x' }] })
  const res = await post(request)
  const { events, summary } = await drain(res, profile)
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello')
  assert.equal(events.filter((e) => e.type === 'reasoning').map((e) => e.text).join(''), 'think1')
  const toolEvents = events.filter((e) => e.type === 'tool_call')
  assert.deepEqual(toolEvents.map((e) => e.call.function.name), ['read', 'list'])
  assert.equal(toolEvents[0].call.id, 'c1')
  assert.equal(toolEvents[0].call.function.arguments, '{"p":1}')
  assert.equal(summary.finishReason, 'tool_calls')
  assert.equal(summary.usage.promptTokens, 10)
  assert.equal(summary.usage.completionTokens, 5)
  assert.equal(summary.usage.cachedTokens, 4)
  assert.equal(summary.content, 'Hello')
  assert.equal(summary.reasoning, 'think1')
  await server.close()
  console.log('openai-chat streaming events: OK')
}

// ---------------------------------------------- openai-responses: request

{
  const server = await stub((req, res) =>
    sse(res, [
      'data: {"type":"response.output_text.delta","delta":"Hi"}',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_9","name":"lookup"}}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"a\\":1}"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3}}}',
    ]),
  )
  const profile = { id: 'stub-resp', baseURL: `${server.base}/v1`, protocol: 'openai-responses', apiKey: 'k2' }
  const request = buildRequest(profile, { model: 'm2', messages: HISTORY })
  assert.equal(request.url, `${server.base}/v1/responses`)
  assert.equal(request.headers.authorization, 'Bearer k2')
  assert.ok(!('x-api-key' in request.headers), 'responses uses Bearer, not x-api-key')
  assert.equal(request.body.stream, true)
  assert.equal(request.body.instructions, 'be brief', 'system moves to instructions')
  assert.equal(request.body.max_output_tokens, undefined, 'maxTokens omitted when unset')
  assert.ok(!request.body.stream_options, 'responses has no stream_options')
  const input = request.body.input
  assert.equal(input.length, 5)
  assert.deepEqual(input[0].content[0], { type: 'input_text', text: 'hi' })
  assert.deepEqual(input[0].content[1], { type: 'input_image', image_url: 'data:image/png;base64,QUJD' })
  assert.deepEqual(input[1], { role: 'assistant', content: [{ type: 'output_text', text: 'sure' }] })
  assert.deepEqual(input[2], { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"x"}' })
  assert.deepEqual(input[3], { type: 'function_call_output', call_id: 'call_1', output: 'result1' })
  assert.equal(input[4].role, 'user')

  const res = await post(request)
  const { events, summary } = await drain(res, profile)
  assert.equal(summary.content, 'Hi')
  assert.equal(summary.finishReason, 'stop', 'response.completed without incomplete -> stop')
  assert.equal(summary.usage.promptTokens, 7)
  assert.equal(summary.usage.completionTokens, 3)
  assert.equal(summary.toolCalls.length, 1)
  assert.equal(summary.toolCalls[0].id, 'call_9')
  assert.equal(summary.toolCalls[0].function.name, 'lookup')
  assert.equal(summary.toolCalls[0].function.arguments, '{"a":1}')
  assert.ok(events.some((e) => e.type === 'tool_call'))
  await server.close()
  console.log('openai-responses request/stream: OK')
}

// ------------------------------------------- anthropic-messages: request

{
  const server = await stub((req, res) =>
    sse(res, [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hey"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"deep"}}',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_1","name":"calc"}}',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"n\\":"}}',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"2}"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
    ]),
  )
  const profile = { id: 'stub-ant', baseURL: `${server.base}/v1`, protocol: 'anthropic-messages', apiKey: 'sk-ant' }

  // Base URL ending in /v1 must not double up the path segment.
  const request = buildRequest(profile, { model: 'claude-x', messages: HISTORY })
  assert.equal(request.url, `${server.base}/v1/messages`, 'no double v1')
  const flat = buildRequest({ ...profile, baseURL: `${server.base}/` }, { model: 'claude-x', messages: [] })
  assert.equal(flat.url, `${server.base}/v1/messages`, 'bare base gains /v1/messages')
  assert.equal(request.headers['x-api-key'], 'sk-ant')
  assert.equal(request.headers['anthropic-version'], '2023-06-01')
  assert.ok(!('authorization' in request.headers), 'anthropic uses x-api-key, not Bearer')
  const body = request.body
  assert.equal(body.max_tokens, 4096, 'max_tokens defaults to 4096')
  assert.equal(body.system, 'be brief')
  assert.equal(body.messages.length, 3, 'consecutive same-role messages merged')
  assert.deepEqual(body.messages[0].content[0], { type: 'text', text: 'hi' })
  assert.deepEqual(body.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } })
  assert.deepEqual(body.messages[1].content[0], { type: 'text', text: 'sure' })
  assert.deepEqual(body.messages[1].content[1], { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } })
  assert.deepEqual(body.messages[2].content[0], { type: 'tool_result', tool_use_id: 'call_1', content: 'result1' })
  assert.deepEqual(body.messages[2].content[1], { type: 'text', text: 'again' }, 'tool result user msg merges with next user text')
  assert.ok(!('tools' in body), 'tools omitted when no tools given')

  const res = await post(request)
  const { summary } = await drain(res, profile)
  assert.equal(summary.content, 'Hey')
  assert.equal(summary.reasoning, 'deep')
  assert.equal(summary.finishReason, 'tool_calls', 'anthropic stop_reason tool_use maps to tool_calls')
  assert.equal(summary.usage.promptTokens, 12)
  assert.equal(summary.usage.completionTokens, 9)
  assert.equal(summary.toolCalls.length, 1)
  assert.equal(summary.toolCalls[0].id, 'tu_1')
  assert.equal(summary.toolCalls[0].function.name, 'calc')
  assert.equal(summary.toolCalls[0].function.arguments, '{"n":2}')
  await server.close()
  console.log('anthropic-messages request/stream: OK')
}

// ---------------------------------------------------- 401: recovery hint

{
  const server = await stub((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"error":"invalid api key"}')
  })
  const profile = { id: 'stub-401', baseURL: server.base, protocol: 'openai-chat', apiKey: 'bad' }
  const res = await post(buildRequest(profile, { model: 'm', messages: [{ role: 'user', content: 'x' }] }))
  await assert.rejects(
    () => drain(res, profile),
    (error) => {
      assert.match(error.message, /provider "stub-401"/)
      assert.match(error.message, /HTTP 401/)
      assert.match(error.message, /Settings → Models/)
      return true
    },
    '401 surfaces provider id + status + Settings recovery hint',
  )
  await server.close()
  console.log('401 recovery hint: OK')
}

// ------------------------------------------------ adapterError hint matrix

{
  const e401 = adapterError('p', 401, 'nope')
  assert.match(e401.message, /HTTP 401/)
  assert.match(e401.message, /Settings → Models/)
  const e500 = adapterError('p', 500, 'boom')
  assert.match(e500.message, /Settings → Models/)
  const e0 = adapterError('p', 0, 'reset')
  assert.match(e0.message, /stream error|unavailable/i)
  assert.match(e0.message, /Settings → Models/)
  console.log('adapterError matrix: OK')
}

// ---------------------------------------------- abort mid-stream propagates

{
  const server = await stub((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"A sufficiently long first chunk"}}]}\n\n')
    // Never finish promptly: the client must abort the read.
    const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 4000)
    res.on('close', () => clearTimeout(timer))
  })
  const profile = { id: 'stub-abort', baseURL: server.base, protocol: 'openai-chat' }
  const controller = new AbortController()
  const request = buildRequest(profile, { model: 'm', messages: [{ role: 'user', content: 'x' }] })
  const res = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal })
  const iter = parseStream(res, profile)
  const first = await iter.next()
  assert.equal(first.done, false)
  assert.equal(first.value.type, 'delta')
  controller.abort()
  await assert.rejects(
    async () => {
      let step = first
      while (!step.done) step = await iter.next()
    },
    (error) => error?.name === 'AbortError' || /abort/i.test(String(error?.message ?? error)),
    'abort mid-stream rejects the generator (cancellation path)',
  )
  await server.close()
  console.log('abort mid-stream: OK')
}

// ---------------------------------------------------------- discovery

{
  const openai = await stub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"data":[{"id":"m1","name":"Model One"},{"id":"m2","name":"Model Two"}]}')
  })
  const models = await listModels({ id: 'disc-oai', baseURL: `${openai.base}/v1`, protocol: 'openai-chat', apiKey: 'k' })
  assert.equal(openai.seen.url, '/v1/models')
  assert.equal(openai.seen.headers.authorization, 'Bearer k')
  assert.deepEqual(models, [
    { id: 'm1', displayName: 'Model One' },
    { id: 'm2', displayName: 'Model Two' },
  ])
  await openai.close()

  const anthropic = await stub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"data":[{"type":"model","id":"claude-x","display_name":"Claude X"}]}')
  })
  const antModels = await listModels({ id: 'disc-ant', baseURL: anthropic.base, protocol: 'anthropic-messages', apiKey: 'sk-ant' })
  assert.equal(anthropic.seen.url, '/v1/models', 'anthropic discovery gains /v1')
  assert.equal(anthropic.seen.headers['x-api-key'], 'sk-ant')
  assert.ok(!('authorization' in anthropic.seen.headers))
  assert.deepEqual(antModels, [{ id: 'claude-x', displayName: 'Claude X' }])
  await anthropic.close()

  const failing = await stub((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end('{"error":"forbidden"}')
  })
  await assert.rejects(
    () => listModels({ id: 'disc-403', baseURL: failing.base, protocol: 'openai-chat' }),
    (error) => {
      assert.match(error.message, /disc-403/)
      assert.match(error.message, /HTTP 403/)
      assert.match(error.message, /Settings → Models/)
      return true
    },
    'discovery failures carry the same recovery hint',
  )
  await failing.close()
  console.log('discovery: OK')
}

console.log('adapters: OK (openai-chat + openai-responses + anthropic-messages + discovery)')
