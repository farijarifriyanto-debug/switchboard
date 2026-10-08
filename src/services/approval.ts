import { Service } from 'cordis'
import type { Context } from 'cordis'
import { SettingsError } from './settings-error.js'

export type ApprovalMode = 'off' | 'risky' | 'all'
export type Decision = 'approved' | 'approved_session' | 'rejected' | 'timeout' | 'cancelled'
export type OperatorDecision = Exclude<Decision, 'timeout' | 'cancelled'>

export interface ApprovalConfig {
  /** `off` runs tools immediately, `risky` gates mutating tools, `all` gates everything. */
  mode?: ApprovalMode
  /** How long a pending request stays open before auto-rejecting with `timeout`. */
  timeoutMs?: number
}

export interface PendingApproval {
  id: string
  tool: string
  args: unknown
  sessionId?: string
  requestedAt: number
  resolve: (decision: Decision) => void
}

const DEFAULT_TIMEOUT = 120_000

/** Short, single-line description of a tool call for an approval prompt (CLI, channels). */
export function describeToolCall(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>
  const text = tool === 'run_command' ? String(a.command ?? '') : tool === 'write_file' ? `${a.path} (${Buffer.byteLength(String(a.content ?? ''))} bytes)` : JSON.stringify(args ?? {})
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

/** Tools that mutate state or leave the machine — gated by the `risky` mode. */
const RISKY = new Set(['run_command', 'write_file'])

/**
 * `ctx.approvals` — the human gate between the model and a tool.
 *
 * `ToolsService` awaits `request()` before executing anything when a mode is
 * active; the console polls/lists pending items and settles them with
 * `decide()`. Timeout defaults to a rejection so an abandoned gate never hangs
 * a session forever.
 */
export class ApprovalService extends Service {
  static inject: string[] = []

  mode: ApprovalMode
  private timeoutMs: number
  private pending_ = new Map<string, PendingApproval>()
  private seq = 0
  /**
   * Session-scoped grants: `(tool, sessionId) -> expiry`. Granted by the
   * "Allow for this session" decision; checked before every gated call.
   */
  private sessionGrants = new Map<string, number>()
  /** Recent settled decisions, newest first (audit trail for the console). */
  recent: Array<{ id: string; tool: string; decision: Decision; at: number }> = []

  constructor(ctx: Context, config: ApprovalConfig = {}) {
    super(ctx, 'approvals')
    this.mode = config.mode ?? 'off'
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT
  }

  /**
   * Hot-apply for the settings console: validated change takes effect on the
   * NEXT gate call — pending gates keep their current queue (spec §7).
   */
  setMode(mode: unknown): ApprovalMode {
    if (mode !== 'off' && mode !== 'risky' && mode !== 'all') {
      throw new SettingsError(`Unknown approval mode "${String(mode)}".`, {
        status: 400,
        hint: 'Choose off (run immediately), risky (gate mutations) or all (gate every tool).',
      })
    }
    this.mode = mode
    return mode
  }

  /** True when a call to `tool` inside `sessionId` needs an operator decision first. */
  needsApproval(tool: string, sessionId?: string, risk?: 'risky'): boolean {
    if (this.mode === 'off') return false
    if (this.mode === 'all' || RISKY.has(tool) || risk === 'risky') {
      return !this.hasSessionGrant(tool, sessionId)
    }
    return false
  }

  /** True while a session-scoped grant for this tool/session is live. */
  hasSessionGrant(tool: string, sessionId?: string): boolean {
    const key = `${tool}::${sessionId ?? ''}`
    const expires = this.sessionGrants.get(key)
    if (expires === undefined) return false
    if (Date.now() > expires) {
      this.sessionGrants.delete(key)
      return false
    }
    return true
  }

  /** Grants (or checks) the "allow for this session" scope for one tool. */
  grantSession(tool: string, sessionId?: string, ttlMs = 12 * 60 * 60_000): void {
    this.sessionGrants.set(`${tool}::${sessionId ?? ''}`, Date.now() + ttlMs)
  }

  /** Drops every session-scoped grant (called when a session ends/unloads). */
  clearSessionGrants(sessionId?: string): void {
    if (sessionId === undefined) return this.sessionGrants.clear()
    for (const key of this.sessionGrants.keys()) {
      if (key.endsWith(`::${sessionId}`)) this.sessionGrants.delete(key)
    }
  }

  /** Currently unsettled requests, oldest first. */
  pending(): Array<Omit<PendingApproval, 'resolve'>> {
    return [...this.pending_.values()].map(({ resolve, ...rest }) => rest)
  }

  /** Registers a gate and waits for `decide()` or the timeout. */
  async request(tool: string, args: unknown, sessionId?: string, signal?: AbortSignal): Promise<Decision> {
    const id = `ap-${Date.now().toString(36)}-${(++this.seq).toString(36)}`
    return new Promise<Decision>((resolve) => {
      const record: PendingApproval = { id, tool, args, sessionId, requestedAt: Date.now(), resolve }
      this.pending_.set(id, record)
      let settled = false
      const settle = (decision: Decision) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.pending_.delete(id)
        this.settle(id, record.tool, decision)
        resolve(decision)
      }
      const onAbort = () => settle('cancelled')
      const timer = setTimeout(() => settle('timeout'), this.timeoutMs)
      timer.unref?.()
      record.resolve = settle
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      // after the record exists, so a synchronous listener can decide() it
      this.ctx.emit('approval/request', { id, tool, args, sessionId })
    })
  }

  /** Applies an operator decision. Unknown ids are ignored. */
  decide(id: string, decision: OperatorDecision): boolean {
    const record = this.pending_.get(id)
    if (!record) return false
    if (decision === 'approved_session') {
      this.grantSession(record.tool, record.sessionId)
      record.resolve('approved_session')
      return true
    }
    record.resolve(decision)
    return true
  }

  private settle(id: string, tool: string, decision: Decision): void {
    this.recent.unshift({ id, tool, decision, at: Date.now() })
    this.recent = this.recent.slice(0, 50)
    this.ctx.emit('approval/settled', { id, tool, decision })
  }
}

declare module 'cordis' {
  interface Context {
    approvals: ApprovalService
  }
}