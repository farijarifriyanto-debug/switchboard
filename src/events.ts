/**
 * Plugin event bus contract.
 *
 * Everything in Switchboard is a plugin and every plugin may listen to or emit these
 * events through the Cordis context (`ctx.on` / `ctx.emit`). Importing this
 * module anywhere in the program is enough to register the augmentation.
 */
import type { GenerateResult } from './types.js'

declare module 'cordis' {
  interface Events {
    /** Emitted after every model call. Useful for latency telemetry plugins. */
    'llm/metrics'(metrics: GenerateResult): void
    /** A tool was registered by a plugin. */
    'tools/register'(name: string): void
    /** A tool was removed (plugin unloaded). */
    'tools/unregister'(name: string): void
    /** The agent loop started a new step. */
    'agent/step'(payload: { step: number; sessionId: string; model: string }): void
    /** A tool finished executing inside the agent loop. */
    'agent/tool'(payload: { id: string; name: string; args: unknown; result: string; sessionId: string; durationMs?: number }): void
    /** The agent produced a final answer. */
    'agent/done'(payload: { sessionId: string; steps: number; content: string }): void
    /** A new session was created. */
    'session/create'(id: string): void
    /** A message was appended to a session. */
    'session/append'(payload: { id: string; role: string }): void
    /** A request failed transiently and is about to be retried. */
    'llm/retry'(payload: { attempt: number; max: number; delayMs: number; error: string; sessionId?: string }): void
    /** The workspace boundary changed (root switched at runtime). */
    'workspace/changed'(root: string): void
    /** A tool execution paused for an operator decision. */
    'approval/request'(payload: { id: string; tool: string; args: unknown; sessionId?: string }): void
    /** The operator approved, rejected or timed out on an approval request.
     *  `approved_session` means "approved + scoped grant for this session". */
    'approval/settled'(payload: { id: string; tool: string; decision: 'approved' | 'approved_session' | 'rejected' | 'timeout' | 'cancelled' }): void
    /** The agent loop emitted a standard run event (see RunEventType). */
    'run/event'(payload: import('./types.js').RunEvent): void
    /** A delegated worker session was registered for one task (or one background child). */
    'subagent/start'(payload: { sessionId: string; parentSessionId: string; tasks: number }): void
    /** A delegated worker session finished (ok = child produced an answer). */
    'subagent/done'(payload: { sessionId: string; ok: boolean }): void
    /** A session's lifecycle status changed (working/waiting_approval/...). */
    'session/status'(payload: { id: string; status: string }): void
    /** An MCP server came up (connected, discovered and registered). */
    'mcp/server:up'(payload: { server: string }): void
    /** An MCP server went down or its reconnect budget was exhausted. */
    'mcp/server:down'(payload: { server: string; reason?: string }): void
    /** An MCP tool call finished. */
    'mcp/tool:call'(payload: { server: string; tool: string; ms: number; ok: boolean }): void
  }
}

export {}
