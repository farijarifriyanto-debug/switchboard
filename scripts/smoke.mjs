/**
 * Offline smoke test for Switchboard — boots the plugin host, exercises the tool
 * registry and the event bus, then disposes. No network calls.
 *
 *   node scripts/smoke.mjs
 */
import assert from 'node:assert/strict'
import { createHost } from '../dist/index.js'

const host = await createHost({
  llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub' },
  // Keep the smoke test hermetic: no persisted telemetry/sessions from earlier runs.
  metrics: { persist: '', load: false },
  sessions: { dir: '', load: false },
})

try {
  const { ctx } = host

  // Core services are present.
  for (const name of ['llm', 'tools', 'sessions', 'metrics', 'agent']) {
    assert.ok(ctx[name], `service ${name} should be provided`)
  }

  // Built-in tools are registered by plugins.
  const names = ctx.tools.list().map((t) => t.name)
  for (const name of ['read_file', 'write_file', 'list_dir', 'search_files', 'run_command', 'web_fetch', 'web_search']) {
    assert.ok(names.includes(name), `tool ${name} should be registered`)
  }

  // The registry actually executes.
  const listing = await ctx.tools.call('list_dir', { path: '.' })
  assert.ok(listing.includes('package.json'), 'list_dir should see package.json')

  // Unknown tools fail soft.
  assert.match(await ctx.tools.call('nope', {}), /unknown tool/)

  // Path escapes are refused.
  assert.match(await ctx.tools.call('read_file', { path: '../../etc/passwd' }), /escapes workspace/)

  // Plugin lifecycle: register + auto-dispose via ctx.effect.
  let disposed = false
  const probe = {
    name: 'smoke-probe',
    inject: ['tools'],
    apply(c) {
      c.effect(() => {
        const off = c.tools.register({
          name: 'probe',
          description: 'probe',
          parameters: { type: 'object', properties: {} },
          execute: () => 'ok',
        })
        return () => {
          disposed = true
          off()
        }
      })
    },
  }
  await ctx.plugin(probe)
  assert.equal(await ctx.tools.call('probe', {}), 'ok')

  // Event bus: metrics plugin subscribes to llm/metrics.
  ctx.emit('llm/metrics', {
    model: 'stub',
    content: '',
    reasoning: '',
    toolCalls: [],
    usage: {},
    ttftMs: 120,
    totalMs: 300,
    tokensPerSec: 42,
  })
  const summary = ctx.metrics.summary()
  assert.equal(summary.stub?.calls, 1)
  assert.equal(summary.stub?.ttftP50, 120)

  // Sessions.
  const session = ctx.sessions.create({ system: 'system prompt' })
  ctx.sessions.message(session.id, 'hello')
  assert.equal(ctx.sessions.require(session.id).messages.length, 2)

  // Session lookup by unique id prefix.
  assert.equal(ctx.sessions.find(session.id.slice(0, 8))?.id, session.id)

  // Inline-reasoning splitting (content  thinker> + reasoning_content).
  const { InlineReasoningSplitter } = await import('../dist/services/llm.js')
  const splitter = new InlineReasoningSplitter()
  const pieces = [
    ...splitter.push('<thi'),
    ...splitter.push('nk>\nstep one\n</thi'),
    ...splitter.push('nk>\n\nfinal'),
    ...splitter.flush(),
  ]
  assert.equal(pieces.filter((p) => p.kind === 'think').map((p) => p.text).join(''), '\nstep one\n')
  assert.equal(pieces.filter((p) => p.kind === 'text').map((p) => p.text).join(''), '\n\nfinal')

  // Retry policy classifier.
  const { isRetryableStatus } = await import('../dist/services/llm.js')
  assert.equal(isRetryableStatus(429), true)
  assert.equal(isRetryableStatus(503), true)
  assert.equal(isRetryableStatus(400), false)
  assert.equal(isRetryableStatus(401), false)

  // Usage accounting: missing output counts are estimated, cache is clamped.
  const estimated = ctx.llm.usageReport({ promptTokens: 100, cachedTokens: 250 }, 'one two three four')
  assert.equal(estimated.cachedTokens, 100, 'cached tokens cannot exceed the prompt')
  assert.equal(estimated.completionTokens, 5, 'four characters per token estimate')
  assert.equal(estimated.totalTokens, 105)

  const reported = ctx.llm.usageReport({ promptTokens: 10, completionTokens: 3, totalTokens: 13 }, 'ignored')
  assert.equal(reported.completionTokens, 3, 'provider-reported counts win over the estimate')
  assert.equal(reported.totalTokens, 13)

  // Unloading the probe plugin removes its tool.
  const runtime = ctx.registry.get(probe)
  const [probeFiber] = [...runtime.fibers]
  await probeFiber.dispose()
  assert.equal(disposed, true, 'effect disposer should run')
  assert.ok(!ctx.tools.list().some((t) => t.name === 'probe'), 'probe tool should be gone')

  // Web console: static assets + JSON API over loopback.
  const webHost = await createHost({
    llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub' },
    metrics: { persist: '', load: false },
    sessions: { dir: '', load: false },
    web: { enabled: true, port: 0 },
  })
  try {
    const { url } = await webHost.ctx.web.ready()
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/, 'web should report a bound address')

    const page = await fetch(url)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<title>Switchboard · BotConnector<\/title>/, 'branded index.html should be served')

    const css = await fetch(url + 'app.css')
    assert.match(css.headers.get('content-type'), /text\/css/)

    // Path traversal is refused.
    const escape = await fetch(url + '..%2F..%2Fpackage.json')
    assert.ok(escape.status === 403 || escape.status === 404, 'static server should refuse escapes')

    const state = await (await fetch(url + 'api/state')).json()
    assert.equal(state.model, 'stub')
    assert.ok(Array.isArray(state.tools) && state.tools.length > 0, 'state should list tools')
    assert.ok(Array.isArray(state.sessions), 'state should list sessions')

    const created = await (
      await fetch(url + 'api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'smoke' }),
      })
    ).json()
    assert.match(created.id, /^s-/)

    const fetched = await (await fetch(`${url}api/sessions/${created.id}`)).json()
    assert.equal(fetched.title, 'smoke')

    const removed = await (await fetch(`${url}api/sessions/${created.id}`, { method: 'DELETE' })).json()
    assert.equal(removed.deleted, created.id)

    assert.equal((await fetch(url + 'api/nope')).status, 404, 'unknown API route should 404')
  } finally {
    await webHost.dispose()
  }

  console.log('smoke: all checks passed')
} finally {
  await host.dispose()
}
