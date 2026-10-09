import type { Context } from 'cordis'
import type { ResolvedSubagent, SubagentConfig } from '../config.js'
import { validateSubagent } from '../config.js'
import type { SessionData } from '../services/session.js'
import type { ToolContext } from '../services/tools.js'
import type { RunEvent } from '../types.js'
import { isSessionBusyError } from './agent.js'

/** Worker system prompt (spec §6.1) — content pinned by tests. */
export const WORKER_SYSTEM_PROMPT =
  'You are a Switchboard worker subagent, an isolated copy of the agent for one delegated task. ' +
  'Your entire task is contained in the user message: the description plus optional context. ' +
  'Do not ask clarifying questions; make reasonable assumptions and finish the work with the tools you have. ' +
  'You may NOT delegate further — the `task` tool is not available to you. ' +
  'When done, reply with a single concise final report of what you did and found, with no preamble.'

export interface TaskSpec { description: string; context?: string; model?: string; maxSteps?: number }
export interface ValidatedTaskArgs { tasks: TaskSpec[]; background: boolean }

/**
 * All-or-nothing args validation (spec §4.2). Returns { error } with the
 * EXACT message `Error: task: <detail>` (kunci bernama), never throws.
 * Unknown fields inside a task → warn only.
 */
export function validateTaskArgs(raw: unknown, warn: (m: string) => void = () => {}): ValidatedTaskArgs | { error: string } {
  const fail = (detail: string) => ({ error: `Error: task: ${detail}` })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('tasks must be an array of task objects')
  const obj = raw as Record<string, unknown>
  const list = obj.tasks
  if (!Array.isArray(list)) return fail('tasks must be an array of task objects')
  if (list.length === 0) return fail('tasks must contain at least one task')
  const tasks: TaskSpec[] = []
  for (let i = 0; i < list.length; i++) {
    const t = list[i]
    if (typeof t !== 'object' || t === null || Array.isArray(t)) return fail(`tasks[${i}] must be an object`)
    // Field errors carry the batch key as a TRAILING `(tasks[i])` — both
    // spec §4.2 test shapes must match on the same string:
    // `Error: task: maxSteps must be an integer >= 1` AND `tasks[1]`.
    const failField = (detail: string) => fail(`${detail} (tasks[${i}])`)
    const rec = t as Record<string, unknown>
    if (typeof rec.description !== 'string' || rec.description.trim() === '') return failField('description must be a non-empty string')
    if (rec.context !== undefined && typeof rec.context !== 'string') return failField('context must be a string')
    if (rec.model !== undefined && (typeof rec.model !== 'string' || rec.model === '')) return failField('model must be a non-empty string')
    if (rec.maxSteps !== undefined && (typeof rec.maxSteps !== 'number' || !Number.isInteger(rec.maxSteps) || !Number.isFinite(rec.maxSteps) || rec.maxSteps < 1)) {
      return failField('maxSteps must be an integer >= 1')
    }
    // misplaced/typed `background` inside a task entry (spec §4.2 test matrix)
    if (rec.background !== undefined && typeof rec.background !== 'boolean') return failField('"background" must be a boolean')
    for (const key of Object.keys(rec)) {
      if (!['description', 'context', 'model', 'maxSteps'].includes(key)) warn(`task: tasks[${i}]: unknown field "${key}"`)
    }
    tasks.push({
      description: rec.description,
      ...(rec.context !== undefined ? { context: rec.context as string } : {}),
      ...(rec.model !== undefined ? { model: rec.model as string } : {}),
      ...(rec.maxSteps !== undefined ? { maxSteps: rec.maxSteps as number } : {}),
    })
  }
  if (obj.background !== undefined && typeof obj.background !== 'boolean') return fail('"background" must be a boolean')
  return { tasks, background: obj.background === true }
}

export interface JobRecord {
  jobId: string
  sessionId: string
  parentSessionId: string
  description: string
  status: 'queued' | 'running' | 'done' | 'failed'
  startedAt?: number
  finishedAt?: number
  result?: string
  error?: string
}

export const childPrompt = (task: TaskSpec): string =>
  [task.description, task.context ? `Context:\n${task.context}` : null,
   'When the task is done, report your results concisely as a single final message.']
    .filter((x): x is string => x !== null)
    .join('\n\n')

export interface SubagentRunState { pending: number; busy: boolean; wakeBlocked: boolean; waking: boolean }
export interface SubagentService {
  jobs(): JobRecord[]
  job(id: string): JobRecord | undefined
  state(sessionId: string): SubagentRunState
  flush(sessionId: string): Promise<void>
}

const EMPTY_VIEW: SubagentRunState = { pending: 0, busy: false, wakeBlocked: false, waking: false }

/** One delivered-result message waiting for (or past) its wake (spec §7.2). */
export interface Injection { jobId: string; body: string }

/** Per-parent-session inject/wake state (spec §7.2). */
interface ParentState {
  pending: Injection[]
  busy: boolean
  wakeToken?: symbol
  wakeBlocked: boolean
  flushScheduled: boolean
}

type Outcome = { description: string; status: 'ok' | 'failed'; result?: string; error?: string; sessionId: string }

export const subagent = {
  name: 'subagent',
  inject: ['agent', 'sessions', 'tools', 'workspace'],

  apply(ctx: Context, config?: SubagentConfig) {
    const resolved: ResolvedSubagent = validateSubagent(config, (m) => ctx.logger('subagent').warn('%s', m))
    // Session service instance captured while still active: the sessions fiber
    // disposes BEFORE this plugin (registry order), so `ctx.sessions` is gone by
    // teardown time — but the instance itself keeps serving setStatus calls.
    const sessionsRef = ctx.sessions
    const jobs = new Map<string, JobRecord>()
    const controllers = new Map<string, AbortController>() // per child, for unload
    const limitHit = new Map<string, string>() // child -> why a budget stopped it
    const parents = new Map<string, ParentState>() // per-parent inject/wake state
    let jobSeq = 0
    let disposed = false

    // ---- inject/wake state (spec §7.2) ---------------------------------------
    const ensureParent = (id: string): ParentState => {
      let st = parents.get(id)
      if (!st) {
        // Seed busy from the LIVE status only at first sight — a parent that is
        // mid-turn when its first result lands must not be woken.
        const status = ctx.sessions.get(id)?.status
        st = { pending: [], busy: status === 'working' || status === 'waiting_approval', wakeBlocked: false, flushScheduled: false }
        parents.set(id, st)
      }
      return st
    }

    const scheduleFlush = (id: string): void => {
      const st = parents.get(id)
      if (!st || disposed || st.flushScheduled) return
      st.flushScheduled = true
      setImmediate(() => {
        st.flushScheduled = false
        void runFlush(id)
      })
    }

    const appendInjections = (id: string, batch: Injection[]): void => {
      const session = ctx.sessions.get(id)
      if (!session) return
      for (const inj of batch) session.messages.push({ role: 'user', content: inj.body })
      void ctx.sessions.flush() // persistence parity with the rest of the codebase
    }

    const wakeController = new AbortController() // shared wake signal (aborted on unload)

    const runFlush = async (id: string): Promise<void> => {
      if (disposed) return
      const st = parents.get(id) // NO ensure — unknown parent → bail
      if (!st || st.pending.length === 0) return
      if (st.busy || st.wakeToken) return
      if (!ctx.sessions.get(id)) { st.pending = []; return } // session gone → discarded

      const batch = st.pending.splice(0, st.pending.length)
      appendInjections(id, batch) // spec §7.2 step 6: injection ALWAYS delivered…
      if (!resolved.autoResume) { st.wakeBlocked = true; return } // …only the wake is gated
      if (st.wakeBlocked) return // step 7: stay down until trigger (i) pushInjection or (ii) user-turn end

      const token = Symbol('wake')
      st.wakeToken = token
      let sawFinal = false
      try {
        for await (const raw of ctx.agent.stream('', id, { signal: wakeController.signal })) {
          const ev = raw as { type: string }
          if (ev.type === 'final') sawFinal = true
        }
        const status = ctx.sessions.require(id).status
        if (!sawFinal && status === 'failed') throw new Error('wake ended without a final (session failed)')
        if (!sawFinal && status === 'cancelled') throw new Error('wake was cancelled')
      } catch (err) {
        if (disposed) return
        const message = err instanceof Error ? err.message : String(err)
        if (isSessionBusyError(err)) {
          ctx.logger('subagent').info('wake for %c skipped: %s', id, message) // parent running → retrigger later, NOT a failure
        } else {
          ctx.logger('subagent').error('wake for %c failed: %s', id, message)
          st.wakeBlocked = true
        }
      } finally {
        const cur = parents.get(id)
        if (cur?.wakeToken === token) cur.wakeToken = undefined
        if (!disposed) scheduleFlush(id) // drain injections that arrived during the wake
      }
    }

    const pushInjection = (id: string, inj: Injection): void => {
      if (disposed) return
      const st = ensureParent(id)
      st.pending.push(inj)
      st.wakeBlocked = false // trigger (i): a result arrived
      scheduleFlush(id)
    }

    /** Exact injection body (spec §7.2) — pinned by tests. */
    const injectionBody = (jobId: string, o: Outcome): string =>
      `[job ${jobId} selesai] status: ${o.status === 'ok' ? 'ok' : 'failed'}\n${o.status === 'ok' ? (o.result ?? '') : (o.error ?? 'failed')}`

    // ---- child driving (spec §4.3) -------------------------------------------
    /** Drives ONE pre-created worker session to completion. Session registration
     *  and subagent/start emission live in runEntry (batch semantics, spec §9). */
    const runChild = async (
      child: SessionData, task: TaskSpec, link: AbortController,
      onStart: () => void,
    ): Promise<Outcome> => {
      // one controller per worker, chained to the batch's: a worker over its token budget stops alone
      const own = new AbortController()
      const chain = (): void => own.abort()
      if (link.signal.aborted) own.abort()
      else link.signal.addEventListener('abort', chain, { once: true })
      controllers.set(child.id, own)
      onStart()
      try {
        let ok = false
        let result: string | undefined
        let error: string | undefined
        const gen = ctx.agent.stream(childPrompt(task), child.id, {
          signal: own.signal,
          system: WORKER_SYSTEM_PROMPT,
          model: task.model,
          maxSteps: task.maxSteps ?? resolved.maxSteps,
          // workers report back to the parent; they neither delegate further nor save notes or skills
          excludeTools: ['task', 'remember', 'propose_skill'],
        })
        for await (const raw of gen) {
          const ev = raw as unknown as { type: string; content?: string; stopReason?: 'answer' | 'step_limit'; error?: string; steps?: number }
          if (ev.type === 'final') {
            ok = ev.stopReason !== 'step_limit' // Task 2 adds the field; absence (undefined) counts as an answer
            result = ev.content ?? ''
            if (!ok) error = 'step limit reached without a final answer'
          } else if (ev.type === 'cancelled') {
            error = 'aborted'
          } else if (ev.type === 'error') {
            error = ev.error ?? 'child error'
          }
        }
        const limit = limitHit.get(child.id)
        if (limit) {
          ok = false
          error = limit
        }
        if (!ok && !error) error = 'child produced no answer'
        if (!disposed) ctx.emit('subagent/done', { sessionId: child.id, ok })
        return { description: task.description, status: ok ? 'ok' : 'failed', ...(ok ? { result: result ?? '' } : { error: error ?? 'failed' }), sessionId: child.id }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!disposed) ctx.emit('subagent/done', { sessionId: child.id, ok: false })
        return { description: task.description, status: 'failed', error: message, sessionId: child.id }
      } finally {
        link.signal.removeEventListener('abort', chain)
        controllers.delete(child.id)
        limitHit.delete(child.id)
      }
    }

    // ---- wave pool (spec §4.4): maxParallel waves, outcomes aligned by index ----
    const runWaves = async (
      tasks: TaskSpec[], children: SessionData[], link: AbortController,
      onStart: (index: number) => void, // queued → running (job bookkeeping)
      onUpdate: (index: number, outcome: Outcome) => void,
    ): Promise<Outcome[]> => {
      await new Promise((r) => setImmediate(r)) // jobs observable as 'queued' synchronously after tool_result
      const outcomes: Outcome[] = []
      for (let i = 0; i < tasks.length; i += resolved.maxParallel) {
        // spec §7.1: a wave that never started is `queued → failed 'aborted before
        // start'` when the batch link is aborted (parent Stop) or the plugin
        // disposed. Mark EVERY remaining task (not just this wave) — otherwise a
        // job beyond the first skipped wave would sit `queued` forever.
        if (disposed || link.signal.aborted) {
          const why = disposed ? 'aborted before start (unload)' : 'aborted before start'
          for (let j = i; j < tasks.length; j++) {
            const skipped: Outcome = { description: tasks[j].description, status: 'failed', error: why, sessionId: children[j].id }
            onUpdate(j, skipped)
            outcomes[j] = skipped
          }
          break
        }
        const wave = tasks.slice(i, i + resolved.maxParallel)
        await Promise.all(wave.map(async (task, w) => {
          const idx = i + w
          if (disposed || link.signal.aborted) {
            const why = disposed ? 'aborted before start (unload)' : 'aborted before start'
            const aborted: Outcome = { description: task.description, status: 'failed', error: why, sessionId: children[idx].id }
            onUpdate(idx, aborted)
            outcomes[idx] = aborted
            return
          }
          const outcome = await runChild(children[idx], task, link, () => onStart(idx))
          outcomes[idx] = outcome
          onUpdate(idx, outcome)
        }))
      }
      return outcomes
    }

    // ---- budgets: a worker that uses more than maxWorkerTokens is stopped on its own
    ctx.on('llm/metrics', (result) => {
      if (disposed || !resolved.maxWorkerTokens || !result.sessionId) return
      const own = controllers.get(result.sessionId)
      if (!own || own.signal.aborted) return
      const used = Object.values(ctx.sessions.get(result.sessionId)?.usage?.byModel ?? {}).reduce((n, row) => n + row.promptTokens + row.completionTokens, 0)
      if (used > resolved.maxWorkerTokens) {
        limitHit.set(result.sessionId, `worker stopped: it used ${used.toLocaleString('en-US')} tokens (subagent.maxWorkerTokens is ${resolved.maxWorkerTokens.toLocaleString('en-US')}). Narrow the task or raise the limit.`)
        own.abort()
      }
    })

    /** All-or-nothing check before any worker starts; returns the refusal text, or undefined when fine. */
    const overBudget = (parentSid: string, wanted: number): string | undefined => {
      const started = ctx.sessions.list().filter((s) => s.kind === 'subagent' && s.parentSessionId === parentSid).length
      if (started + wanted > resolved.maxWorkers) {
        return `Error: task: worker limit — this session already started ${started} worker(s) and asked for ${wanted} more (subagent.maxWorkers is ${resolved.maxWorkers}). Do the remaining work yourself, or ask the user to raise the limit.`
      }
      const usage = ctx.get('usage', false)
      if (!usage) return undefined
      const spent = usage.summary(parentSid, { workersOnly: true })
      const tokens = spent.promptTokens + spent.completionTokens
      if (resolved.maxTokens && tokens >= resolved.maxTokens) {
        return `Error: task: token budget used — this session's workers already used ${tokens.toLocaleString('en-US')} tokens (subagent.maxTokens is ${resolved.maxTokens.toLocaleString('en-US')}). Do the remaining work yourself, or ask the user to raise the limit.`
      }
      if (resolved.maxCostUsd !== undefined && spent.costUsd !== undefined && spent.costUsd >= resolved.maxCostUsd) {
        return `Error: task: cost budget used — this session's workers cost about $${spent.costUsd.toFixed(2)} (subagent.maxCostUsd is $${resolved.maxCostUsd}). Do the remaining work yourself, or ask the user to raise the limit.`
      }
      return undefined
    }

    // ---- batch entry (tool `execute` → runEntry) ------------------------------
    const runEntry = async (parentSid: string, raw: unknown, toolSignal?: AbortSignal): Promise<string> => {
      const validated = validateTaskArgs(raw, (m) => ctx.logger('subagent').warn('%s', m))
      if ('error' in validated) return validated.error
      const { tasks, background } = validated
      const refused = overBudget(parentSid, tasks.length)
      if (refused) return refused

      // jobIds BEFORE session creation so background children carry jobId (spec §6.2)
      const jobIds = background ? tasks.map(() => `j-${Date.now().toString(36)}-${(++jobSeq).toString(36)}`) : []
      const parent = ctx.sessions.require(parentSid)
      const children = tasks.map((task, i) => ctx.sessions.create({
        title: task.description.replace(/\s+/g, ' ').slice(0, 72),
        system: WORKER_SYSTEM_PROMPT,
        projectRoot: parent.projectRoot ?? ctx.workspace.root,
        model: parent.model,
        provider: parent.provider,
        kind: 'subagent',
        parentSessionId: parentSid,
        ...(background && { jobId: jobIds[i] }),
      }))
      // spec §9: one subagent/start PER child at registration, tasks = batch count
      for (const child of children) {
        ctx.emit('subagent/start', { sessionId: child.id, parentSessionId: parentSid, tasks: tasks.length })
      }

      if (!background) {
        const link = new AbortController()
        toolSignal?.addEventListener('abort', () => link.abort(), { once: true })
        const outcomes = await runWaves(tasks, children, link, () => {}, () => {})
        const payload = outcomes.map((o) => ({
          description: o.description, status: o.status,
          ...(o.status === 'ok' ? { result: o.result ?? '' } : { error: o.error ?? 'failed' }),
        }))
        return JSON.stringify(payload, null, 2)
      }

      // background: jobs queued, return descriptors now (waves start on setImmediate)
      const descriptors = tasks.map((task, i) => {
        jobs.set(jobIds[i], { jobId: jobIds[i], sessionId: children[i].id, parentSessionId: parentSid, description: task.description, status: 'queued' })
        return { jobId: jobIds[i], sessionId: children[i].id, description: task.description }
      })
      const link = new AbortController()
      // spec §5: background IS linked to the parent run signal — inert on a normal
      // end (the controller is only aborted via the 'abort' event), but a parent
      // Stop during the spawn run fails queued jobs 'aborted before start' and
      // aborts the running wave. Detached jobs from earlier completed runs stay safe.
      toolSignal?.addEventListener('abort', () => link.abort(), { once: true })
      void runWaves(
        tasks, children, link,
        (i) => {
          if (disposed) return // spec 16(d): bookkeeping stops at unload
          const j = jobs.get(jobIds[i]); if (j && j.status === 'queued') { j.status = 'running'; j.startedAt = Date.now() }
        },
        (i, o) => {
          if (disposed) return // spec 16(d): a late settle callback writes nothing
          const j = jobs.get(jobIds[i]); if (!j) return
          j.finishedAt = Date.now()
          if (o.status === 'ok') { j.status = 'done'; j.result = o.result }
          else { j.status = 'failed'; j.error = o.error ?? 'failed' }
          // background results flow into the parent via inject/wake (spec §7.2)
          pushInjection(parentSid, { jobId: jobIds[i], body: injectionBody(jobIds[i], o) })
        },
      ).catch((err) => ctx.logger('subagent').error('background batch failed: %s', err instanceof Error ? err.message : err))
      return JSON.stringify(descriptors, null, 2)
    }

    if (resolved.enabled) {
      ctx.effect(() => ctx.tools.register({
        name: 'task',
        description:
          'Delegate one or more independent tasks to isolated Switchboard worker subagents. ' +
          'Each task gets its own session with no memory of this conversation. ' +
          'Runs tasks in parallel (up to subagent.maxParallel). ' +
          'Set background: true to get jobIds immediately and continue chatting; results are injected as messages later.',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              description: 'Tasks to run in parallel.',
              items: {
                type: 'object',
                properties: {
                  description: { type: 'string', description: 'What to accomplish — self-contained.' },
                  context: { type: 'string', description: 'Optional extra background for the worker.' },
                  model: { type: 'string', description: 'Optional model id override for this task.' },
                  maxSteps: { type: 'number', description: 'Optional per-task step budget (>=1).' },
                },
                required: ['description'],
                additionalProperties: false,
              },
            },
            background: { type: 'boolean', description: 'Return jobIds immediately instead of waiting.' },
          },
          required: ['tasks'],
          additionalProperties: false,
        },
        execute: async (args: unknown, tctx: ToolContext): Promise<string> => {
          if (!tctx.sessionId) return 'Error: task: no parent session (ToolContext.sessionId missing)'
          return runEntry(tctx.sessionId, args, tctx.signal)
        },
      }))
    }

    // ---- inject/wake listeners (cordis auto-cleans these per fiber) ----------
    ctx.on('run/event', (ev: RunEvent) => {
      if (disposed || !ev.sessionId) return
      const st = parents.get(ev.sessionId) // only parents we already track
      if (!st) return
      if (ev.type === 'turn_started') { st.busy = true; return }
      if (ev.type === 'turn_completed' || ev.type === 'cancelled' || ev.type === 'error') {
        const wasWake = st.wakeToken !== undefined
        st.busy = false
        st.wakeToken = undefined
        if (!wasWake) st.wakeBlocked = false // trigger (ii): a user turn ended
        scheduleFlush(ev.sessionId)
      }
    })
    ctx.on('agent/done', (ev: { sessionId: string }) => {
      if (!disposed) scheduleFlush(ev.sessionId)
    })

    // Unload (Task 9 / spec §8 teardown, pinned order):
    // 1. disposed — blocks every async continuation (guards check at callback time)
    // 2. abort the in-flight wake (cancelled end event, no re-arm, no further flush)
    // 3. freeze job records (queued/running → failed + finishedAt), abort children
    // 4. reset ParentState view → EMPTY_VIEW (svc.state() keeps answering)
    // 5. jobs.clear() AFTER mutation — tests hold live record refs across unload
    ctx.effect(() => () => {
      disposed = true
      wakeController.abort()
      for (const job of jobs.values()) {
        if (job.status === 'queued') {
          job.status = 'failed'
          job.error = 'aborted before start (unload)'
          job.finishedAt = Date.now() // settle time is real even though it never started
        } else if (job.status === 'running') {
          job.status = 'failed'
          job.error = 'aborted (unload)'
          job.finishedAt = Date.now()
        }
      }
      for (const controller of controllers.values()) controller.abort()
      // In-flight children abort asynchronously; their own setStatus runs in an
      // inactive fiber context (silently swallowed) — freeze their session status
      // HERE, while effect cleanup still has a live context (spec 16(d): no child
      // left 'working' after unload).
      for (const childId of controllers.keys()) {
        try { sessionsRef.setStatus?.(childId, 'cancelled') } catch { /* sessions already gone */ }
      }
      controllers.clear()
      for (const st of parents.values()) {
        st.pending = []
        st.busy = false
        st.wakeToken = undefined
        st.wakeBlocked = false
      }
      parents.clear()
      jobs.clear()
    })

    const api: SubagentService = {
      jobs: () => [...jobs.values()],
      job: (id) => jobs.get(id),
      state: (sessionId) => {
        const st = parents.get(sessionId)
        if (!st) return { ...EMPTY_VIEW }
        return { pending: st.pending.length, busy: st.busy, wakeBlocked: st.wakeBlocked, waking: st.wakeToken !== undefined }
      },
      flush: (sessionId) => runFlush(sessionId),
    }
    ctx.reflect.provide('subagent', api)
  },
}

declare module 'cordis' {
  interface Context {
    subagent?: SubagentService
  }
}
