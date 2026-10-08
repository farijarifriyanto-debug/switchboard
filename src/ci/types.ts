export interface StepDef {
  name: string
  run: string
  env: Record<string, string>
  workingDirectory?: string
  timeoutMinutes?: number
}

export interface JobDef {
  id: string
  name: string
  needs: string[]
  env: Record<string, string>
  steps: StepDef[]
}

export interface ScheduleDef {
  cron: string
}

export interface Workflow {
  id: string
  name: string
  file: string
  on: unknown
  schedule: ScheduleDef[]
  env: Record<string, string>
  jobs: JobDef[]
}

export type RunStatus = 'running' | 'success' | 'failed' | 'setup-failed' | 'cancelled'
export type JobStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled'
export type StepStatus = 'success' | 'failed' | 'skipped' | 'cancelled'

export interface StepRecord {
  name: string
  run: string
  status: StepStatus
  exitCode: number | null
  startedAt: string | null
  endedAt: string | null
  log: string
  truncated?: boolean
  note?: string
}

export interface JobRecord {
  id: string
  name: string
  status: JobStatus
  startedAt?: string
  endedAt?: string
  steps: StepRecord[]
}

export interface RunRecord {
  id: string
  workflow: string
  name: string
  root: string
  status: RunStatus
  trigger: 'cli' | 'web' | 'schedule'
  error?: string
  startedAt: string
  updatedAt: string
  endedAt?: string
  jobs: JobRecord[]
}

/** RunRecord for list endpoints: step records keep status/exit only. */
export interface RunSummary extends Omit<RunRecord, 'jobs'> {
  jobs: Array<Omit<JobRecord, 'steps'> & { steps: Array<Pick<StepRecord, 'name' | 'status' | 'exitCode'>> }>
}

export type CiEvent =
  | { type: 'job_start'; job: JobDef }
  | { type: 'step_start'; job: JobDef; step: StepDef }
  | { type: 'step_end'; job: JobDef; step: StepDef; record: StepRecord }
  | { type: 'job_end'; job: JobDef; status: JobStatus }
