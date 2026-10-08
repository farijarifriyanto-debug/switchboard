import { listWorkflows, loadWorkflow, SetupError } from './workflows.js'
import { run, type RunOptions } from './runner.js'
import { newRunId, saveRun } from './store.js'
import type { RunRecord } from './types.js'

export { SetupError, listWorkflows, loadWorkflow, parseWorkflow } from './workflows.js'
export { CronError, evaluateSchedules, loadScheduleState, nextFire, parseCron, saveScheduleState, scheduleStateFile } from './schedule.js'
export type { CronSpec, ScheduleCandidate, ScheduleDecision, ScheduleState } from './schedule.js'
export { getRun, listRuns, newRunId, resolveKeepRuns, runsDir, saveRun } from './store.js'
export { run } from './runner.js'
export type { RunOptions } from './runner.js'
export type { CiEvent, JobDef, JobRecord, JobStatus, RunRecord, RunStatus, RunSummary, ScheduleDef, StepDef, StepRecord, StepStatus, Workflow } from './types.js'
export type { RunPage, RunQuery } from './store.js'

/**
 * Runs a workflow by id or display name. Unknown names throw SetupError
 * (no record); parse/validation failures persist a `setup-failed` run.
 */
export async function runWorkflow(root: string, nameOrId: string, opts: RunOptions): Promise<RunRecord> {
  const list = await listWorkflows(root)
  const found = list.find((w) => w.id === nameOrId || w.name === nameOrId)
  if (!found) {
    throw new SetupError(`unknown workflow "${nameOrId}" (available: ${list.map((w) => w.id).join(', ') || 'none'})`)
  }
  try {
    const workflow = await loadWorkflow(root, found.id)
    return await run(root, workflow, opts)
  } catch (error) {
    if (!(error instanceof SetupError)) throw error
    const nowIso = new Date().toISOString()
    const record: RunRecord = {
      id: opts.runId ?? newRunId(),
      workflow: found.id,
      name: found.name,
      root,
      status: 'setup-failed',
      trigger: opts.trigger,
      error: error.message,
      startedAt: nowIso,
      updatedAt: nowIso,
      jobs: [],
    }
    await saveRun(root, record, opts.keepRuns)
    return record
  }
}
