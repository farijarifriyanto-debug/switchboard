/**
 * Pairing: an unknown sender gets a one-time code, the owner approves it, only then is it served.
 *
 *   node scripts/test-pairing.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
import { PairingStore } from '../dist/channels/pairing.js'

const dir = await mkdtemp(path.join(tmpdir(), 'sbx-pair-'))

// ---- store
{
  const a = new PairingStore(path.join(dir, 'pairing.json'))
  const first = await a.request('telegram', '77', 'eve')
  assert.match(first.code, /^[A-HJKMNP-Z2-9]{8}$/)
  assert.equal(await a.request('telegram', '77'), null, 'one reply per sender per 10 minutes')
  const b = new PairingStore(path.join(dir, 'pairing.json')) // another process
  assert.equal((await b.list()).pending.length, 1, 'pending codes are shared through the file')
  assert.equal(await b.approve('WRONGCODE'), null)
  const who = await b.approve(first.code.toLowerCase())
  assert.deepEqual([who.channel, who.userId], ['telegram', '77'])
  assert.equal(await b.approve(first.code), null, 'a code works once')
  await a.load()
  assert.equal(a.has('telegram', '77'), true)
  assert.equal(a.has('discord', '77'), false, 'approval is per channel')
  assert.equal(await b.revoke('telegram', '77'), true)
  await a.load()
  assert.equal(a.has('telegram', '77'), false)
  // at most 5 pending codes
  const c = new PairingStore(path.join(dir, 'full.json'))
  for (let i = 0; i < 5; i += 1) assert.ok(await c.request('discord', String(100 + i)))
  assert.equal(await c.request('discord', '999'), null)
}

// ---- telegram end to end (fake Bot API + stub model)
const TOKEN = '1:T'
const calls = []
const queue = []
let wake
const tg = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const method = req.url.split('/').pop()
  const reply = (result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }))
  if (method === 'getUpdates') {
    if (queue.length) return reply(queue.splice(0))
    const t = setTimeout(() => reply([]), 250)
    wake = () => (clearTimeout(t), reply(queue.splice(0)))
    return req.on('close', () => clearTimeout(t))
  }
  calls.push({ method, ...params })
  return reply(method === 'sendMessage' ? { message_id: calls.length + 100 } : method === 'getMe' ? { username: 'b' } : true)
})
await new Promise((r) => tg.listen(0, '127.0.0.1', r))
let uid = 1
const say = (text, from) => (queue.push({ update_id: uid++, message: { message_id: uid, text, from: { id: from }, chat: { id: from, type: 'private' } } }), wake?.())
const texts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.text)
const waitFor = async (fn, what) => {
  for (let i = 0; i < 300; i += 1) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const stub = http.createServer((req, res) => {
  req.resume()
  if (req.url?.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"stub"}]}')
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello paired' } }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
  res.end('data: [DONE]\n\n')
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))

process.env.TELEGRAM_BOT_TOKEN = TOKEN
const base = {
  llm: { baseURL: `http://127.0.0.1:${stub.address().port}/v1`, defaultModel: 'stub', retries: 0 },
  metrics: { persist: '', load: false },
  sessions: { dir: path.join(dir, 'sessions') },
  settings: { dir },
}
const tgCfg = { enabled: true, allowFrom: [], apiBase: `http://127.0.0.1:${tg.address().port}`, pollSeconds: 1, dir }
await assert.rejects(createHost({ ...base, channels: { telegram: tgCfg } }), /allowFrom/, 'no allow-list and no pairing still refuses to start')

const host = await createHost({ ...base, channels: { telegram: { ...tgCfg, pairing: true } } })
try {
  say('hi', 555)
  await waitFor(() => texts().some((t) => /sbx channels approve [A-Z2-9]{8}/.test(t)), 'pairing offer')
  const code = texts().find((t) => /sbx channels approve/.test(t)).match(/approve ([A-Z2-9]{8})/)[1]
  assert.ok(!texts().some((t) => /hello paired/.test(t)), 'an unpaired sender is not served')
  say('hi again', 555)
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(texts().filter((t) => /Not paired/.test(t)).length, 1, 'the bot does not repeat itself')

  const owner = new PairingStore(path.join(dir, 'pairing.json'))
  assert.ok(await owner.approve(code))
  say('now served?', 555)
  await waitFor(() => texts().some((t) => /hello paired/.test(t)), 'answer after approval')
  console.log('test-pairing: all checks passed')
} finally {
  await host.dispose()
  tg.close()
  stub.close()
  await rm(dir, { recursive: true, force: true })
  setTimeout(() => process.exit(0), 100)
}
