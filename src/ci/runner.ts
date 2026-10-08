import { spawn } from 'node:child_process'
import path from 'node:path'
import type { CiEvent, JobDef, JobRecord, JobStatus, RunRecord, StepDef, StepRecord, Workflow } from './types.js'
import { newRunId, saveRun } from './store.js'
import { killTree, trackTree } from '../services/proc.js'

export interface RunOptions {
  trigger: 'cli' | 'web' | 'schedule'
  runId?: string
  keepRuns?: number
  signal?: AbortSignal
  onEvent?: (ev: CiEvent) => void
}

const LOG_CAP = 256 * 1024
const DEFAULT_TIMEOUT_MIN = 10

/** Stable topological order: file order first, needs respected, ties keep file order. */
function topoOrder(jobs: JobDef[]): JobDef[] {
  const done = new Set<string>()
  const out: JobDef[] = []
  while (out.length < jobs.length) {
    const next = jobs.find((j) => !done.has(j.id) && j.needs.every((n) => done.has(n)))
    if (!next) throw new Error('jobs contain a dependency cycle')
    done.add(next.id)
    out.push(next)
  }
  return out
}

function execStep(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number | null; log: string; truncated: boolean; timedOut: boolean; cancelled: boolean }> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const file = isWin ? 'powershell.exe' : '/bin/sh'
    // powershell.exe reports 1 for any failed native command, so the exit code
    // has to be carried out via $LASTEXITCODE or steps lose their real code.
    // $LASTEXITCODE stays null when the step failed only through a cmdlet, so
    // fall back to $?: 1 when the last statement failed, 0 when it succeeded.
    const args = isWin
      ? ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}; $ok = $?; exit $(if ($LASTEXITCODE) { $LASTEXITCODE } elseif (-not $ok) { 1 } else { 0 })`]
      : ['-c', command]
    // detached on POSIX: the step leads its own process group so killTree can stop grandchildren too
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, detached: !isWin })
    trackTree(child)
    let log = ''
    let truncated = false
    let timedOut = false
    let cancelled = false
    const append = (chunk: Buffer): void => {
      if (truncated) return
      const room = LOG_CAP - log.length
      log += chunk.toString('utf8').slice(0, Math.max(0, room))
      if (log.length >= LOG_CAP) truncated = true
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const kill = (): void => killTree(child)
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, opts.timeoutMs)
    const onAbort = (): void => {
      cancelled = true
      kill()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (code: number | null, extra = ''): void => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (extra) log += (log ? '\n' : '') + extra
      if (truncated) log += '\n…[log truncated]'
      resolve({ code, log, truncated, timedOut, cancelled })
    }
    child.on('error', (error) => finish(1, String(error)))
    child.on('close', (code) => finish(code))
  })
}

export async function run(root: string, workflow: Workflow, opts: RunOptions): Promise<RunRecord> {
  const nowIso = (): string => new Date().toISOString()
  const record: RunRecord = {
    id: opts.runId ?? newRunId(),
    workflow: workflow.id,
    name: workflow.name,
    root,
    status: 'running',
    trigger: opts.trigger,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    jobs: workflow.jobs.map((j) => ({ id: j.id, name: j.name, status: 'pending' as JobStatus, steps: [] })),
  }
  const emit = (ev: CiEvent): void => opts.onEvent?.(ev)
  const persist = (): Promise<void> => saveRun(root, record, opts.keepRuns)
  await persist()

  const statusById = new Map<string, JobStatus>(record.jobs.map((j) => [j.id, j.status]))
  for (const job of topoOrder(workflow.jobs)) {
    const jobRecord = record.jobs.find((j) => j.id === job.id) as JobRecord
    if (opts.signal?.aborted) {
      jobRecord.status = 'cancelled'
      statusById.set(job.id, 'cancelled')
      await persist()
      continue
    }
    const needFailed = job.needs.some((n) => ['failed', 'skipped'].includes(statusById.get(n) ?? ''))
    if (needFailed) {
      jobRecord.status = 'skipped'
      statusById.set(job.id, 'skipped')
      await persist()
      emit({ type: 'job_end', job, status: 'skipped' })
      continue
    }

    jobRecord.status = 'running'
    jobRecord.startedAt = nowIso()
    await persist()
    emit({ type: 'job_start', job })

    let outcome: JobStatus = 'success'
    for (const step of job.steps) {
      const aborted = opts.signal?.aborted === true
      if (aborted || outcome !== 'success') {
        // abort only cancels a job that was still passing — a failed job
        // keeps 'failed' or the run-status formula can report success
        const cancelledNow = aborted && outcome === 'success'
        jobRecord.steps.push({
          name: step.name,
          run: step.run,
          status: cancelledNow ? 'cancelled' : 'skipped',
          exitCode: null,
          startedAt: null,
          endedAt: null,
          log: '',
        })
        if (cancelledNow) outcome = 'cancelled'
        continue
      }
      emit({ type: 'step_start', job, step })
      const startedAt = nowIso()
      const env: NodeJS.ProcessEnv = {
        // commands need PATH/PATHEXT from the parent shell, but CI vars must
        // win over whatever the parent happens to export
        ...process.env,
        CI: 'true',
        SWITCHBOARD_CI: '1',
        SWITCHBOARD_CI_WORKFLOW: workflow.id,
        SWITCHBOARD_CI_RUN_ID: record.id,
        SWITCHBOARD_CI_JOB: job.id,
        SWITCHBOARD_CI_STEP: step.name,
        ...workflow.env,
        ...job.env,
        ...step.env,
      }
      const timeoutMs = (step.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN) * 60_000
      const result = await execStep(step.run, {
        cwd: path.resolve(root, step.workingDirectory ?? '.'),
        env,
        timeoutMs,
        signal: opts.signal,
      })
      const stepRecord: StepRecord = {
        name: step.name,
        run: step.run,
        status: result.cancelled ? 'cancelled' : result.code === 0 ? 'success' : 'failed',
        exitCode: result.code,
        startedAt,
        endedAt: nowIso(),
        log: result.log,
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.timedOut ? { note: `step timed out after ${step.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN} minute(s)` } : {}),
      }
      jobRecord.steps.push(stepRecord)
      if (stepRecord.status === 'cancelled') outcome = 'cancelled'
      else if (stepRecord.status === 'failed') outcome = 'failed'
      await persist()
      emit({ type: 'step_end', job, step, record: stepRecord })
    }

    jobRecord.status = outcome
    jobRecord.endedAt = nowIso()
    statusById.set(job.id, outcome)
    await persist()
    emit({ type: 'job_end', job, status: outcome })
  }

  // spec: success only when every job succeeded; a failure (skips only ever
  // cascade from one) wins over cancellation; anything else is cancelled.
  record.status = record.jobs.some((j) => j.status === 'failed')
    ? 'failed'
    : record.jobs.every((j) => j.status === 'success')
      ? 'success'
      : 'cancelled'
  record.endedAt = nowIso()
  await persist()
  return record
}
