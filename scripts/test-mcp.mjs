/**
 * MCP client bridge tests.
 *
 *   node scripts/test-mcp.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { childEnv, interpolateMcp, validateMcpServers } from '../dist/config.js'
import { createHost, mcpBridge } from '../dist/index.js'

const section = (name) => console.log(`- ${name}`)
const dir = await mkdtemp(path.join(tmpdir(), 'sbx-mcp-'))

const FIXTURE = fileURLToPath(new URL('../test/fixtures/fake-mcp.mjs', import.meta.url))
const FIXTURE_INSTRUCTIONS = 'Fixture server for Switchboard MCP tests.'

const waitFor = async (fn, ms, label) => {
  const t0 = Date.now()
  for (;;) {
    const value = await fn().catch(() => undefined)
    if (value) return value
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${label}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

function startStubLlm() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'stub' }] }))
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok.' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

const stubLlm = await startStubLlm()
const hosts = []
const boot = async (config) => {
  const host = await createHost({
    llm: { baseURL: stubLlm.url, defaultModel: 'stub', retries: 0 },
    metrics: { persist: '', load: false },
    sessions: { dir: '', load: false },
    approval: { mode: 'off' },
    ...config,
  })
  hosts.push(host)
  return host
}
const fakeServers = (extra = {}) => ({ fake: { command: process.execPath, args: [FIXTURE], ...extra } })
const mcpServers = (servers) => ({ mcp: { servers } })
const fakeServer = (extra = {}) => mcpServers(fakeServers(extra))

try {
  section('validate: bad server name throws with the key')
  assert.throws(
    () => validateMcpServers({ servers: { 'bad name!': { command: 'x' } } }, () => {}),
    /invalid server name "bad name!"/,
  )

  section('validate: mixed transport fields throw')
  assert.throws(
    () => validateMcpServers({ servers: { a: { command: 'x', url: 'http://127.0.0.1:1/mcp' } } }, () => {}),
    /"url"\/"headers" are only valid with transport "streamable-http"/,
  )
  assert.throws(
    () => validateMcpServers({ servers: { a: { transport: 'streamable-http', url: 'http://x/mcp', command: 'x' } } }, () => {}),
    /"command"\/"args"\/"env"\/"cwd" are only valid with transport "stdio"/,
  )

  section('validate: missing required fields throw')
  assert.throws(() => validateMcpServers({ servers: { a: {} } }, () => {}), /requires "command"/)
  assert.throws(
    () => validateMcpServers({ servers: { a: { transport: 'streamable-http' } } }, () => {}),
    /requires "url"/,
  )
  assert.throws(
    () => validateMcpServers({ servers: { a: { transport: 'ssh', command: 'x' } } }, () => {}),
    /unknown transport "ssh"/,
  )

  section('validate: unknown fields warn instead of failing')
  const warns = []
  const outWarn = validateMcpServers({ servers: { a: { command: 'x', banana: 1 } } }, (m) => warns.push(m))
  assert.ok(outWarn.a, 'server a must still resolve')
  assert.ok(warns.some((m) => m.includes('unknown field "banana"')), `warns: ${warns.join(' | ')}`)

  section('validate: defaults mirror DSH')
  const out = validateMcpServers({ servers: { a: { command: 'x' } } }, () => {})
  assert.equal(out.a.transport, 'stdio')
  assert.deepEqual(out.a.args, [])
  assert.equal(out.a.toolCallTimeoutMs, 60000)
  assert.equal(out.a.maxInstructionBytes, 32768)
  assert.equal(out.a.failOnStartupError, false)
  assert.deepEqual(out.a.reconnect, { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 })

  section('validate: type errors are rejected with the server key')
  assert.throws(
    () => validateMcpServers({ servers: { a: { command: 'x', toolCallTimeoutMs: -5 } } }, () => {}),
    /mcp: a: "toolCallTimeoutMs" must be a positive number/,
  )
  assert.throws(
    () => validateMcpServers({ servers: { a: { command: 'x', args: [1] } } }, () => {}),
    /"args" must be an array of strings/,
  )

  section('validate: ${VAR} interpolation, missing resolves empty + warns')
  process.env.SBX_TEST_HOME = 'C:/tmp/home'
  delete process.env.SBX_TEST_MISSING_VAR
  const interp = validateMcpServers(
    { servers: { a: { command: 'x', env: { P: '${SBX_TEST_HOME}/mem.json', Q: 'gone-${SBX_TEST_MISSING_VAR}' } } } },
    (m) => warns.push(m),
  )
  assert.equal(interp.a.env.P, 'C:/tmp/home/mem.json')
  assert.equal(interp.a.env.Q, 'gone-')
  assert.ok(warns.some((m) => m.includes('unresolved ${SBX_TEST_MISSING_VAR} in env.Q')), `warns: ${warns.join(' | ')}`)
  delete process.env.SBX_TEST_HOME

  section('validate: headers interpolation for streamable-http')
  const interpHttp = validateMcpServers(
    { servers: { h: { transport: 'streamable-http', url: 'http://x/mcp', headers: { Authorization: 'Bearer ${SBX_TEST_TOKEN}' } } } },
    () => {},
  )
  delete process.env.SBX_TEST_TOKEN
  assert.equal(interpHttp.h.headers.Authorization, 'Bearer ')

  section('validate: empty / absent mcp is inert')
  assert.deepEqual(validateMcpServers(undefined, () => {}), {})
  assert.deepEqual(validateMcpServers({}, () => {}), {})
  assert.deepEqual(validateMcpServers({ servers: {} }, () => {}), {})

  section('childEnv: scrubs BOTCONNECTOR_* and KEY-like ambient names, config wins')
  const env = childEnv(
    { SBX_KEEP: 'from-config' },
    { PATH: 'p', BOTCONNECTOR_API_KEY: 'leak', SOME_SECRET_KEY: 'leak2', SBX_KEEP: 'ambient', SBX_PLAIN: 'v', GONE: undefined },
  )
  assert.equal(env.PATH, 'p')
  assert.equal(env.SBX_PLAIN, 'v')
  assert.equal(env.SBX_KEEP, 'from-config')
  assert.ok(!('BOTCONNECTOR_API_KEY' in env), 'BOTCONNECTOR_* must not reach children')
  assert.ok(!('SOME_SECRET_KEY' in env), 'KEY-matching names must not reach children')
  assert.ok(!('GONE' in env), 'undefined ambient values are dropped')

  section('interpolateMcp reports every missing name')
  const r = interpolateMcp('${A}-${B}-${A}', { A: '1' })
  assert.equal(r.value, '1--1')
  assert.deepEqual(r.missing, ['B'])

  const { mcpToolName, planMcpGeneration } = await import('../dist/mcp/naming.js')

  section('naming: clean names pass through unchanged')
  assert.equal(mcpToolName('srv', 'echo'), 'mcp__srv__echo')

  section('naming: replacement appends -<12hex> hash of (server, raw)')
  const replaced = mcpToolName('srv', 'my tool!')
  assert.match(replaced, /^mcp__srv__my_tool_-[0-9a-f]{12}$/)
  assert.equal(replaced, mcpToolName('srv', 'my tool!'), 'must be deterministic')

  section('naming: distinct raws never collapse after normalization')
  assert.notEqual(mcpToolName('srv', 'a b'), mcpToolName('srv', 'a-b'))

  section('naming: truncation stays within 64 chars and keeps the hash')
  const long = mcpToolName('srv', 'x'.repeat(100))
  assert.ok(long.length <= 64, `length ${long.length}`)
  assert.match(long, /^mcp__srv__x+-[0-9a-f]{12}$/)

  section('naming: cross-server coexistence')
  assert.equal(mcpToolName('a', 'search'), 'mcp__a__search')
  assert.equal(mcpToolName('b', 'search'), 'mcp__b__search')

  section('naming: invalid inputs throw')
  assert.throws(() => mcpToolName('bad name', 'x'), /invalid server name/)
  assert.throws(() => mcpToolName('srv', ''), /invalid tool name/)

  section('generation: duplicate raw tool invalidates the whole list')
  const dup = planMcpGeneration('s', ['echo', 'echo'])
  assert.ok('invalid' in dup && /duplicate tool "echo"/.test(dup.invalid), JSON.stringify(dup))

  section('generation: empty raw name invalidates the list')
  assert.ok('invalid' in planMcpGeneration('s', ['ok', '']))

  section('generation: happy path maps 1:1 in order')
  const plan = planMcpGeneration('s', ['echo', 'my tool'])
  assert.ok(!('invalid' in plan), JSON.stringify(plan))
  assert.equal(plan.names[0], 'mcp__s__echo')
  assert.match(plan.names[1], /^mcp__s__my_tool-[0-9a-f]{12}$/)

  const { renderMcpResult } = await import('../dist/mcp/render.js')
  const { MCP_INSTRUCTIONS_HEADING, withMcpInstructions } = await import('../dist/plugins/agent.js')

  section('render: text blocks join in order')
  assert.equal(renderMcpResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')

  section('render: resource links become <name> (<uri>)')
  assert.equal(
    renderMcpResult({ content: [{ type: 'resource_link', name: 'doc', uri: 'file:///x.md' }] }),
    'doc (file:///x.md)',
  )

  section('render: images/audio degrade to bounded diagnostics')
  const image = renderMcpResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(40000) }] })
  assert.match(image, /^\[image: image\/png, \d+ KB omitted — attachment bridge deferred\]$/)
  assert.ok(image.length < 200, 'diagnostic must be bounded')
  assert.match(renderMcpResult({ content: [{ type: 'audio', mimeType: 'audio/wav' }] }), /^\[audio omitted — attachment bridge deferred\]$/)

  section('render: structuredContent goes to the log only')
  const logged = []
  const rendered = renderMcpResult(
    { content: [{ type: 'text', text: 'visible' }], structuredContent: { secret: 'ignored-by-model' } },
    (m) => logged.push(m),
  )
  assert.equal(rendered, 'visible')
  assert.equal(logged.length, 1)
  assert.match(logged[0], /structuredContent/)

  section('render: empty content says so')
  assert.equal(renderMcpResult({ content: [] }), '(empty result)')

  section('instructions helper: appends, replaces and removes the section')
  const base = 'You are Switchboard.'
  const one = withMcpInstructions(base, '### fake\nrules one')
  assert.ok(one.includes(`\n${MCP_INSTRUCTIONS_HEADING}\n### fake\nrules one`))
  const two = withMcpInstructions(one, '### fake\nrules two')
  assert.ok(two.includes('rules two') && !two.includes('rules one'), 'old section must be replaced')
  assert.equal(two.split(MCP_INSTRUCTIONS_HEADING).length, 2, 'heading must appear exactly once')
  assert.equal(withMcpInstructions(two, ''), base, 'empty section restores the base')

  section('approval: MCP tools are gated in risky mode unless readOnlyHint is set')
  {
    const gated = await boot({ ...fakeServer(), approval: { mode: 'risky', timeoutMs: 200 } })
    await gated.ctx.mcp.ready()
    assert.equal(gated.ctx.tools.get('mcp__fake__echo')?.risk, 'risky', 'a tool without readOnlyHint is risky')
    assert.equal(gated.ctx.tools.get('mcp__fake__pid')?.risk, undefined, 'readOnlyHint skips the gate')
    assert.match(await gated.ctx.tools.call('mcp__fake__echo', { text: 'hi' }, { sessionId: 's' }), /approval timed out/, 'risky MCP tool waits for an operator')
    assert.doesNotMatch(await gated.ctx.tools.call('mcp__fake__pid', {}, { sessionId: 's' }), /approval/, 'read-only MCP tool runs')
  }

  section('events: mcp/* are wired on the host context')
  const eventHost = await createHost({ metrics: { persist: '', load: false }, sessions: { dir: '', load: false }, approval: { mode: 'off' } })
  try {
    const seen = []
    eventHost.ctx.on('mcp/tool:call', (p) => seen.push(['tool', p]))
    eventHost.ctx.on('mcp/server:up', (p) => seen.push(['up', p]))
    eventHost.ctx.on('mcp/server:down', (p) => seen.push(['down', p]))
    eventHost.ctx.emit('mcp/server:up', { server: 'x' })
    eventHost.ctx.emit('mcp/tool:call', { server: 'x', tool: 't', ms: 5, ok: true })
    eventHost.ctx.emit('mcp/server:down', { server: 'x', reason: 'r' })
    assert.deepEqual(seen, [
      ['up', { server: 'x' }],
      ['tool', { server: 'x', tool: 't', ms: 5, ok: true }],
      ['down', { server: 'x', reason: 'r' }],
    ])
  } finally {
    await eventHost.dispose()
  }

  section('boot: tools registered before the first turn, status up')
  {
    const host = await boot(fakeServer())
    const mcp = host.ctx.mcp
    assert.ok(mcp, 'ctx.mcp must be provided')
    assert.equal(mcp.status()[0].state, 'up')
    assert.equal(mcp.status()[0].tools.length, 9)
    assert.ok(host.ctx.tools.get('mcp__fake__echo'), 'echo must be registered')
    assert.ok(host.ctx.tools.defs().some((d) => d.function.name === 'mcp__fake__echo'))
    assert.equal(mcp.origin('mcp__fake__echo'), 'mcp:fake')
    assert.equal(mcp.origin('run_command'), undefined)
    await mcp.ready()
  }

  section('call: OK result + mcp/tool:call event')
  {
    const host = await boot(fakeServer())
    const seen = []
    host.ctx.on('mcp/tool:call', (p) => seen.push(p))
    const out = await host.ctx.tools.call('mcp__fake__echo', { text: 'hi' })
    assert.equal(out, 'echo:hi')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].server, 'fake')
    assert.equal(seen[0].tool, 'echo')
    assert.equal(seen[0].ok, true)
    assert.equal(typeof seen[0].ms, 'number')
  }

  section('call: MCP isError surfaces as a visible Error result')
  {
    const host = await boot(fakeServer())
    const out = await host.ctx.tools.call('mcp__fake__failing', {})
    assert.match(out, /^Error:/)
    assert.match(out, /fixture failure/)
  }

  section('call: timeout is bounded by toolCallTimeoutMs')
  {
    const host = await boot(fakeServer({ toolCallTimeoutMs: 100 }))
    const out = await host.ctx.tools.call('mcp__fake__slow', { ms: 900 })
    assert.match(out, /^Error:/)
    assert.match(out, /timed out|timeout/i, out)
  }

  section('call: caller AbortSignal cancels')
  {
    const host = await boot(fakeServer())
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    const out = await host.ctx.tools.call('mcp__fake__slow', { ms: 900 }, { signal: ac.signal })
    assert.match(out, /^Error:/)
  }

  section('outage: generation stays registered, calls fail visibly')
  {
    const host = await boot(fakeServer())
    await host.ctx.tools.call('mcp__fake__shutdown', {})
    await waitFor(async () => (await host.ctx.mcp.status())[0].state === 'down', 3000, 'server down')
    assert.ok(host.ctx.tools.get('mcp__fake__echo'), 'tools must stay registered while down')
    const out = await host.ctx.tools.call('mcp__fake__echo', { text: 'x' })
    assert.match(out, /MCP server 'fake' is down/)
  }

  section('fail-open: unreachable command leaves the host up')
  {
    const host = await boot(mcpServers({ ghost: { command: 'sbx-no-such-binary-xyz' } }))
    const s = host.ctx.mcp.status()[0]
    assert.equal(s.name, 'ghost')
    assert.equal(s.state, 'down')
    assert.ok(s.lastError, 'lastError must be recorded')
    assert.equal(host.ctx.tools.list().filter((t) => t.name.startsWith('mcp__')).length, 0)
  }

  section('failOnStartupError: boot rejects, naming the server')
  {
    await assert.rejects(
      boot(mcpServers({ ghost: { command: 'sbx-no-such-binary-xyz', failOnStartupError: true } })),
      /mcp server 'ghost'/,
    )
  }

  section('instructions: injected into the system prompt per turn')
  {
    const host = await boot(fakeServer())
    const text = await host.ctx.agent.run('hi')
    assert.ok(typeof text === 'string')
    const session = host.ctx.sessions.list().at(-1)
    const system = session.messages.find((m) => m.role === 'system')
    assert.ok(system, 'system message must exist')
    assert.ok(system.content.includes('## MCP servers'), 'MCP heading missing')
    assert.ok(system.content.includes('### fake'), 'server label missing')
    assert.ok(system.content.includes(FIXTURE_INSTRUCTIONS), 'instructions missing')
  }

  section('env: scrubbed child env + config override reach the server')
  {
    // Inject secret-looking ambient vars so the scrub assertion is never
    // vacuous (the suite process may or may not carry a real API key).
    const prevKey = process.env.BOTCONNECTOR_API_KEY
    const prevSecret = process.env.SOME_SECRET_KEY
    process.env.BOTCONNECTOR_API_KEY = 'leak-canary'
    process.env.SOME_SECRET_KEY = 'leak-canary'
    try {
      const host = await boot(fakeServer({ env: { SBX_MCP_OVERRIDE: 'from-config' } }))
      const out = await host.ctx.tools.call('mcp__fake__env', {})
      const facts = JSON.parse(out)
      assert.equal(facts.hasBotconnectorKey, false, 'BOTCONNECTOR_* must be scrubbed')
      assert.equal(facts.hasSecret, false, 'KEY-like names must be scrubbed')
      assert.equal(facts.override, 'from-config')
      assert.equal(facts.hasHome, true, 'harmless ambient vars are inherited')
    } finally {
      if (prevKey === undefined) delete process.env.BOTCONNECTOR_API_KEY
      else process.env.BOTCONNECTOR_API_KEY = prevKey
      if (prevSecret === undefined) delete process.env.SOME_SECRET_KEY
      else process.env.SOME_SECRET_KEY = prevSecret
    }
  }

  section('instructions: oversized block rejects the connection (fail-open)')
  {
    const host = await boot(fakeServer({ env: { SBX_MCP_INSTRUCTIONS: 'Y'.repeat(300) }, maxInstructionBytes: 100 }))
    const s = host.ctx.mcp.status()[0]
    assert.equal(s.state, 'down')
    assert.match(s.lastError ?? '', /maxInstructionBytes/)
    assert.equal(s.tools.length, 0)
    assert.equal(host.ctx.mcp.instructions(), '')
  }

  section('atomicity: registry conflict rejects the whole generation')
  {
    const host = await boot({}) // no mcp block
    const disposeLocal = host.ctx.tools.register({
      name: 'mcp__fake__echo',
      description: 'local impostor',
      parameters: { type: 'object', properties: {} },
      execute: () => 'local',
    })
    try {
      await host.ctx.plugin(mcpBridge, { servers: fakeServers() })
      const s = host.ctx.mcp.status()[0]
      assert.equal(s.state, 'down', 'failed sync must follow the failure path')
      assert.match(s.lastError ?? '', /registration conflict/)
      assert.equal(s.tools.length, 0, 'no partial generation may register')
      assert.equal(await host.ctx.tools.call('mcp__fake__echo', {}), 'local', 'previous occupant must win')
    } finally {
      disposeLocal()
    }
  }

  section('reconnect: crash respawns a fresh child and recovers')
  {
    const host = await boot(fakeServer({ reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 200, maxAttempts: 5 } }))
    const downs = []
    const ups = []
    host.ctx.on('mcp/server:down', (p) => downs.push(p))
    host.ctx.on('mcp/server:up', (p) => ups.push(p))
    const pid1 = Number(await host.ctx.tools.call('mcp__fake__pid', {}))
    assert.ok(pid1 > 0)
    await host.ctx.tools.call('mcp__fake__shutdown', {})
    await waitFor(async () => (await host.ctx.mcp.status())[0].state === 'up', 5000, 'reconnected')
    const pid2 = Number(await host.ctx.tools.call('mcp__fake__pid', {}))
    assert.notEqual(pid2, pid1, 'a fresh child must have been spawned')
    // Initial 'up' fires inside createHost (before listeners attach), so the
    // only observable up is the post-crash respawn.
    assert.ok(downs.length >= 1 && ups.length >= 1, `downs=${downs.length} ups=${ups.length}`)
    assert.equal(await host.ctx.tools.call('mcp__fake__echo', { text: 'back' }), 'echo:back')
  }

  section('budget: 10-style exhaustion unregisters tools and stops reconnecting')
  {
    const flag = path.join(dir, 'crash.flag')
    const host = await boot(
      fakeServer({
        env: { SBX_MCP_CRASH_FILE: flag },
        reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 100, maxAttempts: 3 },
      }),
    )
    assert.equal((await host.ctx.mcp.status())[0].state, 'up')
    await writeFile(flag, 'x', 'utf8')
    await host.ctx.tools.call('mcp__fake__shutdown', {})
    await waitFor(async () => (await host.ctx.mcp.status())[0].state === 'exhausted', 8000, 'exhausted')
    const s = (await host.ctx.mcp.status())[0]
    assert.equal(s.attempts, 3)
    assert.equal(s.tools.length, 0, 'generation must be unregistered')
    assert.equal(host.ctx.tools.get('mcp__fake__echo'), undefined)
    const out = await host.ctx.tools.call('mcp__fake__echo', { text: 'x' })
    assert.match(out, /unknown tool/)
    const attempts = s.attempts
    await new Promise((r) => setTimeout(r, 300))
    assert.equal((await host.ctx.mcp.status())[0].attempts, attempts, 'no further attempts after exhaustion')
  }

  section('reconnect disabled: tools stay listed, calls fail, no retries')
  {
    const host = await boot(fakeServer({ reconnect: { enabled: false } }))
    await host.ctx.tools.call('mcp__fake__shutdown', {})
    await waitFor(async () => (await host.ctx.mcp.status())[0].state === 'down', 3000, 'down')
    await new Promise((r) => setTimeout(r, 300))
    const s = (await host.ctx.mcp.status())[0]
    assert.equal(s.state, 'down')
    assert.equal(s.attempts, 0, 'disabled reconnect must not burn attempts')
    assert.equal(s.reconnectInMs, undefined, 'no reconnect scheduled')
    assert.ok(host.ctx.tools.get('mcp__fake__echo'), 'tools stay registered')
    assert.match(await host.ctx.tools.call('mcp__fake__echo', { text: 'x' }), /is down/)
  }

  section('budget: a connection stable for >= maxDelayMs resets the budget')
  {
    const flag = path.join(dir, 'reset.flag')
    const host = await boot(
      fakeServer({
        env: { SBX_MCP_CRASH_FILE: flag },
        reconnect: { enabled: true, initialDelayMs: 300, maxDelayMs: 300, maxAttempts: 2 },
      }),
    )
    assert.equal((await host.ctx.mcp.status())[0].state, 'up')
    // First failure: attempts 1, then a 300 ms window before the retry.
    await writeFile(flag, 'x', 'utf8')
    await host.ctx.tools.call('mcp__fake__shutdown', {})
    await waitFor(async () => (await host.ctx.mcp.status())[0].attempts === 1, 2000, 'first failed attempt')
    await rm(flag, { force: true })
    await waitFor(async () => (await host.ctx.mcp.status())[0].state === 'up', 5000, 'second boot up')
    assert.equal((await host.ctx.mcp.status())[0].attempts, 1, 'attempts persist right after reconnect')
    await new Promise((r) => setTimeout(r, 400)) // >= maxDelayMs: budget resets to 0
    assert.equal((await host.ctx.mcp.status())[0].attempts, 0, 'stable uptime must reset the budget')
    // Second outage: without the reset this would be attempts 2 == max => exhausted.
    await writeFile(flag, 'x', 'utf8')
    await host.ctx.tools.call('mcp__fake__shutdown', {})
    await waitFor(async () => (await host.ctx.mcp.status())[0].attempts === 1, 3000, 'post-reset failed attempt')
    assert.equal((await host.ctx.mcp.status())[0].state, 'down', 'budget reset must keep the server retrying')
  }

  section('list_changed: atomic swap adds the new tool and keeps the old set')
  {
    const host = await boot(fakeServer())
    const out = await host.ctx.tools.call('mcp__fake__mutate', {})
    assert.equal(out, 'added extra')
    await waitFor(async () => Boolean(host.ctx.tools.get('mcp__fake__extra')), 3000, 'extra registered')
    assert.ok(host.ctx.tools.get('mcp__fake__echo'), 'old generation members stay')
    assert.equal((await host.ctx.mcp.status())[0].tools.length, 10)
  }

  section('list_changed: failed resync keeps the previous generation')
  {
    const host = await boot(fakeServer())
    await host.ctx.tools.call('mcp__fake__breaklist', {})
    await host.ctx.tools.call('mcp__fake__mutate', {})
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(host.ctx.tools.get('mcp__fake__extra'), undefined, 'failed sync must not add tools')
    assert.ok(host.ctx.tools.get('mcp__fake__echo'), 'previous tools stay')
    assert.ok(host.ctx.tools.get('mcp__fake__mutate'), 'previous tools stay (2)')
    assert.equal((await host.ctx.mcp.status())[0].state, 'up', 'a failed resync is not an outage')
    await host.ctx.tools.call('mcp__fake__heal', {})
    await host.ctx.tools.call('mcp__fake__mutate', {})
    await waitFor(async () => Boolean(host.ctx.tools.get('mcp__fake__extra')), 3000, 'extra after heal')
  }

  section('instructions disappear while the server is down')
  {
    const host = await boot(fakeServer({ reconnect: { enabled: false } }))
    const first = await host.ctx.agent.run('hi')
    assert.ok(first)
    const sys1 = host.ctx.sessions.list().at(-1).messages.find((m) => m.role === 'system').content
    assert.ok(sys1.includes('## MCP servers'))
    await host.ctx.tools.call('mcp__fake__shutdown', {})
    await waitFor(async () => (await host.ctx.mcp.status())[0].state === 'down', 3000, 'down again')
    await host.ctx.agent.run('again')
    // list() is newest-first; the second run created a fresh session.
    const session2 = host.ctx.sessions.list()[0]
    const sys2 = session2.messages.find((m) => m.role === 'system').content
    assert.ok(!sys2.includes('## MCP servers'), 'instructions must be gone while down')
  }

  section('dispose: no orphan child processes')
  {
    const host = await boot(fakeServer())
    const pid = Number(await host.ctx.tools.call('mcp__fake__pid', {}))
    hosts.splice(hosts.indexOf(host), 1) // disposed manually below
    await host.dispose()
    await waitFor(
      async () => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      },
      3000,
      'fixture child exits on dispose',
    )
  }

  const { startFakeMcpHttp } = await import('../test/fixtures/fake-mcp-http.mjs')

  section('http transport: connect, list, call, instructions, dispose')
  {
    const httpFixture = startFakeMcpHttp()
    await httpFixture.listen()
    let host
    try {
      host = await boot(mcpServers({ httptools: { transport: 'streamable-http', url: httpFixture.url() } }))
      const s = host.ctx.mcp.status()[0]
      assert.equal(s.state, 'up')
      assert.equal(s.endpoint, httpFixture.url())
      assert.deepEqual(s.tools, ['mcp__httptools__ping'])
      assert.equal(await host.ctx.tools.call('mcp__httptools__ping', {}), 'pong')
      assert.match(host.ctx.mcp.instructions(), /HTTP fixture for Switchboard MCP tests\./)
      assert.match(host.ctx.mcp.instructions(), /### httptools/)
      const session = host.ctx.sessions.list().at(-1)
      assert.ok(!session, 'no session should have been created by tool calls alone')
    } finally {
      if (host) {
        hosts.splice(hosts.indexOf(host), 1)
        await host.dispose().catch(() => {})
      }
      await httpFixture.close()
    }
  }

  section('http transport: unreachable url fails open')
  {
    const host = await boot(mcpServers({ far: { transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' } }))
    const s = host.ctx.mcp.status()[0]
    assert.equal(s.state, 'down')
    assert.ok(s.lastError)
    assert.equal(host.ctx.tools.list().filter((t) => t.name.startsWith('mcp__')).length, 0)
  }

  const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
  const { spawn } = await import('node:child_process')

  function runCli(argv, env = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...argv], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, out, err }))
    })
  }

  // Models stub for `doctor` (endpoint check must pass => exit 0).
  const modelsStub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'stub' }] }))
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  await new Promise((r) => modelsStub.listen(0, '127.0.0.1', r))
  const modelsUrl = `http://127.0.0.1:${modelsStub.address().port}/v1`

  const cliBase = { llm: { baseURL: modelsUrl, defaultModel: 'stub' }, metrics: { persist: '', load: false }, sessions: { dir: path.join(dir, 'cli-sessions'), load: false } }
  const cfgUp = path.join(dir, 'cli-up.jsonc')
  await writeFile(cfgUp, JSON.stringify({ ...cliBase, mcp: { servers: { fake: { command: process.execPath, args: [FIXTURE] } } } }), 'utf8')
  const cfgDown = path.join(dir, 'cli-down.jsonc')
  await writeFile(cfgDown, JSON.stringify({ ...cliBase, mcp: { servers: { ghost: { command: 'sbx-no-such-binary-xyz' } } } }), 'utf8')
  const cfgPlain = path.join(dir, 'cli-plain.jsonc')
  await writeFile(cfgPlain, JSON.stringify(cliBase), 'utf8')

  section('cli tools: MCP tools carry origin mcp:<server>')
  {
    const r = await runCli(['tools', '-c', cfgUp])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /mcp__fake__echo/)
    assert.match(r.out, /from mcp:fake/)
  }

  section('cli info: per-server state line')
  {
    const r = await runCli(['info', '-c', cfgUp])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /fake: up \(\d+ tools\)/)
    const plain = await runCli(['info', '-c', cfgPlain])
    assert.ok(!/: up \(/.test(plain.out), 'no mcp line without an mcp block')
  }

  section('cli doctor: failing server is a warning, not an error')
  {
    const up = await runCli(['doctor', '-c', cfgUp], { BOTCONNECTOR_API_KEY: 'k' })
    assert.equal(up.code, 0, `${up.out}${up.err}`)
    assert.match(up.out, /mcp fake\s+up \(\d+ tools\)/)
    const down = await runCli(['doctor', '-c', cfgDown], { BOTCONNECTOR_API_KEY: 'k' })
    assert.equal(down.code, 0, `down server must only warn: ${down.out}${down.err}`)
    assert.match(down.out, /mcp ghost\s+down/)
    assert.match(down.out, /warning/, 'the summary must mention the warning')
  }

  await new Promise((r) => modelsStub.close(r))
} finally {
  for (const host of hosts) await host.dispose().catch(() => {})
  await stubLlm.close()
  await rm(dir, { recursive: true, force: true })
}

console.log('mcp: OK')
