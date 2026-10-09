/**
 * Discord channel against a fake gateway (a hand-rolled WebSocket server) and fake REST: DMs from the allow-list
 * only, tool approvals through buttons, commands, resume after a dropped connection, a fatal close code, automation
 * delivery, and the fail-closed start-up rules. Needs Node 22+ (global WebSocket); skipped on older Node.
 *
 *   node scripts/test-discord.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
import { splitDiscord } from '../dist/channels/discord.js'

// ---- pure helper
assert.deepEqual(splitDiscord('short'), ['short'])
const long = `${'line one\n'.repeat(400)}end`
const parts = splitDiscord(long, 1000)
assert.ok(parts.every((p) => p.length <= 1000) && parts.length > 2)
assert.equal(parts.join('\n').replace(/\n+/g, '\n'), long.replace(/\n+/g, '\n'))
assert.ok(splitDiscord('a'.repeat(5000)).every((p) => p.length <= 1900), 'default limit is under Discord\'s 2000')

if (typeof WebSocket === 'undefined') {
  console.log('discord: SKIPPED (needs Node 22+ for the built-in WebSocket)')
  process.exit(0)
}

const TOKEN = 'FAKE.DISCORD.TOKEN'
const ALLOWED = '4242424242424242'
const STRANGER = '5555555555555555'
const BOT = '999000111'

// ---- fake Discord: REST + gateway on one server
const rest = []
let nextId = 1000
let conn // the live gateway connection
const seen = { identify: 0, resume: [], heartbeats: 0 }
let seq = 0
let url
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const frame = (opcode, payload) => {
  const body = Buffer.from(payload)
  const head = body.length < 126 ? Buffer.from([0x80 | opcode, body.length]) : Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255])
  return Buffer.concat([head, body])
}
class Conn {
  constructor(socket) {
    this.socket = socket
    this.buf = Buffer.alloc(0)
    socket.on('data', (d) => this.onData(d))
    socket.on('error', () => {})
    this.send({ op: 10, d: { heartbeat_interval: 300 } })
  }
  send(obj) {
    if (!this.socket.destroyed) this.socket.write(frame(1, JSON.stringify(obj)))
  }
  dispatch(t, d) {
    this.send({ op: 0, t, s: ++seq, d })
  }
  close(code) {
    const c = Buffer.alloc(2)
    c.writeUInt16BE(code)
    this.socket.write(frame(8, c))
    this.socket.end()
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d])
    for (;;) {
      if (this.buf.length < 2) return
      const opcode = this.buf[0] & 15
      let len = this.buf[1] & 127
      let off = 2
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4 }
      if (this.buf.length < off + 4 + len) return
      const mask = this.buf.subarray(off, off + 4)
      const data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len))
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]
      this.buf = this.buf.subarray(off + 4 + len)
      if (opcode === 8) { this.socket.end(); return }
      if (opcode === 1) this.onFrame(JSON.parse(data.toString('utf8')))
    }
  }
  onFrame(f) {
    if (f.op === 1) { seen.heartbeats++; this.send({ op: 11 }) }
    else if (f.op === 2) {
      seen.identify++
      assert.equal(f.d.token, TOKEN)
      assert.equal(f.d.intents, 4096, 'only the DIRECT_MESSAGES intent is requested')
      this.dispatch('READY', { session_id: 'sess1', resume_gateway_url: url, user: { id: BOT, username: 'testbot' } })
    } else if (f.op === 6) {
      seen.resume.push(f.d)
      this.dispatch('RESUMED', {})
    }
  }
}

const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {}
  assert.equal(req.headers.authorization, `Bot ${TOKEN}`, 'REST calls carry the bot token as a header')
  const reply = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(obj === undefined ? '' : JSON.stringify(obj))
  }
  const route = req.url.replace(/^\/api/, '')
  if (route === '/gateway/bot') return reply(200, { url })
  rest.push({ method: req.method, route, ...body })
  if (route === '/users/@me/channels') return reply(200, { id: `dm-${body.recipient_id}` })
  if (req.method === 'POST' && /^\/channels\/[^/]+\/messages$/.test(route)) return reply(200, { id: String(++nextId) })
  return reply(204)
})
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  conn = new Conn(socket)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
url = `ws://127.0.0.1:${server.address().port}`
const apiBase = `http://127.0.0.1:${server.address().port}/api`

const waitFor = async (predicate, what, ms = 8_000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const hit = predicate()
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const posted = () => rest.filter((c) => c.method === 'POST' && /\/messages$/.test(c.route))
const lastText = () => posted().at(-1)?.content
const dm = (content, author = ALLOWED, extra = {}) => conn.dispatch('MESSAGE_CREATE', { id: String(++nextId), channel_id: `dm-${author}`, author: { id: author }, content, type: 0, ...extra })
const click = (customId, user = ALLOWED, extra = {}) => conn.dispatch('INTERACTION_CREATE', { id: `i${++nextId}`, token: `tok${nextId}`, type: 3, channel_id: `dm-${user}`, user: { id: user }, data: { custom_id: customId }, ...extra })

// ---- stub model: plain answers, or a run_command call when asked
let mode = 'plain'
const stub = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'stub' }] }))
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const lastMsg = (body.messages ?? []).at(-1)
  const toolMsg = lastMsg?.role === 'tool' ? lastMsg : undefined
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  if (mode === 'tool' && !toolMsg) {
    send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run_command', arguments: '{"command":"echo from-the-shell"}' } }] } }] })
    send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  } else {
    send({ choices: [{ delta: { content: toolMsg ? `tool said: ${toolMsg.content}` : 'plain answer' } }] })
    send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
  }
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))

const dir = await mkdtemp(path.join(tmpdir(), 'sbx-dc-'))
const base = {
  llm: { baseURL: `http://127.0.0.1:${stub.address().port}/v1`, defaultModel: 'stub', retries: 0 },
  metrics: { persist: '', load: false },
  sessions: { dir: path.join(dir, 'sessions') },
  settings: { dir },
}
const channel = { enabled: true, allowFrom: [ALLOWED], apiBase, dir }

// ---- fail-closed start-up
process.env.DISCORD_BOT_TOKEN = ''
await assert.rejects(createHost({ ...base, channels: { discord: channel } }), /set DISCORD_BOT_TOKEN/)
process.env.DISCORD_BOT_TOKEN = TOKEN
await assert.rejects(createHost({ ...base, channels: { discord: { ...channel, allowFrom: [] } } }), /allowFrom/)
await assert.rejects(createHost({ ...base, channels: { discord: { ...channel, allowFrom: [4242424242424242424242] } } }), /write it as a string/)
await assert.rejects(createHost({ ...base, channels: { discord: { ...channel, allowFrom: ['not-an-id'] } } }), /is not a Discord user id/)
await assert.rejects(createHost({ ...base, approval: { mode: 'off' }, channels: { discord: channel } }), /approval.mode is "off"/)
await assert.rejects(createHost({ ...base, channels: { discord: { ...channel, preset: 'nope' } } }), /unknown preset/)

let host = await createHost({ ...base, channels: { discord: channel }, approval: { mode: 'risky', timeoutMs: 20_000 } })
try {
  await waitFor(() => conn && seen.identify === 1, 'gateway identify')

  // ---- who is served
  dm('hello', STRANGER) // not on the list
  dm('hello', ALLOWED, { guild_id: '777' }) // right user, but in a server
  dm('hello', BOT) // the bot's own echo
  dm('hello', ALLOWED, { author: { id: ALLOWED, bot: true } }) // another bot claiming the id
  dm('hello', ALLOWED, { type: 7 }) // a system message (member joined)
  click('ap|x|y', STRANGER)
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(posted().length, 0, 'strangers, servers, bots and system messages get no reply')

  // ---- a normal turn
  dm('hello')
  await waitFor(() => lastText() === 'plain answer', 'the answer')
  assert.deepEqual(posted().at(-1).allowed_mentions, { parse: [] }, 'replies never ping anyone')
  assert.ok(rest.some((c) => c.route === '/channels/dm-' + ALLOWED + '/typing'), 'typing indicator')
  dm('/status')
  await waitFor(() => /^session s-/.test(lastText() ?? '') && /approval risky/.test(lastText()), 'status')
  const firstSession = /session (s-[\w-]+)/.exec(lastText())[1]
  dm('/preset reviewer')
  await waitFor(() => lastText() === 'Preset set to reviewer.', 'preset set')
  dm('/preset default')
  await waitFor(() => lastText() === 'Preset set to default.', 'preset cleared')

  // ---- tool approval through buttons
  mode = 'tool'
  dm('please run it')
  const ask = await waitFor(() => posted().find((c) => /^Approve run_command\?/.test(c.content)), 'the approval prompt')
  assert.match(ask.content, /echo from-the-shell/)
  const buttons = ask.components[0].components
  assert.deepEqual(buttons.map((b) => b.label), ['Allow', 'Deny', 'Always (this chat)'])
  const [allow, deny] = buttons.map((b) => b.custom_id)
  click(allow, STRANGER) // a stranger's click changes nothing
  click(allow, ALLOWED, { guild_id: '777' }) // nor does one from a server
  await new Promise((r) => setTimeout(r, 500))
  assert.ok(!posted().some((c) => /tool said/.test(c.content)), 'a stranger cannot approve')
  click(allow) // allow
  await waitFor(() => posted().some((c) => /tool said: from-the-shell/.test(c.content)), 'the tool result in the answer')
  const edit = await waitFor(() => rest.find((c) => c.method === 'PATCH' && c.content === '✅ Allowed'), 'the prompt is marked allowed')
  assert.deepEqual(edit.components, [], 'the buttons are removed once decided')
  assert.ok(rest.some((c) => /^\/interactions\/i\d+\/tok\d+\/callback$/.test(c.route) && c.type === 6), 'the click is acknowledged')

  // ---- deny
  dm('again')
  const ask2 = await waitFor(() => posted().filter((c) => /^Approve run_command\?/.test(c.content)).at(1), 'second prompt')
  click(ask2.components[0].components[1].custom_id) // deny
  await waitFor(() => posted().some((c) => /rejected/.test(c.content ?? '') && /tool said/.test(c.content ?? '')), 'the model saw the denial')
  assert.ok(deny.startsWith('ap|'))

  // ---- a late click on a settled prompt
  click(allow)
  await waitFor(() => rest.some((c) => /callback$/.test(c.route) && c.type === 4 && /no longer pending/.test(c.data?.content ?? '')), 'late click answered')

  // ---- stop while waiting for approval
  dm('and once more')
  await waitFor(() => posted().filter((c) => /^Approve run_command\?/.test(c.content)).length === 3, 'third prompt')
  dm('/stop')
  await waitFor(() => lastText() === '⏹ Stopped.', 'stopped')

  // ---- a dropped connection resumes the session instead of re-identifying
  mode = 'plain'
  const before = seen.identify
  conn.socket.destroy()
  await waitFor(() => seen.resume.length === 1, 'resume after the connection dropped', 12_000)
  assert.equal(seen.identify, before, 'no new identify')
  assert.equal(seen.resume[0].session_id, 'sess1')
  assert.equal(seen.resume[0].token, TOKEN)
  assert.ok(seen.resume[0].seq >= 1)
  dm('after the reconnect')
  await waitFor(() => lastText() === 'plain answer' && posted().length > 0, 'served after resume')
  assert.ok(seen.heartbeats >= 1, 'heartbeats are sent')

  // ---- /new makes a different session, and the map survives a restart
  dm('/new')
  await waitFor(() => lastText() === 'Started a new conversation.', 'new')
  dm('/status')
  await waitFor(() => /^session s-/.test(lastText()) && !lastText().includes(firstSession), 'status after /new')
  const secondSession = /session (s-[\w-]+)/.exec(lastText())[1]
  await host.ctx.sessions.flush()

  // ---- automation delivery opens a DM with an allow-listed user only
  await host.ctx.discord.send(ALLOWED, 'hello from an automation')
  assert.ok(rest.some((c) => c.route === '/users/@me/channels' && c.recipient_id === ALLOWED))
  assert.equal(lastText(), 'hello from an automation')
  assert.equal(posted().at(-1) && rest.at(-1).route, `/channels/dm-${ALLOWED}/messages`)
  await assert.rejects(host.ctx.discord.send(STRANGER, 'x'), /not on the Discord allow-list/)
  const item = await host.ctx.automations.create({ id: 'ping', name: 'ping', schedule: '0 9 * * *', prompt: 'say hi', deliver: { type: 'discord', userId: ALLOWED } })
  assert.deepEqual(item.deliver, { type: 'discord', userId: ALLOWED })
  await assert.rejects(host.ctx.automations.create({ id: 'bad', name: 'bad', schedule: '0 9 * * *', prompt: 'x', deliver: { type: 'discord', userId: 'nope' } }), /Discord user id/)
  await host.dispose()
  await new Promise((r) => setTimeout(r, 300))

  host = await createHost({ ...base, channels: { discord: channel }, approval: { mode: 'risky' } })
  await waitFor(() => seen.identify === before + 1, 'identify after a restart')
  dm('/status')
  await waitFor(() => lastText()?.includes(secondSession), 'the same session after a restart')
  assert.ok(!JSON.stringify(rest).includes(TOKEN), 'the token is never sent as message content')

  // ---- a fatal close (bad token) stops the channel for good
  const identifies = seen.identify
  conn.close(4004)
  await new Promise((r) => setTimeout(r, 2_500))
  assert.equal(seen.identify, identifies, 'no reconnect after an authentication failure')
  console.log('discord: OK')
} finally {
  await host.dispose()
  server.close()
  server.closeAllConnections?.()
  stub.close()
  stub.closeAllConnections?.()
  await rm(dir, { recursive: true, force: true })
}
