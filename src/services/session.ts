import { Service } from 'cordis'
import type { Context } from 'cordis'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentMessage } from '../types.js'

export interface SessionConfig {
  /** Directory holding one JSON file per session. `~` is expanded; `""` disables persistence. */
  dir?: string
  /** Load persisted sessions into memory at startup. */
  load?: boolean
  /** Write changes to disk automatically (debounced). */
  autosave?: boolean
  /** Maximum number of persisted sessions hydrated at startup. */
  max?: number
}

export type SessionStatus = 'working' | 'waiting_approval' | 'idle' | 'failed' | 'completed' | 'cancelled'

export interface SessionData {
  id: string
  title: string
  model?: string
  /** Provider registry id this session chats through (spec §7); unset = config default. */
  provider?: string
  /** Originals of messages folded into a compaction summary (capped; never sent to the model). */
  archived?: AgentMessage[]
  /** Preset id (src/services/presets.ts) applied to every run of this session. */
  preset?: string
  /** Workspace root associated with this session when it was created. */
  projectRoot?: string
  /** Set on delegated worker sessions (spec §6.2). */
  kind?: 'subagent'
  parentSessionId?: string
  /** Background children only (spec §6.2): the job that owns this worker. */
  jobId?: string
  /** Coarse lifecycle state for the sessions list; defaults to `idle`. */
  status?: SessionStatus
  createdAt: number
  updatedAt: number
  messages: AgentMessage[]
}

/** Expands a leading `~` to the user's home directory. */
export function expandHome(input: string): string {
  return input.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE ?? process.env.HOME ?? '.')
}

const DEFAULT_DIR = '~/.switchboard/sessions'
const SAVE_DEBOUNCE_MS = 250

/**
 * `ctx.sessions` — conversation store.
 *
 * Keeps sessions in memory and mirrors them to one JSON file per session, so a
 * conversation survives the process. Writes are atomic (tmp file + rename) and
 * debounced; call `flush()` before exiting to make sure nothing is pending.
 *
 * Swap it for another store (SQLite, Qdrant, ...) by providing the same service
 * name from a different plugin.
 */
export class SessionService extends Service {
  static inject: string[] = []

  readonly dir?: string
  private autosave: boolean
  private max: number
  private sessions = new Map<string, SessionData>()
  private seq = 0
  private dirty = new Set<string>()
  private timer?: ReturnType<typeof setTimeout>

  constructor(ctx: Context, config: SessionConfig = {}) {
    super(ctx, 'sessions')
    const configured = config.dir ?? DEFAULT_DIR
    this.dir = configured === '' ? undefined : path.resolve(expandHome(configured))
    this.autosave = config.autosave !== false
    this.max = config.max ?? 200
  }

  // ---------------------------------------------------------------- reading

  create(options: { id?: string; title?: string; model?: string; provider?: string; preset?: string; system?: string; projectRoot?: string; kind?: 'subagent'; parentSessionId?: string; jobId?: string } = {}): SessionData {
    const id = options.id ?? `s-${Date.now().toString(36)}-${(++this.seq).toString(36)}`
    const messages: AgentMessage[] = []
    if (options.system) messages.push({ role: 'system', content: options.system })
    const data: SessionData = {
      id,
      title: options.title ?? 'untitled',
      model: options.model,
      provider: options.provider,
      ...(options.preset ? { preset: options.preset } : {}),
      projectRoot: options.projectRoot,
      ...(options.kind !== undefined && { kind: options.kind }),
      ...(options.parentSessionId !== undefined && { parentSessionId: options.parentSessionId }),
      ...(options.jobId !== undefined && { jobId: options.jobId }),
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages,
    }
    this.sessions.set(id, data)
    this.ctx.emit('session/create', id)
    this.schedule(id)
    return data
  }

  get(id: string): SessionData | undefined {
    return this.sessions.get(id)
  }

  require(id: string): SessionData {
    const found = this.sessions.get(id)
    if (!found) {
      const hint = this.dir ? ` (looked in ${this.dir})` : ''
      throw new Error(`session "${id}" not found${hint}`)
    }
    return found
  }

  /** All known sessions, newest first. Accepts a unique id prefix. */
  list(): SessionData[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Finds a session by exact id or unambiguous prefix. */
  find(prefix: string): SessionData | undefined {
    if (this.sessions.has(prefix)) return this.sessions.get(prefix)
    const matches = this.list().filter((s) => s.id.startsWith(prefix))
    return matches.length === 1 ? matches[0] : undefined
  }

  // ---------------------------------------------------------------- writing

  append(id: string, message: AgentMessage): SessionData {
    const data = this.require(id)
    data.messages.push(message)
    data.updatedAt = Date.now()
    this.ctx.emit('session/append', { id, role: message.role })
    this.schedule(id)
    return data
  }

  message(id: string, content: string, role: AgentMessage['role'] = 'user'): SessionData {
    return this.append(id, { role, content })
  }

  /** Swaps the live transcript (compaction); `archived` are the originals it replaces. */
  replaceMessages(id: string, messages: AgentMessage[], archived: AgentMessage[] = []): SessionData {
    const data = this.require(id)
    data.messages = messages
    if (archived.length) data.archived = [...(data.archived ?? []), ...archived].slice(-2_000)
    data.updatedAt = Date.now()
    this.schedule(id)
    return data
  }

  /** Binds (or clears, with undefined) the preset used by this session's runs. */
  setPreset(id: string, preset: string | undefined): SessionData {
    const data = this.require(id)
    if (preset) data.preset = preset
    else delete data.preset
    data.updatedAt = Date.now()
    this.schedule(id)
    return data
  }

  rename(id: string, title: string): SessionData {
    const data = this.require(id)
    data.title = title
    data.updatedAt = Date.now()
    this.schedule(id)
    return data
  }

  /** Sets the lifecycle status and emits `session/status` (fires only on change). */
  setStatus(id: string, status: SessionStatus): SessionData {
    const data = this.require(id)
    if (data.status === status) return data
    data.status = status
    data.updatedAt = Date.now()
    this.ctx.emit('session/status', { id, status })
    this.schedule(id)
    return data
  }

  clear(id: string): void {
    const data = this.require(id)
    data.messages = data.messages.filter((m) => m.role === 'system')
    data.updatedAt = Date.now()
    this.schedule(id)
  }

  delete(id: string): boolean {
    const existed = this.sessions.delete(id)
    this.dirty.delete(id)
    if (this.dir) void unlink(this.file(id)).catch(() => {})
    return existed
  }

  // ------------------------------------------------------------ persistence

  private file(id: string): string {
    return path.join(this.dir as string, `${id}.json`)
  }

  private schedule(id: string): void {
    if (!this.dir || !this.autosave) return
    this.dirty.add(id)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, SAVE_DEBOUNCE_MS)
    this.timer.unref?.()
  }

  /** Writes every pending session to disk. Safe to call at any time. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.dir || !this.dirty.size) return
    const ids = [...this.dirty]
    this.dirty.clear()
    await Promise.all(ids.map((id) => this.write(id)))
  }

  private async write(id: string): Promise<void> {
    const data = this.sessions.get(id)
    if (!data || !this.dir) return
    const target = this.file(id)
    const tmp = `${target}.tmp`
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
      await rename(tmp, target)
    } catch {
      /* a session store must never break a run */
    }
  }

  /** Loads persisted sessions from disk into memory. Returns how many were read. */
  async hydrate(): Promise<number> {
    if (!this.dir) return 0
    const entries = await readdir(this.dir).catch(() => [] as string[])
    const files = entries.filter((name) => name.endsWith('.json') && !name.endsWith('.tmp'))
    const loaded: SessionData[] = []
    for (const name of files) {
      const text = await readFile(path.join(this.dir, name), 'utf8').catch(() => '')
      if (!text) continue
      try {
        const data = JSON.parse(text) as SessionData
        if (data?.id && Array.isArray(data.messages)) loaded.push(data)
      } catch {
        /* skip malformed session file */
      }
    }
    loaded.sort((a, b) => b.updatedAt - a.updatedAt)
    for (const data of loaded.slice(0, this.max)) {
      if (!this.sessions.has(data.id)) this.sessions.set(data.id, data)
    }
    return Math.min(loaded.length, this.max)
  }
}

declare module 'cordis' {
  interface Context {
    sessions: SessionService
  }
}
