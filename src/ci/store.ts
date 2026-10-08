import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RunRecord, RunSummary } from './types.js'

const STALE_MS = 60 * 60 * 1000

export const DEFAULT_KEEP = 200

/** keepRuns is honoured only as an integer >= 10; anything else falls back to the default. */
export function resolveKeepRuns(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 10 ? value : DEFAULT_KEEP
}

export function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function runsDir(root: string): string {
  const shard = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12)
  return path.join(os.homedir(), '.switchboard', 'ci', shard, 'runs')
}

function normalize(record: RunRecord): RunRecord {
  const last = Date.parse(record.updatedAt || record.startedAt)
  if (record.status === 'running' && Number.isFinite(last) && Date.now() - last > STALE_MS) {
    return { ...record, status: 'failed', error: record.error ?? 'run went stale (process died mid-run?)' }
  }
  return record
}

function summarize(record: RunRecord): RunSummary {
  return {
    ...record,
    jobs: record.jobs.map((job) => ({
      ...job,
      steps: job.steps.map((s) => ({ name: s.name, status: s.status, exitCode: s.exitCode })),
    })),
  }
}

async function prune(dir: string, keep: number): Promise<void> {
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'))
  if (files.length <= keep) return
  const dated = await Promise.all(
    files.map(async (f) => {
      const at = (await fs.stat(path.join(dir, f)).catch(() => null))?.mtimeMs ?? 0
      return { f, at }
    }),
  )
  dated.sort((a, b) => a.at - b.at)
  for (const { f } of dated.slice(0, dated.length - keep)) await fs.rm(path.join(dir, f), { force: true })
}

export async function saveRun(root: string, record: RunRecord, keepRuns?: number): Promise<void> {
  const dir = runsDir(root)
  await fs.mkdir(dir, { recursive: true })
  const stamped: RunRecord = { ...record, updatedAt: new Date().toISOString() }
  await fs.writeFile(path.join(dir, `${stamped.id}.json`), JSON.stringify(stamped, null, 2), 'utf8')
  await prune(dir, resolveKeepRuns(keepRuns))
}

export async function getRun(root: string, id: string): Promise<RunRecord | null> {
  const file = path.join(runsDir(root), `${id}.json`)
  const text = await fs.readFile(file, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    return normalize(JSON.parse(text) as RunRecord)
  } catch {
    return null
  }
}

export interface RunQuery {
  limit?: number
  offset?: number
  workflow?: string
  status?: string
}

export interface RunPage {
  runs: RunSummary[]
  total: number
  limit: number
  offset: number
}

export async function listRuns(root: string, query: RunQuery = {}): Promise<RunPage> {
  const dir = runsDir(root)
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'))
  const records: RunRecord[] = []
  for (const file of files) {
    const text = await fs.readFile(path.join(dir, file), 'utf8').catch(() => null)
    if (text === null) continue
    try {
      records.push(normalize(JSON.parse(text) as RunRecord))
    } catch {
      /* skip unreadable record */
    }
  }
  records.sort((a, b) => (b.startedAt > a.startedAt ? 1 : b.startedAt < a.startedAt ? -1 : b.id.localeCompare(a.id)))
  const filtered = records.filter(
    (r) =>
      (query.workflow == null || query.workflow === '' || r.workflow === query.workflow) &&
      (query.status == null || query.status === '' || r.status === query.status),
  )
  const total = filtered.length
  const limit =
    query.limit != null && Number.isFinite(query.limit) && query.limit >= 1 ? Math.floor(query.limit) : 20
  const rawOffset = query.offset != null && Number.isFinite(query.offset) && query.offset >= 0 ? Math.floor(query.offset) : 0
  const offset = Math.min(rawOffset, total)
  return { runs: filtered.slice(offset, offset + limit).map(summarize), total, limit, offset }
}
