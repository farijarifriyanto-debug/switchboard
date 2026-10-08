import { Service } from 'cordis'
import type { Context } from 'cordis'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseCron, nextFire } from '../ci/schedule.js'
import { SettingsError } from './settings-error.js'
import { expandHome } from './session.js'

export interface AutomationsConfig {
  /** Directory holding `automations.json`. Default `~/.switchboard`. */
  dir?: string
  /** Hard limit for one run, in ms (default 10 minutes). */
  runTimeoutMs?: number
}

export type Delivery = { type: 'console' } | { type: 'telegram'; chatId: number }

export interface RunRecord {
  id: string
  at: number
  endedAt: number
  status: 'success' | 'failed' | 'missed'
  output: string
  error?: string
}

export interface Automation {
  id: string
  name: string
  /** Five-field cron, local time. */
  schedule: string
  prompt: string
  /** Preset the run uses; limits what the agent can touch. Default `reviewer` (read-only). */
  preset: string
  deliver: Delivery
  enabled: boolean
  createdAt: number
  nextRun?: number
  failures: number
  runs: RunRecord[]
}

export const AUTOMATION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/
const MAX_AUTOMATIONS = 20
const MIN_GAP_MS = 5 * 60_000
const MISSED_AFTER_MS = 2 * 60 * 60_000
const KEEP_RUNS = 20
const MAX_OUTPUT = 4_000
const DISABLE_AFTER = 5

/** Smallest gap between the next few firings; a cron that fires every minute is refused. */
function minGap(schedule: string, from: Date): number {
  const cron = parseCron(schedule)
  let prev = nextFire(cron, from)
  let min = Infinity
  for (let i = 0; i < 8 && prev; i += 1) {
    const next = nextFire(cron, prev)
    if (!next) break
    min = Math.min(min, next.getTime() - prev.getTime())
    prev = next
  }
  return min
}

export function validateAutomation(input: unknown, id?: string, now = new Date()): Omit<Automation, 'createdAt' | 'failures' | 'runs' | 'nextRun'> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new SettingsError('An automation must be an object.')
  const raw = input as Record<string, unknown>
  const wanted = id ?? (typeof raw.id === 'string' ? raw.id.trim() : '')
  if (!AUTOMATION_ID_RE.test(wanted)) throw new SettingsError('Automation id must be 1-40 characters: lowercase letters, digits, "-" or "_".')
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name || name.length > 80) throw new SettingsError('An automation needs a name (max 80 characters).')
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
  if (!prompt || prompt.length > 4_000) throw new SettingsError('An automation needs a prompt (max 4000 characters).')
  const schedule = typeof raw.schedule === 'string' ? raw.schedule.trim().replace(/\s+/g, ' ') : ''
  try {
    if (minGap(schedule, now) < MIN_GAP_MS) throw new SettingsError('That schedule fires more often than every 5 minutes.', { hint: 'Use at most one run per 5 minutes, e.g. "*/10 * * * *".' })
  } catch (error) {
    if (error instanceof SettingsError) throw error
    throw new SettingsError(`Bad schedule: ${error instanceof Error ? error.message : String(error)}`, { hint: 'Five fields: minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5".' })
  }
  const preset = typeof raw.preset === 'string' && raw.preset.trim() ? raw.preset.trim() : 'reviewer'
  const d = raw.deliver as Record<string, unknown> | undefined
  let deliver: Delivery = { type: 'console' }
  if (d && d.type === 'telegram') {
    const chatId = Number(d.chatId)
    if (!Number.isSafeInteger(chatId)) throw new SettingsError('deliver.chatId must be your Telegram user id.')
    deliver = { type: 'telegram', chatId }
  } else if (d && d.type !== 'console') throw new SettingsError('deliver.type must be "console" or "telegram".')
  return { id: wanted, name, schedule, prompt, preset, deliver, enabled: raw.enabled !== false }
}

/**
 * `ctx.automations` — scheduled agent runs (roadmap stage 5).
 *
 * Each due automation runs its prompt in a fresh session with its preset and
 * delivers the answer to the console history or to Telegram. Runs are
 * unattended, so any tool that needs approval is refused on the spot: what an
 * automation can do is exactly what its preset allows without asking.
 * One run at a time, 10 minute limit, missed slots are recorded and skipped.
 */
export class AutomationService extends Service {
  static inject: string[] = []

  readonly dir: string
  private readonly runTimeoutMs: number
  private items: Automation[] = []
  private writeChain: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  private busy = false
  /** Sessions owned by a run: approval requests there are rejected immediately. */
  private readonly unattended = new Set<string>()

  constructor(ctx: Context, config: AutomationsConfig = {}) {
    super(ctx, 'automations')
    this.dir = path.resolve(expandHome(config.dir ?? '~/.switchboard'))
    this.runTimeoutMs = config.runTimeoutMs ?? 10 * 60_000
    ctx.on('approval/request', ({ id, sessionId }) => {
      if (sessionId && this.unattended.has(sessionId)) ctx.get('approvals', false)?.decide(id, 'rejected')
    })
    void this.load()
  }

  private get file(): string {
    return path.join(this.dir, 'automations.json')
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { version?: number; automations?: Automation[] }
      if (parsed.version === 1 && Array.isArray(parsed.automations)) this.items = parsed.automations
    } catch {
      /* none yet */
    }
  }

  /** Resolves once the file has been read (tests, `sbx automations`). */
  async ready(): Promise<void> {
    await this.load()
  }

  private persist(): Promise<void> {
    const text = JSON.stringify({ version: 1, automations: this.items }, null, 2)
    const run = this.writeChain.then(async () => {
      await mkdir(this.dir, { recursive: true })
      await writeFile(`${this.file}.tmp`, text, { encoding: 'utf8', mode: 0o600 })
      await rename(`${this.file}.tmp`, this.file)
    })
    this.writeChain = run.catch(() => {})
    return run
  }

  list(): Automation[] {
    return structuredClone(this.items)
  }

  get(id: string): Automation | undefined {
    const found = this.items.find((a) => a.id === id)
    return found ? structuredClone(found) : undefined
  }

  private checkPreset(preset: string): void {
    if (preset !== 'default' && !this.ctx.get('presets', false)?.get(preset)) throw new SettingsError(`No preset "${preset}".`, { status: 404 })
  }

  async create(input: unknown, now = new Date()): Promise<Automation> {
    const fields = validateAutomation(input, undefined, now)
    if (this.items.some((a) => a.id === fields.id)) throw new SettingsError(`Automation "${fields.id}" already exists.`, { status: 409 })
    if (this.items.length >= MAX_AUTOMATIONS) throw new SettingsError(`At most ${MAX_AUTOMATIONS} automations.`, { status: 409 })
    this.checkPreset(fields.preset)
    const item: Automation = { ...fields, createdAt: now.getTime(), failures: 0, runs: [] }
    item.nextRun = nextFire(parseCron(item.schedule), now)?.getTime()
    this.items.push(item)
    await this.persist()
    return structuredClone(item)
  }

  async update(id: string, input: unknown, now = new Date()): Promise<Automation> {
    const index = this.items.findIndex((a) => a.id === id)
    if (index === -1) throw new SettingsError(`No automation "${id}".`, { status: 404 })
    const fields = validateAutomation(input, id, now)
    this.checkPreset(fields.preset)
    const old = this.items[index]
    const item: Automation = { ...old, ...fields, failures: fields.enabled && !old.enabled ? 0 : old.failures }
    item.nextRun = item.enabled ? nextFire(parseCron(item.schedule), now)?.getTime() : undefined
    this.items[index] = item
    await this.persist()
    return structuredClone(item)
  }

  async remove(id: string): Promise<void> {
    const index = this.items.findIndex((a) => a.id === id)
    if (index === -1) throw new SettingsError(`No automation "${id}".`, { status: 404 })
    this.items.splice(index, 1)
    await this.persist()
  }

  /** Starts the 30 s scheduler. Only long-lived commands (`sbx web`, `sbx channels`) call this. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), 30_000)
    this.timer.unref?.()
    this.ctx.effect(() => () => {
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
    })
  }

  /** Runs everything due at `now`, one at a time. Returns the ids that ran or were skipped as missed. */
  async tick(now = new Date()): Promise<{ ran: string[]; missed: string[] }> {
    const out = { ran: [] as string[], missed: [] as string[] }
    if (this.busy) return out
    this.busy = true
    try {
      for (const item of this.items) {
        if (!item.enabled || item.nextRun === undefined || item.nextRun > now.getTime()) continue
        const late = now.getTime() - item.nextRun
        const due = item.nextRun
        item.nextRun = nextFire(parseCron(item.schedule), now)?.getTime()
        if (late > MISSED_AFTER_MS) {
          this.record(item, { id: `r-${due.toString(36)}`, at: due, endedAt: now.getTime(), status: 'missed', output: '', error: `skipped: the scheduler was not running (${Math.round(late / 60_000)} min late)` })
          out.missed.push(item.id)
          continue
        }
        await this.execute(item)
        out.ran.push(item.id)
      }
      await this.persist()
    } finally {
      this.busy = false
    }
    return out
  }

  /** Runs one automation now, regardless of its schedule. */
  async runNow(id: string): Promise<RunRecord> {
    const item = this.items.find((a) => a.id === id)
    if (!item) throw new SettingsError(`No automation "${id}".`, { status: 404 })
    if (this.busy) throw new SettingsError('Another automation is running.', { status: 409 })
    this.busy = true
    try {
      const record = await this.execute(item)
      await this.persist()
      return structuredClone(record)
    } finally {
      this.busy = false
    }
  }

  private record(item: Automation, run: RunRecord): void {
    item.runs = [run, ...item.runs].slice(0, KEEP_RUNS)
  }

  private async execute(item: Automation): Promise<RunRecord> {
    const startedAt = Date.now()
    const sessions = this.ctx.get('sessions', false)
    const agent = this.ctx.get('agent', false)
    const run: RunRecord = { id: `r-${startedAt.toString(36)}`, at: startedAt, endedAt: startedAt, status: 'failed', output: '' }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.runTimeoutMs)
    let sessionId: string | undefined
    try {
      if (!sessions || !agent) throw new Error('the agent is not available')
      sessionId = sessions.create({ title: `Automation: ${item.name}`, ...(item.preset !== 'default' ? { preset: item.preset } : {}), projectRoot: this.ctx.get('workspace', false)?.root }).id
      this.unattended.add(sessionId)
      let answer = ''
      let failure = ''
      for await (const event of agent.stream(item.prompt, sessionId, { signal: ac.signal })) {
        if (event.type === 'final') answer = event.content
        else if (event.type === 'error') failure = event.error
      }
      if (ac.signal.aborted) failure = failure || `timed out after ${Math.round(this.runTimeoutMs / 60_000)} minutes`
      if (failure) throw new Error(failure)
      run.status = 'success'
      run.output = answer.slice(0, MAX_OUTPUT)
    } catch (error) {
      run.status = 'failed'
      run.error = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    } finally {
      clearTimeout(timer)
      if (sessionId) {
        this.unattended.delete(sessionId)
        sessions?.delete(sessionId)
      }
    }
    run.endedAt = Date.now()
    this.record(item, run)
    item.failures = run.status === 'success' ? 0 : item.failures + 1
    if (item.failures >= DISABLE_AFTER) {
      item.enabled = false
      item.nextRun = undefined
      run.error = `${run.error ?? 'failed'} (disabled after ${DISABLE_AFTER} failures in a row)`
    }
    await this.deliver(item, run)
    return run
  }

  private async deliver(item: Automation, run: RunRecord): Promise<void> {
    if (item.deliver.type !== 'telegram') return
    const telegram = this.ctx.get('telegram', false)
    const text = run.status === 'success' ? `⏰ ${item.name}\n\n${run.output || '(no output)'}` : `⏰ ${item.name} failed: ${run.error ?? 'unknown error'}`
    if (!telegram) {
      this.ctx.logger('automations').warn('"%s": Telegram delivery is set but the Telegram channel is not running', item.id)
      return
    }
    await telegram.send(item.deliver.chatId, text).catch((error: unknown) => this.ctx.logger('automations').warn('delivery failed: %s', String(error)))
  }
}

declare module 'cordis' {
  interface Context {
    automations: AutomationService
  }
}
