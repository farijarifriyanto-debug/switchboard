import { Service } from 'cordis'
import type { Context } from 'cordis'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface UndoConfig {
  /** Set false to stop recording (the `/undo` commands then report nothing to undo). */
  enabled?: boolean
  /** Where before-images live, default `~/.switchboard/undo`. */
  dir?: string
  /** Entries kept per session (oldest are dropped), default 200. */
  maxEntries?: number
  /** Files larger than this are not backed up, so their change cannot be undone, default 5 MB. */
  maxFileBytes?: number
}

export interface UndoEntry {
  seq: number
  file: string
  tool: string
  at: number
  /** The file did not exist before the change (undo deletes it). */
  created: boolean
  /** sha256 of what the tool wrote; undo refuses when the file has been edited since. */
  afterHash: string
  /** False when the before-image was too large to keep. */
  backed: boolean
}

export interface UndoResult {
  restored: string[]
  skipped: Array<{ file: string; reason: string }>
}

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

/**
 * `ctx.undo` — before-images of the files the agent writes, per session.
 *
 * Only changes made through the file tools are recorded; files changed by shell commands are not.
 * Undo restores the newest changes first and refuses a file that was edited after the agent
 * wrote it (pass `force` to override), so it never silently discards the user's own work.
 */
export class UndoService extends Service {
  static inject: string[] = []

  readonly enabled: boolean
  private readonly dir: string
  private readonly maxEntries: number
  private readonly maxFileBytes: number
  /** Serialises index updates per session (tools may run in parallel). */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, config: UndoConfig = {}) {
    super(ctx, 'undo')
    this.enabled = config.enabled !== false
    this.dir = path.resolve((config.dir ?? path.join(os.homedir(), '.switchboard', 'undo')).replace(/^~(?=$|[\\/])/, os.homedir()))
    this.maxEntries = config.maxEntries ?? 200
    this.maxFileBytes = config.maxFileBytes ?? 5_000_000
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.dir, sessionId.replace(/[^\w.-]/g, '_'))
  }

  private async load(sessionId: string): Promise<UndoEntry[]> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.sessionDir(sessionId), 'index.json'), 'utf8')) as UndoEntry[]
    } catch {
      return []
    }
  }

  private async save(sessionId: string, entries: UndoEntry[]): Promise<void> {
    const dir = this.sessionDir(sessionId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(entries), 'utf8')
  }

  private exclusive<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(sessionId) ?? Promise.resolve()).then(job, job)
    this.locks.set(sessionId, run.catch(() => undefined))
    return run
  }

  /**
   * Runs `write` (which must put `content` into `file`) and journals the before-image.
   * A failed write leaves no entry behind.
   */
  async track(sessionId: string | undefined, file: string, tool: string, content: string, write: () => Promise<void>): Promise<void> {
    if (!this.enabled) return write()
    const sid = sessionId || 'no-session'
    const before = await fs.readFile(file).catch(() => null)
    await write()
    await this.exclusive(sid, async () => {
      const entries = await this.load(sid)
      const seq = (entries.at(-1)?.seq ?? 0) + 1
      const backed = before === null || before.length <= this.maxFileBytes
      if (before && backed) {
        await fs.mkdir(this.sessionDir(sid), { recursive: true })
        await fs.writeFile(path.join(this.sessionDir(sid), `${seq}.bak`), before)
      }
      entries.push({ seq, file, tool, at: Date.now(), created: before === null, afterHash: sha(content), backed })
      for (const dropped of entries.splice(0, Math.max(0, entries.length - this.maxEntries))) {
        await fs.rm(path.join(this.sessionDir(sid), `${dropped.seq}.bak`), { force: true })
      }
      await this.save(sid, entries)
    })
  }

  /** Recorded changes, oldest first. */
  list(sessionId: string): Promise<UndoEntry[]> {
    return this.load(sessionId || 'no-session')
  }

  /** Undo the newest `count` changes. */
  undo(sessionId: string, count = 1, force = false): Promise<UndoResult> {
    const sid = sessionId || 'no-session'
    return this.exclusive(sid, async () => {
      const entries = await this.load(sid)
      const result: UndoResult = { restored: [], skipped: [] }
      for (let n = 0; n < count && entries.length; n += 1) {
        const entry = entries.pop() as UndoEntry
        const bak = path.join(this.sessionDir(sid), `${entry.seq}.bak`)
        const current = await fs.readFile(entry.file).catch(() => null)
        if (!force && current !== null && sha(current) !== entry.afterHash) {
          result.skipped.push({ file: entry.file, reason: 'edited since the agent wrote it (use force to overwrite)' })
        } else if (!entry.backed) {
          result.skipped.push({ file: entry.file, reason: 'the original was too large to keep' })
        } else if (entry.created) {
          await fs.rm(entry.file, { force: true })
          result.restored.push(entry.file)
        } else {
          await fs.mkdir(path.dirname(entry.file), { recursive: true })
          await fs.copyFile(bak, entry.file)
          result.restored.push(entry.file)
        }
        await fs.rm(bak, { force: true })
      }
      await this.save(sid, entries)
      return result
    })
  }
}

export function formatUndo(result: UndoResult): string {
  if (!result.restored.length && !result.skipped.length) return 'Nothing to undo.'
  return [
    ...result.restored.map((f) => `restored ${f}`),
    ...result.skipped.map((s) => `skipped ${s.file}: ${s.reason}`),
  ].join('\n')
}

declare module 'cordis' {
  interface Context {
    undo: UndoService
  }
}
