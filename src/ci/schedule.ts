import { promises as fs } from 'node:fs'
import path from 'node:path'
import { runsDir } from './store.js'

/** Cron parse failure: bad field count, out-of-range value, unsupported token. */
export class CronError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CronError'
  }
}

export interface CronSpec {
  minutes: Set<number>
  hours: Set<number>
  doms: Set<number>
  months: Set<number>
  dows: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

interface CronField {
  name: string
  min: number
  max: number
}

const FIELDS: CronField[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
]

function parseField(text: string, field: CronField): Set<number> {
  const values = new Set<number>()
  const add = (n: number): void => {
    if (n < field.min || n > field.max) {
      throw new CronError(`value ${n} out of range ${field.min}-${field.max} in ${field.name} field`)
    }
    values.add(field.name === 'day-of-week' && n === 7 ? 0 : n)
  }
  const num = (atom: string): number => {
    if (!/^\d+$/.test(atom)) throw new CronError(`unsupported token "${atom}" in ${field.name} field`)
    return Number(atom)
  }
  for (const atom of text.split(',')) {
    if (!atom) throw new CronError(`empty entry in ${field.name} field`)
    if (atom === '*') {
      for (let v = field.min; v <= field.max; v += 1) add(v)
      continue
    }
    const step = /^\*\/(\d+)$/.exec(atom)
    if (step) {
      const n = Number(step[1])
      if (n < 1) throw new CronError(`step must be a positive integer in ${field.name} field`)
      for (let v = field.min; v <= field.max; v += n) add(v)
      continue
    }
    const range = /^(\d+)-(\d+)$/.exec(atom)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from > to) throw new CronError(`range ${from}-${to} is descending in ${field.name} field`)
      for (let v = from; v <= to; v += 1) add(v)
      continue
    }
    add(num(atom))
  }
  if (!values.size) throw new CronError(`${field.name} field matches nothing`)
  return values
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/).filter(Boolean)
  if (parts.length !== 5) {
    throw new CronError(`expected 5 fields (minute hour dom month dow), got ${parts.length}`)
  }
  const [minText, hourText, domText, monthText, dowText] = parts
  return {
    minutes: parseField(minText, FIELDS[0]),
    hours: parseField(hourText, FIELDS[1]),
    doms: parseField(domText, FIELDS[2]),
    months: parseField(monthText, FIELDS[3]),
    dows: parseField(dowText, FIELDS[4]),
    domRestricted: domText !== '*',
    dowRestricted: dowText !== '*',
  }
}

function dayMatches(cron: CronSpec, d: Date): boolean {
  const domOk = cron.doms.has(d.getDate())
  const dowOk = cron.dows.has(d.getDay())
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk
  if (cron.domRestricted) return domOk
  if (cron.dowRestricted) return dowOk
  return true
}

/** Next matching local time strictly after `after`; null when none within 5 years. */
export function nextFire(cron: CronSpec, after: Date): Date | null {
  if (!Number.isFinite(after.getTime())) return null
  const d = new Date(after.getTime())
  d.setSeconds(0, 0)
  d.setTime(d.getTime() + 60_000)
  const limit = d.getFullYear() + 5
  while (d.getFullYear() <= limit) {
    if (!cron.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(cron, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!cron.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!cron.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
      continue
    }
    return d
  }
  return null
}

export interface ScheduleState {
  version: 1
  workflows: Record<string, { lastFired: string }>
}

export function scheduleStateFile(root: string): string {
  return path.join(path.dirname(runsDir(root)), 'schedule-state.json')
}

export async function loadScheduleState(root: string): Promise<ScheduleState> {
  const text = await fs.readFile(scheduleStateFile(root), 'utf8').catch(() => null)
  if (!text) return { version: 1, workflows: {} }
  try {
    const parsed = JSON.parse(text) as Partial<ScheduleState>
    if (!parsed || typeof parsed !== 'object' || !parsed.workflows || typeof parsed.workflows !== 'object') {
      return { version: 1, workflows: {} }
    }
    return { version: 1, workflows: parsed.workflows }
  } catch {
    return { version: 1, workflows: {} }
  }
}

export async function saveScheduleState(root: string, state: ScheduleState): Promise<void> {
  const file = scheduleStateFile(root)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export interface ScheduleCandidate {
  id: string
  schedule: string[]
}

export interface ScheduleDecision {
  toFire: string[]
  skipped: string[]
  state: ScheduleState
  changed: boolean
}

/**
 * Pure per-tick decision. Advancing `lastFired` to `now` on a due workflow is
 * equivalent to jumping to the most recent missed slot (no slot exists between
 * them), so catch-up collapses to one run without scanning missed slots.
 */
export function evaluateSchedules(
  candidates: ScheduleCandidate[],
  state: ScheduleState,
  now: Date,
  running: ReadonlySet<string> = new Set(),
): ScheduleDecision {
  const workflows = { ...state.workflows }
  const toFire: string[] = []
  const skipped: string[] = []
  let changed = false
  const nowIso = now.toISOString()
  for (const candidate of candidates) {
    if (!candidate.schedule.length) continue
    const seen = workflows[candidate.id]
    if (!seen || typeof seen.lastFired !== 'string' || !Number.isFinite(Date.parse(seen.lastFired))) {
      workflows[candidate.id] = { lastFired: nowIso }
      changed = true
      continue
    }
    const lastFired = new Date(seen.lastFired)
    let due = false
    for (const cron of candidate.schedule) {
      const next = nextFire(parseCron(cron), lastFired)
      if (next && next.getTime() <= now.getTime()) {
        due = true
        break
      }
    }
    if (!due) continue
    workflows[candidate.id] = { lastFired: nowIso }
    changed = true
    if (running.has(candidate.id)) skipped.push(candidate.id)
    else toFire.push(candidate.id)
  }
  return { toFire, skipped, state: { version: 1, workflows }, changed }
}
