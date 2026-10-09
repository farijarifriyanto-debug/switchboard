import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createHost } from '../dist/index.js'

const root = await fs.mkdtemp(path.join(tmpdir(), 'sbx-channel-ready-'))
const originalRead = fs.readFile
const prompts = []
const api = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c)
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  res.setHeader('content-type', 'application/json')
  if (req.url.endsWith('/getUpdates')) return // aborted at host disposal
  if (req.url.endsWith('/gateway/bot')) { res.writeHead(401); res.end('{}'); return }
  if (req.url.endsWith('/sendMessage') || /\/channels\/\d+\/messages$/.test(req.url) && req.method === 'POST') prompts.push({ url: req.url, body })
  res.end(JSON.stringify(req.url.startsWith('/bot') ? { ok: true, result: { message_id: 1, username: 'fixture' } } : { id: '1' }))
})
api.listen(0, '127.0.0.1'); await once(api, 'listening')
const apiBase = `http://127.0.0.1:${api.address().port}`
const wait = async fn => { const end = Date.now() + 4000; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 10)) } throw new Error('wait timed out') }
try {
  for (const channel of ['telegram', ...(globalThis.WebSocket ? ['discord'] : [])]) {
    const dir = path.join(root, channel), sessions = path.join(dir, 'sessions'); await fs.mkdir(sessions, { recursive: true })
    const mapFile = path.join(dir, channel === 'telegram' ? 'channels.json' : 'channels-discord.json')
    const now = Date.now()
    await fs.writeFile(path.join(sessions, 's-parent.json'), JSON.stringify({ id: 's-parent', title: 'Parent', createdAt: now, updatedAt: now, status: 'idle', messages: [] }))
    await fs.writeFile(mapFile, JSON.stringify({ version: 1, [channel]: { '424242': 's-parent' } }))
    let release, entered, resolved = false
    const blocked = new Promise(r => { release = r }), reading = new Promise(r => { entered = r })
    fs.readFile = async (file, ...args) => { if (file === mapFile) { entered(); await blocked } return originalRead(file, ...args) }
    syncBuiltinESMExports()
    process.env.SBX_READY_FIXTURE_TOKEN = '123456:LOCAL'
    const boot = createHost({ llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 }, settings: { dir: '' }, metrics: { persist: '', load: false }, sessions: { dir: sessions }, approval: { mode: 'risky', timeoutMs: 2000 }, channels: { [channel]: { enabled: true, dir, apiBase, tokenEnv: 'SBX_READY_FIXTURE_TOKEN', allowFrom: ['424242'] } } }).then(host => { resolved = true; return host })
    let host
    try {
      await reading; await new Promise(r => setTimeout(r, 60))
      assert.equal(resolved, false, `${channel} host waits for chat-map restoration before recovery`)
      release(); host = await boot
      const child = host.ctx.sessions.create({ kind: 'subagent', parentSessionId: 's-parent' })
      const before = prompts.length, decision = host.ctx.approvals.request('write_file', { path: 'file', content: 'text' }, child.id)
      await wait(() => prompts.length > before)
      assert.equal(prompts.length - before, 1, `${channel} worker gets exactly one approval prompt after restore`)
      host.ctx.approvals.decide(host.ctx.approvals.pending()[0].id, 'rejected'); await decision
      console.log(`channel-ready: ${channel} OK`)
    } finally {
      release(); host ??= await boot; await host.dispose()
      fs.readFile = originalRead; syncBuiltinESMExports()
    }
  }
} finally {
  fs.readFile = originalRead; syncBuiltinESMExports(); delete process.env.SBX_READY_FIXTURE_TOKEN
  api.closeAllConnections(); await new Promise(r => api.close(r)); await fs.rm(root, { recursive: true, force: true })
}
