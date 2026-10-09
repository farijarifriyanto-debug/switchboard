import type { AgentEvent, AgentMessage, GenerateResult, RunEvent, RunEventType, ToolCall } from '../types.js'
import type { Context } from 'cordis'
import type { AgentService, AgentStreamOptions } from '../services/agent.js'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { estimateMessages, trimMessages } from '../context.js'
import { withSkills } from '../services/skills.js'
import { withMemory } from '../services/memory.js'
import type { SessionStatus } from '../services/session.js'

export interface AgentLoopConfig {
  /** System prompt used when a session has none. */
  system?: string
  /** Maximum model turns per run. */
  maxSteps?: number
  /** Temperature forwarded to the model. */
  temperature?: number
  /** Max output tokens per model turn. */
  maxTokens?: number
  /** Soft ceiling for the prompt sent each turn (characters/4 estimate). */
  maxPromptTokens?: number
  /** Recent messages always kept while trimming. */
  keepRecent?: number
  /** Truncate a single tool result to this many characters. */
  maxToolResultChars?: number
}

/** True for the per-session mutex rejection thrown by `stream()` (spec §8). */
export function isSessionBusyError(error: unknown): boolean {
  return error instanceof Error && /^session "[^"]+" is already running$/.test(error.message)
}

export const DEFAULT_SYSTEM_PROMPT = [
  'You are Switchboard, an agent harness running on BotConnector.',
  'You can call tools to inspect files, run commands, search the web (web_search) and fetch web pages (web_fetch).',
  'Prefer the list_dir and search_files tools over shell commands to explore a repository.',
  'Think step by step, call tools when needed, then answer concisely.',
  'When you are done, reply with the final answer and no tool calls.',
].join(' ')

/**
 * Platform line appended to whatever system prompt is in use, so the model
 * always knows which shell it runs in and never gives up after one unknown
 * command (the `ls -R` on cmd.exe failure mode).
 */
export const PLATFORM_HINT =
  process.platform === 'win32'
    ? 'Platform: Windows — the shell is PowerShell, so ls, dir, cat and similar commands work. If a command is not recognized, retry with the Windows equivalent and continue; never claim the task is impossible.'
    : 'Platform: POSIX — the shell is bash. If a command is not recognized, retry with an equivalent command and continue; never claim the task is impossible.'

const DEFAULTS = { maxPromptTokens: 96_000, keepRecent: 4, maxToolResultChars: 24_000 }

/** Per-file cap for AGENTS.md injections (~6k tokens of context). */
export const AGENTS_MD_CAP = 24_000

/**
 * Appends project and global AGENTS.md files to a system prompt (the shared
 * agent-context convention). Missing files are ignored, oversized files are
 * truncated; a failure to read never breaks the prompt.
 */
export function withAgentsMd(base: string, projectRoot: string, globalFile: string): string {
  const parts: string[] = []
  const read = (file: string, marker: string): void => {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return
    }
    if (!text.trim()) return
    let body = text
    if (body.length > AGENTS_MD_CAP) body = `${body.slice(0, AGENTS_MD_CAP)}\n…[AGENTS.md truncated]`
    parts.push(`\n\n# ${marker}\n${body.trimEnd()}`)
  }
  read(path.join(projectRoot, 'AGENTS.md'), 'Project instructions (AGENTS.md)')
  read(globalFile, 'Global instructions (AGENTS.md)')
  return parts.length ? `${base}${parts.join('')}` : base
}

/**
 * Appends a fresh "Today is …" line so the model can resolve relative dates
 * ("today", "latest") and date recent web_search queries. Idempotent: an
 * existing date line is never doubled.
 */
export function withDateContext(base: string, now: Date = new Date()): string {
  if (base.includes('Today is ')) return base
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' })
  let tz = 'local time'
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz
  } catch {
    /* fall back to the generic label */
  }
  return `${base}\n\nToday is ${weekday}, ${y}-${m}-${d} (${tz}). Resolve relative dates ("today", "latest", "this week") against it, and include the date in web_search queries when recency matters.`
}

/** Heading of the per-turn MCP instructions section (spec §6). */
export const MCP_INSTRUCTIONS_HEADING = '## MCP servers'

/**
 * Replaces (or removes) the MCP instructions section of a system prompt.
 * Section text is `### <server>\n<instructions>` blocks joined by a blank
 * line; an empty section restores the base prompt.
 */
export function withMcpInstructions(base: string, section: string): string {
  const marker = `\n${MCP_INSTRUCTIONS_HEADING}`
  const idx = base.startsWith(MCP_INSTRUCTIONS_HEADING) ? 0 : base.indexOf(marker)
  const head = idx === -1 ? base : base.slice(0, idx).replace(/\s+$/, '')
  const body = section.trim()
  if (!body) return head
  return `${head}\n\n${MCP_INSTRUCTIONS_HEADING}\n${body}`
}

/**
 * `agent-loop` — the harness spine.
 *
 * Drives the model, executes tool calls and repeats until the model stops
 * asking for tools. Model turns are streamed, so text reaches the caller as it
 * is produced instead of at the end of the turn. Everything it consumes (llm,
 * tools, sessions) is itself a plugin, so any of them can be swapped.
 */
export const agentLoop = {
  name: 'agent-loop',
  inject: ['llm', 'tools', 'sessions', 'approvals', 'trace', 'workspace'],

  apply(ctx: Context, config: AgentLoopConfig = {}) {
    const base = config.system ?? DEFAULT_SYSTEM_PROMPT
    const platformPrompt = base.includes('Platform:') ? base : `${base} ${PLATFORM_HINT}`
    const globalAgents = path.join(os.homedir(), '.switchboard', 'AGENTS.md')
    const system = withAgentsMd(platformPrompt, ctx.workspace?.root ?? process.cwd(), globalAgents)
    const maxSteps = config.maxSteps ?? 8
    const maxPromptTokens = config.maxPromptTokens ?? DEFAULTS.maxPromptTokens
    const keepRecent = config.keepRecent ?? DEFAULTS.keepRecent
    const maxToolResultChars = config.maxToolResultChars ?? DEFAULTS.maxToolResultChars
    // Per-session run mutex (spec §8): one live run per session id. Scoped to
    // this host instance so an abandoned generator in one host can never block
    // a session id issued by another host.
    const activeRuns = new Map<string, symbol>()

    const service = {
      /** Runs the loop and returns the final assistant text. */
      async run(prompt: string, sessionId?: string): Promise<string> {
        let content = ''
        for await (const ev of service.stream(prompt, sessionId)) {
          if (ev.type === 'final') content = ev.content
        }
        return content
      },

      /**
       * Runs the loop, yielding every step for progressive rendering.
       * Also accepts a continuation of an existing session and an
       * AbortSignal so the caller can cancel a run (stop button).
       */
      async *stream(
        prompt: string,
        sessionId?: string,
        options: AgentStreamOptions = {},
      ): AsyncGenerator<AgentEvent> {
        // --- preset (roadmap stage 2): fills in what the caller did not set ---
        // Explicit per-run options win; excludeTools are unioned. An unknown id
        // is an error when asked for, and ignored when only remembered on a
        // session (the preset was deleted since).
        const presets = ctx.get('presets', false)
        const presetId = options.preset ?? (sessionId ? ctx.sessions.get(sessionId)?.preset : undefined)
        if (presetId && presets) {
          const resolved = presets.resolve(presetId, ctx.tools.list().map((t) => t.name))
          if (!resolved && options.preset) throw new Error(`unknown preset "${presetId}"`)
          if (resolved) {
            options = {
              ...resolved,
              ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
              excludeTools: [...new Set([...(resolved.excludeTools ?? []), ...(options.excludeTools ?? [])])],
            }
          }
        }
        // --- per-run overrides (spec §8): computed BEFORE any mutation ---
        // SessionData has NO `system` field — the system lives as the session's
        // first role:'system' message and the per-turn assembly overwrites it
        // from the base every run. options.system replaces only that BASE.
        const runSystem = (() => {
          if (options.system === undefined) return config.system ?? DEFAULT_SYSTEM_PROMPT // today's closure base
          const raw = options.system
          return raw.includes('Platform:') ? raw : `${raw} ${PLATFORM_HINT}`
        })()
        const session = sessionId
          ? ctx.sessions.require(sessionId)
          : ctx.sessions.create({ title: prompt.slice(0, 60), system: runSystem, projectRoot: ctx.workspace?.root, ...(presetId && presets?.get(presetId) ? { preset: presetId } : {}) })
        // a preset named for an existing session sticks to it
        if (sessionId && options.preset && session.preset !== options.preset && presets?.get(options.preset)) ctx.sessions.setPreset(session.id, options.preset)
        // --- per-session mutex (spec §8): acquire BEFORE any mutation ---
        // The busy check throws BEFORE the system write / message append /
        // turn_started — pure read first, nothing observable changed.
        if (activeRuns.has(session.id)) throw new Error(`session "${session.id}" is already running`)
        const runToken = Symbol(session.id)
        activeRuns.set(session.id, runToken)
        let endEmitted = false // final | step-limit final | epilogue already yielded
        try {
          const runModel = ctx.llm.resolveModel(options.model ?? session.model)
          // Provider chain (spec §7): per-run override > session > config default.
          const runProvider = options.provider ?? session.provider
          const runMaxSteps = options.maxSteps ?? maxSteps
          const exclude = options.excludeTools ?? []
          // Per-turn assembly: runSystem is the base (replaces the closure reference).
          const platformPrompt = runSystem.includes('Platform:') ? runSystem : `${runSystem} ${PLATFORM_HINT}`
          const system = withAgentsMd(platformPrompt, ctx.workspace?.root ?? process.cwd(), globalAgents)
          // Refresh the stored system prompt every turn so the date line never
          // goes stale on a long-running server (boot-time `system` is frozen).
          const datedSystem = withDateContext(system)
          // `ctx.get(..., false)` (not `ctx.mcp`): cordis property access on a
          // runtime plugin requires `inject`, but MCP is an optional service —
          // hosts without an `mcp` block must keep working.
          // Skills: advertise name + description only while the model can actually call load_skill.
          const skillsSvc = ctx.get('skills', false)
          const skillsSection = skillsSvc && !exclude.includes('load_skill') && ctx.tools.get('load_skill') ? await skillsSvc.index() : ''
          const memorySection = (await ctx.get('memory', false)?.section()) ?? ''
          const finalSystem = withMcpInstructions(withMemory(withSkills(datedSystem, skillsSection), memorySection), ctx.get('mcp', false)?.instructions() ?? '')
          const systemIndex = session.messages.findIndex((m) => m.role === 'system')
          if (systemIndex === -1) session.messages.unshift({ role: 'system', content: finalSystem })
          else session.messages[systemIndex] = { role: 'system', content: finalSystem }
          // `/skill-name task` runs that skill: its body travels with the message.
          if (prompt) prompt = (await ctx.get('skills', false)?.expand(prompt)) ?? prompt
          if (prompt) {
            if (!session.messages.some((m) => m.role === 'user') && (!session.title || session.title === 'New task' || session.title === 'untitled')) {
              ctx.sessions.rename(session.id, prompt.replace(/\s+/g, ' ').slice(0, 72))
            }
            ctx.sessions.append(session.id, {
              role: 'user',
              content: prompt,
              ...(options.attachments?.length ? { attachments: options.attachments } : {}),
            })
          }

          const model = runModel
          const signal = options.signal
          // One AbortController per run: it fans out to the LLM request and to
          // every tool call, so Stop really stops the *whole* step chain.
          const controller = new AbortController()
          const onOuterAbort = () => controller.abort()
          if (signal) {
            if (signal.aborted) controller.abort()
            else signal.addEventListener('abort', onOuterAbort, { once: true })
          }
          if (controller.signal.aborted) {
            setStatus(session.id, 'cancelled')
            ctx.emit('run/event', runEvent(session.id, 'cancelled', { status: 'cancelled', label: 'Cancelled' }))
            endEmitted = true // this path already emitted its own end event
            yield { type: 'cancelled' } as unknown as AgentEvent
            return
          }

          setStatus(session.id, 'working')
          ctx.emit('run/event', runEvent(session.id, 'turn_started', { status: 'working', label: 'Started working' }))
          yield { type: 'turn_started' } as unknown as AgentEvent

          let steps = 0
          let aborted = false
          let failed = false

          try {
            while (steps < runMaxSteps) {
              steps += 1
              ctx.emit('agent/step', { step: steps, sessionId: session.id, model })
              ctx.trace?.runEvent(runEvent(session.id, 'step_started', {
                status: 'working',
                label: `Step ${steps}`,
                data: { step: steps },
              }))
              yield { type: 'step', step: steps }

              // Fold old history into a summary before it has to be dropped.
              const compaction = ctx.get('compaction', false)
              if (compaction?.shouldCompact(session.id, session.messages, maxPromptTokens)) {
                const outcome = await compaction.compact(session.id, { model, provider: runProvider, signal: controller.signal })
                if (outcome.ok) {
                  ctx.logger('agent-loop').info('compacted %c messages (~%c -> ~%c tokens)', outcome.summarized, outcome.before, outcome.after)
                  yield { type: 'notice', notice: `compacted ${outcome.summarized} older message(s) into a summary (~${outcome.before} → ~${outcome.after} tokens)` }
                } else {
                  yield { type: 'notice', notice: `could not compact (${outcome.reason}); older messages will be trimmed instead` }
                }
              }

              // Keep the prompt inside the context window.
              const trimmed = trimMessages(session.messages, { maxPromptTokens, keepRecent })
              if (trimmed.dropped > 0) {
                const notice = `trimmed ${trimmed.dropped} older message(s) to fit ~${maxPromptTokens} tokens`
                ctx.logger('agent-loop').info('%c', notice)
                yield { type: 'notice', notice }
              }

              const turn = yield* streamTurn(session.id, {
                model,
                provider: runProvider,
                messages: trimmed.messages,
                temperature: config.temperature,
                maxTokens: config.maxTokens,
                signal: controller.signal,
                exclude,
              })
              if (!turn) {
                // The turn threw (already yielded `error`) or the stream was cut.
                if (controller.signal.aborted) aborted = true
                else failed = true
                break
              }

              const calls: ToolCall[] = turn.toolCalls
              const assistant: AgentMessage = {
                role: 'assistant',
                content: turn.content,
                ...(calls.length ? { tool_calls: calls } : {}),
              }

              if (!calls.length && controller.signal.aborted) {
                aborted = true
                break
              }

              if (!calls.length) {
                ctx.sessions.append(session.id, assistant)
                setStatus(session.id, 'completed')
                ctx.trace?.runEvent(runEvent(session.id, 'turn_completed', {
                  status: 'completed',
                  label: 'Finished',
                }))
                ctx.emit('agent/done', { sessionId: session.id, steps, content: turn.content })
                endEmitted = true
                yield { type: 'final', content: turn.content, steps, stopReason: 'answer' }
                return
              }

              // The assistant turn is only committed once its tool calls are known,
              // so a failed turn never leaves a half-written conversation behind.
              ctx.sessions.append(session.id, assistant)

              for (const call of calls) {
                if (controller.signal.aborted) {
                  aborted = true
                  break
                }
                let args: unknown = {}
                try {
                  args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
                } catch {
                  args = { _raw: call.function.arguments }
                }
                const label = toolLabel(call.function.name, args)
                ctx.trace?.runEvent(runEvent(session.id, 'tool_requested', {
                  label: `Calling ${label}`,
                  data: { name: call.function.name, args, callId: call.id },
                }))
                yield { type: 'tool_call', id: call.id, name: call.function.name, args }

                // Gate: a pending approval flips the session into waiting_approval.
                // Excluded tools are never offered for approval (spec 10.4: "no
                // approval") — the deny check in tools.call surfaces the error.
                if (!exclude.includes(call.function.name) && ctx.approvals.needsApproval(call.function.name, session.id, ctx.tools.get(call.function.name)?.risk)) {
                  setStatus(session.id, 'waiting_approval')
                  ctx.trace?.runEvent(runEvent(session.id, 'approval_needed', {
                    status: 'waiting_approval',
                    label: `Approval needed: ${label}`,
                    data: { name: call.function.name, args, callId: call.id },
                  }))
                  yield { type: 'approval_needed', name: call.function.name, args } as unknown as AgentEvent
                }

                ctx.trace?.runEvent(runEvent(session.id, 'tool_running', {
                  label: `Running ${label}`,
                  data: { name: call.function.name, args, callId: call.id },
                }))
                const startedAt = Date.now()
                const toolCtx = { sessionId: session.id, signal: controller.signal, ...(exclude.length ? { deny: exclude } : {}) }
                let beforeFile: string | undefined
                if (call.function.name === 'write_file' && typeof (args as any)?.path === 'string') {
                  const previous = await ctx.tools.call('read_file', { path: (args as any).path }, toolCtx)
                  beforeFile = previous.startsWith('Error:') ? '' : previous
                }
                let result = await ctx.tools.call(call.function.name, args, toolCtx)
                if (result.length > maxToolResultChars) {
                  const kept = result.slice(0, maxToolResultChars)
                  result = `${kept}\n…[truncated ${result.length - maxToolResultChars} chars]`
                }
                const durationMs = Date.now() - startedAt

                ctx.sessions.append(session.id, {
                  role: 'tool',
                  content: result,
                  tool_call_id: call.id,
                  name: call.function.name,
                })
                ctx.emit('agent/tool', {
                  id: call.id,
                  name: call.function.name,
                  args,
                  result,
                  sessionId: session.id,
                  durationMs,
                })
                const failed1 = result.startsWith('Error:')
                ctx.trace?.runEvent(runEvent(session.id, 'tool_completed', {
                  status: 'working',
                  label: `${failed1 ? 'Failed' : 'Finished'} ${label}`,
                  data: { name: call.function.name, args, callId: call.id, exit: result.startsWith('exit ') ? result.split('\n')[0] : undefined },
                }), result.length > 2_000 ? `${result.slice(0, 2_000)}…` : result)
                if (call.function.name === 'write_file' && !failed1) {
                  ctx.trace?.runEvent(runEvent(session.id, 'file_changed', {
                    label: `Changed ${(args as any)?.path ?? 'file'}`,
                    data: { path: (args as any)?.path, name: 'write_file' },
                  }))
                  yield {
                    type: 'file_changed',
                    path: (args as any)?.path,
                    before: beforeFile ?? '',
                    content: String((args as any)?.content ?? ''),
                  } as unknown as AgentEvent
                }
                yield { type: 'tool_result', id: call.id, name: call.function.name, result }

                // Back to work: the gate cleared one way or another.
                if (ctx.sessions.get(session.id)?.status === 'waiting_approval') {
                  setStatus(session.id, 'working')
                }
              }
              if (aborted) break
            }

            if (steps >= runMaxSteps && !aborted && !failed) {
              const note = `Stopped after ${runMaxSteps} steps without a final answer.`
              setStatus(session.id, 'completed')
              ctx.trace?.runEvent(runEvent(session.id, 'turn_completed', { status: 'completed', label: 'Finished (step limit)' }))
              endEmitted = true
              yield { type: 'final', content: note, steps, stopReason: 'step_limit' }
            }
        } finally {
          if (signal) signal.removeEventListener('abort', onOuterAbort)
        }

        // Cancellation / error epilogue (status is set but no final answer).
        if (aborted) {
          setStatus(session.id, 'cancelled')
          ctx.trace?.runEvent(runEvent(session.id, 'cancelled', { status: 'cancelled', label: 'Cancelled' }))
          endEmitted = true
          yield { type: 'cancelled' } as unknown as AgentEvent
        } else if (failed) {
          setStatus(session.id, 'failed')
          ctx.trace?.runEvent(runEvent(session.id, 'error', { status: 'failed', label: 'Failed' }))
          endEmitted = true
        }
        } finally {
          if (activeRuns.get(session.id) === runToken) activeRuns.delete(session.id)
          if (!endEmitted) {
            // Abandoned (.return()/throw before any end event): leave a
            // terminal status + exactly one trace event. NEVER yield here —
            // finally runs on return-completion, no consumer is listening.
            // Post-unload the fiber context is inactive (service getters throw):
            // a driver's gen.return() must never crash on this cleanup.
            try {
              const cur = ctx.sessions.get(session.id)
              if (cur && cur.status !== 'completed' && cur.status !== 'failed' && cur.status !== 'cancelled') {
                setStatus(session.id, 'cancelled')
              }
              ctx.trace?.runEvent(runEvent(session.id, 'cancelled', { status: 'cancelled', label: 'Cancelled', data: { reason: 'generator abandoned' } }))
            } catch { /* context disposed — nothing left to record */ }
          }
        }
      },
    } as unknown as AgentService

    /** Builds a standard RunEvent with the shared per-run seq, emits + traces it. */
    let seqCounter = 0
    function runEvent(sessionId: string, type: RunEventType, rest: Omit<Partial<RunEvent>, 'type' | 'sessionId'>): RunEvent {
      const ev = { type, sessionId, seq: ++seqCounter, at: Date.now(), ...rest } as RunEvent
      ctx.emit('run/event', ev)
      return ev
    }

    /** Maps session status transitions onto the session store (best effort). */
    function setStatus(id: string, status: SessionStatus): void {
      try {
        ctx.sessions.setStatus?.(id, status)
      } catch {
        /* a missing session must never break the loop */
      }
    }

    /** Human one-liner for a tool call, e.g. "npm test" or "src/foo.ts". */
    function toolLabel(name: string, args: unknown): string {
      const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
      const pick = (k: string) => String(a[k] ?? '')
      return (
        name === 'run_command' ? pick('command') || pick('cmd') || 'command'
        : name === 'read_file' ? pick('path') || 'file'
        : name === 'write_file' ? pick('path') || 'file'
        : name === 'list_dir' ? pick('path') || '.'
        : name === 'search_files' ? pick('pattern') || 'pattern'
        : name === 'web_search' ? pick('query') || 'query'
        : name === 'web_fetch' || name === 'fetch_url' ? pick('url') || 'url'
        : name
      )
    }

    /**
     * Streams one model turn, forwarding deltas as they arrive and remembering
     * the final result for the caller.
     */
    async function* streamTurn(
      sessionId: string,
      opts: {
        model: string
        provider?: string
        messages: AgentMessage[]
        temperature?: number
        maxTokens?: number
        signal?: AbortSignal
        exclude?: string[]
      },
    ): AsyncGenerator<AgentEvent, GenerateResult | undefined> {
      if (opts.signal?.aborted) return undefined
      let result: GenerateResult | undefined
      try {
        const defs = opts.exclude?.length
          ? ctx.tools.defs().filter((d) => !opts.exclude!.includes(d.function.name))
          : ctx.tools.defs()
        for await (const ev of ctx.llm.stream({
          model: opts.model,
          provider: opts.provider,
          messages: opts.messages,
          tools: defs,
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          signal: opts.signal,
          sessionId,
        })) {
          if (ev.type === 'delta') yield { type: 'delta', text: ev.text }
          else if (ev.type === 'reasoning') yield { type: 'reasoning', text: ev.text }
          else if (ev.type === 'done') result = ev.result
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (opts.signal?.aborted || message.includes('aborted')) {
          return undefined // cancellation: not a failure
        }
        ctx.logger('agent-loop').error('turn failed for session %c: %s', sessionId, message)
        ctx.trace?.record({
          kind: 'error',
          sessionId,
          level: 'error',
          summary: 'LLM request failed',
          detail: message,
        })
        yield { type: 'error', error: message }
        return undefined
      }
      if (result) {
        yield { type: 'metrics', metrics: result, ...(ctx.get('usage', false) ? { usage: ctx.get('usage', false)!.summary(sessionId) } : {}) }
      }
      return result
    }

    // Expose `ctx.agent` as a service owned by this plugin's fiber, so Cordis
    // removes it automatically when the plugin unloads.
    ctx.reflect.provide('agent', service)
  },
}

export { estimateMessages }