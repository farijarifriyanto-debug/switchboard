/** Shared types for Switchboard. */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** raw JSON string as produced by the model */
    arguments: string
  }
}

export interface AgentMessage {
  role: Role
  content: string
  /** Optional image inputs retained with a user turn and projected to OpenAI-compatible vision parts. */
  attachments?: Array<{ name: string; mimeType: string; dataUrl: string }>
  name?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  description?: string
  [key: string]: unknown
}

export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JsonSchema
  }
}

/** Tokens spent on one model within a session (persisted with the session). */
export interface ModelUsage {
  calls: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens: number
}

export interface SessionUsage {
  byModel: Record<string, ModelUsage>
}

export interface Usage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /** Prompt tokens served from the provider's cache. */
  cachedTokens?: number
  /** Prompt tokens written into the provider's cache (Anthropic-style). */
  cacheWriteTokens?: number
}

export interface GenerateOptions {
  model?: string
  /**
   * Provider registry id for this call (spec §7). Resolution above this field:
   * `options.provider ?? session.provider ?? the config default`. The profile
   * is snapshotted once at stream start — a settings save mid-run cannot
   * change endpoint or credentials of the in-flight request.
   */
  provider?: string
  messages: AgentMessage[]
  tools?: ToolDef[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** Correlates the call with a session for trace recording. */
  sessionId?: string
}

export interface GenerateResult {
  model: string
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  finishReason?: string
  usage: Usage
  /** ms until the first streamed token */
  ttftMs: number
  /** ms total wall clock */
  totalMs: number
  /** approximate output tokens per second */
  tokensPerSec: number
  /** Correlates the call with a session (trace + UI metadata). */
  sessionId?: string
}

export type LLMEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; result: GenerateResult }

export interface ModelInfo {
  id: string
  object?: string
  owned_by?: string
  botconnector_access?: string
  botconnector_capabilities?: { tools?: boolean; reasoning?: boolean; vision?: boolean; context?: number }
  [key: string]: unknown
}

/** What `ctx.usage.summary()` returns: totals plus an estimated cost when prices are known. */
export interface UsageSummary {
  calls: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  /** Estimated cost in USD from the model prices known right now; undefined when nothing is priced. */
  costUsd?: number
  /** True when every model used has a known price (or is free), so `costUsd` is complete. */
  complete: boolean
  /** Models used that have no known price. */
  unpriced: string[]
  /** Subagent sessions folded into the totals. */
  subagents: number
}

export type AgentEvent =
  | { type: 'step'; step: number }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string }
  | { type: 'metrics'; metrics: GenerateResult; usage?: UsageSummary }
  | { type: 'notice'; notice: string }
  | { type: 'final'; content: string; steps: number; stopReason?: 'answer' | 'step_limit' }
  | { type: 'error'; error: string }
  | { type: 'file_changed'; path: string; before: string; content: string }

/**
 * Standard incremental run events (provider/model agnostic contract between the
 * agent loop and any UI). `run` events are coarse human-meaningful frames; the
 * raw agent events ride along inside `data` for adapters like the SSE relay.
 */
export type RunEventType =
  | 'turn_started'
  | 'step_started'
  | 'assistant_stream'
  | 'tool_requested'
  | 'approval_needed'
  | 'tool_running'
  | 'tool_completed'
  | 'file_changed'
  | 'retry'
  | 'fallback'
  | 'turn_completed'
  | 'error'
  | 'cancelled'
  | 'status'
  | 'file_read'

export interface RunEvent {
  type: RunEventType
  sessionId: string
  /** Monotonic per-run event counter. */
  seq: number
  at: number
  /** Coarse lifecycle state: working | waiting_approval | idle | failed | completed | cancelled */
  status?: string
  /** Human one-liner ("Run npm test"), safe to show verbatim in the UI. */
  label?: string
  /** Structured payload (never raw chain-of-thought). */
  data?: Record<string, unknown>
}

/** A stored trace entry — one per protocol-relevant thing that happened. */
export interface TraceEntry {
  at: number
  kind: RunEventType | 'session' | 'llm' | 'tool' | 'approval'
  sessionId?: string
  requestId?: string
  /** Model actually used for an LLM call. */
  model?: string
  /** Provider/route hint when the endpoint reports one. */
  route?: string
  ttftMs?: number
  totalMs?: number
  tokensPerSec?: number
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
  cacheWriteTokens?: number
  /** Tool call name / label. */
  name?: string
  durationMs?: number
  exit?: string
  attempt?: number
  max?: number
  level: 'info' | 'warn' | 'error'
  summary: string
  detail?: string
}
