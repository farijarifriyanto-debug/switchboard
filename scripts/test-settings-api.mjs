/**
 * Settings API contract test (spec §6-§8): guard matrix (Host/Origin/
 * content-type), provider CRUD, write-only credentials, model catalog,
 * draft discovery (key never persisted), default validation, in-use delete
 * 409 → force detach, approval setMode, `/api/settings` + `/api/state`
 * aggregation, and multi-provider chat with hot-apply (slow provider A
 * finishes in flight after a save switches to provider B).
 *
 *   node scripts/test-settings-api.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'

const SECRET = 'sk-test-SECRET-do-not-leak-123'
const DRAFT_SECRET = 'sk-draft-ONE-SHOT-456'

/** OpenAI-chat stub answering with a marker; counts chat + discovery hits. */
function chatStub(marker, delayMs = 0) {
  const state = { chat: 0, models: 0 }
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      state.models += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: `${marker}-m1`, name: `${marker} model one` }, { id: `${marker}-m2` }] }))
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404)
      res.end()
      return
    }
    state.chat += 1
    for await (const chunk of req) void chunk
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    send({ choices: [{ delta: { content: `${marker} ` } }] })
    send({ choices: [{ delta: { content: 'from ' } }] })
    send({ choices: [{ delta: { content: marker } }] })
    send({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return { server, state }
}

/** Raw request so the test can forge Host/Origin/content-type headers. */
function rawRequest(port, { method = 'GET', route = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

/** JSON helper: write methods always send content-type + a JSON body. */
function api(base, route, { method = 'GET', body, headers = {} } = {}) {
  const write = method !== 'GET'
  return fetch(base + route.replace(/^\//, ''), {
    method,
    headers: { ...(write ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(write ? { body: JSON.stringify(body ?? {}) } : {}),
  }).then(async (res) => {
    let data = null
    try {
      data = await res.json()
    } catch {
      /* empty body */
    }
    return { status: res.status, data }
  })
}

function expectError(result, status, label) {
  assert.equal(result.status, status, `${label}: expected ${status}, got ${result.status} (${JSON.stringify(result.data)})`)
  assert.ok(result.data && typeof result.data.error === 'string' && result.data.error, `${label}: {error} required`)
  assert.ok(typeof result.data.hint === 'string' && result.data.hint, `${label}: {hint} recovery required`)
}

const stubA = chatStub('AAA', 400)
const stubB = chatStub('BBB')
for (const stub of [stubA, stubB]) {
  await new Promise((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
}
const portA = stubA.server.address().port
const portB = stubB.server.address().port
const urlA = `http://127.0.0.1:${portA}/v1`
const urlB = `http://127.0.0.1:${portB}/v1`

const settingsDir = await mkdtemp(path.join(tmpdir(), 'sbx-settings-api-'))
const host = await createHost({
  settings: { dir: settingsDir },
  llm: { baseURL: urlA, defaultModel: 'AAA-m1', retries: 0 },
  metrics: { persist: '', load: false },
  sessions: { dir: '', load: false },
  web: { enabled: true, port: 0 },
})

try {
  const { url, port } = await host.ctx.web.ready()
  const base = url

  // ------------------------------------------------------------- guard
  {
    const badHost = await rawRequest(port, { route: '/api/settings', headers: { host: 'evil.example' } })
    assert.equal(badHost.status, 403, 'DNS-rebinding: non-loopback Host must be 403')
    const parsed = JSON.parse(badHost.body)
    assert.ok(parsed.error && parsed.hint, '403 carries {error, hint}')

    const badOrigin = await rawRequest(port, {
      route: '/api/settings',
      headers: { host: `127.0.0.1:${port}`, origin: 'http://evil.example' },
    })
    assert.equal(badOrigin.status, 403, 'cross-origin must be 403')
    assert.ok(JSON.parse(badOrigin.body).hint, 'cross-origin 403 carries a recovery hint')

    const plain = await rawRequest(port, {
      method: 'PUT',
      route: '/api/settings/general',
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain' },
      body: 'approvalMode=all',
    })
    assert.equal(plain.status, 415, 'text/plain mutation must be 415')

    const good = await api(base, '/api/settings')
    assert.equal(good.status, 200, 'loopback GET /api/settings passes the guard')
    console.log('- guard matrix: Host 403 / Origin 403 / text/plain 415 / ok 200')
  }

  // --------------------------------------------------- GET /api/settings
  {
    const { status, data } = await api(base, '/api/settings')
    assert.equal(status, 200)
    assert.ok(typeof data.general.approvalMode === 'string', 'general.approvalMode')
    assert.ok(data.general.storage.settingsDir.includes('sbx-settings-api-'), 'storage.settingsDir points at the temp dir')
    assert.ok(typeof data.general.endpoint === 'string' && data.general.endpoint, 'general.endpoint')
    assert.ok(Array.isArray(data.general.keyPrecedence) && data.general.keyPrecedence.length >= 3, 'key precedence explainer')
    assert.ok(Array.isArray(data.providers) && data.providers.some((p) => p.id === 'default'), 'providers lists the virtual default')
    assert.deepEqual(typeof data.default.provider, 'string', 'default {provider, model}')
    assert.ok(data.agent.maxSteps >= 1, 'agent block is non-secret config')
    assert.equal(typeof data.mcp.configured, 'boolean', 'mcp status')
    assert.deepEqual(data.supported.protocols, ['openai-chat', 'openai-responses', 'anthropic-messages'], 'supported.protocols')
    assert.deepEqual(data.supported.approvalModes, ['off', 'risky', 'all'], 'supported.approvalModes')
    assert.ok(data.supported.discovery === true, 'supported.discovery')
    console.log('- GET /api/settings shape')
  }

  // ------------------------------------------------------------- CRUD
  {
    const create = await api(base, '/api/settings/providers', {
      method: 'POST',
      body: { id: 'stub-a', displayName: 'Stub A', baseURL: urlA, protocol: 'openai-chat' },
    })
    assert.equal(create.status, 201, `create -> 201 (${JSON.stringify(create.data)})`)
    assert.equal(create.data.id, 'stub-a')

    const dupe = await api(base, '/api/settings/providers', {
      method: 'POST',
      body: { id: 'stub-a', displayName: 'Again', baseURL: urlA, protocol: 'openai-chat' },
    })
    expectError(dupe, 409, 'duplicate id')

    const badProto = await api(base, '/api/settings/providers', {
      method: 'POST',
      body: { displayName: 'Bad', baseURL: urlA, protocol: 'grpc' },
    })
    expectError(badProto, 400, 'unknown protocol')

    const list = await api(base, '/api/settings/providers')
    assert.equal(list.status, 200)
    assert.ok(list.data.providers.some((p) => p.id === 'stub-a'), 'created provider listed')
    for (const provider of list.data.providers) {
      assert.ok(provider.credential && typeof provider.credential.configured === 'boolean', 'credential describe only')
      assert.ok(!('apiKey' in provider), 'list never contains apiKey')
    }

    const rename = await api(base, '/api/settings/providers/stub-a', { method: 'PUT', body: { displayName: 'Stub A Renamed' } })
    assert.equal(rename.status, 200)
    assert.equal(rename.data.displayName, 'Stub A Renamed')

    const reid = await api(base, '/api/settings/providers/stub-a', { method: 'PUT', body: { id: 'other-id' } })
    expectError(reid, 400, 'id immutable')

    const editDefault = await api(base, '/api/settings/providers/default', { method: 'PUT', body: { displayName: 'Nope' } })
    expectError(editDefault, 400, 'default is config-owned')
    assert.match(editDefault.data.hint, /switchboard\.config\.jsonc/, 'default hint points at the config file')
    console.log('- CRUD roundtrip + validation')
  }

  // ------------------------------------------------- write-only credential
  {
    const set = await api(base, '/api/settings/providers/stub-a/credential', { method: 'PUT', body: { apiKey: SECRET } })
    assert.equal(set.status, 200, `credential set -> 200 (${JSON.stringify(set.data)})`)
    assert.deepEqual(set.data, { configured: true, source: 'local', updatedAt: set.data.updatedAt }, 'set answers with describe only')
    assert.ok(!JSON.stringify(set.data).includes(SECRET), 'write response echoes no key')

    const get = await api(base, '/api/settings/providers/stub-a/credential')
    assert.equal(get.status, 200)
    assert.equal(get.data.configured, true)
    assert.equal(get.data.source, 'local')

    const settingsText = JSON.stringify((await api(base, '/api/settings')).data)
    assert.ok(!settingsText.includes(SECRET), 'GET /api/settings never contains the key')
    const stateText = JSON.stringify((await api(base, '/api/state')).data)
    assert.ok(!stateText.includes(SECRET), '/api/state never contains the key')

    const credFile = await readFile(path.join(settingsDir, 'credentials.json'), 'utf8')
    assert.ok(credFile.includes(SECRET), 'the local store persists the key (0600 file)')
    const provFile = await readFile(path.join(settingsDir, 'providers.json'), 'utf8')
    assert.ok(!provFile.includes(SECRET), 'providers.json must stay key-free')

    const empty = await api(base, '/api/settings/providers/stub-a/credential', { method: 'PUT', body: { apiKey: '' } })
    expectError(empty, 400, 'empty key rejected')

    const clear = await api(base, '/api/settings/providers/stub-a/credential', { method: 'DELETE' })
    assert.equal(clear.status, 200)
    const after = await api(base, '/api/settings/providers/stub-a/credential')
    assert.deepEqual(after.data, { configured: false, source: null }, 'cleared credential reports unconfigured')
    console.log('- write-only credential semantics')
  }

  // ------------------------------------------- catalog + draft discovery
  {
    const putModels = await api(base, '/api/settings/providers/stub-a/models', {
      method: 'PUT',
      body: {
        models: [
          { id: 'alpha', displayName: 'Alpha', context: 8192, maxOutput: 2048, inputs: { vision: true, tools: true } },
          { id: 'beta', inputs: { tools: false } },
        ],
      },
    })
    assert.equal(putModels.status, 200, `models PUT -> 200 (${JSON.stringify(putModels.data)})`)
    assert.equal(putModels.data.models.length, 2)

    const getModels = await api(base, '/api/settings/providers/stub-a/models')
    assert.deepEqual(getModels.data.models.map((m) => m.id), ['alpha', 'beta'])

    const providersBefore = (await readFile(path.join(settingsDir, 'providers.json'), 'utf8')).length
    const discover = await api(base, '/api/settings/discover', {
      method: 'POST',
      body: { baseURL: urlB, protocol: 'openai-chat', apiKey: DRAFT_SECRET },
    })
    assert.equal(discover.status, 200, `discovery -> 200 (${JSON.stringify(discover.data)})`)
    assert.deepEqual(discover.data.models.map((m) => m.id), ['BBB-m1', 'BBB-m2'])

    const credAfter = await readFile(path.join(settingsDir, 'credentials.json'), 'utf8')
    assert.ok(!credAfter.includes(DRAFT_SECRET), 'draft key must never be persisted')
    const provAfter = await readFile(path.join(settingsDir, 'providers.json'), 'utf8')
    assert.ok(!provAfter.includes(DRAFT_SECRET), 'providers.json must not receive the draft key')
    assert.equal(provAfter.length, providersBefore, 'discovery creates no provider')

    const badUrl = await api(base, '/api/settings/discover', { method: 'POST', body: { baseURL: 'not a url', protocol: 'openai-chat' } })
    expectError(badUrl, 400, 'invalid draft baseURL')

    const upstream = await api(base, '/api/settings/discover', {
      method: 'POST',
      body: { baseURL: `http://127.0.0.1:${portA}`, protocol: 'openai-chat' },
    })
    assert.equal(upstream.status, 502, 'upstream failure -> 502')
    assert.match(upstream.data.error, /HTTP 404/, 'upstream status surfaced')
    assert.ok(upstream.data.hint, 'upstream failure carries a recovery hint')
    console.log('- catalog replace + draft discovery (key not persisted)')
  }

  // --------------------------------------------------- default validation
  {
    const unknown = await api(base, '/api/settings/default', { method: 'PUT', body: { provider: 'nope', model: 'x' } })
    expectError(unknown, 404, 'unknown default provider')

    const ghost = await api(base, '/api/settings/default', { method: 'PUT', body: { provider: 'stub-a', model: 'ghost' } })
    expectError(ghost, 400, 'model outside catalog')

    const ok = await api(base, '/api/settings/default', { method: 'PUT', body: { provider: 'stub-a', model: 'alpha' } })
    assert.equal(ok.status, 200)
    assert.deepEqual((await api(base, '/api/settings/default')).data, { provider: 'stub-a', model: 'alpha' })
    console.log('- default provider/model validation')
  }

  // ------------------------------------------------------ approval setMode
  {
    const put = await api(base, '/api/settings/general', { method: 'PUT', body: { approvalMode: 'risky' } })
    assert.equal(put.status, 200)
    assert.equal(put.data.approvalMode, 'risky')
    const approvals = await api(base, '/api/approvals')
    assert.equal(approvals.data.mode, 'risky', 'hot-apply: approval gate reads the new mode')

    expectError(await api(base, '/api/settings/general', { method: 'PUT', body: { approvalMode: 'nope' } }), 400, 'bad mode')
    expectError(await api(base, '/api/settings/general', { method: 'PUT', body: {} }), 400, 'mode required')
    console.log('- approval setMode')
  }

  // ------------------------------------------------------ state aggregation
  {
    const { status, data } = await api(base, '/api/state')
    assert.equal(status, 200)
    const stub = data.providers.find((p) => p.id === 'stub-a')
    assert.ok(stub, 'state lists persisted providers')
    assert.equal(stub.displayName, 'Stub A Renamed')
    assert.equal(stub.protocol, 'openai-chat')
    assert.equal(stub.credential.configured, false, 'credential describe in state')
    assert.deepEqual(data.default, { provider: 'stub-a', model: 'alpha' }, 'state carries the default selection')
    const alpha = data.models.find((m) => m.id === 'alpha' && m.provider === 'stub-a')
    assert.ok(alpha, 'state models include the persisted catalog with provider identity')
    assert.equal(alpha.providerName, 'Stub A Renamed')
    assert.equal(alpha.displayName, 'Alpha')
    assert.equal(alpha.context, 8192)
    assert.equal(alpha.maxOutput, 2048)
    assert.deepEqual(alpha.inputs, { vision: true, tools: true })
    assert.ok(!JSON.stringify(data).includes(SECRET), 'state stays key-free')
    console.log('- /api/state aggregation (providers + default + catalog models)')
  }

  // ------------------------------------------------- delete in-use 409/force
  {
    const session = await api(base, '/api/sessions', {
      method: 'POST',
      body: { title: 'uses stub-a', model: 'alpha', provider: 'stub-a' },
    })
    assert.equal(session.status, 201)
    assert.equal(session.data.provider, 'stub-a', 'POST /api/sessions keeps the provider identity')

    const stateAfter = await api(base, '/api/state')
    const listed = stateAfter.data.sessions.find((s) => s.id === session.data.id)
    assert.equal(listed?.provider, 'stub-a', '/api/state sessions carry provider (client counts in-use before delete)')

    const conflict = await api(base, '/api/settings/providers/stub-a', { method: 'DELETE' })
    assert.equal(conflict.status, 409, `in-use -> 409 (${JSON.stringify(conflict.data)})`)
    assert.ok(conflict.data.inUse?.sessions?.length === 1, '409 lists the sessions')
    assert.equal(conflict.data.inUse.sessions[0].title, 'uses stub-a')
    assert.ok(conflict.data.hint, '409 carries recovery hint')

    const forced = await api(base, '/api/settings/providers/stub-a?force=1', { method: 'DELETE' })
    assert.equal(forced.status, 200, `force delete -> 200 (${JSON.stringify(forced.data)})`)
    assert.equal(forced.data.deleted.id, 'stub-a')
    assert.equal(forced.data.detachedSessions, 1)
    assert.equal(typeof forced.data.fallback.provider, 'string', 'response includes the fallback')

    const after = await api(base, `/api/sessions/${encodeURIComponent(session.data.id)}`)
    assert.ok(after.data.provider === undefined || after.data.provider === null, 'force delete detaches the session')

    const list = await api(base, '/api/settings/providers')
    assert.ok(!list.data.providers.some((p) => p.id === 'stub-a'), 'provider removed')

    expectError(await api(base, '/api/settings/providers/default', { method: 'DELETE' }), 400, 'default not deletable')
    console.log('- delete in-use: 409 -> force detach + fallback')
  }

  // ----------------------------------------------- hot-apply multi-provider
  {
    stubA.state.chat = 0
    stubB.state.chat = 0
    const create = await api(base, '/api/settings/providers', {
      method: 'POST',
      body: { id: 'hot-a', displayName: 'Hot A', baseURL: urlA, protocol: 'openai-chat' },
    })
    assert.equal(create.status, 201)

    const res = await fetch(base + 'api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello there friend', provider: 'hot-a', model: 'm1' }),
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/event-stream/)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let savedMidFlight = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (!savedMidFlight && text.includes('AAA')) {
        savedMidFlight = true
        // In flight: point the provider at stub B — the running stream must
        // keep using the snapshot taken at request start (spec §7).
        const put = await api(base, '/api/settings/providers/hot-a', { method: 'PUT', body: { baseURL: urlB } })
        assert.equal(put.status, 200, 'mid-flight save accepted')
      }
    }
    assert.ok(savedMidFlight, 'the in-flight stream produced output from provider A')
    assert.match(text, /AAA/, 'in-flight run finishes on A despite the save')
    assert.equal(stubA.state.chat, 1, 'A served the in-flight run')
    assert.equal(stubB.state.chat, 0, 'B was never reached during that run')

    const sessionFrame = /event: session\ndata: (.+)/.exec(text)
    assert.ok(sessionFrame, 'session frame present')
    const sessionId = JSON.parse(sessionFrame[1]).sessionId
    const stored = await api(base, `/api/sessions/${encodeURIComponent(sessionId)}`)
    assert.equal(stored.data.provider, 'hot-a', 'session.provider persisted for future turns')

    const next = await fetch(base + 'api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello again', sessionId, model: 'm1' }),
    })
    assert.equal(next.status, 200)
    const nextText = await next.text()
    assert.match(nextText, /BBB/, 'next request uses the saved profile (hot-apply)')
    assert.ok(!/AAA from AAA/.test(nextText.replace(/event: session[^\n]*\n/, '')), 'the old endpoint is gone')
    assert.equal(stubA.state.chat, 1, 'A not called again')
    assert.equal(stubB.state.chat, 1, 'B served the follow-up turn')
    console.log('- hot-apply chat: in-flight keeps A, next request hits B, session.provider persisted')
  }

  console.log('settings-api: OK (guard, CRUD, credential write-only, discovery, default, approvals, state, delete recovery, hot-apply)')
} finally {
  for (const stub of [stubA, stubB]) stub.server.close()
  await host.dispose()
  await rm(settingsDir, { recursive: true, force: true })
}
