import { randomInt } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Unambiguous characters only (no 0/O, 1/I/L). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
const TTL_MS = 60 * 60_000
const MAX_PENDING = 5
const REPLY_EVERY_MS = 10 * 60_000

interface PairingFile {
  version: 1
  approved: Record<string, string[]>
  pending: Record<string, { channel: string; userId: string; label?: string; at: number }>
}

export interface PendingPairing {
  code: string
  channel: string
  userId: string
  label?: string
  at: number
}

/**
 * Pairing for chat channels: an unknown sender who writes to the bot gets a one-time code, and the
 * owner approves it on the machine with `sbx channels approve <code>`. Approved ids are kept in
 * `<dir>/pairing.json` next to the static `allowFrom` list; both the channel process and the CLI use it.
 *
 * Nothing else is revealed to an unknown sender: the bot only shows the code and how to approve it,
 * answers at most once per 10 minutes, and holds at most 5 pending codes of one hour each.
 */
export class PairingStore {
  private data: PairingFile = { version: 1, approved: {}, pending: {} }
  private mtime = -1
  private readonly lastReply = new Map<string, number>()

  constructor(readonly file: string) {}

  /** Re-reads the file when another process changed it. */
  async load(): Promise<void> {
    const st = await stat(this.file).catch(() => null)
    if (!st) {
      this.data = { version: 1, approved: {}, pending: {} }
      this.mtime = -1
      return
    }
    if (st.mtimeMs === this.mtime) return
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<PairingFile>
      this.data = { version: 1, approved: parsed.approved ?? {}, pending: parsed.pending ?? {} }
    } catch {
      this.data = { version: 1, approved: {}, pending: {} }
    }
    this.mtime = st.mtimeMs
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.file)
    this.mtime = (await stat(this.file)).mtimeMs
  }

  private prune(now = Date.now()): void {
    for (const [code, p] of Object.entries(this.data.pending)) if (now - p.at > TTL_MS) delete this.data.pending[code]
  }

  /** Call `load()` first on a hot path. */
  has(channel: string, userId: string): boolean {
    return (this.data.approved[channel] ?? []).includes(String(userId))
  }

  /**
   * A code for this sender, or null when the bot should stay silent (too many pending codes, or it
   * already answered this sender in the last 10 minutes).
   */
  async request(channel: string, userId: string, label?: string): Promise<{ code: string; fresh: boolean } | null> {
    await this.load()
    const key = `${channel}:${userId}`
    const now = Date.now()
    if (now - (this.lastReply.get(key) ?? 0) < REPLY_EVERY_MS) return null
    this.prune(now)
    const existing = Object.entries(this.data.pending).find(([, p]) => p.channel === channel && p.userId === userId)
    if (existing) {
      this.lastReply.set(key, now)
      return { code: existing[0], fresh: false }
    }
    if (Object.keys(this.data.pending).length >= MAX_PENDING) return null
    let code = ''
    do code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    while (this.data.pending[code])
    this.data.pending[code] = { channel, userId, ...(label ? { label: label.slice(0, 60) } : {}), at: now }
    this.lastReply.set(key, now)
    await this.save()
    return { code, fresh: true }
  }

  async list(): Promise<{ pending: PendingPairing[]; approved: Array<{ channel: string; userId: string }> }> {
    await this.load()
    this.prune()
    return {
      pending: Object.entries(this.data.pending).map(([code, p]) => ({ code, ...p })),
      approved: Object.entries(this.data.approved).flatMap(([channel, ids]) => ids.map((userId) => ({ channel, userId }))),
    }
  }

  /** Approves a pending code; returns who it was, or null when the code is unknown or expired. */
  async approve(code: string): Promise<PendingPairing | null> {
    await this.load()
    this.prune()
    const key = code.trim().toUpperCase()
    const p = this.data.pending[key]
    if (!p) return null
    delete this.data.pending[key]
    const ids = (this.data.approved[p.channel] ??= [])
    if (!ids.includes(p.userId)) ids.push(p.userId)
    await this.save()
    return { code: key, ...p }
  }

  async revoke(channel: string, userId: string): Promise<boolean> {
    await this.load()
    const ids = this.data.approved[channel] ?? []
    if (!ids.includes(userId)) return false
    this.data.approved[channel] = ids.filter((id) => id !== userId)
    await this.save()
    return true
  }
}
