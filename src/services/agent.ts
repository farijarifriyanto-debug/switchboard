import type { AgentEvent } from '../types.js'

/** Per-run options accepted by `ctx.agent.stream` (spec §8). */
export interface AgentStreamOptions {
  signal?: AbortSignal
  attachments?: Array<{ name: string; mimeType: string; dataUrl: string }>
  /** Full system override for this run only (merged like config.system:
   *  PLATFORM_HINT appended when absent; AGENTS.md injection still boot-time). */
  system?: string
  /** Per-run model id (resolution: options.model ?? session.model ?? llm.defaultModel). */
  model?: string
  /** Per-run provider id (resolution: options.provider ?? session.provider ?? default, spec §7). */
  provider?: string
  /** Per-run agent-loop budget (overrides AgentLoopConfig.maxSteps for this run). */
  maxSteps?: number
  /** Preset id for this run (also stored on the session). Explicit options below win over it. */
  preset?: string
  /** Tool names hidden from this run (subagent children must never see `task`). */
  excludeTools?: string[]
}

/**
 * `ctx.agent` — populated by the `agent-loop` plugin.
 *
 * Declared as a service shape so other plugins can inject it without importing
 * the implementation.
 */
export interface AgentService {
  run(prompt: string, sessionId?: string): Promise<string>
  stream(prompt: string, sessionId?: string, options?: AgentStreamOptions): AsyncGenerator<AgentEvent>
}

declare module 'cordis' {
  interface Context {
    agent: AgentService
  }
}
