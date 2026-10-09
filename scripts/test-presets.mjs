/**
 * Agent presets: validation, persistence, tool filtering, session binding,
 * per-run override, and the console API.
 *
 *   node scripts/test-presets.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
import { validatePreset } from '../dist/services/presets.js'

// ---- stub chat endpoint that records what each request carried
const seen = []
const stub = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'stub' }] }))
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  seen.push({ tools: (body.tools ?? []).map((t) => t.function.name), system: body.messages?.[0]?.content ?? '', model: body.model })
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))
const baseURL = `http://127.0.0.1:${stub.address().port}/v1`

const dir = await mkdtemp(path.join(tmpdir(), 'sbx-presets-'))
const boot = () =>
  createHost({
    llm: { baseURL, defaultModel: 'stub', retries: 0 },
    metrics: { persist: '', load: false },
    sessions: { dir: '', load: false },
    settings: { dir },
    web: { enabled: true, port: 0 },
  })
const drain = async (stream) => {
  for await (const _ of stream) void _
}

// ---- validation
assert.throws(() => validatePreset({ id: 'Bad Id', name: 'x' }), /Preset id/)
assert.throws(() => validatePreset({ id: 'ok', name: '' }), /needs a name/)
assert.throws(() => validatePreset({ id: 'ok', name: 'x', maxSteps: 0 }), /maxSteps/)
assert.throws(() => validatePreset({ id: 'ok', name: 'x', maxSteps: 51 }), /maxSteps/)
assert.throws(() => validatePreset({ id: 'ok', name: 'x', tools: { allow: 'read_file' } }), /list of tool names/)
assert.throws(() => validatePreset({ id: 'ok', name: 'x', system: 'a'.repeat(8001) }), /too long/)
assert.deepEqual(validatePreset({ id: 'ok', name: ' X ', maxSteps: '7', tools: { allow: ['a', 'a', ' b '] }, junk: 1 }), { id: 'ok', name: 'X', maxSteps: 7, tools: { allow: ['a', 'b'] } })

let host = await boot()
try {
  const { ctx } = host
  assert.deepEqual(ctx.presets.list().map((p) => p.id), ['default', 'reviewer', 'browser', 'researcher'])
  assert.ok(ctx.presets.list().every((p) => p.builtin))

  // ---- CRUD + persistence
  await ctx.presets.create({ id: 'terse', name: 'Terse', system: 'Answer in one sentence.', model: 'stub', maxSteps: 3, tools: { deny: ['run_command'] } })
  await assert.rejects(ctx.presets.create({ id: 'terse', name: 'dup' }), /already exists/)
  await assert.rejects(ctx.presets.create({ id: 'reviewer', name: 'shadow' }), /already exists/)
  await assert.rejects(ctx.presets.update('reviewer', { name: 'x' }), /Built-in/)
  await assert.rejects(ctx.presets.remove('default'), /Built-in/)
  await assert.rejects(ctx.presets.update('nope', { name: 'x' }), /No preset/)
  // PUT replaces the whole preset
  assert.deepEqual(await ctx.presets.update('terse', { name: 'Terse 2', maxSteps: 4 }), { id: 'terse', name: 'Terse 2', maxSteps: 4 })
  await ctx.presets.update('terse', { name: 'Terse 2', system: 'Answer in one sentence.', model: 'stub', maxSteps: 4, tools: { deny: ['run_command'] } })
  assert.equal(JSON.parse(await readFile(path.join(dir, 'presets.json'), 'utf8')).presets.length, 1)

  // ---- resolve: allow-list hides everything else, deny adds, unknown id is undefined
  const names = ctx.tools.list().map((t) => t.name)
  const reviewer = ctx.presets.resolve('reviewer', names)
  assert.deepEqual(names.filter((n) => !reviewer.excludeTools.includes(n)).sort(), ['list_dir', 'load_skill', 'read_file', 'search_files'])
  assert.ok(reviewer.excludeTools.includes('run_command') && reviewer.excludeTools.includes('write_file'))
  assert.equal(ctx.presets.resolve('missing', names), undefined)

  // prefix patterns: allow mcp__browser__* keeps those tools and hides the rest; deny patterns hide matches
  const browserNames = [...names, 'mcp__browser__navigate', 'mcp__browser__click', 'mcp__other__x']
  const browser = ctx.presets.resolve('browser', browserNames)
  assert.deepEqual(browserNames.filter((n) => !browser.excludeTools.includes(n)).sort(), [...names.filter(n => n.startsWith('browser_')), 'load_skill', 'mcp__browser__click', 'mcp__browser__navigate', 'web_search'].sort())
  assert.throws(() => validatePreset({ id: 'bad', name: 'x', tools: { allow: ['mcp__*__x'] } }), /only allowed at the end/)
  assert.throws(() => validatePreset({ id: 'bad', name: 'x', tools: { allow: ['*'] } }), /only allowed at the end/)
  await ctx.presets.create({ id: 'nobrowser', name: 'No browser', tools: { deny: ['mcp__browser__*', 'run_command'] } })
  const nb = ctx.presets.resolve('nobrowser', browserNames)
  assert.deepEqual(nb.excludeTools.sort(), ['mcp__browser__click', 'mcp__browser__navigate', 'run_command'])
  await ctx.presets.remove('nobrowser')

  // ---- agent: preset applies to tools, system and session; explicit options win
  const s1 = ctx.sessions.create({ title: 't', preset: 'reviewer' })
  await drain(ctx.agent.stream('hello', s1.id))
  let last = seen.at(-1)
  assert.deepEqual([...last.tools].sort(), ['list_dir', 'load_skill', 'read_file', 'search_files'], 'only the allowed tools are offered')
  assert.match(last.system, /careful code reviewer/, 'preset system prompt is used')
  await drain(ctx.agent.stream('again', s1.id))
  assert.deepEqual([...seen.at(-1).tools].sort(), ['list_dir', 'load_skill', 'read_file', 'search_files'], 'the session keeps its preset')
  await drain(ctx.agent.stream('override', s1.id, { excludeTools: ['read_file'] }))
  assert.deepEqual([...seen.at(-1).tools].sort(), ['list_dir', 'load_skill', 'search_files'], 'per-run excludeTools are added')

  const s2 = ctx.sessions.create({ title: 'plain' })
  await drain(ctx.agent.stream('hi', s2.id, { preset: 'terse' }))
  assert.equal(ctx.sessions.get(s2.id).preset, 'terse', 'a preset named in a run sticks to the session')
  assert.ok(!seen.at(-1).tools.includes('run_command'), 'deny list applied')
  assert.match(seen.at(-1).system, /one sentence/)
  await assert.rejects(drain(ctx.agent.stream('x', s2.id, { preset: 'nope' })), /unknown preset/)

  // a brand-new session through stream() carries the preset from the start
  const fresh = ctx.agent.stream('new one', undefined, { preset: 'researcher' })
  await drain(fresh)
  const created = ctx.sessions.list().find((s) => s.title === 'new one')
  assert.equal(created.preset, 'researcher')

  // deleting a preset detaches sessions; they fall back to the plain agent
  await ctx.presets.remove('terse')
  assert.equal(ctx.sessions.get(s2.id).preset, undefined)
  await drain(ctx.agent.stream('after delete', s2.id))
  assert.ok(seen.at(-1).tools.includes('run_command'), 'plain agent again')

  // ---- API
  const { url } = await ctx.web.ready()
  const json = (route, method, body) => fetch(`${url}api/${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const list = await (await json('presets', 'GET')).json()
  assert.deepEqual(list.presets.map((p) => p.id), ['default', 'reviewer', 'browser', 'researcher'])
  const made = await json('presets', 'POST', { id: 'apione', name: 'API one', tools: { allow: ['read_file', 'not_a_tool'] } })
  assert.equal(made.status, 201)
  assert.deepEqual((await (await json('presets', 'GET')).json()).presets.find((p) => p.id === 'apione').unknownTools, ['not_a_tool'])
  assert.equal((await json('presets', 'POST', { id: 'apione', name: 'again' })).status, 409)
  assert.equal((await json('presets', 'POST', { id: 'BAD', name: 'x' })).status, 400)
  assert.equal((await json('presets/reviewer', 'DELETE')).status, 409)
  assert.equal((await json('presets/apione', 'PUT', { name: 'API 1' })).status, 200)
  const sess = await (await json('sessions', 'POST', { title: 'via api', preset: 'reviewer' })).json()
  assert.equal(sess.preset, 'reviewer')
  assert.equal((await json(`sessions/${sess.id}/preset`, 'POST', { preset: 'nope' })).status, 404)
  assert.equal((await (await json(`sessions/${sess.id}/preset`, 'POST', { preset: 'researcher' })).json()).preset, 'researcher')
  assert.equal((await (await json(`sessions/${sess.id}/preset`, 'POST', { preset: null })).json()).preset, null)
  assert.equal((await json('chat', 'POST', { prompt: 'hi', preset: 'nope' })).status, 404)
  assert.equal((await json('presets/apione', 'DELETE')).status, 200)

  // ---- console wiring: the composer ships the selector and the script talks to the API
  assert.match(await (await fetch(url)).text(), /id="preset-mini"/)
  assert.match(await (await fetch(`${url}app.js`)).text(), /\/api\/presets/)

  // ---- persistence across a restart
  await ctx.presets.create({ id: 'keeper', name: 'Keeper' })
  await host.dispose()
  host = await boot()
  assert.ok(host.ctx.presets.get('keeper'), 'user presets survive a restart')
  assert.equal(host.ctx.presets.get('terse'), undefined)
  console.log('presets: OK')
} finally {
  await host.dispose()
  stub.close()
  stub.closeAllConnections?.()
  await rm(dir, { recursive: true, force: true })
}
