import { Service } from 'cordis'
import type { Context } from 'cordis'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { expandHome } from './session.js'
import type { RunEvent, TraceEntry } from '../types.js'

export interface TraceConfig {
  /** Ring size in memory (per-session list). 0 disables recording. */
  limit?: number
  /**
   * Optional JSONL mirror so a trace survives a process restart (one file per
   * session under this directory). Empty string disables persistence.
   */
  dir?: string
}

const DEFAULT_DIR = '~/.switchboard/trace'

/**
 * `ctx.trace` — durable record of *protocol-relevant* things: LLM calls with
 * latency/usage, retries, tool calls with exit codes, approvals, fallbacks,
 * errors. Raw model-visible text never goes here; the transcript lives in the
 * session store and details stay in the events themselves.
 *
 * The UI's Trace pane reads `list(sessionId)`; everything else records silently.
 */
export class TraceService extends Service {
  static inject: string[] = []

  private limit: number
  private dir?: string
  /** sessionId -> ring buffer, oldest first. */
  private rings = new Map<string, TraceEntry[]>()
  /** sessionId -> pending JSONL lines awaiting the debounce flush. */
  private dirty = new Map<string, TraceEntry[]>()
  /** sessionId keys already hydrated from the JSONL mirror. */
  private hydrated = new Set<string>()
  /** sessionId -> in-flight hydration. */
  private hydrating = new Map<string, Promise<void>>()
  private seq = 0
  private seenRunEvents = new WeakSet<RunEvent>()
  private timer?: ReturnType<typeof setTimeout>

  constructor(ctx: Context, config: TraceConfig = {}) {
    super(ctx, 'trace')
    this.limit = config.limit ?? 400
    const dir = config.dir === '' ? '' : (config.dir ?? DEFAULT_DIR)
    this.dir = dir ? path.resolve(expandHome(dir)) : undefined

    // Keep telemetry decoupled: services publish protocol events and this
    // observer projects them into the durable trace without requiring DI calls.
    const approvalSessions = new Map<string, string | undefined>()
    ctx.on('run/event', (event) => this.runEvent(event))
    ctx.on('llm/retry', (event) => this.record({
      kind: 'retry', sessionId: event.sessionId, level: 'warn',
      attempt: event.attempt, max: event.max,
      summary: `Retry ${event.attempt}/${event.max}`,
      detail: event.error,
    }))
    ctx.on('llm/fallback', (event) => this.record({
      kind: 'status', sessionId: event.sessionId, level: 'warn',
      summary: `Fallback ${event.from} -> ${event.to}`,
      detail: event.error,
    }))
    ctx.on('llm/metrics', (result) => this.record({
      kind: 'llm', sessionId: result.sessionId, model: result.model,
      ttftMs: result.ttftMs, totalMs: result.totalMs,
      tokensPerSec: result.tokensPerSec,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      cachedTokens: result.usage.cachedTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      level: 'info',
      summary: `${result.model} answered ${result.usage.completionTokens ?? '?'} tok · ttft ${result.ttftMs}ms`,
    }))
    ctx.on('approval/request', (event) => {
      approvalSessions.set(event.id, event.sessionId)
      this.record({
        kind: 'approval', sessionId: event.sessionId, name: event.tool,
        level: 'warn', summary: `Approval requested: ${event.tool}`,
      })
    })
    ctx.on('approval/settled', (event) => {
      this.record({
        kind: 'approval', sessionId: approvalSessions.get(event.id), name: event.tool,
        level: event.decision === 'rejected' || event.decision === 'timeout' || event.decision === 'cancelled' ? 'warn' : 'info',
        summary: `Approval ${event.decision}: ${event.tool}`,
      })
      approvalSessions.delete(event.id)
    })
    ctx.on('session/status', (event) => this.record({
      kind: 'status', sessionId: event.id, level: event.status === 'failed' ? 'error' : 'info',
      summary: `Session ${event.status}`,
    }))
    ctx.on('agent/tool', (event) => this.record({
      kind: 'tool', sessionId: event.sessionId, name: event.name, durationMs: event.durationMs,
      level: event.result.startsWith('Error:') ? 'error' : 'info',
      summary: `${event.result.startsWith('Error:') ? 'Failed' : 'Finished'} ${event.name}`,
      detail: event.result.length > 2_000 ? `${event.result.slice(0, 2_000)}…` : event.result,
    }))
  }

  /** Appends one entry to the in-memory ring (and schedules the JSONL mirror). */
  record(entry: Omit<TraceEntry, 'at'> & { at?: number }): void {
    if (this.limit <= 0) return
    const full: TraceEntry = { at: Date.now(), ...entry } as TraceEntry
    const key = entry.sessionId ?? 'global'
    const ring = this.rings.get(key) ?? []
    ring.push(full)
    if (ring.length > this.limit) ring.splice(0, ring.length - this.limit)
    this.rings.set(key, ring)
    if (this.dir) {
      const pending = this.dirty.get(key) ?? []
      pending.push(full)
      this.dirty.set(key, pending)
      this.schedule()
    }
  }

  /** Records the coarse run-event stream (status changes, tool activity...). */
  runEvent(ev: RunEvent, detail?: string): void {
    if (this.seenRunEvents.has(ev)) return
    this.seenRunEvents.add(ev)
    this.record({
      kind: ev.type,
      sessionId: ev.sessionId,
      level: ev.type === 'error' ? 'error' : ev.status === 'failed' ? 'error' : 'info',
      summary: ev.label ?? humanRunEvent(ev),
      detail,
    })
  }

  /** Newest-first entries for one session (or the global ring).
   *  First read per key hydrates from the JSONL mirror so history survives a restart. */
  async list(sessionId?: string, limit = 200): Promise<TraceEntry[]> {
    const key = sessionId ?? 'global'
    await this.hydrate(key)
    const ring = this.rings.get(key) ?? []
    return ring.slice(-limit).reverse().map((entry) => ({ ...entry }))
  }

  private hydrate(key: string): Promise<void> {
    if (!this.dir || this.hydrated.has(key)) return Promise.resolve()
    let pending = this.hydrating.get(key)
    if (!pending) {
      pending = this.loadKey(key).finally(() => this.hydrating.delete(key))
      this.hydrating.set(key, pending)
    }
    return pending
  }

  private async loadKey(key: string): Promise<void> {
    if (!this.dir) return
    this.hydrated.add(key)
    try {
      const text = await readFile(path.join(this.dir, `${key}.jsonl`), 'utf8')
      const loaded: TraceEntry[] = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { loaded.push(JSON.parse(line) as TraceEntry) } catch { /* skip corrupt line */ }
      }
      if (!loaded.length) return
      const ring = this.rings.get(key) ?? []
      const seen = new Set(ring.map((e) => `${e.at}|${e.kind}|${e.summary ?? ''}`))
      const merged = [...ring, ...loaded.filter((e) => !seen.has(`${e.at}|${e.kind}|${e.summary ?? ''}`))]
      merged.sort((a, b) => a.at - b.at)
      if (merged.length > this.limit) merged.splice(0, merged.length - this.limit)
      this.rings.set(key, merged)
    } catch {
      /* no mirror file yet — ring stays as-is */
    }
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, 300)
    this.timer.unref?.()
  }

  /** Writes every pending line to `<dir>/<sessionId>.jsonl` (atomic per file). */
  async flush(): Promise<void> {
    if (!this.dir || !this.dirty.size) return
    const batches = [...this.dirty.entries()]
    this.dirty.clear()
    for (const [sessionId, entries] of batches) {
      if (!entries.length) continue
      try {
        await mkdir(this.dir, { recursive: true })
        const target = path.join(this.dir, `${sessionId}.jsonl`)
        const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
        await appendFile(target, text, 'utf8')
      } catch {
        /* telemetry must never break a run */
      }
    }
  }
}

/**
 * Fallback human one-liner for a run event with no explicit `label`.
 */
export function humanRunEvent(ev: RunEvent): string {
  switch (ev.type) {
    case 'turn_started': return 'Started working'
    case 'step_started': return `Step ${ev.data?.step ?? ''}`.trim()
    case 'assistant_stream': return 'Generating answer'
    case 'tool_requested': return `Calling ${ev.data?.name ?? 'tool'}`
    case 'tool_running': return `Running ${ev.data?.name ?? 'tool'}`
    case 'tool_completed': return `Finished ${ev.data?.name ?? 'tool'}`
    case 'approval_needed': return 'Waiting for approval'
    case 'file_changed': return `Changed ${(ev.data as any)?.path ?? 'file'}`
    case 'retry': return `Retry ${ev.data?.attempt ?? 1}`
    case 'fallback': return 'Falling back'
    case 'turn_completed': return 'Finished'
    case 'error': return 'Error'
    case 'cancelled': return 'Cancelled'
    case 'status': return String(ev.status ?? 'status')
    default: return ev.type
  }
}

declare module 'cordis' {
  interface Context {
    trace: TraceService
  }
}