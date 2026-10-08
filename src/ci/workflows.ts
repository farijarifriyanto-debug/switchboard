import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { parseCron } from './schedule.js'
import type { JobDef, ScheduleDef, StepDef, Workflow } from './types.js'

/** A workflow that cannot (or must not) run: bad YAML, bad graph, unsupported keys. */
export class SetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SetupError'
  }
}

const FORBIDDEN = new Set(['uses', 'matrix', 'services', 'if', 'continue-on-error', 'secrets'])

function envOf(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
}

function displayName(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback
}

/** Extracts and validates `on.schedule`; only a bare string or a list of { cron } is accepted. */
function parseSchedule(on: unknown, base: string): ScheduleDef[] {
  if (!on || typeof on !== 'object' || Array.isArray(on)) return []
  const raw = (on as Record<string, unknown>).schedule
  if (raw == null) return []
  const check = (cron: string): string => {
    try {
      parseCron(cron)
    } catch (error) {
      throw new SetupError(`${base}: invalid cron "${cron}" in on.schedule: ${error instanceof Error ? error.message : String(error)}`)
    }
    return cron
  }
  if (typeof raw === 'string') return [{ cron: check(raw.trim()) }]
  if (!Array.isArray(raw)) {
    throw new SetupError(`${base}: on.schedule must be a string or a list of { cron: "..." }`)
  }
  const out: ScheduleDef[] = []
  for (const entry of raw) {
    const cron =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry) && typeof (entry as { cron?: unknown }).cron === 'string'
        ? ((entry as { cron: string }).cron).trim()
        : null
    if (cron === null) {
      throw new SetupError(`${base}: on.schedule entries must be { cron: "..." }`)
    }
    out.push({ cron: check(cron) })
  }
  return out
}

function detectCycle(jobs: JobDef[]): void {
  const state = new Map<string, 'visit' | 'done'>()
  const visit = (id: string): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visit') throw new SetupError('jobs contain a dependency cycle')
    state.set(id, 'visit')
    const job = jobs.find((j) => j.id === id)
    for (const next of job?.needs ?? []) visit(next)
    state.set(id, 'done')
  }
  for (const job of jobs) visit(job.id)
}

export function parseWorkflow(text: string, file: string): Workflow {
  const base = path.basename(file)
  let doc: unknown
  try {
    doc = parse(text)
  } catch (error) {
    throw new SetupError(`invalid YAML in ${base}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new SetupError(`${base}: workflow must be a mapping`)
  const root = doc as Record<string, unknown>
  const schedule = parseSchedule(root.on, base)
  const jobsRaw = root.jobs
  if (!jobsRaw || typeof jobsRaw !== 'object' || Array.isArray(jobsRaw) || !Object.keys(jobsRaw).length) {
    throw new SetupError(`${base}: jobs: must be a non-empty mapping`)
  }

  const jobs: JobDef[] = []
  for (const [jobId, raw] of Object.entries(jobsRaw as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SetupError(`job "${jobId}": must be a mapping`)
    const job = raw as Record<string, unknown>
    const checkKeys = (obj: Record<string, unknown>, where: string): void => {
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return
        if (Array.isArray(value)) {
          for (const item of value) visit(item)
          return
        }
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (FORBIDDEN.has(key)) throw new SetupError(`unsupported key "${key}" in ${where} — not available in sbx ci v1`)
          visit(child)
        }
      }
      visit(obj)
    }
    checkKeys(job, `job "${jobId}"`)
    const needs = job.needs == null ? [] : Array.isArray(job.needs) ? job.needs.map(String) : [String(job.needs)]
    const stepsRaw = job.steps
    if (!Array.isArray(stepsRaw) || !stepsRaw.length) throw new SetupError(`job "${jobId}": steps: must be a non-empty list`)
    const steps: StepDef[] = stepsRaw.map((entry, index) => {
      const where = `job "${jobId}" step ${index + 1}`
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new SetupError(`${where}: must be a mapping`)
      const step = entry as Record<string, unknown>
      checkKeys(step, where)
      if (typeof step.run !== 'string' || !step.run.trim()) throw new SetupError(`${where}: run: is required`)
      let timeoutMinutes: number | undefined
      if (step['timeout-minutes'] != null) {
        timeoutMinutes = Number(step['timeout-minutes'])
        if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
          throw new SetupError(`${where}: timeout-minutes must be a positive number`)
        }
      }
      return {
        name: displayName(step.name, step.run.slice(0, 40)),
        run: step.run,
        env: envOf(step.env),
        ...(step['working-directory'] ? { workingDirectory: String(step['working-directory']) } : {}),
        ...(timeoutMinutes != null ? { timeoutMinutes } : {}),
      }
    })
    jobs.push({
      id: jobId,
      name: displayName(job.name, jobId),
      needs,
      env: envOf(job.env),
      steps,
    })
  }

  const ids = new Set(jobs.map((j) => j.id))
  for (const job of jobs) {
    for (const need of job.needs) {
      if (!ids.has(need)) throw new SetupError(`job "${job.id}" needs unknown job "${need}"`)
    }
  }
  detectCycle(jobs)

  return {
    id: path.basename(file).replace(/\.ya?ml$/, ''),
    name: displayName(root.name, path.basename(file).replace(/\.ya?ml$/, '')),
    file,
    on: root.on ?? null,
    schedule,
    env: envOf(root.env),
    jobs,
  }
}

/** All workflows under `<root>/.switchboard/workflows`; bad files carry `error`. */
export async function listWorkflows(root: string): Promise<Array<{ id: string; name: string; file: string; jobs: string[]; schedule: string[]; error?: string }>> {
  const dir = path.join(root, '.switchboard', 'workflows')
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  const out: Array<{ id: string; name: string; file: string; jobs: string[]; schedule: string[]; error?: string }> = []
  for (const entry of entries.sort()) {
    if (!/\.ya?ml$/.test(entry)) continue
    const file = path.join(dir, entry)
    const id = entry.replace(/\.ya?ml$/, '')
    try {
      const wf = parseWorkflow(await fs.readFile(file, 'utf8'), file)
      out.push({ id: wf.id, name: wf.name, file, jobs: wf.jobs.map((j) => j.id), schedule: wf.schedule.map((s) => s.cron) })
    } catch (error) {
      out.push({ id, name: id, file, jobs: [], schedule: [], error: error instanceof Error ? error.message : String(error) })
    }
  }
  return out
}

export async function loadWorkflow(root: string, id: string): Promise<Workflow> {
  const dir = path.join(root, '.switchboard', 'workflows')
  for (const ext of ['.yml', '.yaml']) {
    const file = path.join(dir, `${id}${ext}`)
    const text = await fs.readFile(file, 'utf8').catch(() => null)
    if (text !== null) return parseWorkflow(text, file)
  }
  const available = (await listWorkflows(root)).map((w) => w.id).join(', ') || 'none'
  throw new SetupError(`unknown workflow "${id}" (available: ${available})`)
}
