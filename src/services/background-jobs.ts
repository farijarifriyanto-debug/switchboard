import type { TaskSpec, JobRecord } from '../plugins/subagent.js'

/** Stored with the parent transcript, so result delivery and its receipt are atomic. */
export interface StoredBackgroundJob extends JobRecord {
  task: TaskSpec
  delivered?: boolean
}
export interface BackgroundState {
  version: 1
  jobs: StoredBackgroundJob[]
  wakePending?: boolean
  wakeRunning?: boolean
  wakeBlocked?: boolean
}

export function validBackground(value: unknown, parentId: string): value is BackgroundState {
  const v = value as BackgroundState | undefined
  return v?.version === 1 && Array.isArray(v.jobs) && v.jobs.length <= 1000 && v.jobs.every(j =>
    j && typeof j.jobId === 'string' && /^[\w-]+$/.test(j.jobId) &&
    typeof j.sessionId === 'string' && /^[\w-]+$/.test(j.sessionId) && j.parentSessionId === parentId &&
    ['queued', 'running', 'done', 'failed'].includes(j.status) &&
    typeof j.task?.description === 'string' && j.task.description.trim().length > 0 &&
    (j.task.context === undefined || typeof j.task.context === 'string') &&
    (j.task.model === undefined || typeof j.task.model === 'string') &&
    (j.task.maxSteps === undefined || Number.isInteger(j.task.maxSteps) && j.task.maxSteps >= 1) &&
    (j.result === undefined || typeof j.result === 'string') && (j.error === undefined || typeof j.error === 'string'))
}
