/** Contract test after build: no downloads, Cloud calls or runtime starts. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  discoverBotConnectorLocal,
  connectBotConnectorLocal,
  localCorePort,
  localCoreURL,
} from '../dist/services/botconnector-local.js'

let health = 200
let models = 200
let lastAuth = ''
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/health') return res.writeHead(health).end(health === 200 ? '{"status":"ok"}' : '{}')
  if (req.url === '/v1/models') {
    lastAuth = req.headers.authorization || ''
    return res.writeHead(models).end(models === 200
      ? JSON.stringify({ data: [
          { id: 'qwen3-8b-local' }, { id: 'qwen3-8b-local' }, { id: 'gemma4:cloud' },
          { id: 'vision-local.gguf' },
        ] })
      : '{}')
  }
  res.writeHead(404).end('{}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const previousPort = process.env.SWITCHBOARD_LOCAL_CORE_PORT
const previousKey = process.env.BOTCONNECTOR_LOCAL_API_KEY
try {
  process.env.SWITCHBOARD_LOCAL_CORE_PORT = String(server.address().port)
  assert.throws(() => localCoreURL(80), /Invalid local port/)
  assert.throws(() => localCorePort('evil.example.com'), /Invalid/)
  assert.equal(localCoreURL().startsWith('http://127.0.0.1:'), true)
  let status = await discoverBotConnectorLocal()
  assert.equal(status.running, true)
  assert.deepEqual(status.models.map(m => m.id), ['qwen3-8b-local', 'vision-local.gguf'])
  assert.equal(lastAuth, '')
  process.env.BOTCONNECTOR_LOCAL_API_KEY = 'test-only-fixture'
  status = await discoverBotConnectorLocal()
  assert.equal(lastAuth, 'Bearer test-only-fixture')
  models = 401
  status = await discoverBotConnectorLocal()
  assert.equal(status.running, false)
  assert.equal(status.authRequired, true)
  models = 200
  health = 503
  status = await discoverBotConnectorLocal()
  assert.equal(status.running, false)
  health = 200

  const store = {
    current: null, defaultChoice: null,
    get(id) { return this.current?.id === id ? this.current : null },
    async create(entry) { this.current = entry },
    async setModels(_id, models) { this.current.models = models },
    async setDefault(selection) { this.defaultChoice = selection },
  }
  await assert.rejects(connectBotConnectorLocal(store, 'gemma4:cloud'), /Choose a model/)
  await connectBotConnectorLocal(store, 'qwen3-8b-local')
  assert.equal(store.current.baseURL, localCoreURL() + '/v1')
  assert.equal(store.current.apiKeyEnv, 'BOTCONNECTOR_LOCAL_API_KEY')
  assert.deepEqual(store.defaultChoice, { provider: 'local-botconnector', model: 'qwen3-8b-local' })
  await connectBotConnectorLocal(store, 'vision-local.gguf')
  assert.equal(store.defaultChoice.model, 'vision-local.gguf')
  store.current.baseURL = 'https://api.example.invalid/v1'
  await assert.rejects(connectBotConnectorLocal(store, 'qwen3-8b-local'), /different settings/)
  console.log('LOCAL_CORE_CONTRACT_PASS: loopback, model filtering, auth, error, registration, explicit selection, no remote fallback')
} finally {
  if (previousPort === undefined) delete process.env.SWITCHBOARD_LOCAL_CORE_PORT
  else process.env.SWITCHBOARD_LOCAL_CORE_PORT = previousPort
  if (previousKey === undefined) delete process.env.BOTCONNECTOR_LOCAL_API_KEY
  else process.env.BOTCONNECTOR_LOCAL_API_KEY = previousKey
  await new Promise(resolve => server.close(resolve))
}
