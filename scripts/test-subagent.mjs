/**
 * Subagent delegation tests.
 *
 *   node scripts/test-subagent.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateSubagent } from '../dist/config.js'
import { createHost } from '../dist/index.js'

const section = (name) => console.log(`- ${name}`)
const dir = await mkdtemp(path.join(tmpdir(), 'sbx-subagent-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const waitFor = async (fn, ms, label) => {
  const t0 = Date.now()
  for (;;) {
    // Works for sync predicates and async probes; fn throwing = not ready yet.
    let value
    try {
      value = await fn()
    } catch {
      value = undefined
    }
    if (value) return value
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${label}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/**
 * Scriptable OpenAI-compatible stub.
 *
 * Parent requests (tools[] contains `task`) vs child requests are distinguished
 * by the tool list. A wake is a parent request whose LAST user message starts
 * with "[job " (the wake runs with prompt "" so the injection is last).
 * Knobs (see `resetStub`): parentMode 'answer'|'always_tool'|'task',
 * childMode 'answer'|'always_tool', wakeMode 'answer'|'error', taskArgs,
 * forcedCall (one-shot), forceChildTask, failChildWhen, errorDelayMs,
 * wakeDelayMs, childDelayMs, parentDelayMs, slowTag/slowExtraMs,
 * child/parent answers, inflight counters for wave assertions.
 */
function createStubLlm() {
  const state = {
    requests: [], // { body, isChild, isWake, at, endAt, lastUser, tools }
    parentMode: 'answer',
    childMode: 'answer',
    wakeMode: 'answer',
    taskArgs: null,
    forcedCall: null, // { name, args } — emitted once on the next parent turn
    forceChildTask: false, // child emits a `task` call while it has no tool result
    failChildWhen: null, // substring: child request containing it answers 500
    errorDelayMs: 0,
    wakeDelayMs: 0,
    childDelayMs: 0,
    parentDelayMs: 0, // non-child, non-wake parent turn delay (for controlled user runs)
    slowTag: null, // child prompt containing it also waits slowExtraMs
    slowExtraMs: 0,
    parentAnswer: 'ok.',
    childAnswer: 'child ok.',
    inflightChild: 0,
    maxInflightChild: 0,
    wakeStarts: 0,
    parentHasTaskTool: false, // pre-Task-6 parents have no `task` tool yet — don't misclassify them as children
  }

  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'stub' }] }))
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    const messages = body.messages ?? []
    const tools = (body.tools ?? []).map((t) => t.function?.name)
    const hasTaskTool = tools.includes('task')
    if (hasTaskTool) state.parentHasTaskTool = true
    // Parent = has `task`; child = lacks it (children always spawn AFTER a
    // parent request that contained `task`, so the latch never misfires).
    // Before Task 6 registers the tool, no request has it ⇒ everything counts
    // as a parent, which is also true (no children exist yet).
    const isChild = !hasTaskTool && state.parentHasTaskTool
    const sawTool = messages.some((m) => m.role === 'tool')
    // `sawTool` (ANY tool msg) breaks task-mode on a session with tool HISTORY
    // (15(c-ii) Phase B reuses a session that already ran task): this run's own
    // tool call is exactly "the LAST message is the tool result".
    const lastIsTool = messages[messages.length - 1]?.role === 'tool'
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const isWake = !isChild && lastUser.startsWith('[job ')
    const rec = { body, isChild, isWake, at: Date.now(), endAt: 0, lastUser, tools }
    state.requests.push(rec)

    let delay = 0
    if (isChild) {
      state.inflightChild += 1
      state.maxInflightChild = Math.max(state.maxInflightChild, state.inflightChild)
      delay += state.childDelayMs + (state.slowTag && lastUser.includes(state.slowTag) ? state.slowExtraMs : 0)
    }
    if (isWake) {
      state.wakeStarts += 1
      delay += state.wakeDelayMs + (state.wakeMode === 'error' ? state.errorDelayMs : 0)
    }
    if (!isChild && !isWake) delay += state.parentDelayMs
    if (delay) await sleep(delay)

    const finish = (content) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }
    const toolCall = (id, name, args) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }
    try {
      if (isChild && state.failChildWhen && lastUser.includes(state.failChildWhen)) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('boom')
        return
      }
      const mode = isChild ? state.childMode : isWake ? state.wakeMode : state.parentMode
      if (mode === 'error') {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('boom')
        return
      }
      if (mode === 'task') {
        if (!lastIsTool) toolCall('call_task', 'task', state.taskArgs ?? { tasks: [{ description: 'do it' }] })
        else finish('batch done.')
        return
      }
      if (mode === 'always_tool') {
        if (!sawTool) {
          const forced = state.forcedCall
          if (forced) state.forcedCall = null
          const call = forced ?? { name: 'list_dir', args: { path: '.' } }
          toolCall('call_1', call.name, call.args)
          return
        }
        finish('after tool.')
        return
      }
      if (isChild && state.forceChildTask && !sawTool) {
        toolCall('call_task', 'task', {})
        return
      }
      finish(isChild ? state.childAnswer : state.parentAnswer)
    } finally {
      if (isChild) state.inflightChild -= 1
      rec.endAt = Date.now()
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)), state })
    })
  })
}

const stubLlm = await createStubLlm()
const stub = { state: stubLlm.state }
const resetStub = () =>
  Object.assign(stub.state, {
    parentMode: 'answer', childMode: 'answer', wakeMode: 'answer', taskArgs: null,
    forcedCall: null, forceChildTask: false, failChildWhen: null, errorDelayMs: 0,
    wakeDelayMs: 0, childDelayMs: 0, parentDelayMs: 0, slowTag: null, slowExtraMs: 0,
    parentAnswer: 'ok.', childAnswer: 'child ok.', maxInflightChild: 0, wakeStarts: 0,
    parentHasTaskTool: false,
    requests: [],
  })

const hosts = []
const boot = async (config = {}) => {
  resetStub()
  const host = await createHost({
    llm: { baseURL: stubLlm.url, defaultModel: 'stub', retries: 0 },
    metrics: { persist: '', load: false },
    sessions: { dir: '', load: false },
    workspace: { root: dir },
    ...config,
  })
  host.events = [] // run/event (seq-deduped) AND subagent events, for assertions
  host.ctx.on('run/event', (ev) => host.events.push(ev))
  host.ctx.on('subagent/start', (ev) => host.events.push({ type: 'subagent/start', ...ev }))
  host.ctx.on('subagent/done', (ev) => host.events.push({ type: 'subagent/done', ...ev }))
  hosts.push(host)
  return host
}

// Event helpers — ALWAYS dedupe by seq (agent.ts double-emits turn_started).
const uniq = (arr) => [...new Set(arr)]
const startsFor = (host, sid) => uniq(host.events.filter((e) => e.type === 'turn_started' && e.sessionId === sid).map((e) => e.seq)).length
const endsFor = (host, sid, type) => uniq(host.events.filter((e) => e.type === type && e.sessionId === sid).map((e) => e.seq)).length

// Stream drivers — never `break` a for-await on a live run (implicit .return()).
const collect = async (gen) => { const out = []; for await (const ev of gen) out.push(ev); return out }
const until = async (gen, pred, label = 'event') => {
  for (;;) {
    const { value, done } = await gen.next()
    if (done) throw new Error(`stream ended before ${label}`)
    if (pred(value)) return value
  }
}

const main = await boot()

try {
  section('config: defaults when the block is absent')
  assert.deepEqual(validateSubagent(undefined, () => {}), { enabled: true, maxParallel: 3, maxSteps: 8, autoResume: true })
  assert.deepEqual(validateSubagent({}, () => {}), { enabled: true, maxParallel: 3, maxSteps: 8, autoResume: true })

  section('config: type errors throw naming the key')
  assert.throws(() => validateSubagent({ maxParallel: 2.5 }, () => {}), /"maxParallel" must be an integer >= 1/)
  assert.throws(() => validateSubagent({ maxParallel: 0 }, () => {}), /"maxParallel" must be an integer >= 1/)
  assert.throws(() => validateSubagent({ maxParallel: -1 }, () => {}), /"maxParallel" must be an integer >= 1/)
  assert.throws(() => validateSubagent({ maxSteps: NaN }, () => {}), /"maxSteps" must be an integer >= 1/)
  assert.throws(() => validateSubagent({ maxSteps: Infinity }, () => {}), /"maxSteps" must be an integer >= 1/)
  assert.throws(() => validateSubagent({ maxSteps: '4' }, () => {}), /"maxSteps" must be an integer >= 1/)
  assert.throws(() => validateSubagent({ enabled: 'yes' }, () => {}), /"enabled" must be a boolean/)
  assert.throws(() => validateSubagent({ autoResume: 1 }, () => {}), /"autoResume" must be a boolean/)
  assert.throws(() => validateSubagent('nope', () => {}), /must be an object/)

  section('config: unknown fields warn instead of failing')
  const warns = []
  const out = validateSubagent({ banana: true, maxParallel: 5 }, (m) => warns.push(m))
  assert.equal(out.maxParallel, 5)
  assert.ok(warns.some((m) => m.includes('unknown field "banana"')), `warns: ${warns.join(' | ')}`)

  section('2: final carries stopReason "answer"')
  {
    const h = await boot()
    const events = await collect(h.ctx.agent.stream('say hi'))
    const final = events.find((e) => e.type === 'final')
    assert.ok(final, 'a final is required')
    assert.equal(final.stopReason, 'answer')
  }

  section('2: step-limit final carries stopReason "step_limit"')
  {
    const h = await boot({ agent: { maxSteps: 1 } })
    stub.state.parentMode = 'always_tool' // turn 1 returns tool_calls → budget spent
    const events = await collect(h.ctx.agent.stream('go'))
    const final = events.find((e) => e.type === 'final')
    assert.equal(final?.stopReason, 'step_limit')
    assert.match(final.content, /Stopped after 1 steps without a final answer/)
  }

  section('3: per-run system override')
  {
    const h = await boot()
    const before = stub.state.requests.length
    const gen = h.ctx.agent.stream('hello world', undefined, { system: 'CUSTOM INSTRUCTION: respond in pirate speak. Pirate instructions.' })
    const final = await until(gen, (e) => e.type === 'final', 'final')
    assert.equal(final.stopReason, 'answer')
    const req = stub.state.requests.slice(before).find((r) => !r.isChild)
    assert.ok(req, 'a parent request is required')
    assert.ok(req.lastUser.includes('hello world'), 'prompt delivered')
    // custom system must START with the raw string (AGENTS.md may append after it)
    const systemMsgs = req.body.messages.filter((m) => m.role === 'system').map((m) => m.content)
    assert.ok(
      systemMsgs.some((c) => c.startsWith('CUSTOM INSTRUCTION: respond in pirate speak. Pirate instructions.')),
      'custom system used verbatim as the base',
    )
    // win32 agent loop appends the Platform hint because the custom text lacks "Platform:"
    assert.ok(systemMsgs.some((c) => c.includes('Platform:')), 'PLATFORM_HINT appended when absent')
  }

  section('3: custom system containing "Platform:" is NOT wrapped')
  {
    const h = await boot()
    const before = stub.state.requests.length
    await collect(h.ctx.agent.stream('hi', undefined, { system: 'Platform: android custom rules' }))
    const req = stub.state.requests.slice(before).find((r) => !r.isChild)
    const sys = req.body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    const occurrences = sys.split('Platform:').length - 1
    assert.equal(occurrences, 1, `Platform hint injected exactly once, got ${occurrences}`)
  }

  section('3: per-run model + maxSteps')
  {
    const h = await boot()
    stub.state.parentMode = 'always_tool'
    const before = stub.state.requests.length
    const events = await collect(h.ctx.agent.stream('go', undefined, { model: 'override-model', maxSteps: 1 }))
    const req = stub.state.requests.slice(before).find((r) => !r.isChild)
    assert.equal(req.body.model, 'override-model', 'per-run model reaches the request body')
    // Task 2 added stopReason to final — maxSteps=1 truncates to 'step_limit'
    assert.equal(events.find((e) => e.type === 'final')?.stopReason, 'step_limit', 'per-run maxSteps=1 truncates')
  }

  section('3: default path unchanged (byte-identical system prefix)')
  {
    const h = await boot()
    const before = stub.state.requests.length
    await collect(h.ctx.agent.stream('plain default check'))
    const req = stub.state.requests.slice(before).find((r) => !r.isChild)
    const sys = req.body.messages.find((m) => m.role === 'system')?.content ?? ''
    const { DEFAULT_SYSTEM_PROMPT } = await import('../dist/plugins/agent.js')
    assert.ok(sys.startsWith(DEFAULT_SYSTEM_PROMPT), 'default system starts with the DEFAULT_SYSTEM_PROMPT')
  }

  section('4: deny error string (unit)')
  {
    const h = await boot()
    const denied = await h.ctx.tools.call('read_file', { path: 'x' }, { deny: ['read_file'] })
    // tools.call() returns a plain string (see src/services/tools.ts:81) — a
    // denied call returns the error STRING like any other tool failure
    assert.equal(denied, 'Error: tool "read_file" is not available to this agent', 'EXACT message, no throw (spec §5)')
    const ok = await h.ctx.tools.call('list_dir', { path: '.' }, { deny: ['read_file'] })
    assert.ok(!ok.startsWith('Error: tool "list_dir"'), 'list_dir still callable with a deny list')
    assert.ok(!/not available to this agent/.test(ok), 'list_dir result is not a deny message')
  }

  section('4: excludeTools strips `task` from the request body')
  {
    const h = await boot()
    const before = stub.state.requests.length
    await collect(h.ctx.agent.stream('hi', undefined, { excludeTools: ['task', 'run_command'] }))
    const req = stub.state.requests.slice(before).find((r) => Array.isArray(r.tools))
    const names = req.body.tools.map((t) => t.function.name)
    assert.ok(!names.includes('task'), 'task excluded')
    assert.ok(!names.includes('run_command'), 'run_command excluded')
    assert.ok(names.includes('list_dir'), 'list_dir still present')
  }

  section('4: excluded tool is never offered for approval')
  {
    const h = await boot({ approval: { mode: 'all' } })
    stub.state.parentMode = 'always_tool'
    stub.state.forcedCall = { name: 'run_command', args: { command: 'echo hi' } }
    const gen = h.ctx.agent.stream('please run something', undefined, { excludeTools: ['run_command'] })
    const events = []
    for await (const ev of gen) {
      events.push(ev)
      if (ev.type === 'approval_needed') assert.fail('excluded tool must not request approval')
      if (ev.type === 'final') break
    }
    assert.equal(h.ctx.approvals.pending().length, 0, 'nothing left pending')
    assert.ok(
      events.some((e) => (e.type === 'tool_result' || e.type === 'error') && /not available to this agent/.test(JSON.stringify(e))),
      'deny message surfaced as a normal tool_result',
    )
    assert.ok(h.ctx.tools.get('run_command'), 'registry untouched')
  }

  section('13(a): concurrent stream on one session rejects before mutating')
  {
    const h = await boot()
    stub.state.parentMode = 'always_tool'
    const gen1 = h.ctx.agent.stream('first long turn')
    // park gen1 at turn_started — the generator is suspended, the run stays
    // active (mutex held) with no delay knobs needed
    await until(gen1, (e) => e.type === 'turn_started', 'turn_started')
    const sid = h.ctx.sessions.list()[0].id
    const msgsBefore = h.ctx.sessions.require(sid).messages.length
    const statusBefore = h.ctx.sessions.require(sid).status
    await assert.rejects(
      async () => { await h.ctx.agent.stream('second turn', sid).next() }, // stream() is an async generator: the busy error surfaces on the FIRST .next()
      /session "[^"]+" is already running/,
    )
    // nothing changed: no message, no status, no event
    assert.equal(h.ctx.sessions.require(sid).messages.length, msgsBefore, 'no message appended')
    assert.equal(h.ctx.sessions.require(sid).status, statusBefore, 'status untouched')
    assert.equal(startsFor(h, sid), 1, 'no second turn_started')
    const collected = await collect(gen1)
    assert.ok(collected.some((e) => e.type === 'final'), 'first run completed after drain')
  }

  section('13(c)-loop: .return() mid-run — token released, status cancelled, exactly ONE event')
  {
    const h = await boot()
    stub.state.parentMode = 'always_tool'
    const gen = h.ctx.agent.stream('parked turn')
    await until(gen, (e) => e.type === 'turn_started', 'turn_started')
    const sid = h.ctx.sessions.list()[0].id
    // mutex held while parked
    await assert.rejects(async () => { await h.ctx.agent.stream('x', sid).next() }, /is already running/)
    assert.equal(endsFor(h, sid, 'cancelled'), 0, 'none before .return()')
    await gen.return(undefined) // explicit close — must run the cleanup layers
    const after = h.ctx.sessions.require(sid)
    assert.equal(after.status, 'cancelled', 'layer 2: terminal status')
    assert.equal(endsFor(h, sid, 'cancelled'), 1, 'layer 3: exactly one cancelled (seq-deduped)')
    stub.state.parentMode = 'answer'
    const events = await collect(h.ctx.agent.stream('next turn', sid))
    assert.ok(events.some((e) => e.type === 'final'), 'layer 1: mutex released, session reusable')
    assert.equal(startsFor(h, sid), 2, 'exactly two turns total')
  }

  section('13(b): normal end releases the token; a later .return() emits nothing')
  {
    const h = await boot()
    const gen = h.ctx.agent.stream('complete normally')
    await until(gen, (e) => e.type === 'final', 'final') // final already yielded → endEmitted
    await gen.return(undefined)
    const sid = h.ctx.sessions.list()[0].id
    assert.equal(h.ctx.sessions.require(sid).status, 'completed', 'stays completed')
    assert.equal(endsFor(h, sid, 'cancelled'), 0, 'no bogus cancelled event')
    assert.equal(endsFor(h, sid, 'error'), 0, 'no bogus error event')
    // token was released at normal end: a new run works
    const again = await collect(h.ctx.agent.stream('one more', sid))
    assert.ok(again.some((e) => e.type === 'final'), 'next run succeeds')
  }

  section('13(d): Stop/abort releases the token — loop cancelled, no second event from finally')
  {
    const h = await boot()
    stub.state.parentMode = 'always_tool'
    const ac = new AbortController()
    const gen = h.ctx.agent.stream('aborted turn', undefined, { signal: ac.signal })
    await until(gen, (e) => e.type === 'turn_started', 'turn_started')
    const sid = h.ctx.sessions.list()[0].id
    ac.abort()
    const rest = await collect(gen) // drain after abort → epilogue lands in-body
    assert.equal(endsFor(h, sid, 'cancelled'), 1, 'exactly ONE cancelled (finally must not double it)')
    assert.equal(h.ctx.sessions.require(sid).status, 'cancelled')
    assert.ok(!rest.some((e) => e.type === 'final'), 'no final after abort')
    const next = await collect(h.ctx.agent.stream('reuse', sid))
    assert.ok(next.some((e) => e.type === 'final'), 'reusable')
  }

  section('13(f): waiting_approval still holds the mutex')
  {
    const h = await boot({ approval: { mode: 'all' } })
    stub.state.parentMode = 'always_tool'
    stub.state.forcedCall = { name: 'run_command', args: { command: 'echo risky' } }
    const gen = h.ctx.agent.stream('needs approval')
    // Drain in the background: `approval_needed` is yielded BEFORE tools.call,
    // and only tools.call → approvals.request() registers the pending gate
    // (which parks the run awaiting decide()).
    const events = []
    const drained = (async () => { for await (const ev of gen) events.push(ev) })()
    const gate = await waitFor(() => events.find((e) => e.type === 'approval_needed'), 5000, 'approval_needed')
    assert.ok(gate, 'parked at the approval gate')
    const sid = h.ctx.sessions.list()[0].id
    await waitFor(() => h.ctx.approvals.pending().length === 1, 5000, 'pending gate registered')
    await assert.rejects(async () => { await h.ctx.agent.stream('while approval pending', sid).next() }, /is already running/)
    assert.equal(h.ctx.sessions.require(sid).status, 'waiting_approval', 'status holds')
    const [item] = h.ctx.approvals.pending() // real API: pending()[0].id + decide(id, 'rejected')
    assert.equal(item.tool, gate.name, 'pending gate matches the yielded tool')
    h.ctx.approvals.decide(item.id, 'rejected') // string decision, NOT an object (see test-approval.mjs)
    await drained // rejection ends the run → generator completes → mutex released
    assert.ok(events.some((e) => e.type === 'final' || e.type === 'cancelled'), 'run ended after decision')
    const after = await collect(h.ctx.agent.stream('post-approval run', sid))
    assert.ok(after.some((e) => e.type === 'final'), 'mutex released once the approval run ended')
  }

  section('helper: isSessionBusyError')
  {
    const { isSessionBusyError } = await import('../dist/plugins/agent.js')
    assert.equal(isSessionBusyError(new Error('session "s1" is already running')), true)
    assert.equal(isSessionBusyError(new Error('tool "x" not found')), false)
    assert.equal(isSessionBusyError('session "s1" is already running'), false, 'non-Error rejected')
  }

  // ---- Task 6: the `task` tool — workers, waves, background jobs (§4–§6) ----

  section('6: task args validation (all-or-nothing)')
  {
    const mod = await import('../dist/plugins/subagent.js') // RED until Task 6 step 3
    const v = mod.validateTaskArgs
    const warn = (m) => { throw new Error(`unexpected warn: ${m}`) }
    assert.deepEqual(v({ tasks: [{ description: 'd1' }] }, warn), { tasks: [{ description: 'd1' }], background: false })
    assert.deepEqual(v({ tasks: [{ description: 'd1' }], background: true }, warn), { tasks: [{ description: 'd1' }], background: true })
    // error shapes
    assert.match(v('nope').error, /Error: task: tasks must be an array of task objects/)
    assert.match(v({ tasks: [] }).error, /Error: task: tasks must contain at least one task/)
    assert.match(v({ tasks: ['x'] }).error, /Error: task: tasks\[0\] must be an object/)
    assert.match(v({ tasks: [{ context: 'c' }] }).error, /Error: task: description must be a non-empty string/)
    assert.match(v({ tasks: [{ description: '' }] }).error, /Error: task: description must be a non-empty string/)
    assert.match(v({ tasks: [{ description: 'd', context: 5 }] }).error, /Error: task: context must be a string/)
    assert.match(v({ tasks: [{ description: 'd', model: 7 }] }).error, /Error: task: model must be a non-empty string/)
    assert.match(v({ tasks: [{ description: 'd', maxSteps: 0 }] }).error, /Error: task: maxSteps must be an integer >= 1/)
    assert.match(v({ tasks: [{ description: 'd', maxSteps: 2.5 }] }).error, /Error: task: maxSteps must be an integer >= 1/)
    assert.match(v({ tasks: [{ description: 'd', background: 'yes' }] }).error, /Error: task: "background" must be a boolean/)
    // all-or-nothing: ONE bad task fails the whole batch, key named
    assert.match(v({ tasks: [{ description: 'ok' }, { description: 'ok2', maxSteps: -1 }] }).error, /tasks\[1\]/)
    // unknown field → warn, not error
    const warns = []
    const out = v({ tasks: [{ description: 'd', banana: 1 }] }, (m) => warns.push(m))
    assert.ok(out.tasks, 'still valid')
    assert.ok(warns.some((m) => m.includes('banana')), `warned: ${warns.join('|')}`)
  }

  section('6: invalid batch creates NO child session and NO job (all-or-nothing, e2e)')
  {
    const h = await boot()
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'good' }, { description: 'bad', maxSteps: 0 }] } // one bad entry
    const sessionsBefore = h.ctx.sessions.list().length
    const events = await collect(h.ctx.agent.stream('spawn an invalid batch'))
    const toolEvent = events.find((e) => (e.type === 'tool_result' && /Error: task:/.test(String(e.result))) || (e.type === 'error' && /Error: task:/.test(JSON.stringify(e))))
    const text = JSON.stringify(events)
    assert.match(text, /Error: task: maxSteps must be an integer >= 1/, 'visible error result')
    // ADAPT: the run itself creates the PARENT session (+1) — exactly that one
    // new session proves no CHILD was created (plan's `=== sessionsBefore`
    // forgot the parent create inside stream()).
    assert.equal(h.ctx.sessions.list().length, sessionsBefore + 1, 'no child session created')
    assert.equal(h.ctx.subagent.jobs().length, 0, 'no job registered')
    assert.equal(h.events.filter((e) => e.type === 'subagent/start').length, 0, 'no subagent/start')
    assert.ok(toolEvent || text.includes('Error: task:'), 'error surfaced to the parent run')
  }

  section('6: task tool registered; disabled config removes it')
  {
    const on = await boot()
    assert.ok(on.ctx.tools.get('task'), 'task registered by default')
    const off = await boot({ subagent: { enabled: false } })
    assert.equal(off.ctx.tools.get('task'), undefined, 'enabled:false removes the tool')
  }

  section('6: blocking single task — worker session, metadata, prompt, events')
  {
    const h = await boot()
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'check the tmp dir' }] } // child prompt mirrors the test intent
    const before = stub.state.requests.length
    const events = await collect(h.ctx.agent.stream('spawn one task: check the tmp dir'))
    const final = events.find((e) => e.type === 'final')
    assert.ok(final.content.includes('batch done.'), 'parent gets the batch summary')
    // events: subagent/start + subagent/done per child
    const starts = h.events.filter((e) => e.type === 'subagent/start')
    const dones = h.events.filter((e) => e.type === 'subagent/done')
    assert.equal(starts.length, 1, 'one start')
    assert.equal(dones.length, 1, 'one done')
    assert.equal(starts[0].tasks, 1, 'tasks = batch size')
    const parentSid = starts[0].parentSessionId
    assert.ok(h.ctx.sessions.list().some((s) => s.id === parentSid), 'parent link points at the real parent session')
    assert.equal(dones[0].ok, true, 'ok when child answered')
    // child session metadata (persisted field via sessions.create)
    const child = h.ctx.sessions.require(dones[0].sessionId)
    assert.equal(child.kind, 'subagent', 'kind metadata persisted')
    assert.equal(child.parentSessionId, parentSid, 'parentSessionId persisted')
    assert.equal(child.jobId, undefined, 'blocking child has NO jobId')
    // child request shape
    const childReq = stub.state.requests.slice(before).find((r) => r.isChild)
    assert.ok(childReq, 'a child request happened')
    const sys = childReq.body.messages.find((m) => m.role === 'system')?.content ?? ''
    const { WORKER_SYSTEM_PROMPT } = await import('../dist/plugins/subagent.js')
    assert.ok(sys.startsWith(WORKER_SYSTEM_PROMPT), 'worker system prompt')
    assert.ok(sys.includes('Platform:'), 'PLATFORM_HINT appended (custom system rule)')
    assert.ok(sys.includes('Today is'), 'date context appended per-run')
    assert.ok(!childReq.tools.includes('task'), 'no task in child tools') // stub records tool NAMES
    assert.ok(childReq.lastUser.includes('check the tmp dir'), 'description reaches child prompt')
  }

  section('6: child system prompt persists on 2nd stream (spec 10.3)')
  {
    const h = await boot()
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'persist probe' }] }
    const events = await collect(h.ctx.agent.stream('spawn one child'))
    const childId = h.events.find((e) => e.type === 'subagent/done').sessionId
    const { WORKER_SYSTEM_PROMPT } = await import('../dist/plugins/subagent.js')
    // sessions.create({system}) stores the worker prompt as the FIRST system
    // message (spec §4: SessionData has no `system` field)
    const first = h.ctx.sessions.require(childId).messages.find((m) => m.role === 'system')
    assert.ok(first?.content.startsWith(WORKER_SYSTEM_PROMPT), 'create() stored the worker prompt as first system message')
    // 2nd run on the same child: stream() re-assembles system from base +
    // options.system every turn — the caller MUST pass WORKER again (spec §8)
    const before = stub.state.requests.length
    stub.state.parentMode = 'answer'
    const again = await collect(h.ctx.agent.stream('continue the child work', childId, { system: WORKER_SYSTEM_PROMPT, excludeTools: ['task'] }))
    assert.ok(again.some((e) => e.type === 'final'), 'second child run completed')
    const req2 = stub.state.requests.slice(before).find((r) => r.isChild)
    assert.ok(req2, 'second child request happened')
    const sys2 = req2.body.messages.find((m) => m.role === 'system')?.content ?? ''
    assert.ok(sys2.startsWith(WORKER_SYSTEM_PROMPT), '2nd stream still starts with the WORKER prompt')
    assert.ok(!req2.tools.includes('task'), '2nd stream still excludes task') // stub records tool NAMES
    const stored = h.ctx.sessions.require(childId).messages.find((m) => m.role === 'system')
    assert.ok(stored.content.startsWith(WORKER_SYSTEM_PROMPT), 'persisted system message not clobbered by DEFAULT prompt')
  }

  section('6: anti-recursion — forced child `task` call denied by dispatcher (two layers)')
  {
    const h = await boot()
    stub.state.parentMode = 'task' // the parent must actually CALL task for a child to exist
    stub.state.forceChildTask = true
    const events = await collect(h.ctx.agent.stream('spawn: recursion probe'))
    const final = events.find((e) => e.type === 'final')
    assert.ok(final, 'parent turn finished')
    // layer 1 (hidden): no child request ever offered `task`
    const grandChildren = stub.state.requests.filter((r) => r.isChild && r.tools.includes('task')) // stub records tool NAMES
    assert.equal(grandChildren.length, 0, 'no child ever saw the task tool')
    // layer 2 (rejected): the forced call got the EXACT dispatcher error as a
    // normal tool result — no approval prompt, no new session (spec §5)
    const childStart = h.events.find((e) => e.type === 'subagent/start')
    const childSession = h.ctx.sessions.require(childStart.sessionId)
    // ADAPT: don't scan JSON.stringify (it escapes the quotes in "task" → the
    // needle never matches); scan the raw message content instead.
    assert.ok(
      childSession.messages.some((m) => String(m.content ?? '').includes('Error: tool "task" is not available to this agent')),
      'exact deny message landed as the child tool result',
    )
    assert.equal(h.events.some((e) => e.type === 'approval_needed'), false, 'no approval prompt')
    assert.equal(h.ctx.approvals.pending().length, 0, 'nothing pending')
    const subagentSessions = h.ctx.sessions.list().filter((s) => s.kind === 'subagent')
    assert.equal(subagentSessions.length, 1, 'only the ONE child session exists (no grandchild)')
    assert.equal(h.events.filter((e) => e.type === 'subagent/start').length, 1, 'no grandchildren spawned')
    assert.ok(h.ctx.tools.get('task'), 'parent registry untouched')
  }

  section('6: waves — 5 tasks, maxParallel 2 → concurrency ≤ 2 and waves 2+2+1')
  {
    const h = await boot({ subagent: { maxParallel: 2 } })
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [
      { description: 'w1' }, { description: 'w2' }, { description: 'w3' }, { description: 'w4' }, { description: 'w5' },
    ] }
    stub.state.childDelayMs = 60
    const events = await collect(h.ctx.agent.stream('run five tasks'))
    const dones = h.events.filter((e) => e.type === 'subagent/done')
    assert.equal(dones.length, 5, 'all five children finished')
    assert.ok(dones.every((d) => d.ok), 'all ok')
    assert.ok(events.some((e) => e.type === 'final'), 'parent got the batch result')
    assert.equal(stub.state.maxInflightChild, 2, 'observed concurrency never exceeds maxParallel')
    // wave shape 2+2+1: a wave-N child may only START after every wave-(N-1)
    // child finished (childDelayMs keeps children multi-turn-free: 1 req each)
    const childReqs = stub.state.requests.filter((r) => r.isChild).sort((a, b) => a.at - b.at)
    assert.equal(childReqs.length, 5, 'five child requests')
    const endOf = (i) => Math.max(childReqs[i].endAt, childReqs[i + 1]?.endAt ?? 0)
    assert.ok(childReqs[2].at >= endOf(0), 'wave 2 starts only after wave 1 (children 0-1) finished')
    assert.ok(childReqs[4].at >= endOf(2), 'wave 3 (single child) starts only after wave 2 finished')
  }

  section('6: mixed batch — one child failure reported, siblings ok')
  {
    const h = await boot({ subagent: { maxParallel: 2 } })
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'ok one' }, { description: 'second contains FAIL THIS ONE marker' }] }
    stub.state.failChildWhen = 'FAIL THIS ONE'
    const events = await collect(h.ctx.agent.stream('two tasks, second contains FAIL THIS ONE marker'))
    const dones = h.events.filter((e) => e.type === 'subagent/done')
    assert.equal(dones.length, 2)
    assert.ok(dones.some((d) => d.ok === true), 'one ok')
    assert.ok(dones.some((d) => d.ok === false), 'one failed')
    const final = events.find((e) => e.type === 'final')
    assert.ok(final, 'parent still completed with a summary')
  }

  section('6: hydrate across hosts — metadata preserved')
  {
    resetStub()
    const dir2 = await mkdtemp(path.join(tmpdir(), 'sbx-hydrate-'))
    try {
      stub.state.parentMode = 'task'
      stub.state.taskArgs = { tasks: [{ description: 'hydrate task' }] }
      const cfg = { llm: { baseURL: stubLlm.url, defaultModel: 'stub', retries: 0 }, metrics: { persist: '', load: false }, workspace: { root: dir } }
      const h1 = await createHost({ ...cfg, sessions: { dir: dir2, load: false } })
      h1.events = []
      h1.ctx.on('run/event', (ev) => h1.events.push(ev))
      h1.ctx.on('subagent/start', (ev) => h1.events.push({ type: 'subagent/start', ...ev }))
      h1.ctx.on('subagent/done', (ev) => h1.events.push({ type: 'subagent/done', ...ev }))
      hosts.push(h1)
      await collect(h1.ctx.agent.stream('spawn a task in dir2'))
      const parentId = h1.events.find((e) => e.type === 'subagent/start').parentSessionId
      const childId = h1.events.find((e) => e.type === 'subagent/done').sessionId
      await h1.ctx.sessions.flush()
      await h1.dispose()
      hosts.splice(hosts.indexOf(h1), 1) // disposed manually — keep the teardown list clean
      const h2 = await createHost({ ...cfg, sessions: { dir: dir2, load: true } })
      hosts.push(h2)
      const loaded = h2.ctx.sessions.require(childId)
      assert.equal(loaded.kind, 'subagent', 'kind survives hydrate')
      assert.equal(loaded.parentSessionId, parentId, 'parentSessionId survives')
      // SessionData has NO `system` field (spec §4): the worker system prompt
      // persists as the first role:'system' message, written at create() and
      // refreshed by every stream() run
      const { WORKER_SYSTEM_PROMPT } = await import('../dist/plugins/subagent.js')
      const sysMsg = loaded.messages.find((m) => m.role === 'system')
      assert.ok(sysMsg?.content.startsWith(WORKER_SYSTEM_PROMPT), 'worker system prompt persisted as the first system message')
      // metadata of the batch (2nd stream on the same child) keeps working after reload:
      stub.state.parentMode = 'answer'
      const again = await collect(h2.ctx.agent.stream('follow-up', childId, { system: WORKER_SYSTEM_PROMPT, excludeTools: ['task'] }))
      assert.ok(again.some((e) => e.type === 'final'), 'hydrated child session is runnable')
      const childReq2 = stub.state.requests.at(-1)
      const sys2 = childReq2.body.messages.find((m) => m.role === 'system')?.content ?? ''
      assert.ok(sys2.startsWith(WORKER_SYSTEM_PROMPT), '2nd run re-assembles the WORKER system (options.system wins)')
      assert.ok(!childReq2.tools.includes('task'), '2nd run still excludes task') // stub records tool NAMES
    } finally {
      await rm(dir2, { recursive: true, force: true })
    }
  }

  section('6: background job lifecycle — queued → done with timing fields')
  {
    const h = await boot()
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [
      { description: 'bg1' }, { description: 'bg2' }, { description: 'bg3' }, { description: 'bg4' },
    ], background: true }
    stub.state.childDelayMs = 40
    const events = await collect(h.ctx.agent.stream('spawn background batch'))
    // ADAPT: the parent's final is the stub's turn-2 text ('batch done.') — the
    // descriptors ride the tool_result (still IMMEDIATE: before any child runs).
    const toolResult = events.find((e) => e.type === 'tool_result' && e.name === 'task' && /"jobId"/.test(String(e.result)))
    assert.ok(toolResult, 'jobIds returned immediately in the tool result')
    const parsed = JSON.parse(String(toolResult.result).match(/\[[\s\S]*\]/)[0])
    assert.equal(parsed.length, 4, 'four job descriptors')
    assert.ok(parsed.every((j) => j.jobId && j.sessionId && j.description), 'descriptor shape')
    assert.ok(events.some((e) => e.type === 'final'), 'parent still completed')
    const svc = h.ctx.subagent
    assert.equal(svc.jobs().length, 4, 'registry populated')
    // because runWaves starts on setImmediate, jobs are observable as 'queued' synchronously
    assert.ok(svc.jobs().every((j) => j.status === 'queued' || j.status === 'running' || j.status === 'done'), 'status transitions sane')
    // wait for completion
    await waitFor(() => svc.jobs().every((j) => j.status === 'done' || j.status === 'failed'), 8000, 'jobs settle')
    assert.ok(svc.jobs().every((j) => j.status === 'done'), 'all done')
    assert.ok(svc.jobs().every((j) => typeof j.startedAt === 'number' && typeof j.finishedAt === 'number'), 'timestamps set')
    assert.ok(svc.jobs().every((j) => typeof j.result === 'string'), 'result recorded')
    // ADAPT: plan's loop asserted x === x (tautology) — make it the real link.
    for (const j of svc.jobs()) assert.equal(h.ctx.sessions.require(j.sessionId).jobId, j.jobId, 'child.sessionId ↔ job link')
    const bgChild = h.ctx.sessions.require(svc.jobs()[0].sessionId)
    assert.equal(bgChild.kind, 'subagent')
    assert.ok(bgChild.jobId, 'background child has jobId')
    assert.equal(h.events.filter((e) => e.type === 'subagent/start').length, 4)
    assert.equal(h.events.filter((e) => e.type === 'subagent/done').length, 4)
  }

  section('6: step-limit child burns maxSteps → failed job + failed injection; sibling ok (spec 10.10)')
  {
    const h = await boot()
    stub.state.parentMode = 'task'
    // always_tool: every child turn is a tool call until the loop budget dies.
    // Task A caps maxSteps: 1 → step 1 spends the budget on the tool call, so
    // the run ends step_limit WITHOUT a final report. Task B keeps the default
    // budget → its second turn sees the tool result and answers normally.
    stub.state.childMode = 'always_tool'
    stub.state.taskArgs = { tasks: [
      { description: 'step-limited child', maxSteps: 1 },
      { description: 'normal sibling' },
    ], background: true }
    const events = await collect(h.ctx.agent.stream('spawn step-limit + sibling'))
    const toolResult = events.find((e) => e.type === 'tool_result' && e.name === 'task' && /"jobId"/.test(String(e.result)))
    assert.ok(toolResult, 'jobIds returned immediately in the tool result')
    const parsed = JSON.parse(String(toolResult.result).match(/\[[\s\S]*\]/)[0])
    assert.equal(parsed.length, 2, 'two job descriptors')
    const svc = h.ctx.subagent
    await waitFor(() => svc.jobs().length === 2 && svc.jobs().every((j) => j.status === 'done' || j.status === 'failed'), 8000, 'jobs settle')
    const lim = svc.job(parsed[0].jobId)
    const sib = svc.job(parsed[1].jobId)
    // (1) the step-limit job FAILED
    assert.equal(lim.status, 'failed', 'job status failed')
    // (2) the error explains the step limit
    assert.equal(lim.error, 'step limit reached without a final answer', 'error names the step limit')
    // (3) both timing fields are populated
    assert.equal(typeof lim.startedAt, 'number', 'startedAt set (wave did start this job)')
    assert.equal(typeof lim.finishedAt, 'number', 'finishedAt set at settle')
    // (4) the parent session received the FAILED injection
    await waitFor(() => {
      const parent = h.ctx.sessions.get(lim.parentSessionId)
      return parent?.messages.some((m) => m.role === 'user' && String(m.content).includes(`[job ${lim.jobId} selesai] status: failed`))
    }, 8000, 'failed injection appended to the parent session')
    const parent = h.ctx.sessions.get(lim.parentSessionId)
    const inj = parent.messages.find((m) => m.role === 'user' && String(m.content).includes(`[job ${lim.jobId} selesai]`))
    assert.match(String(inj.content), /status: failed/, 'injection status failed')
    assert.match(String(inj.content), /step limit/i, 'injection carries the step-limit error')
    // (5) the sibling completed normally
    assert.equal(sib.status, 'done', 'sibling job done')
    assert.equal(typeof sib.result, 'string', 'sibling result recorded')
    assert.equal(h.ctx.sessions.require(sib.sessionId).status !== 'working', true, 'sibling child not stuck working')
  }

  section('6: blocking abort mid-wave → all results aborted')
  {
    const h = await boot({ subagent: { maxParallel: 2 } })
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'slow a' }, { description: 'slow b' }, { description: 'slow c' }] }
    stub.state.childDelayMs = 300
    const ac = new AbortController()
    const gen = h.ctx.agent.stream('spawn then abort', undefined, { signal: ac.signal })
    // ADAPT: `until(tool_call)` parks the generator BEFORE tools.call runs
    // (children would never start), and subagent/start fires at REGISTRATION
    // (before any child HTTP) — wait for a real child REQUEST instead, so the
    // abort lands mid-wave with children genuinely in flight.
    const events = []
    const drained = (async () => { for await (const ev of gen) events.push(ev) })()
    await waitFor(() => stub.state.requests.some((r) => r.isChild), 5000, 'first child request in flight')
    ac.abort() // children in flight — mid-wave abort
    await drained
    assert.ok(events.some((e) => e.type === 'final' || e.type === 'cancelled'), 'run ended')
    await waitFor(() => h.events.filter((e) => e.type === 'subagent/done').length >= 1, 3000, 'children settled')
    // child sessions must not stay 'working'
    const children = h.ctx.sessions.list().filter((s) => s.kind === 'subagent')
    assert.ok(children.length >= 1)
    await waitFor(() => children.every((c) => c.status !== 'working'), 3000, 'no child stuck working')
  }

  section('6: background abort DURING spawn run — queued/running job transitions (spec 10.10)')
  {
    const h = await boot({ subagent: { maxParallel: 2 } })
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'a' }, { description: 'b' }, { description: 'c' }], background: true }
    stub.state.childDelayMs = 400 // children slow enough that wave 2 never starts
    const ac = new AbortController()
    const gen = h.ctx.agent.stream('background then abort soon', undefined, { signal: ac.signal })
    await until(gen, (e) => e.type === 'tool_result' && e.name === 'task' && /"jobId"/.test(String(e.result)), 'jobIds returned')
    await waitFor(() => h.events.filter((e) => e.type === 'subagent/start').length >= 2, 3000, 'wave 1 registered (2 of 3)')
    ac.abort() // Stop WHILE the spawn run is still active → link aborts (spec §5)
    const rest = await collect(gen)
    assert.ok(rest.some((e) => e.type === 'cancelled' || e.type === 'final'), 'spawn run ended')
    const svc = h.ctx.subagent
    await waitFor(() => svc.jobs().every((j) => j.status === 'failed' || j.status === 'done'), 8000, 'jobs settled')
    const failed = svc.jobs().filter((j) => j.status === 'failed')
    assert.ok(failed.length >= 2, 'at least the 3 batch jobs failed')
    const neverStarted = svc.jobs().filter((j) => j.startedAt === undefined)
    const didStart = svc.jobs().filter((j) => j.startedAt !== undefined)
    assert.ok(neverStarted.length >= 1, 'wave 2 job was still queued at abort')
    assert.ok(neverStarted.every((j) => j.error === 'aborted before start'), 'queued → failed: exact spec §7.1 error')
    assert.ok(neverStarted.every((j) => j.finishedAt !== undefined), 'queued failure still records finishedAt')
    assert.ok(didStart.every((j) => j.error === 'aborted' && j.finishedAt !== undefined), 'running → failed(aborted) with startedAt+finishedAt')
    // child sessions must not stay 'working'
    const children = h.ctx.sessions.list().filter((s) => s.kind === 'subagent')
    assert.equal(children.length, 3, 'all three children exist')
    await waitFor(() => children.every((c) => c.status !== 'working'), 3000, 'no child stuck working')
  }

  section('6: background jobs survive a LATER parent run abort (spec 10.11, detached)')
  {
    const h = await boot({ subagent: { maxParallel: 2 } })
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'bg-x' }, { description: 'bg-y' }], background: true }
    stub.state.childDelayMs = 120
    // run 1: no abort at all — link never fires, jobs detach from this run
    const run1 = await collect(h.ctx.agent.stream('spawn background, finish normally'))
    assert.ok(run1.find((e) => e.type === 'final'), 'run 1 completed')
    const svc = h.ctx.subagent
    const refs = svc.jobs().slice() // detached records
    assert.equal(refs.length, 2, 'two jobs')
    const sid = refs[0].parentSessionId // spec 10.11: "a later PARENT run's Stop" — MUST be the same parent session (a different sid would make the abort trivially unrelated)
    // run 2: a LATER run on the SAME parent session with its own controller; aborting IT must not touch run 1's detached jobs
    stub.state.parentMode = 'always_tool'
    const ac2 = new AbortController()
    const gen2 = h.ctx.agent.stream('second run, then Stop', sid, { signal: ac2.signal })
    await until(gen2, (e) => e.type === 'turn_started', 'run 2 active')
    ac2.abort()
    await collect(gen2)
    // run 1's detached jobs still complete on their own
    await waitFor(() => refs.every((j) => j.status === 'done'), 8000, 'detached bg jobs completed despite run 2 Stop')
    assert.ok(refs.every((j) => j.error === undefined), 'no abort leaked into detached jobs')
    assert.ok(refs.every((j) => typeof j.startedAt === 'number' && typeof j.finishedAt === 'number'), 'timing fields intact')
  }

  section('6: config guard — invalid block refuses host boot')
  {
    await assert.rejects(
      () => createHost({ subagent: { maxParallel: 0 } }),
      /"maxParallel" must be an integer >= 1/,
    )
  }

  section('7: background result auto-injects + auto-wakes exactly once')
  {
    const h = await boot()
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'quick check' }], background: true }
    const events = await collect(h.ctx.agent.stream('please run a bg task'))
    const final = events.find((e) => e.type === 'final')
    assert.ok(final, 'parent turn finished')
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    // job settles → injection pushed → flush → wake
    await waitFor(() => startsFor(h, sid) === 2, 8000, 'wake ran') // seq-deduped: run=1 + wake=1
    const msgs = h.ctx.sessions.require(sid).messages
    const jobMsgs = msgs.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[job '))
    assert.equal(jobMsgs.length, 1, 'exactly one injection message')
    const jobId = svc.jobs()[0].jobId
    assert.equal(jobMsgs[0].content, `[job ${jobId} selesai] status: ok\nchild ok.`, 'EXACT injection format')
    const st = svc.state(sid)
    assert.equal(st.pending, 0, 'drained')
    assert.equal(st.wakeBlocked, false, 'not blocked')
    // wake turn saw the injection (last user message at wake request time)
    await waitFor(() => stub.state.requests.some((r) => r.isWake), 3000, 'a wake request happened')
    const wakeReq = stub.state.requests.find((r) => r.isWake)
    assert.ok(wakeReq.lastUser.startsWith('[job '), 'wake context carries the injection')
  }

  section('10.9(a): job finishes WHILE parent still streaming — inject waits for turn end')
  {
    const h = await boot()
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'fast one' }], background: true }
    stub.state.childDelayMs = 30
    const gen = h.ctx.agent.stream('long parent turn with bg task')
    // park at the task tool result (the batch is now registered, children running)
    await until(gen, (e) => e.type === 'tool_result' && e.name === 'task' && /"jobId"/.test(String(e.result)), 'task tool_result with jobId')
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    // job finishes mid-turn → pending grows, NO wake yet (busy)
    await waitFor(() => svc.jobs()[0]?.status === 'done', 8000, 'job done')
    const st = svc.state(sid)
    assert.equal(st.pending, 1, 'injection queued while parent busy')
    assert.equal(st.busy, true, 'parent still streaming')
    assert.equal(startsFor(h, sid), 1, 'no wake yet')
    // finish the parent turn → flush runs → wake
    await collect(gen)
    await waitFor(() => startsFor(h, sid) === 2, 8000, 'wake after turn end')
    assert.equal(svc.state(sid).pending, 0, 'drained after wake')
    const msgs = h.ctx.sessions.require(sid).messages
    assert.ok(msgs.some((m) => m.role === 'user' && m.content.startsWith('[job ')), 'injection present')
  }

  section('10.9(c-i): two jobs settle together — TWO injections, ONE wake')
  {
    const h = await boot({ subagent: { maxParallel: 2 } })
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'A' }, { description: 'B' }], background: true }
    stub.state.slowTag = 'SLOW'
    stub.state.slowExtraMs = 300
    stub.state.wakeDelayMs = 500 // slow wake so the window is observable
    const gen = h.ctx.agent.stream('two bg tasks')
    await until(gen, (e) => e.type === 'final', 'final')
    await collect(gen) // release the run mutex — a parked-at-final generator still holds it (Task 5)
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    await waitFor(() => svc.state(sid).pending === 0 && svc.jobs().every((j) => j.status === 'done'), 8000, 'all settled')
    const msgs = h.ctx.sessions.require(sid).messages
    const jobMsgs = msgs.filter((m) => m.role === 'user' && m.content.startsWith('[job '))
    assert.equal(jobMsgs.length, 2, 'both injections appended')
    const finalStarts = startsFor(h, sid)
    assert.equal(finalStarts, 2, `exactly ONE wake turn (run=1 + wake=1), got ${finalStarts}`)
    await waitFor(() => stub.state.requests.filter((r) => r.isWake).length === 1, 3000, 'one wake HTTP request')
  }

  section('10.9(c-ii): three jobs in one busy window — single flush batches all injections')
  {
    const h = await boot({ subagent: { maxParallel: 3 } })
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'x' }, { description: 'y' }, { description: 'z' }], background: true }
    stub.state.childDelayMs = 50 // all settle within one busy window
    // Keep run0 BUSY while the children settle (~60-80ms): without a slow parent
    // turn the jobs land after run0's final and the single-flush claim depends on
    // same-tick coalescing (flaky). parentDelayMs delays each parent turn.
    stub.state.parentDelayMs = 100
    const gen = h.ctx.agent.stream('three bg tasks')
    await until(gen, (e) => e.type === 'final', 'final')
    await collect(gen) // release the run mutex (generator parked at final)
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    await waitFor(() => svc.state(sid).pending === 0 && svc.jobs().every((j) => j.status === 'done'), 8000, 'settled')
    const msgs = h.ctx.sessions.require(sid).messages
    const jobMsgs = msgs.filter((m) => m.role === 'user' && m.content.startsWith('[job '))
    assert.equal(jobMsgs.length, 3, 'all three injected')
    assert.equal(startsFor(h, sid), 2, `single wake despite 3 jobs`)
    await waitFor(() => stub.state.requests.filter((r) => r.isWake).length === 1, 3000, 'one wake request for the batch')
  }

  section('10.9(b): job settles DURING an active wake — drained after finally, SECOND wake fires')
  {
    const h = await boot({ subagent: { maxParallel: 1 } }) // sequential waves: job 2 runs while wake 1 is active
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'j1' }, { description: 'j2' }], background: true }
    stub.state.childDelayMs = 400 // job1 done ~400ms, job2 done ~800ms
    stub.state.wakeDelayMs = 600  // wake1 (starts ~400ms) still active when job2 settles
    const gen = h.ctx.agent.stream('two sequential bg jobs')
    await until(gen, (e) => e.type === 'final', 'final')
    await collect(gen) // release the run mutex (generator parked at final)
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    // wake1 must be running when job2 pushes its injection (spec 10.9(b))
    await waitFor(() => svc.state(sid).waking === true && svc.jobs().filter((j) => j.status === 'done').length === 1, 8000, 'wake1 active, job1 done')
    // job2 settles mid-wake → pending grows; wake1 must NOT lose it
    await waitFor(() => svc.jobs().every((j) => j.status === 'done'), 8000, 'job2 done during wake1')
    await waitFor(() => startsFor(h, sid) === 3, 10000, 'second wake fired after wake1 finally')
    assert.equal(svc.state(sid).pending, 0, 'injection from mid-wake was drained, none lost')
    const msgs = h.ctx.sessions.require(sid).messages
    const jobMsgs = msgs.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[job '))
    assert.equal(jobMsgs.length, 2, 'both injections present')
    await waitFor(() => stub.state.requests.filter((r) => r.isWake).length === 2, 3000, 'exactly two wake HTTP requests')
  }

  section('10.9(d): autoResume=false — injection delivered, never wakes')
  {
    const h = await boot({ subagent: { autoResume: false } })
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'q' }], background: true }
    const gen = h.ctx.agent.stream('bg with autoresume off')
    await until(gen, (e) => e.type === 'final', 'final')
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    await waitFor(() => svc.jobs()[0]?.status === 'done', 8000, 'job done')
    await waitFor(() => svc.state(sid).pending === 0, 3000, 'injection delivered (queue drained)')
    const st = svc.state(sid)
    assert.equal(st.wakeBlocked, true, 'flagged blocked (no auto-resume)')
    assert.equal(startsFor(h, sid), 1, 'no wake turn')
    const msgs = h.ctx.sessions.require(sid).messages
    assert.ok(msgs.some((m) => m.role === 'user' && m.content.startsWith('[job ')), 'injection appended to history')
    // a later flush must still not wake while autoResume is false
    await svc.flush(sid)
    assert.equal(startsFor(h, sid), 1, 'flush never wakes with autoResume=false')
    assert.equal(stub.state.requests.filter((r) => r.isWake).length, 0, 'zero wake HTTP requests')
  }

  section('13(c): parent cancelled mid-turn → injection STILL lands, wake runs on next turn')
  {
    const h = await boot()
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'late job' }], background: true }
    stub.state.childDelayMs = 200 // job settles after we cancel the run
    const gen = h.ctx.agent.stream('cancel me after spawn')
    await until(gen, (e) => e.type === 'tool_result' && e.name === 'task' && /"jobId"/.test(String(e.result)), 'task tool_result with jobId')
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    await gen.return(undefined) // abandon mid-turn → Task 5 cleanup marks cancelled
    assert.equal(h.ctx.sessions.require(sid).status, 'cancelled', 'parent cancelled')
    const svc = h.ctx.subagent
    await waitFor(() => svc.jobs()[0]?.status === 'done', 8000, 'job finished despite cancelled parent')
    // pending===1 is transient (scheduleFlush drains it on the next setImmediate —
    // sub-ms window a 25ms poll never sees); assert the PERSISTENT outcome instead:
    // the injection landed in history and the queue is drained.
    await waitFor(
      () => svc.state(sid).pending === 0 && h.ctx.sessions.require(sid).messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[job ')),
      3000, 'injection delivered after cancel',
    )
    // cancelled session is NOT busy → flush should run → wake starts turn 2
    await waitFor(() => startsFor(h, sid) === 2, 8000, 'wake after cancellation')
    const msgs = h.ctx.sessions.require(sid).messages
    assert.ok(msgs.some((m) => m.role === 'user' && m.content.startsWith('[job ')), 'injection in history')
    assert.equal(svc.state(sid).pending, 0, 'drained')
  }

  section('14: empty flush no-op — finally→scheduleFlush chain performs zero extra wakes')
  {
    const h = await boot()
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'single bg' }], background: true }
    const gen = h.ctx.agent.stream('one bg job')
    await until(gen, (e) => e.type === 'final', 'final')
    await collect(gen) // release the run mutex (generator parked at final)
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    await waitFor(() => startsFor(h, sid) === 2, 8000, 'the real wake ran')
    await waitFor(() => svc.state(sid).pending === 0 && svc.jobs().every((j) => j.status === 'done'), 8000, 'settled')
    // spec 14: the wake's finally → scheduleFlush → runFlush chain must find
    // nothing pending and perform ZERO further wakes — wait past the immediate
    // chain, then prove a manual flush is equally inert
    await new Promise((r) => setTimeout(r, 300))
    const wakesBefore = stub.state.requests.filter((r) => r.isWake).length
    const startsBefore = startsFor(h, sid)
    await svc.flush(sid)
    await svc.flush(sid)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(startsFor(h, sid), startsBefore, 'no extra turn_started from the chain or manual flushes')
    assert.equal(stub.state.requests.filter((r) => r.isWake).length, wakesBefore, 'no extra wake HTTP requests')
    assert.equal(startsBefore, 2, 'still exactly run + one wake')
  }

  section('7: svc.state on an unknown session does NOT create it; flush is idempotent')
  {
    const h = await boot()
    const svc = h.ctx.subagent
    const view = svc.state('s-nonexistent')
    assert.deepEqual(view, { pending: 0, busy: false, wakeBlocked: false, waking: false }, 'fresh literal')
    assert.equal(h.ctx.sessions.list().some((s) => s.id === 's-nonexistent'), false, 'no session created')
    await svc.flush('s-nonexistent') // must not throw, must not create
    const real = h.ctx.sessions.create({ title: 'idle host' }) // hosts start with zero sessions
    const sid = real.id
    const before = startsFor(h, sid)
    await svc.flush(sid) // nothing pending → no wake
    assert.equal(startsFor(h, sid), before, 'idle flush is a no-op')
  }

  section('15(a)+(b): failed wake → parent failed + blocked; finally/manual flushes inject but never wake')
  {
    const h = await boot({ subagent: { maxParallel: 2 } })
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'j1' }, { description: 'j2 SLOW' }], background: true }
    stub.state.slowTag = 'SLOW'; stub.state.slowExtraMs = 150 // j2 pushes DURING wake 1 (mid-wake)
    stub.state.wakeMode = 'error'; stub.state.errorDelayMs = 250 // wake 1 fails AFTER j2 pushed
    const gen = h.ctx.agent.stream('batch that will fail its wake')
    await until(gen, (e) => e.type === 'final', 'final')
    await collect(gen) // release the run mutex (generator parked at final)
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    await waitFor(() => svc.state(sid).wakeBlocked === true, 8000, 'wakeBlocked set by the failure')
    await waitFor(() => svc.jobs().every((j) => j.status === 'done'), 8000, 'jobs done')
    await waitFor(() => svc.state(sid).pending === 0, 3000, 'the failure\'s OWN finally-flush injected the kept pending')
    await sleep(600) // any would-be retry would show up here
    // spec 15(a): parent `failed`, wakeBlocked set, pending KEPT (== delivered, never dropped)
    assert.equal(h.ctx.sessions.require(sid).status, 'failed', 'parent session marked failed')
    assert.equal(svc.state(sid).wakeBlocked, true, 'still blocked (no trigger happened)')
    assert.equal(svc.state(sid).pending, 0, 'queue empty (kept → injected)')
    const msgs = h.ctx.sessions.require(sid).messages
    const jobMsgs = msgs.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[job '))
    assert.equal(jobMsgs.length, 2, 'both injections delivered despite the failure')
    // spec 15(b): no wake from the failure's finally chain, none from manual flushes
    assert.equal(startsFor(h, sid), 2, 'run0 + ONE failed wake; zero retries')
    await waitFor(() => stub.state.requests.filter((r) => r.isWake).length === 1, 3000, 'exactly one wake HTTP attempt')
    await svc.flush(sid); await svc.flush(sid)
    await sleep(200)
    assert.equal(startsFor(h, sid), 2, 'subsequent flushes start NO wake while blocked')
    assert.equal(svc.state(sid).wakeBlocked, true, 'manual flush does not clear the block')
  }

  section('15(c-i): trigger (i) new job completion re-arms — fires exactly once, no user run involved')
  {
    const h = await boot({ subagent: { maxParallel: 1 } }) // sequential waves: job1's settle arms wake1, job2 settles much later
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'first' }, { description: 'second' }], background: true }
    stub.state.childDelayMs = 500 // job1 done ~500ms (arms wake1), job2 starts after → done ~1000ms
    stub.state.wakeMode = 'error'; stub.state.errorDelayMs = 100 // wake1 fails ~600ms — BEFORE job2 settles (the sole later trigger)
    const gen = h.ctx.agent.stream('two jobs, first wake fails')
    await until(gen, (e) => e.type === 'final', 'final')
    await collect(gen) // release the run mutex (generator parked at final)
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    await waitFor(() => svc.state(sid).wakeBlocked === true, 8000, 'blocked after wake1 failed')
    assert.equal(startsFor(h, sid), 2, 'run0 + failed wake1 only — and no user run ends from here on')
    assert.equal(svc.jobs().filter((j) => j.status === 'done').length, 1, 'job2 still pending — block precedes trigger (i)')
    stub.state.wakeMode = 'answer' // heal so the re-armed wake can succeed
    // job2 settles → pushInjection = trigger (i) — the ONLY trigger between block and wake2
    await waitFor(() => svc.jobs().every((j) => j.status === 'done'), 8000, 'job2 settled (trigger i)')
    await waitFor(() => startsFor(h, sid) === 3, 8000, 'exactly one re-armed wake')
    await sleep(400)
    assert.equal(startsFor(h, sid), 3, 'fires EXACTLY ONCE (no third wake)')
    assert.equal(svc.state(sid).wakeBlocked, false, 'cleared by trigger (i) + successful wake')
    assert.equal(svc.state(sid).pending, 0, 'drained')
    await waitFor(() => stub.state.requests.filter((r) => r.isWake).length === 2, 3000, 'failed attempt + one success')
    const jobMsgs = h.ctx.sessions.require(sid).messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[job '))
    assert.equal(jobMsgs.length, 2, 'both injections present')
  }

  section('15(c-ii): trigger (ii) user-run end re-arms INDEPENDENTLY — then a new batch wakes exactly once')
  {
    const h = await boot()
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'one' }], background: true }
    stub.state.wakeMode = 'error'; stub.state.errorDelayMs = 100
    const gen = h.ctx.agent.stream('fail the first wake')
    await until(gen, (e) => e.type === 'final', 'final')
    await collect(gen) // release the run mutex (generator parked at final)
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    await waitFor(() => svc.state(sid).wakeBlocked === true, 8000, 'blocked after wake1 failed')
    const failedStarts = startsFor(h, sid)
    assert.equal(failedStarts, 2, 'run0 + failed wake1')
    assert.equal(svc.state(sid).pending, 0, 'queue empty — the single job was delivered by the flush that armed wake1')

    // Phase A — trigger (ii) ALONE: a plain user run on the SAME parent sid, no
    // jobs created (parentMode 'answer' makes the stub reply without tools).
    // wakeMode is deliberately left 'error': any spurious wake attempt during
    // this phase would re-block and fail the assertions below.
    stub.state.parentMode = 'answer'
    assert.equal(svc.state(sid).wakeBlocked, true, 'precondition: still blocked right before the user run')
    const gen2 = h.ctx.agent.stream('plain user turn that re-arms the queue', sid) // sid REQUIRED — omitting it would prove nothing (new session)
    const userEvents = await collect(gen2)
    assert.ok(userEvents.some((e) => e.type === 'final'), 'user run completed')
    await sleep(300) // a wrongly-scheduled wake would start here
    assert.equal(svc.state(sid).wakeBlocked, false, 'spec 15(c-ii): user-run end cleared the block (trigger ii), with zero jobs involved')
    assert.equal(svc.state(sid).pending, 0, 'still empty — no job completion was involved')
    assert.equal(startsFor(h, sid), failedStarts + 1, 'run0 + wake1 + user run; NO wake turn fired')
    await waitFor(() => stub.state.requests.filter((r) => r.isWake).length === 1, 3000, 'still only the failed wake HTTP — nothing to deliver ⇒ no wake')

    // Phase B — trigger (i): a NEW background batch on the SAME sid wakes exactly once
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'two' }], background: true }
    stub.state.wakeMode = 'answer' // heal so the batch wake can succeed
    const gen3 = h.ctx.agent.stream('spawn the second batch', sid)
    await until(gen3, (e) => e.type === 'final', 'final')
    await collect(gen3) // release the run mutex (generator parked at final)
    await waitFor(() => startsFor(h, sid) === failedStarts + 3, 8000, 'spawn run + exactly one batch wake')
    await sleep(400)
    assert.equal(startsFor(h, sid), failedStarts + 3, 'exactly one wake for the new batch (failedStarts + user run + spawn + wake)')
    assert.equal(svc.state(sid).wakeBlocked, false, 'remained clear')
    assert.equal(svc.state(sid).pending, 0, 'drained')
    await waitFor(() => stub.state.requests.filter((r) => r.isWake).length === 2, 3000, 'one failed + one successful wake HTTP total')
    const jobMsgs = h.ctx.sessions.require(sid).messages.filter((m) => m.role === 'user' && m.content.startsWith('[job '))
    assert.equal(jobMsgs.length, 2, 'both batches injected')
  }

  section('15(d): wake losing mutex contention = deferral ONLY (no wakeBlocked, no failed status)')
  {
    const h = await boot()
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'd1' }, { description: 'd2 SLOW' }], background: true }
    stub.state.childDelayMs = 150 // d1 settles ~150ms (after run0 final), d2 ~400ms
    stub.state.slowTag = 'SLOW'; stub.state.slowExtraMs = 250
    const run0 = h.ctx.agent.stream('spawn the 15d batch')
    await until(run0, (e) => e.type === 'final', 'final run0')
    await collect(run0) // release the run mutex (generator parked at final)
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    // From now on the USER's run is slow and plain-answering: it will win the
    // mutex against wake1 and stay active while d2 settles (~400ms) — 800ms
    // delay guarantees d2's push happens strictly during the user run.
    stub.state.parentMode = 'answer'
    stub.state.parentDelayMs = 800
    const realStream = h.ctx.agent.stream.bind(h.ctx.agent)
    let userGen = null
    h.ctx.agent.stream = (prompt, sessionId, options) => {
      if (prompt === '' && sessionId === sid && !userGen) {
        userGen = realStream('user interrupt during wake', sessionId, options)
        void userGen.next().catch(() => {}) // acquires the mutex synchronously
        return realStream(prompt, sessionId, options) // the wake then loses → busy error (deferral path 1)
      }
      return realStream(prompt, sessionId, options)
    }
    try {
      await waitFor(() => userGen, 5000, 'wake attempt contended, user run created')
      // spec 15(d): contention is NOT a failure and NOT a block
      assert.equal(svc.state(sid).wakeBlocked, false, 'mutex contention does not set wakeBlocked')
      assert.equal(h.events.filter((e) => e.type === 'error' && e.sessionId === sid).length, 0, 'no error end event')
      assert.notEqual(h.ctx.sessions.require(sid).status, 'failed', 'status is not failed')
      // d2 settles DURING the user run → pending=1 (no wake possible while busy)
      await waitFor(() => svc.state(sid).pending === 1, 8000, 'd2 injected while user run active')
      const userRest = await collect(userGen)
      assert.ok(userRest.some((e) => e.type === 'final'), 'user run completed')
    } finally {
      h.ctx.agent.stream = realStream
      stub.state.parentDelayMs = 0
    }
    // user-run end (trigger ii) → flush delivers d2 + fires the deferred wake ONCE
    await waitFor(() => startsFor(h, sid) === 3, 8000, 'deferred wake after user run end')
    await sleep(300)
    assert.equal(startsFor(h, sid), 3, 'run0 + user run + exactly one wake')
    assert.equal(svc.state(sid).wakeBlocked, false, 'still not blocked')
    assert.equal(svc.state(sid).pending, 0, 'drained')
    await waitFor(() => stub.state.requests.filter((r) => r.isWake).length === 1, 3000, 'only the deferred wake hit HTTP (contended attempt died pre-HTTP)')
    assert.equal(h.ctx.sessions.require(sid).status, 'completed', 'healthy final status')
    const jobMsgs = h.ctx.sessions.require(sid).messages.filter((m) => m.role === 'user' && m.content.startsWith('[job '))
    assert.equal(jobMsgs.length, 2, 'both injections delivered')
  }

  section('13(e): user turn overtakes a pending wake — injection before prompt, NO rescheduled wake')
  {
    const h = await boot()
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'bg for 13e' }], background: true }
    stub.state.childDelayMs = 120 // job settles AFTER run0 final and AFTER our wrapper is armed
    const run0 = h.ctx.agent.stream('spawn the 13e batch')
    await until(run0, (e) => e.type === 'final', 'final run0')
    await collect(run0) // release the run mutex (generator parked at final)
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    stub.state.parentMode = 'answer'
    // Arm the takeover wrapper BEFORE the job settles: the wake's stream('')
    // call starts the USER's run first (mutex acquired synchronously on .next()),
    // so the wake loses contention — but the flush has ALREADY appended the
    // injection, which therefore sits BEFORE the user prompt.
    const realStream = h.ctx.agent.stream.bind(h.ctx.agent)
    let userGen = null
    h.ctx.agent.stream = (prompt, sessionId, options) => {
      if (prompt === '' && sessionId === sid && !userGen) {
        userGen = realStream('user question that overtakes the wake', sessionId, options)
        void userGen.next().catch(() => {})
        return realStream(prompt, sessionId, options) // wake → busy error (deferral, not failure)
      }
      return realStream(prompt, sessionId, options)
    }
    try {
      await waitFor(() => userGen, 5000, 'wake attempt contended')
      const userRest = await collect(userGen)
      assert.ok(userRest.some((e) => e.type === 'final'), 'user turn completed')
    } finally {
      h.ctx.agent.stream = realStream
    }
    await waitFor(() => svc.state(sid).pending === 0, 8000, 'queue settled')
    const msgs = h.ctx.sessions.require(sid).messages
    const injIdx = msgs.findIndex((m) => m.role === 'user' && m.content.startsWith('[job '))
    const userIdx = msgs.findIndex((m) => m.role === 'user' && m.content === 'user question that overtakes the wake')
    assert.ok(injIdx !== -1 && userIdx !== -1, 'both messages present')
    assert.ok(injIdx < userIdx, 'injection appended BEFORE the user prompt (flush won the append race)')
    // the injection also rides the winner's FIRST-TURN request context
    const userReq = stub.state.requests.find((r) => r.lastUser === 'user question that overtakes the wake')
    assert.ok(userReq, 'user run request captured')
    const userMsgIdx = userReq.body.messages.findIndex((m) => m.role === 'user' && m.content === 'user question that overtakes the wake')
    const ctxIdx = userReq.body.messages.findIndex((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[job '))
    assert.ok(ctxIdx !== -1 && ctxIdx < userMsgIdx, 'injection is in the first-turn context, before the prompt')
    // NO rescheduled wake: pending was empty at user-run end (flush no-op) and
    // the contended attempt died BEFORE any HTTP request (mutex at run start)
    assert.equal(startsFor(h, sid), 2, 'run0 + user run are the ONLY turns (no orchestrator wake)')
    await sleep(500) // a wrongly-rescheduled wake would appear here
    assert.equal(stub.state.requests.filter((r) => r.isWake).length, 0, 'zero wake HTTP requests')
    assert.equal(svc.state(sid).wakeBlocked, false, 'contention left no block (no wake-pending marker)')
    assert.equal(svc.state(sid).pending, 0, 'drained')
    assert.notEqual(h.ctx.sessions.require(sid).status, 'failed', 'parent never failed')
  }

  section('16(a): unload aborts the active wake — cancelled end event, no re-arm, no further flush')
  {
    const h = await boot()
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'wake fodder' }], background: true }
    stub.state.wakeDelayMs = 800 // long wake so we can dispose mid-flight
    const gen = h.ctx.agent.stream('spawn then dispose during wake')
    await until(gen, (e) => e.type === 'final', 'final')
    await collect(gen) // release the run mutex (generator parked at final)
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    await waitFor(() => svc.state(sid).waking === true, 3000, 'wake in flight')
    const startsBefore = startsFor(h, sid)
    await h.dispose()
    hosts.splice(hosts.indexOf(h), 1)
    await sleep(300) // abort → wake epilogue lands here
    assert.equal(endsFor(h, sid, 'cancelled'), 1, 'spec 16(a): aborted wake produced the cancelled end event')
    assert.equal(startsFor(h, sid), startsBefore, 'no new turn_started after dispose (no re-arm)')
    assert.deepEqual(svc.state(sid), { pending: 0, busy: false, wakeBlocked: false, waking: false }, 'state reset to empty view')
    assert.equal(svc.state(sid).pending, 0, 'pending dropped')
    await svc.flush(sid)
    await sleep(200)
    assert.equal(startsFor(h, sid), startsBefore, 'manual flush after unload starts no wake (no further flush)')
  }

  section('16(b): dispose with queued + running background jobs → aborted records, registry cleared')
  {
    const h = await boot({ subagent: { maxParallel: 2 } })
    stub.state.parentMode = 'task' // plan omission: boot() resets parentMode to 'answer'
    stub.state.taskArgs = { tasks: [{ description: 'r1' }, { description: 'r2' }, { description: 'q1' }, { description: 'q2' }], background: true }
    stub.state.childDelayMs = 400
    const gen = h.ctx.agent.stream('four bg jobs, dispose while two run')
    await until(gen, (e) => e.type === 'final', 'final')
    await collect(gen) // release the run mutex (generator parked at final)
    const svc = h.ctx.subagent
    await waitFor(() => svc.jobs().filter((j) => j.status === 'running').length === 2, 3000, 'two running')
    const refs = svc.jobs().map((j) => j) // live record objects — survive jobs.clear()
    await h.dispose()
    hosts.splice(hosts.indexOf(h), 1)
    const running = refs.filter((j) => j.startedAt !== undefined)
    const queued = refs.filter((j) => j.startedAt === undefined)
    assert.equal(running.length, 2, 'two were running')
    assert.equal(queued.length, 2, 'two were queued')
    assert.ok(running.every((j) => j.status === 'failed' && j.error === 'aborted (unload)'), 'running → aborted (unload)')
    assert.ok(running.every((j) => typeof j.startedAt === 'number' && typeof j.finishedAt === 'number'), 'timing kept')
    assert.ok(queued.every((j) => j.status === 'failed' && j.error === 'aborted before start (unload)'), 'queued → aborted before start')
    assert.ok(queued.every((j) => j.startedAt === undefined), 'queued never got startedAt')
    assert.ok(queued.every((j) => typeof j.finishedAt === 'number'), 'queued cancelled at unload still records finishedAt (settle time, spec §7.1)')
    assert.equal(svc.jobs().length, 0, 'spec 16(c): registry cleared after mutation')
    await sleep(600) // in-flight children must not flip records (or re-insert) after unload
    assert.ok(refs.every((j) => j.status === 'failed'), 'records stable after unload')
    assert.equal(svc.jobs().length, 0, 'late callbacks re-insert nothing')
  }

  section('16(c): dispose with a queued injection → pending cleared, no wake, no crash')
  {
    const h = await boot()
    stub.state.parentMode = 'task'
    stub.state.taskArgs = { tasks: [{ description: 'late' }], background: true }
    stub.state.childDelayMs = 60
    // plan omission: parent turn2 (final) completes instantly by default, so the
    // parent is NOT busy when the job settles at +60ms → flush drains pending
    // before polling can see it. Hold the parent busy so pending===1 is durable.
    stub.state.parentDelayMs = 500
    const gen = h.ctx.agent.stream('bg then dispose before flush')
    await until(gen, (e) => e.type === 'tool_result' && e.name === 'task' && /"jobId"/.test(String(e.result)), 'task tool_result with jobId')
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    await waitFor(() => svc.jobs()[0]?.status === 'done', 8000, 'job done')
    await waitFor(() => svc.state(sid).pending === 1, 3000, 'queued (busy parent blocks flush)')
    const startsBefore = startsFor(h, sid)
    await h.dispose()
    hosts.splice(hosts.indexOf(h), 1)
    assert.equal(svc.state(sid).pending, 0, 'spec 16(c): pending dropped on unload')
    await sleep(300)
    assert.equal(startsFor(h, sid), startsBefore, 'no wake after unload')
    await gen.return(undefined) // driver cleanup must not throw
  }

  section('16(d): late job-completion callback after unload writes nothing (record, pending, turn_started)')
  {
    const h = await boot()
    stub.state.parentMode = 'task' // plan omission: boot() resets parentMode to 'answer'
    stub.state.taskArgs = { tasks: [{ description: 'long child' }], background: true }
    stub.state.childDelayMs = 400
    const gen = h.ctx.agent.stream('bg child, unload quickly')
    await until(gen, (e) => e.type === 'final', 'final')
    await collect(gen) // release the run mutex (generator parked at final)
    const sid = h.events.find((e) => e.type === 'subagent/start').parentSessionId
    const svc = h.ctx.subagent
    await waitFor(() => svc.jobs().some((j) => j.status === 'running'), 3000, 'child running')
    const childJob = svc.jobs().find((j) => j.status === 'running') // ref captured PRE-dispose (spec: "a callback that captured pre-dispose state")
    const childSid = childJob.sessionId
    const startsBefore = startsFor(h, sid)
    const sessionsSvc = h.ctx.sessions // root accessor returns undefined once the service fiber disposes — capture pre-dispose
    await h.dispose()
    hosts.splice(hosts.indexOf(h), 1)
    await sleep(600) // past childDelayMs — the child's settle callback fires HERE, post-unload
    assert.equal(childJob.status, 'failed', 'late callback did NOT overwrite the aborted record with done')
    assert.equal(childJob.error, 'aborted (unload)', 'aborted error preserved')
    assert.equal(svc.jobs().length, 0, 'late callback re-inserted nothing into the cleared registry')
    const child = sessionsSvc.require(childSid)
    assert.notEqual(child.status, 'working', 'child not stuck working after unload')
    assert.equal(svc.state(sid).pending, 0, 'late callback appended nothing to pending')
    assert.equal(startsFor(h, sid), startsBefore, 'late callback caused no turn_started')
    assert.equal(stub.state.requests.filter((r) => r.isWake).length, 0, 'zero wake requests in this section')
  }

  section('extra: no subagent/* events emitted during disposal')
  {
    const h = await boot({ subagent: { maxParallel: 1 } })
    stub.state.parentMode = 'task' // plan omission: boot() resets parentMode to 'answer'
    stub.state.taskArgs = { tasks: [{ description: 'e1' }, { description: 'e2' }], background: true }
    stub.state.childDelayMs = 300
    const gen = h.ctx.agent.stream('events during dispose')
    await until(gen, (e) => e.type === 'final', 'final')
    await collect(gen) // release the run mutex (generator parked at final)
    await waitFor(() => h.events.some((e) => e.type === 'subagent/start'), 3000, 'started')
    const countBefore = h.events.filter((e) => e.type === 'subagent/done').length
    await h.dispose()
    hosts.splice(hosts.indexOf(h), 1)
    await sleep(500)
    const countAfter = h.events.filter((e) => e.type === 'subagent/done').length
    // children settling post-dispose must NOT emit (guarded by disposed)
    assert.equal(countAfter, countBefore, 'no subagent/done after unload')
  }
} finally {
  for (const host of hosts) await host.dispose()
  await stubLlm.close()
  await rm(dir, { recursive: true, force: true })
}
console.log('subagent: OK')
