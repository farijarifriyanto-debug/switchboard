/**
 * End-to-end test for the web console API — boots a stub OpenAI-compatible
 * endpoint, then drives `POST /api/chat` over the real SSE transport and checks
 * that streaming deltas, tool calls and metrics survive the round trip.
 *
 *   node scripts/test-web.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
import { scheduleStateFile } from '../dist/ci/index.js'

/** Minimal chat-completions stub: asks for a tool once, then answers. */
function stubProvider() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [{ id: 'stub' }, { id: 'stub2', context_length: 4242 }, { id: 'stub3' }],
        }),
      )
      return
    }
    if (req.url === '/catalog.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: 1, models: [{ id: 'stub', context: 77777 }] }))
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    const sawTool = (body.messages ?? []).some((m) => m.role === 'tool')

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

    if (!sawTool) {
      send({ choices: [{ delta: { reasoning_content: 'I should look around. ' } }] })
      send({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'list_dir', arguments: '{"path":"."}' } },
              ],
            },
          },
        ],
      })
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
      send('data: [DONE]\n\n')
      res.end()
      return
    }

    send({ choices: [{ delta: { content: 'The workspace holds ' } }] })
    send({ choices: [{ delta: { content: 'a package.json.' } }] })
    send({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 9,
        total_tokens: 109,
        prompt_tokens_details: { cached_tokens: 64 },
      },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return server
}

/** Splits an SSE response body into `{ event, data }` frames. */
function readFrames(text) {
  return text
    .split('\n\n')
    .filter((frame) => frame.trim())
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)?.[1]
      const raw = /^data: (.+)$/m.exec(frame)?.[1] ?? '{}'
      return { event, data: JSON.parse(raw) }
    })
}

const provider = stubProvider()
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
const providerPort = provider.address().port

const host = await createHost({
  llm: {
    baseURL: `http://127.0.0.1:${providerPort}/v1`,
    defaultModel: 'stub',
    retries: 0,
    contextCatalogUrl: `http://127.0.0.1:${providerPort}/catalog.json`,
  },
  metrics: { persist: '', load: false },
  sessions: { dir: '', load: false },
  web: { enabled: true, port: 0 },
  ci: { enabled: true },
})

try {
  const { url, port } = await host.ctx.web.ready()
  assert.ok(port > 0, 'web should be listening')

  // Brand assets must work from the same static surface as the console.
  const mascot = await fetch(`${url}assets/bico-hero.png`)
  assert.equal(mascot.status, 200, 'welcome mascot is available')
  assert.equal(mascot.headers.get('content-type'), 'image/png')
  assert.deepEqual([...new Uint8Array(await mascot.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const mark = await fetch(`${url}assets/bico-mark.svg`)
  assert.equal(mark.status, 200, 'brand mark is available')
  assert.equal(mark.headers.get('content-type'), 'image/svg+xml')

  // Plain delta stream, no tools involved.
  const plain = await fetch(`${url}api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'list the workspace' }),
  })
  assert.equal(plain.status, 200)
  assert.match(plain.headers.get('content-type'), /text\/event-stream/)

  const frames = readFrames(await plain.text())
  const names = frames.map((f) => f.event)
  assert.equal(names[0], 'session', 'the first frame must name the session')
  assert.ok(names.includes('step'), 'steps should be reported')
  assert.ok(names.includes('reasoning'), 'reasoning should stream through')
  assert.ok(names.includes('tool_call'), 'the tool call should stream through')
  assert.ok(names.includes('tool_result'), 'the tool result should stream through')
  assert.ok(names.includes('metrics'), 'metrics should stream through')
  assert.ok(names.includes('final'), 'a final frame is required')
  assert.equal(names[names.length - 1], 'end', 'the stream must terminate with `end`')

  const sessionId = frames[0].data.sessionId
  assert.match(sessionId, /^s-/)

  const call = frames.find((f) => f.event === 'tool_call')
  assert.equal(call.data.name, 'list_dir')
  const result = frames.find((f) => f.event === 'tool_result')
  assert.match(result.data.result, /package\.json/, 'list_dir should see the repo')
  const final = frames.find((f) => f.event === 'final')
  assert.match(final.data.content, /package\.json/)

  // The final metrics frame carries usage (the tool-call turn has none).
  const metrics = frames.filter((f) => f.event === 'metrics').pop()
  assert.equal(metrics.data.metrics.usage.cachedTokens, 64, 'cached tokens must survive to the console')
  assert.equal(metrics.data.metrics.usage.promptTokens, 100)
  assert.ok(metrics.data.metrics.ttftMs >= 0)

  // The conversation was persisted with both calls and the tool result.
  const stored = await (await fetch(`${url}api/sessions/${sessionId}`)).json()
  const roles = stored.messages.map((m) => m.role)
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant'], 'stored transcript should be complete')
  assert.match(stored.messages[0].content, /Today is \w+, \d{4}-\d{2}-\d{2} \(/, 'the system prompt carries a fresh date line')

  // Continuing the same session keeps its history.
  const followUp = await fetch(`${url}api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'and the name?', sessionId }),
  })
  const followFrames = readFrames(await followUp.text())
  assert.equal(followFrames[0].data.sessionId, sessionId, 'a followed-up run reuses the session')

  const after = await (await fetch(`${url}api/sessions/${sessionId}`)).json()
  assert.equal(after.messages.filter((m) => m.role === 'user').length, 2)

  // Bad input is rejected before the stream opens.
  const bad = await fetch(`${url}api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '   ' }),
  })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error, 'prompt is required')
  assert.equal((await fetch(`${url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400)
  assert.equal((await fetch(`${url}api/chat`, { method: 'POST', body: '{}' })).status, 415, 'non-JSON POST is refused before parsing')

  // ------------------------------------------------- workspace/files/plugins
  const ws = await (await fetch(`${url}api/workspace`)).json()
  assert.equal(ws.root, path.resolve(''), 'workspace root defaults to the process cwd')
  assert.ok(Array.isArray(ws.recents))

  const filesRoot = await (await fetch(`${url}api/files`)).json()
  assert.equal(filesRoot.dir, '.')
  const rootNames = filesRoot.files.map((f) => f.name)
  assert.ok(rootNames.includes('package.json'), 'the file browser sees the repo')
  assert.ok(filesRoot.files.find((f) => f.name === 'src')?.type === 'dir')

  const filesSub = await (await fetch(`${url}api/files/src`)).json()
  assert.ok(filesSub.files.map((f) => f.name).includes('index.ts'), 'subdirectories resolve')

  // The browser URL parser collapses bare `..`, but a raw client can still send
  // percent-encoded separators — the server-side guard must refuse those.
  const filesEscape = await fetch(`${url}api/files/..%2f..%2fsecret`)
  assert.equal(filesEscape.status, 500, 'path traversal is refused')

  const plugins = await (await fetch(`${url}api/plugins`)).json()
  assert.ok(plugins.plugins.includes('web-ui'), 'loaded plugins are listed')
  assert.ok(plugins.tools.find((t) => t.name === 'read_file'), 'registry tools are listed')

  const badPlugin = await fetch(`${url}api/plugins`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: 'definitely-not-a-real-package-xyz' }),
  })
  assert.equal(badPlugin.status, 400, 'a broken plugin load reports an error')

  // ------------------------------------------------------------- approvals
  const approvals = await (await fetch(`${url}api/approvals`)).json()
  assert.equal(approvals.mode, 'risky', 'the gate defaults to risky')
  assert.deepEqual(approvals.pending, [])
  assert.deepEqual(approvals.recent, [])

  const badDecision = await fetch(`${url}api/approvals/ap-none`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approved' }),
  })
  assert.equal(badDecision.status, 404, 'unknown approval ids are a 404')

  const invalidDecision = await fetch(`${url}api/approvals/ap-none`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'maybe' }),
  })
  assert.equal(invalidDecision.status, 400)

  // ------------------------------------------------------------------- state
  const state = await (await fetch(`${url}api/state`)).json()
  assert.equal(state.workspace.root, path.resolve(''))
  assert.equal(state.approval.mode, 'risky')
  assert.deepEqual(state.mcp, { configured: false }, 'host without mcp config reports configured: false')
  assert.ok(state.plugins.includes('web-ui'))

  // Model context falls back to the configured catalog when upstream omits it.
  const byId = Object.fromEntries(state.models.map((m) => [m.id, m]))
  assert.equal(byId.stub?.context, 77777, 'catalog provides context when the endpoint omits it')
  assert.equal(byId.stub2?.context, 4242, 'an upstream context_length wins over the catalog')
  assert.equal(byId.stub3?.context, null, 'models absent from both sources stay null')

  // ------------------------------------------------------------------ ci api
  const wfDir = path.join(process.cwd(), '.switchboard', 'workflows')
  const ciFixture = path.join(wfDir, 'test-web-ci.yml')
  await mkdir(wfDir, { recursive: true })
  await writeFile(ciFixture, 'name: TestWebCI\njobs:\n  j:\n    steps:\n      - run: node -e "console.log(\'web-ci-marker\')"\n', 'utf8')
  let schedFixture = null
  let stateFile = null
  let stateBackup = null

  try {
    const state2 = await (await fetch(`${url}api/state`)).json()
    assert.equal(state2.ci?.enabled, true, 'state advertises ci enabled')

    const wfList = await (await fetch(`${url}api/ci/workflows`)).json()
    const mine = wfList.find((w) => w.id === 'test-web-ci')
    assert.ok(mine, 'workflow listed')
    assert.equal(mine.name, 'TestWebCI')
    assert.equal(mine.lastRun, null, 'no run yet')

    const started = await fetch(`${url}api/ci/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'test-web-ci' }),
    })
    assert.equal(started.status, 202, 'POST accepts and returns 202')
    const { id: runId } = await started.json()
    assert.match(runId, /^run-/, 'run id returned')

    const rejected = await fetch(`${url}api/ci/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'nope' }),
    })
    assert.equal(rejected.status, 400, 'unknown workflow rejected with 400')
    const rejectedBody = await rejected.json()
    assert.match(rejectedBody.error, /unknown workflow "nope"/, 'error names the missing workflow')
    assert.ok(rejectedBody.error.includes('test-web-ci'), 'error lists the available workflow ids')

    // a CORS-safelisted text/plain POST must never reach the runner: 415 forces
    // the preflight that a cross-origin page cannot satisfy
    const plainPost = await fetch(`${url}api/ci/runs`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ workflow: 'test-web-ci' }),
    })
    assert.equal(plainPost.status, 415, 'non-JSON content-type refused with 415')
    assert.match((await plainPost.json()).error, /content-type/, '415 explains the content-type requirement')

    const untypedPost = await fetch(`${url}api/ci/runs`, {
      method: 'POST',
      body: JSON.stringify({ workflow: 'test-web-ci' }),
    })
    assert.equal(untypedPost.status, 415, 'missing content-type refused with 415')

    let detail = null
    for (let i = 0; i < 60; i += 1) {
      const res = await fetch(`${url}api/ci/runs/${runId}`)
      if (res.ok) {
        detail = await res.json()
        if (detail.status !== 'running') break
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    assert.ok(detail, 'run record found')
    assert.equal(detail.status, 'success', `web run succeeded (got ${detail.status}: ${detail.error ?? ''})`)
    assert.match(detail.jobs[0].steps[0].log, /web-ci-marker/, 'step log stored')

    const runsPage = await (await fetch(`${url}api/ci/runs?limit=5`)).json()
    assert.ok(runsPage.runs.some((r) => r.id === runId), 'run appears in the list')
    assert.equal(runsPage.runs.find((r) => r.id === runId).jobs[0].steps[0].log, undefined, 'list omits step logs')
    assert.equal(typeof runsPage.total, 'number', 'envelope carries total')
    assert.equal(runsPage.limit, 5, 'envelope echoes limit')
    assert.equal(runsPage.offset, 0, 'envelope echoes offset')

    const filtered = await (await fetch(`${url}api/ci/runs?workflow=test-web-ci`)).json()
    assert.ok(filtered.total >= 1, 'workflow filter keeps the run')
    assert.ok(filtered.runs.every((r) => r.workflow === 'test-web-ci'), 'workflow filter is exact')
    const narrowed = await (await fetch(`${url}api/ci/runs?workflow=test-web-ci&status=failed`)).json()
    assert.equal(narrowed.total, 0, 'filters combine to narrow the result')
    const capped = await (await fetch(`${url}api/ci/runs?limit=500`)).json()
    assert.equal(capped.limit, 100, 'route caps limit at 100')

    assert.equal((await fetch(`${url}api/ci/runs/run-missing`)).status, 404, 'unknown run 404s')

    // ------------------------------------------------------------ scheduler
    // Slot: Jan 1 00:00 local, seed far in the past, fake now far in the
    // future — the plugin's real 30 s ticks during the suite are never due.
    stateFile = scheduleStateFile(process.cwd())
    stateBackup = await readFile(stateFile, 'utf8').catch(() => null)
    schedFixture = path.join(wfDir, 'test-web-sched.yml')
    await writeFile(
      schedFixture,
      'name: TestWebSched\non:\n  schedule: "0 0 1 1 *"\njobs:\n  j:\n    steps:\n      - run: node -e "console.log(\'sched-marker\')"\n',
      'utf8',
    )
    const seededLastFired = new Date(2026, 9, 1, 0, 0).toISOString()
    await mkdir(path.dirname(stateFile), { recursive: true })
    await writeFile(stateFile, JSON.stringify({ version: 1, workflows: { 'test-web-sched': { lastFired: seededLastFired } } }), 'utf8')

    const dueNow = new Date(2027, 0, 1, 0, 0, 15)
    const firstTick = await host.ctx.web.schedulerTick(dueNow)
    assert.deepEqual(firstTick.fired, ['test-web-sched'], 'scheduler fires a due workflow')
    assert.deepEqual(firstTick.skipped, [], 'nothing skipped on a clean tick')
    const secondTick = await host.ctx.web.schedulerTick(dueNow)
    assert.deepEqual(secondTick.fired, [], 'catch-up collapses: no duplicate fire in the same slot')

    const stateAfter = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(stateAfter.workflows['test-web-sched'].lastFired, dueNow.toISOString(), 'tick persisted lastFired = now')

    let schedRun = null
    for (let i = 0; i < 60 && !schedRun; i += 1) {
      const list = await (await fetch(`${url}api/ci/runs?workflow=test-web-sched`)).json()
      const first = list.runs[0]
      if (first && first.status !== 'running') schedRun = first
      if (!schedRun) await new Promise((r) => setTimeout(r, 250))
    }
    assert.ok(schedRun, 'scheduled run persisted')
    assert.equal(schedRun.status, 'success', `scheduled run succeeded (got ${schedRun.status})`)
    assert.equal(schedRun.trigger, 'schedule', 'run record carries trigger: schedule')
    // the list endpoint returns summaries (no logs) — fetch the detail record
    const schedDetail = await (await fetch(`${url}api/ci/runs/${schedRun.id}`)).json()
    assert.match(schedDetail.jobs[0].steps[0].log, /sched-marker/, 'scheduled run really executed')
  } finally {
    await rm(ciFixture, { force: true })
    if (schedFixture) await rm(schedFixture, { force: true })
    if (stateFile) {
      if (stateBackup === null) await rm(stateFile, { force: true })
      else await writeFile(stateFile, stateBackup, 'utf8')
    }
    const ciStore = await import('../dist/ci/index.js')
    const dir = ciStore.runsDir(process.cwd())
    for (const f of await readdir(dir).catch(() => [])) {
      const text = await readFile(path.join(dir, f), 'utf8').catch(() => '')
      if (/"workflow"\s*:\s*"(?:test-web-ci|test-web-sched)"/.test(text)) await rm(path.join(dir, f), { force: true })
    }
  }

  // Switching workspace over the API re-points the boundary (stateless after).
  const scratch = await mkdtemp(path.join(tmpdir(), 'sb-web-ws-'))
  await writeFile(path.join(scratch, 'marker.txt'), 'api-switched', 'utf8')
  const switched = await fetch(`${url}api/workspace`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: scratch }),
  })
  assert.equal(switched.status, 200)
  const switchedBody = await switched.json()
  assert.equal(switchedBody.root, path.resolve(scratch))
  const markerFiles = await (await fetch(`${url}api/files`)).json()
  assert.ok(markerFiles.files.map((f) => f.name).includes('marker.txt'), 'the file browser follows the switch')
  assert.equal(await host.ctx.tools.call('read_file', { path: 'marker.txt' }), 'api-switched')

  console.log('test-web: all checks passed')
} finally {
  await host.dispose()
  provider.close()
}

// ------------------------------------------------------- ci disabled by default
const host2 = await createHost({
  llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 },
  metrics: { persist: '', load: false },
  sessions: { dir: '', load: false },
  web: { enabled: true, port: 0 },
})
try {
  const { url: url2 } = await host2.ctx.web.ready()
  assert.equal((await fetch(`${url2}api/ci/workflows`)).status, 404, 'ci routes 404 when disabled')
  const state = await (await fetch(`${url2}api/state`)).json()
  assert.equal(state.ci?.enabled, false, 'state advertises ci disabled')
  const inertTick = await host2.ctx.web.schedulerTick(new Date(2027, 0, 1, 0, 0, 15))
  assert.deepEqual(inertTick, { fired: [], skipped: [] }, 'scheduler tick is inert when ci is disabled')
} finally {
  await host2.dispose()
}

// ------------------------------------------------------- mcp state in /api/state
const hostMcp = await createHost({
  llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 },
  metrics: { persist: '', load: false },
  sessions: { dir: '', load: false },
  web: { enabled: true, port: 0 },
  mcp: { servers: { probe: { transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' } } },
})
try {
  const { url: url3 } = await hostMcp.ctx.web.ready()
  const st = await (await fetch(`${url3}api/state`)).json()
  assert.equal(st.mcp?.configured, true, 'mcp configured host advertises configured: true')
  assert.ok(Array.isArray(st.mcp?.servers) || st.mcp?.servers === null, 'mcp servers is array or null (service state)')
  if (Array.isArray(st.mcp.servers)) {
    for (const s of st.mcp.servers) {
      assert.equal(typeof s.name, 'string', 'server name is a string')
      assert.equal(typeof s.state, 'string', 'server state is a string')
    }
  }
} finally {
  await hostMcp.dispose()
}

// ------------------------------------------- request fence on every /api route
const hostFence = await createHost({
  llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 },
  metrics: { persist: '', load: false },
  sessions: { dir: '', load: false },
  web: { enabled: true, port: 0 },
})
try {
  const { url: fenceUrl } = await hostFence.ctx.web.ready()
  const post = (route, headers, body = '{"path":"."}') => fetch(`${fenceUrl}api/tools/${route}`, { method: 'POST', headers, body })
  const plain = await post('list_dir', { 'content-type': 'text/plain' })
  assert.equal(plain.status, 415, 'text/plain POST (CORS-safelisted, no preflight) is refused on /api/tools')
  const plugins = await fetch(`${fenceUrl}api/plugins`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"src":"x"}' })
  assert.equal(plugins.status, 415, 'text/plain POST is refused on /api/plugins')
  const cross = await post('list_dir', { 'content-type': 'application/json', origin: 'http://evil.example' })
  assert.equal(cross.status, 403, 'cross-origin JSON POST is refused')
  const ok = await post('list_dir', { 'content-type': 'application/json' })
  assert.equal(ok.status, 200, 'same-origin JSON POST still works')
  // DNS rebinding: a foreign Host header must not reach the API on a loopback bind.
  const rebound = await new Promise((resolve, reject) => {
    const u = new URL(fenceUrl)
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/workspace', headers: { host: 'attacker.example' } }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(rebound, 403, 'foreign Host header is refused on a loopback bind')
} finally {
  await hostFence.dispose()
}
