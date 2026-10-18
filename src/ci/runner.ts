import { spawn } from 'node:child_process'
import path from 'node:path'
import type { CiEvent, JobDef, JobRecord, JobStatus, RunRecord, StepDef, StepRecord, Workflow } from './types.js'
import { newRunId, saveRun } from './store.js'
import { SetupError } from './workflows.js'
import { killTree, trackTree } from '../services/proc.js'
import { buildSandboxCommand, killContainer, sandboxProblem, type SandboxConfig } from '../services/sandbox.js'

export interface RunOptions {
  trigger: 'cli' | 'web' | 'schedule'
  runId?: string
  keepRuns?: number
  signal?: AbortSignal
  onEvent?: (ev: CiEvent) => void
  /** Extra parent environment names a workflow step may receive. */
  envAllowlist?: string[]
  /** Sandbox wrapper for every step. `off`/absent runs on the host. */
  sandbox?: SandboxConfig
}

const LOG_CAP = 256 * 1024
const DEFAULT_TIMEOUT_MIN = 10

/**
 * The parent environment is not inherited wholesale: an operator's API keys,
 * cloud credentials, SSH agent sockets, and tokens must not become workflow
 * inputs by accident. These are the non-secret variables commands need to
 * start on Windows, macOS, and Linux. Explicit workflow/job/step `env` always
 * takes precedence, and `ci.envAllowlist` opt-ins are added by name only.
 */
export const CI_BASE_ENV_ALLOWLIST = [
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LANGUAGE', 'TZ',
  'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'OS',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData',
  'APPDATA', 'LOCALAPPDATA', 'SHELL', 'TERM', 'USER', 'LOGNAME',
  'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
] as const

export function buildCiEnv(
  parent: NodeJS.ProcessEnv,
  extra: string[] = [],
  additions: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const names = new Set<string>([...CI_BASE_ENV_ALLOWLIST, ...extra])
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    if (parent[name] !== undefined) env[name] = parent[name]
  }
  return { ...env, ...additions }
}

function shellLaunch(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    // powershell.exe reports 1 for any failed native command, so the exit code
    // has to be carried out via $LASTEXITCODE or steps lose their real code.
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}; $ok = $?; exit $(if ($LASTEXITCODE) { $LASTEXITCODE } elseif (-not $ok) { 1 } else { 0 })`],
    }
  }
  return { file: '/bin/sh', args: ['-c', command] }
}

function relativeSandboxWorkdir(root: string, cwd: string): string | null {
  const relative = path.relative(root, cwd)
  if (relative === '') return '/workspace'
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null
  return path.posix.join('/workspace', relative.split(path.sep).join('/'))
}

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

interface StepLaunch {
  file: string
  args: string[]
  cwd: string
  container?: string
}

function execStep(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; launch?: StepLaunch },
): Promise<{ code: number | null; log: string; truncated: boolean; timedOut: boolean; cancelled: boolean }> {
  return new Promise((resolve) => {
    const shell = shellLaunch(command)
    const launch = opts.launch ?? { file: shell.file, args: shell.args, cwd: opts.cwd }
    const isWin = process.platform === 'win32'
    // detached on POSIX: the step leads its own process group so killTree can stop grandchildren too.
    // A sandboxed docker client is killed together with its container below.
    const child = spawn(launch.file, launch.args, {
      cwd: launch.cwd,
      env: opts.env,
      windowsHide: true,
      detached: !isWin && !launch.container,
    })
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
    const kill = (): void => {
      killTree(child)
      if (launch.container) killContainer(launch.container)
    }
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
  const sandbox = opts.sandbox
  if (sandbox?.mode && sandbox.mode !== 'off') {
    const problem = sandboxProblem(sandbox)
    if (problem) throw new SetupError(`sandbox unavailable: ${problem}`)
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        const cwd = path.resolve(root, step.workingDirectory ?? '.')
        if (!relativeSandboxWorkdir(root, cwd)) {
          throw new SetupError(`step "${step.name}" workingDirectory escapes the workflow root`)
        }
      }
    }
  }
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
      const runnerEnv: Record<string, string> = {
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
      // Host commands receive only the documented allowlist. Explicit
      // workflow env still wins, but it is never merged with the whole parent
      // environment.
      const env = buildCiEnv(process.env, opts.envAllowlist, runnerEnv)
      const cwd = path.resolve(root, step.workingDirectory ?? '.')
      const timeoutMs = (step.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN) * 60_000
      let launch: StepLaunch | undefined
      if (sandbox?.mode && sandbox.mode !== 'off') {
        const workdir = relativeSandboxWorkdir(root, cwd)
        if (!workdir) throw new SetupError(`step "${step.name}" workingDirectory escapes the workflow root`)
        const stepIndex = job.steps.indexOf(step)
        const name = `ci-${record.id}-${job.id}-${stepIndex}`
          .replace(/[^A-Za-z0-9_.-]/g, '-')
          .slice(0, 54)
        const built = buildSandboxCommand(sandbox, {
          workspace: root,
          workdir,
          name,
          command: step.run,
          env: runnerEnv,
        })
        launch = {
          ...built,
          // The docker/bwrap client itself runs on the host, but the command
          // sees the project mounted at /workspace.
          cwd: root,
        }
      }
      const result = await execStep(step.run, {
        cwd,
        env,
        timeoutMs,
        signal: opts.signal,
        launch,
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
