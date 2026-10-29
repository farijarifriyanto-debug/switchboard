import assert from 'node:assert/strict'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import WebSocket from 'ws'
import { createHost } from '../dist/index.js'
import { pairV2 } from './helpers/pair-client.mjs'

async function port() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const result = server.address().port
  await new Promise(resolve => server.close(resolve))
  return result
}
const root = await mkdtemp(path.join(tmpdir(), 'switchboard-byok-'))
const token = randomBytes(24).toString('hex')
const webToken = randomBytes(24).toString('hex')
const extensionOrigin = 'chrome-extension://' + 'a'.repeat(32)
const browserPort = await port()
let host, socket
try {
  host = await createHost({
    settings: { dir: root },
    llm: { baseURL: 'http://127.0.0.1:1/v1', defaultModel: 'placeholder', retries: 0 },
    sessions: { dir: '', load: false }, metrics: { persist: '', load: false },
    browser: { port: browserPort, token },
    web: { enabled: true, host: '127.0.0.1', port: 0, token: webToken },
  })
  const { url } = await host.ctx.web.ready()
  const api = async (route, options = {}) => {
    const headers = {
      origin: extensionOrigin, authorization: 'Bearer ' + token,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
    const response = await fetch(url.replace(/\/$/, '') + route, {
      method: options.method || 'GET', headers,
      ...(options.body ? {body: JSON.stringify(options.body)} : {})
    })
    return { status: response.status, body: await response.json() }
  }
  const consoleApi = (route, opts = {}) => api(route, {
    ...opts, headers: { origin: new URL(url).origin, authorization: 'Bearer ' + webToken }
  })
  const unpaired = await api('/api/companion-byok/request', {
    method: 'POST', body: { provider: 'openrouter', model: 'qwen/qwen3.8-flash' }
  })
  assert.equal(unpaired.status, 403, 'No grant without connected extension')
  await pairV2('http://127.0.0.1:' + browserPort, token, 'token', extensionOrigin)
  socket = new WebSocket('ws://127.0.0.1:' + browserPort + '/api/browser-companion/socket',
    ['switchboard-bridge-v1', 'sb-auth-' + token], { origin: extensionOrigin })
  await new Promise((resolve, reject) => {socket.once('open', resolve); socket.once('error', reject)})
  assert.equal((await api('/api/settings')).status, 401, 'Companion bearer never authorizes settings')
  const post = (route, body) => api(route, {method:'POST',body})
  const req = await post('/api/companion-byok/request', {
    provider: 'openrouter', model: 'qwen/qwen3.8-flash', setDefault: true
  })
  assert.equal(req.status, 201)
  assert.match(req.body.id, /^[a-f0-9]{32}$/)
  const id = req.body.id
  const deniedCommit = await post('/api/companion-byok/commit', {id, apiKey:'sensitive-byok-test-key'})
  assert.equal(deniedCommit.status, 403, 'No credential write without independent console approval')
  const deniedDetails = await api('/api/companion-byok/details?id=' + id)
  assert.equal(deniedDetails.status, 401, 'Companion cannot inspect console approval details')
  const deniedApproval = await post('/api/companion-byok/approve', { id })
  assert.equal(deniedApproval.status, 401, 'Companion cannot self-approve')
  const badOrigin = await api('/api/companion-byok/status', {
    method: 'POST', body: { id }, headers: {origin:'https://evil.example'}
  })
  assert.equal(badOrigin.status, 401, 'Foreign origin fails the companion bearer guard')
  const details = await consoleApi('/api/companion-byok/details?id=' + id)
  assert.equal(details.status, 200)
  assert.equal(details.body.provider, 'OpenRouter (BYOK)')
  assert.equal(details.body.model, 'qwen/qwen3.8-flash')
  assert.equal(JSON.stringify(details.body).includes('apiKey'), false)
  const approval = await consoleApi('/api/companion-byok/approve', {method:'POST', body:{id}})
  assert.equal(approval.status, 200)
  assert.equal((await post('/api/companion-byok/status', { id })).body.approved, true)
  const saved = await post('/api/companion-byok/commit', { id, apiKey:'sensitive-byok-test-key',
    provider:'groq', model:'should-not-be-trusted' })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.provider, 'OpenRouter (BYOK)', 'Cannot override approval with submitted provider')
  assert.equal(saved.body.model, 'qwen/qwen3.8-flash')
  assert.ok(!JSON.stringify(saved.body).includes('sensitive-byok-test-key'))
  assert.equal(host.ctx.providers.default().provider, 'byok-openrouter')
  assert.equal(host.ctx.providers.default().model, 'qwen/qwen3.8-flash')
  const detailsStored = host.ctx.credentials.describe(host.ctx.providers.require('byok-openrouter'))
  assert.equal(detailsStored.configured, true)
  assert.equal(detailsStored.source, 'local')
  assert.ok(!JSON.stringify(detailsStored).includes('sensitive-byok-test-key'))
  assert.equal((await post('/api/companion-byok/commit', {id,apiKey:'another'})).status, 403,
    'Approved grants are strictly one use')
  const statusAfter = await post('/api/companion-byok/status', { id })
  assert.equal(statusAfter.status, 404)
  const missing = await post('/api/companion-byok/request', {provider:'https://evil.example',
    model:'any-model'})
  assert.equal(missing.status, 400, 'Provider list is intentionally narrow')
  const malformed = await post('/api/companion-byok/request', {
    provider:'groq', model:'a?model&key=secret'
  })
  assert.equal(malformed.status, 400, 'Model IDs are bounded and URL-safe')
  const secondary = await post('/api/companion-byok/request', {
    provider:'groq', model:'openai/gpt-oss-20b', setDefault:false
  })
  assert.equal(secondary.status, 201)
  assert.equal((await consoleApi('/api/companion-byok/approve',{
    method:'POST',body:{id:secondary.body.id}
  })).status,200)
  assert.equal((await post('/api/companion-byok/commit',{
    id:secondary.body.id,apiKey:'another-sensitive-test-key'
  })).status,200)
  assert.equal(host.ctx.providers.require('byok-groq').baseURL,'https://api.groq.com/openai/v1')
  assert.equal(host.ctx.providers.default().provider,'byok-openrouter','Save without select does not replace active model')
  console.log('PASS side-panel BYOK one-time consent / console authentication / provider allowlist / write-only credential / consume-once / optional default')
} finally {
  socket?.close()
  await host?.dispose().catch(() => {})
  await rm(root, { recursive:true, force:true, maxRetries:4, retryDelay:150 })
}
