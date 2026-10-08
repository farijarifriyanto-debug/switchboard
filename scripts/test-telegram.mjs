/**
 * Telegram channel against a fake Bot API: allow-list, private chats only,
 * tool approvals through inline buttons, commands, session persistence, and
 * the fail-closed start-up rules.
 *
 *   node scripts/test-telegram.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
import { splitMessage } from '../dist/channels/telegram.js'

// ---- pure helper
assert.deepEqual(splitMessage('short'), ['short'])
const long = `${'line one\n'.repeat(300)}end`
const parts = splitMessage(long, 1000)
assert.ok(parts.every((p) => p.length <= 1000) && parts.length > 2)
assert.equal(parts.join('\n').replace(/\n+/g, '\n'), long.replace(/\n+/g, '\n'), 'nothing is lost when splitting')
assert.equal(splitMessage('a'.repeat(5000), 2000).length, 3, 'unbreakable text is hard-cut')

const TOKEN = '123456:TEST-TOKEN'
const ALLOWED = 4242

// ---- fake Telegram
const calls = []
const queue = []
let waiter
let nextMessageId = 100
const tg = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const method = req.url.split('/').pop()
  assert.ok(req.url.startsWith(`/bot${TOKEN}/`), 'requests carry the token in the path')
  const reply = (result) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result }))
  }
  if (method === 'getUpdates') {
    const deliver = () => reply(queue.splice(0, queue.length))
    if (queue.length) return deliver()
    const timer = setTimeout(() => {
      waiter = undefined
      deliver()
    }, 250)
    waiter = () => {
      clearTimeout(timer)
      waiter = undefined
      deliver()
    }
    req.on('close', () => clearTimeout(timer))
    return
  }
  calls.push({ method, ...params })
  if (method === 'getMe') return reply({ username: 'testbot' })
  if (method === 'sendMessage') return reply({ message_id: ++nextMessageId })
  return reply(true)
})
await new Promise((r) => tg.listen(0, '127.0.0.1', r))
const apiBase = `http://127.0.0.1:${tg.address().port}`
let updateId = 1
const push = (update) => {
  queue.push({ update_id: updateId++, ...update })
  waiter?.()
}
const say = (text, from = ALLOWED, chat = { id: from, type: 'private' }) => push({ message: { message_id: updateId, text, from: { id: from }, chat } })
const tap = (data, from = ALLOWED, chatId = ALLOWED) => push({ callback_query: { id: `cb${updateId}`, from: { id: from }, data, message: { message_id: 1, chat: { id: chatId, type: 'private' } } } })
const waitFor = async (predicate, what, ms = 8_000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const hit = predicate()
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const sent = () => calls.filter((c) => c.method === 'sendMessage')
const lastText = () => sent().at(-1)?.text

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
  const toolMsg = lastMsg?.role === 'tool' ? lastMsg : undefined // only the result of THIS turn's call
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

const dir = await mkdtemp(path.join(tmpdir(), 'sbx-tg-'))
const base = {
  llm: { baseURL: `http://127.0.0.1:${stub.address().port}/v1`, defaultModel: 'stub', retries: 0 },
  metrics: { persist: '', load: false },
  sessions: { dir: path.join(dir, 'sessions') },
  settings: { dir },
}
const channel = { enabled: true, allowFrom: [ALLOWED], apiBase, pollSeconds: 1, dir }

// ---- fail-closed start-up
process.env.TELEGRAM_BOT_TOKEN = ''
await assert.rejects(createHost({ ...base, channels: { telegram: channel } }), /set TELEGRAM_BOT_TOKEN/)
process.env.TELEGRAM_BOT_TOKEN = TOKEN
await assert.rejects(createHost({ ...base, channels: { telegram: { ...channel, allowFrom: [] } } }), /allowFrom/)
await assert.rejects(createHost({ ...base, approval: { mode: 'off' }, channels: { telegram: channel } }), /approval.mode is "off"/)
await assert.rejects(createHost({ ...base, channels: { telegram: { ...channel, preset: 'nope' } } }), /unknown preset/)

let host = await createHost({ ...base, channels: { telegram: channel }, approval: { mode: 'risky', timeoutMs: 20_000 } })
try {
  await waitFor(() => calls.some((c) => c.method === 'getMe'), 'getMe')

  // ---- who is served
  say('hello', 999) // not on the list
  say('hello', ALLOWED, { id: -100, type: 'group' }) // right user, wrong chat type
  tap('ap|x|y', 999)
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(sent().length, 0, 'strangers and group chats get no reply')

  // ---- a normal turn
  say('hello')
  await waitFor(() => lastText() === 'plain answer', 'the answer')
  say('/status')
  await waitFor(() => /^session s-/.test(lastText() ?? '') && /approval risky/.test(lastText()), 'status')
  const firstSession = /session (s-[\w-]+)/.exec(lastText())[1]
  say('/preset reviewer')
  await waitFor(() => lastText() === 'Preset set to reviewer.', 'preset set')
  say('/preset nope')
  await waitFor(() => lastText() === 'No preset "nope".', 'preset rejected')
  say('/preset default')
  await waitFor(() => lastText() === 'Preset set to default.', 'preset cleared')

  // ---- tool approval through buttons
  mode = 'tool'
  say('please run it')
  const ask = await waitFor(() => sent().find((c) => /^Approve run_command\?/.test(c.text)), 'the approval prompt')
  assert.match(ask.text, /echo from-the-shell/)
  const buttons = ask.reply_markup.inline_keyboard[0].map((b) => b.callback_data)
  assert.equal(buttons.length, 3)
  tap(buttons[0], 999) // a stranger's tap changes nothing
  await new Promise((r) => setTimeout(r, 500))
  assert.ok(!sent().some((c) => /tool said/.test(c.text)), 'a stranger cannot approve')
  tap(buttons[0]) // allow
  await waitFor(() => sent().some((c) => /tool said: from-the-shell/.test(c.text)), 'the tool result in the answer')
  await waitFor(() => calls.some((c) => c.method === 'editMessageText' && c.text === '✅ Allowed'), 'the prompt is marked allowed')

  // ---- deny
  say('again')
  const ask2 = await waitFor(() => sent().filter((c) => /^Approve run_command\?/.test(c.text)).at(1), 'second prompt')
  tap(ask2.reply_markup.inline_keyboard[0][1].callback_data) // deny
  await waitFor(() => sent().some((c) => /rejected/.test(c.text ?? '') && /tool said/.test(c.text ?? '')), 'the model saw the denial')

  // ---- stop while waiting for approval
  say('and once more')
  await waitFor(() => sent().filter((c) => /^Approve run_command\?/.test(c.text)).length === 3, 'third prompt')
  say('/stop')
  await waitFor(() => lastText() === '⏹ Stopped.', 'stopped')

  // ---- /new makes a different session, and the map survives a restart
  mode = 'plain'
  say('/new')
  await waitFor(() => lastText() === 'Started a new conversation.', 'new')
  say('/status')
  await waitFor(() => /^session s-/.test(lastText()) && !lastText().includes(firstSession), 'status after /new')
  const secondSession = /session (s-[\w-]+)/.exec(lastText())[1]
  assert.notEqual(secondSession, firstSession)
  await host.ctx.sessions.flush()
  await host.dispose()
  await new Promise((r) => setTimeout(r, 300)) // let the map file land

  // a restart keeps the chat on the same conversation
  host = await createHost({ ...base, channels: { telegram: channel }, approval: { mode: 'risky' } })
  say('/status')
  await waitFor(() => lastText()?.includes(secondSession), 'the same session after a restart')
  assert.ok(!JSON.stringify(calls).includes(TOKEN), 'the token is never sent as message content')
  console.log('telegram: OK')
} finally {
  await host.dispose()
  tg.close()
  tg.closeAllConnections?.()
  stub.close()
  stub.closeAllConnections?.()
  await rm(dir, { recursive: true, force: true })
}
