import { Service } from 'cordis'
import type { Context } from 'cordis'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expandHome } from './session.js'
import { confine } from './confine.js'

export interface WorkspaceConfig {
  /** Initial workspace root. Defaults to the process cwd. */
  root?: string
  /** Remember selected roots in ~/.switchboard/workspaces.json for the picker UI. */
  remember?: boolean
}

interface Recent {
  current: string
  recents: string[]
}

const HISTORY = '~/.switchboard/workspaces.json'
const MAX_RECENTS = 12

/**
 * `ctx.workspace` — the boundary filesystem and shell tools operate inside.
 *
 * The root can be switched at runtime (`use()`), which re-points the tool
 * plugins listening on `workspace/changed`; a short recent list feeds the
 * console's workspace picker.
 */
export class WorkspaceService extends Service {
  static inject: string[] = []

  private current: string
  private historyFile?: string

  constructor(ctx: Context, config: WorkspaceConfig = {}) {
    super(ctx, 'workspace')
    this.current = path.resolve(expandHome(config.root ?? process.cwd()))
    if (config.remember) {
      this.historyFile = path.resolve(expandHome(HISTORY))
      void this.load()
    }
  }

  /** The active root, resolved. */
  get root(): string {
    return this.current
  }

  /** Recent roots, current first. */
  get recents(): string[] {
    return [...this.recents_, this.current].filter(
      (p, i, list) => list.indexOf(p) === i,
    )
  }

  private recents_: string[] = []

  /** Absolute-resolves a target inside the workspace or throws. */
  resolve(target: string): string {
    const resolved = path.resolve(this.current, target)
    const rel = path.relative(this.current, resolved)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`path escapes workspace: ${target}`)
    }
    return resolved
  }

  /** Like `resolve`, but also refuses paths that leave the workspace through a symlink. */
  resolveReal(target: string): Promise<string> {
    return confine(this.current, target)
  }

  /**
   * Switches the workspace root. Tool plugins observe `workspace/changed` and
   * re-point their boundaries; the caller waits on the returned promise.
   */
  async use(root: string): Promise<string> {
    const resolved = path.resolve(expandHome(root))
    const stat = await import('node:fs/promises').then((fs) => fs.stat(resolved))
    if (!stat.isDirectory()) throw new Error(`not a directory: ${resolved}`)
    this.current = resolved
    this.touch(resolved)
    this.ctx.emit('workspace/changed', resolved)
    return resolved
  }

  private touch(root: string): void {
    if (!this.historyFile) return
    this.recents_ = [root, ...this.recents_.filter((p) => p !== root)].slice(0, MAX_RECENTS)
    void this.save()
  }

  private async load(): Promise<void> {
    const text = await readFile(this.historyFile as string, 'utf8').catch(() => '')
    if (!text) return this.migrate()
    try {
      const parsed = JSON.parse(text) as Recent
      this.recents_ = Array.isArray(parsed.recents) ? parsed.recents.slice(0, MAX_RECENTS) : []
      if (parsed.current) this.touch(parsed.current)
    } catch {
      /* history is advisory only */
    }
  }

  /** First run: derive the recent list from existing tool config defaults. */
  private migrate(): void {
    // Nothing to migrate yet; the file appears after the first `use()`.
  }

  private async save(): Promise<void> {
    if (!this.historyFile) return
    const payload: Recent = { current: this.current, recents: this.recents_ }
    try {
      await mkdir(path.dirname(this.historyFile), { recursive: true })
      await writeFile(this.historyFile, JSON.stringify(payload, null, 2), 'utf8')
    } catch {
      /* history is advisory only */
    }
  }
}

declare module 'cordis' {
  interface Context {
    workspace: WorkspaceService
  }
}