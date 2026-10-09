import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { fork } from 'node:child_process'
import { createHost } from '../dist/index.js'
import { acquireRecoveryLock } from '../dist/services/recovery-lock.js'

const root = await mkdtemp(path.join(tmpdir(), 'sbx-review-'))
const requests = []
const server = http.createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'stub' }] })); return }
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  requests.push(JSON.parse(Buffer.concat(chunks).toString()))
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\ndata: [DONE]\n\n')
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const config = (dir, extra = {}) => ({ llm: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, defaultModel: 'stub', retries: 0 }, settings: { dir: '' }, metrics: { persist: '', load: false }, sessions: { dir, max: 1, autosave: false }, workspace: { root, remember: false }, approval: { mode: 'off' }, ...extra })
const wait = async fn => { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (await fn()) return; await new Promise(r => setTimeout(r, 15)) } throw new Error('wait timed out') }
const selected = process.argv[2]
const run = async (name, fn) => { if (!selected || selected === name) { await fn(); console.log(`${name}: OK`) } }
try {
  await run('wake', async () => {
    const host = await createHost(config(path.join(root, 'wake')))
    try {
      const ctx = host.ctx, parent = ctx.sessions.create({ title: 'Parent' }), checkpoint = ctx.sessions.checkpoint.bind(ctx.sessions)
      let failed = false
      ctx.sessions.checkpoint = async id => { if (id === parent.id && parent.background?.wakeRunning && !failed) { failed = true; throw new Error('transient disk error') } return checkpoint(id) }
      const before = requests.length
      await ctx.tools.call('task', { tasks: [{ description: 'worker' }], background: true }, { sessionId: parent.id })
      await wait(() => failed); await new Promise(r => setTimeout(r, 40))
      assert.equal(ctx.subagent.state(parent.id).waking, false, 'failed pre-wake checkpoint releases wake token')
      assert.equal(parent.background.wakePending, true, 'wake remains retryable after failed checkpoint')
      await ctx.subagent.flush(parent.id)
      assert.equal(requests.length - before, 2, 'one worker and one successful parent wake')
      assert.equal(parent.messages.filter(m => m.content.startsWith('[job ')).length, 1, 'retry does not duplicate delivery')
    } finally { await host.dispose() }
  })
  await run('lock', async () => {
    const dir = path.join(root, 'lock'); await mkdir(dir)
    const child = fork(new URL('../test/fixtures/recovery-claim.mjs', import.meta.url), [dir], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    await once(child, 'message')
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    const releases = await Promise.all(Array.from({ length: 12 }, () => acquireRecoveryLock(dir)))
    assert.equal(releases.filter(Boolean).length, 1, 'dead reclamation guard is recoverable with one exclusive winner')
    await releases.find(Boolean)()
    const release = await acquireRecoveryLock(dir); assert.ok(release); await release()
  })
  await run('memory', async () => {
    const globalFile = path.join(root, 'GLOBAL.md'); await writeFile(globalFile, '# Memory\n- PRIVATE_GLOBAL_SENTINEL\n')
    await mkdir(path.join(root, '.switchboard')); await writeFile(path.join(root, '.switchboard', 'MEMORY.md'), '# Memory\n- PRIVATE_PROJECT_SENTINEL\n')
    const host = await createHost(config(path.join(root, 'memory'), { memory: { globalFile } }))
    try {
      for (const preset of ['reviewer', 'researcher']) {
        for await (const _ of host.ctx.agent.stream('hello', undefined, { preset })) {}
        assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /PRIVATE_(GLOBAL|PROJECT)_SENTINEL/, `${preset} receives no notebook projection`)
      }
      for await (const _ of host.ctx.agent.stream('hello')) {}
      assert.match(JSON.stringify(requests.at(-1).messages), /PRIVATE_GLOBAL_SENTINEL/, 'default retains notebook projection')
    } finally { await host.dispose() }
  })
  await run('budget', async () => {
    for (const [kind, limits] of Object.entries({ tokens: { maxTokens: 10 }, workers: { maxWorkers: 1 }, cost: { maxCostUsd: 0.00001 } })) {
      const dir = path.join(root, 'budget-' + kind); await mkdir(dir)
      const now = Date.now(), base = { title: 'old', createdAt: now, updatedAt: now - 1000, messages: [], status: 'idle', model: 'stub' }
      const parent = { ...base, id: 's-parent', background: { version: 1, jobs: [{ jobId: 'j-one', sessionId: 's-queued', parentSessionId: 's-parent', description: 'queued', status: 'queued', task: { description: 'queued' } }] } }
      const old = { ...base, id: 's-old', kind: 'subagent', parentSessionId: parent.id, usage: { byModel: { stub: { calls: 1, promptTokens: 100, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 } } } }
      const queued = { ...base, id: 's-queued', kind: 'subagent', parentSessionId: parent.id, jobId: 'j-one' }
      const newest = { ...base, id: 's-newest', updatedAt: now + 1000 }
      await Promise.all([parent, old, queued, newest].map(s => writeFile(path.join(dir, s.id + '.json'), JSON.stringify(s))))
      const before = requests.length
      const host = await createHost(config(dir, { web: { enabled: true, port: 0 }, subagent: { autoResume: false, ...limits }, usage: { pricing: { stub: { input: 1, output: 1 } } } }))
      try {
        await wait(() => host.ctx.subagent.jobs().some(j => ['failed', 'done'].includes(j.status)))
        assert.equal(requests.length, before, `${kind} budget includes old foreground children outside hydration cap`)
        assert.equal(host.ctx.subagent.jobs()[0].status, 'failed')
      } finally { await host.dispose() }
    }
  })
  await run('batch', async () => {
    const dir = path.join(root, 'batch'), copy = path.join(root, 'restart'); await mkdir(copy)
    const host = await createHost(config(dir))
    try {
      const parent = host.ctx.sessions.create({ title: 'Parent' }), checkpoint = host.ctx.sessions.checkpoint.bind(host.ctx.sessions)
      host.ctx.sessions.checkpoint = async id => { if (id === parent.id && parent.background?.jobs.length === 2) throw new Error('disk full'); return checkpoint(id) }
      const before = requests.length
      const result = await host.ctx.tools.call('task', { tasks: [{ description: 'first' }, { description: 'second' }], background: true }, { sessionId: parent.id })
      assert.match(result, /^Error:/)
      const saved = await readFile(path.join(dir, parent.id + '.json'), 'utf8').catch(() => undefined)
      assert.equal(saved ? JSON.parse(saved).background?.jobs.filter(j => j.status === 'queued').length ?? 0 : 0, 0, 'rejected batch publishes no durable queued jobs')
      if (saved) await copyFile(path.join(dir, parent.id + '.json'), path.join(copy, parent.id + '.json'))
      for (const child of host.ctx.sessions.list().filter(s => s.parentSessionId === parent.id)) await copyFile(path.join(dir, child.id + '.json'), path.join(copy, child.id + '.json'))
      const restarted = await createHost(config(copy, { web: { enabled: true, port: 0 }, subagent: { autoResume: false } }))
      try { await new Promise(r => setTimeout(r, 60)); assert.equal(requests.length, before, 'rejected batch never executes after restart') } finally { await restarted.dispose() }
    } finally { host.ctx.sessions.checkpoint = Object.getPrototypeOf(host.ctx.sessions).checkpoint.bind(host.ctx.sessions); await host.dispose() }
  })
} finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }) }
