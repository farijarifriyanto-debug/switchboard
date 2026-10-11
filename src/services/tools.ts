import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { JsonSchema, ToolDef } from '../types.js'
import type { Decision } from './approval.js'

export interface ToolContext {
  /** Snapshot of this session's project root; workers must not follow UI workspace switches. */
  workspace?: string
  sessionId?: string
  signal?: AbortSignal
  /** Trusted user task for this turn; browser page data must never populate it. */
  userIntent?: string
  model?: string
  provider?: string
  /** Ephemeral browser binding produced by preflight; never persisted or logged. */
  browserPageBinding?: {
    tabId: number
    origin: string
    hash: string
    kind?: 'page' | 'tab' | 'navigation'
    pageOrigin?: string
    mode?: 'manual' | 'auto' | 'skip'
    safeSnapshot?: unknown
    safeContent?: string
  }
  /** Tool names this agent may NOT run (subagent children: ['task']). */
  deny?: string[]
}

export interface ToolSpec {
  name: string
  description: string
  parameters: JsonSchema
  /** Set to false to hide the tool from the model (still callable by hand). */
  exposed?: boolean
  /** `risky` is gated by the `risky` approval mode (external tools that may mutate state). */
  risk?: 'risky'
  /** Optional per-tool action policy. Global `all` still applies to every tool. */
  requiresApproval?: (args: any, ctx: ToolContext) => boolean
  /** Structured async policy. `block` is non-overridable; `require_approval` uses ApprovalService. */
  preflight?: (args: any, ctx: ToolContext) => ToolPolicyResult | Promise<ToolPolicyResult>
  /** Safe, bounded arguments for approval UI, logs, and activity events. */
  auditArgs?: (args: any) => unknown
  execute(args: any, ctx: ToolContext): Promise<string | ToolResult> | string | ToolResult
}

export interface ToolPolicyResult {
  verdict: 'continue' | 'require_approval' | 'block'
  reason: string
}

export interface PreparedToolCall {
  name: string
  args: unknown
  context: ToolContext
  tool?: ToolRegistration
  policy: ToolPolicyResult
  needsApproval: boolean
  fingerprint: string
  earlyResult?: ToolResult
}

export interface ToolResult {
  content: string
  structuredContent?: unknown
  blocks?: unknown[]
  isError?: boolean
}

export interface ToolRegistration extends ToolSpec {
  plugin?: string
}

/** Shape used while a tool plugin is being loaded (plugin name filled in later). */
export interface ToolInput extends ToolSpec {
  plugin?: string
}

/**
 * `ctx.tools` — the tool registry every tool plugin feeds into.
 *
 * Tools are plain objects; a plugin registers them inside its `apply()` and
 * Cordis disposes the registration automatically when the plugin unloads.
 */
export class ToolsService extends Service {
  static inject: string[] = ['approvals']

  private registry = new Map<string, ToolRegistration>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  /** Names of every registered tool. */
  list(): ToolRegistration[] {
    return [...this.registry.values()]
  }

  get(name: string): ToolRegistration | undefined {
    return this.registry.get(name)
  }

  /** Registers a tool and returns its disposer (bound to the calling plugin). */
  register(spec: ToolInput): () => void {
    if (!spec.name) throw new Error('tool: name is required')
    if (this.registry.has(spec.name)) {
      this.ctx.logger('tools').warn('overriding tool %c', spec.name)
    }
    const plugin = (this.ctx.fiber?.name || 'unknown')
    this.registry.set(spec.name, { ...spec, plugin })
    this.ctx.emit('tools/register', spec.name)
    return () => {
      if (this.registry.get(spec.name)?.plugin === plugin) {
        this.registry.delete(spec.name)
        this.ctx.emit('tools/unregister', spec.name)
      }
    }
  }

  /** OpenAI `tools[]` payload for the currently registered, exposed tools. */
  defs(): ToolDef[] {
    return this.list()
      .filter((t) => t.exposed !== false)
      .map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
  }

  /** Executes a tool by name. Never throws; errors are returned as text. */
  async call(name: string, args: unknown, ctx: ToolContext = {}): Promise<string> {
    return (await this.callResult(name, args, ctx)).content
  }

  /** Additive rich-result API; string plugins and the agent loop remain compatible. */
  async callResult(name: string, args: unknown, ctx: ToolContext = {}): Promise<ToolResult> {
    return this.callPrepared(await this.prepare(name, args, ctx))
  }

  /** Evaluates a tool's policy once and binds it to this exact call. */
  async prepare(name: string, args: unknown, ctx: ToolContext = {}): Promise<PreparedToolCall> {
    const failure = (content: string): ToolResult => ({ content, isError: true })
    const tool = this.registry.get(name)
    if (!tool) return { name, args, context: ctx, policy: { verdict: 'block', reason: 'Unknown tool.' }, needsApproval: false, fingerprint: '', earlyResult: failure(`Error: unknown tool "${name}"`) }
    if (ctx.deny?.includes(name)) return { name, args, context: ctx, tool, policy: { verdict: 'block', reason: 'Tool is not available to this agent.' }, needsApproval: false, fingerprint: '', earlyResult: failure(`Error: tool "${name}" is not available to this agent`) }

    let policy: ToolPolicyResult = { verdict: 'continue', reason: '' }
    try {
      if (tool.preflight) {
        policy = await tool.preflight(args, ctx)
        if (!policy || !['continue', 'require_approval', 'block'].includes(policy.verdict)) {
          policy = { verdict: 'require_approval', reason: 'Tool policy returned an invalid decision.' }
        }
      } else {
        const requiresApproval = tool.requiresApproval
          ? tool.requiresApproval(args, ctx)
          : this.ctx.approvals.needsApproval(name, ctx.sessionId, tool.risk)
        if (requiresApproval) policy = { verdict: 'require_approval', reason: 'Approval is required by tool policy.' }
      }
    } catch {
      // A failed policy check must never turn into a successful tool call.
      policy = { verdict: 'require_approval', reason: 'Tool policy evaluation failed; approval is required.' }
    }
    const legacySessionGrant = !tool.preflight && this.ctx.approvals.hasSessionGrant(name, ctx.sessionId)
    const needsApproval = policy.verdict !== 'block' && !legacySessionGrant
      && (policy.verdict === 'require_approval' || this.ctx.approvals.mode === 'all')
    let fingerprint: string
    try {
      fingerprint = JSON.stringify({ name, args, sessionId: ctx.sessionId, userIntent: ctx.userIntent, model: ctx.model, provider: ctx.provider, browserPageBinding: ctx.browserPageBinding })
    } catch {
      return { name, args, context: ctx, tool, policy: { verdict: 'block', reason: 'Tool arguments could not be bound safely.' }, needsApproval: false, fingerprint: '', earlyResult: failure('Error: tool arguments could not be bound safely.') }
    }
    return { name, args, context: ctx, tool, policy, needsApproval, fingerprint }
  }

  /** Safe argument projection shared by tool events, traces, and approval UI. */
  auditArgs(name: string, args: unknown, ctx: ToolContext = {}): unknown {
    const tool = this.registry.get(name)
    try {
      let projected: unknown
      if (tool?.auditArgs) projected = tool.auditArgs(args)
      else if (!name.startsWith('browser_')) return args
      else {
      const redact = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(redact)
        if (!value || typeof value !== 'object') return value
        const out: Record<string, unknown> = {}
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (/^(text|value|content|password|token|authorization|cookie|secret)$/i.test(key)) continue
          if (/^(url|href)$/i.test(key) && typeof child === 'string') {
            try { out[key] = new URL(child).origin } catch { out[key] = '[redacted]' }
          } else out[key] = redact(child)
        }
        return out
      }
        projected = redact(args)
      }
      if (name.startsWith('browser_') && ctx.browserPageBinding && projected && typeof projected === 'object' && !Array.isArray(projected)) {
        return { ...(projected as Record<string, unknown>), targetOrigin: ctx.browserPageBinding.origin }
      }
      return projected
    } catch {
      return '[arguments hidden]'
    }
  }

  /** Safe arguments for persistent assistant/tool history sent back to the model.
   * Unlike auditArgs, retain the presence of private browser inputs so the model
   * can distinguish "a value was entered" from "no value was supplied".
   */
  conversationArgs(name: string, args: unknown, ctx: ToolContext = {}): unknown {
    const projected = this.auditArgs(name, args, ctx)
    if (!name.startsWith('browser_') || !args || typeof args !== 'object' || Array.isArray(args)
      || !projected || typeof projected !== 'object' || Array.isArray(projected)) return projected

    const source = args as Record<string, unknown>
    const safe = { ...(projected as Record<string, unknown>) }
    if (name === 'browser_type') {
      if (Object.prototype.hasOwnProperty.call(source, 'text')) safe.text = '[redacted]'
      else if (Object.prototype.hasOwnProperty.call(source, 'value')) safe.value = '[redacted]'
    } else if (name === 'browser_select' && Object.prototype.hasOwnProperty.call(source, 'value')) {
      safe.value = '[redacted]'
    }
    return safe
  }

  /** Runs the already-prepared call, requesting no more than one approval. */
  async callPrepared(prepared: PreparedToolCall): Promise<ToolResult> {
    const failure = (content: string): ToolResult => ({ content, isError: true })
    if (prepared.earlyResult) return prepared.earlyResult
    const tool = prepared.tool
    if (!tool) return failure(`Error: unknown tool "${prepared.name}"`)
    if (prepared.context.deny?.includes(prepared.name)) return failure(`Error: tool "${prepared.name}" is not available to this agent`)
    let currentFingerprint: string
    try {
      const ctx = prepared.context
      currentFingerprint = JSON.stringify({ name: prepared.name, args: prepared.args, sessionId: ctx.sessionId, userIntent: ctx.userIntent, model: ctx.model, provider: ctx.provider, browserPageBinding: ctx.browserPageBinding })
    } catch {
      return failure('Error: prepared tool arguments could not be verified.')
    }
    if (currentFingerprint !== prepared.fingerprint) return failure('Error: tool context changed after safety preflight; prepare the action again.')
    if (prepared.policy.verdict === 'block') return failure(`Error: action blocked by safety policy. ${prepared.policy.reason}`.trim())
    const { context: ctx } = prepared
    if (prepared.needsApproval) {
      const decision = await this.ctx.approvals.request(prepared.name, this.auditArgs(prepared.name, prepared.args, ctx), ctx.sessionId, ctx.signal)
      if (decision === 'approved_session' && !tool.preflight) this.ctx.approvals.grantSession(prepared.name, ctx.sessionId)
      if (decision === 'rejected') return failure('Error: the operator rejected this tool call.')
      if (decision === 'timeout') return failure('Error: approval timed out; the tool was not run.')
      if (decision === 'cancelled') return failure('Error: approval was cancelled; the tool was not run.')
    }
    try {
      if (ctx.signal?.aborted) return failure('Error: tool call cancelled before execution.')
      const out = await tool.execute(prepared.args, ctx)
      if (typeof out === 'string') return { content: out, ...(out.startsWith('Error:') ? { isError: true } : {}) }
      if (out && typeof out.content === 'string') {
        return { ...out, content: out.isError && !out.content.startsWith('Error:') ? `Error: ${out.content}` : out.content }
      }
      return { content: JSON.stringify(out) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return failure(`Error: ${message}`)
    }
  }

  /** Loads a Switchboard tool plugin module (for the dynamic plugin loader). */
  async loadPlugins(specs: string[], config: Record<string, any> = {}): Promise<void> {
    for (const spec of specs) {
      const normalized = spec.startsWith('.') || spec.startsWith('/') || /^[a-zA-Z]:/.test(spec)
        ? new URL(spec, `file://${process.cwd()}/`).href
        : spec
      const mod: any = await import(normalized)
      const plugin = mod.plugin ?? mod.default
      if (!plugin) {
        this.ctx.logger('tools').warn('module %c has no plugin export', spec)
        continue
      }
      await this.ctx.plugin(plugin, config[spec])
    }
  }
}

declare module 'cordis' {
  interface Context {
    tools: ToolsService
  }
}
