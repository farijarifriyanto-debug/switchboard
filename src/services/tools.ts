import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { JsonSchema, ToolDef } from '../types.js'
import type { Decision } from './approval.js'

export interface ToolContext {
  sessionId?: string
  signal?: AbortSignal
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
  execute(args: any, ctx: ToolContext): Promise<string> | string
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
    const tool = this.registry.get(name)
    if (!tool) return `Error: unknown tool "${name}"`
    if (ctx.deny?.includes(name)) {
      return `Error: tool "${name}" is not available to this agent`
    }
    try {
      // The approval gate lives here so *every* caller (agent loop, console,
      // future subagents) is covered by the same policy. needsApproval()
      // already honors a live "Allow for this session" grant.
      if (this.ctx.approvals.needsApproval(name, ctx.sessionId, tool.risk)) {
        const decision = await this.ctx.approvals.request(name, args, ctx.sessionId, ctx.signal)
        if (decision === 'approved_session') this.ctx.approvals.grantSession(name, ctx.sessionId)
        if (decision === 'rejected') return 'Error: the operator rejected this tool call.'
        if (decision === 'timeout') return 'Error: approval timed out; the tool was not run.'
        if (decision === 'cancelled') return 'Error: approval was cancelled; the tool was not run.'
      }
      const out = await tool.execute(args, ctx)
      return typeof out === 'string' ? out : JSON.stringify(out)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Error: ${message}`
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
