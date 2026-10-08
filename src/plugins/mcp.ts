import type { Context } from 'cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { childEnv, validateMcpServers, type McpConfig, type ResolvedMcpServer } from '../config.js'
import { planMcpGeneration } from '../mcp/naming.js'
import { renderMcpResult } from '../mcp/render.js'
import type { JsonSchema } from '../types.js'

export type McpServerState = 'connecting' | 'up' | 'down' | 'exhausted'

export interface McpServerStatus {
  name: string
  state: McpServerState
  tools: string[]
  attempts: number
  lastError?: string
  reconnectInMs?: number
  endpoint?: string
}

export interface McpServiceApi {
  ready(): Promise<void>
  status(): McpServerStatus[]
  instructions(): string
  origin(toolName: string): string | undefined
}

declare module 'cordis' {
  interface Context {
    mcp?: McpServiceApi
  }
}

interface GenEntry {
  registered: string
  dispose: () => void
}

interface ServerRuntime {
  name: string
  cfg: ResolvedMcpServer
  state: McpServerState
  client?: Client
  gen: GenEntry[]
  attempts: number
  lastError?: string
  reconnectAt?: number
  timer?: ReturnType<typeof setTimeout>
  instructions: string
  stopping: boolean
  queue: Promise<void>
}

function endpointLabel(cfg: ResolvedMcpServer): string {
  return cfg.transport === 'stdio' ? [cfg.command ?? '', ...(cfg.args ?? [])].join(' ') : (cfg.url ?? '')
}

/**
 * `mcp` — one supervisor per configured server (spec §5). Fail-open: a server
 * that cannot connect logs, stays down and retries with DSH backoff; the host
 * is only affected when `failOnStartupError: true`.
 */
export const mcpBridge = {
  name: 'mcp',
  inject: ['tools'],

  async apply(ctx: Context, config: McpConfig = {}) {
    const servers = validateMcpServers(config, (msg) => ctx.logger('mcp').warn('%s', msg))
    const names = Object.keys(servers)
    if (!names.length) return

    const runtimes: ServerRuntime[] = names.map((name) => ({
      name,
      cfg: servers[name],
      state: 'connecting',
      gen: [],
      attempts: 0,
      instructions: '',
      stopping: false,
      queue: Promise.resolve(),
    }))

    // Serializes instruction acceptance across servers so the byte cap (spec
    // §6) is evaluated against a stable set.
    let instructionChain: Promise<void> = Promise.resolve()

    const clearTimer = (s: ServerRuntime): void => {
      if (s.timer) {
        clearTimeout(s.timer)
        s.timer = undefined
      }
    }

    const disposeGen = (s: ServerRuntime): void => {
      for (const entry of s.gen) entry.dispose()
      s.gen = []
    }

    const enqueue = (s: ServerRuntime, task: () => Promise<void>): Promise<void> => {
      const next = s.queue.then(task).catch((error: unknown) => {
        ctx.logger('mcp').error('server %c: %s', s.name, String(error))
      })
      s.queue = next
      return next
    }

    const status = (): McpServerStatus[] =>
      runtimes.map((s) => ({
        name: s.name,
        state: s.state,
        tools: s.gen.map((g) => g.registered),
        attempts: s.attempts,
        ...(s.lastError ? { lastError: s.lastError } : {}),
        ...(s.reconnectAt ? { reconnectInMs: Math.max(0, s.reconnectAt - Date.now()) } : {}),
        endpoint: endpointLabel(s.cfg),
      }))

    const instructions = (): string => {
      const parts: string[] = []
      for (const s of runtimes) {
        if (s.state !== 'up' || !s.instructions.trim()) continue
        parts.push(`### ${s.name}\n${s.instructions.trimEnd()}`)
      }
      return parts.length ? parts.join('\n\n') : ''
    }

    const origin = (toolName: string): string | undefined => {
      const s = runtimes.find((r) => r.gen.some((g) => g.registered === toolName))
      return s ? `mcp:${s.name}` : undefined
    }

    const acceptInstructions = async (s: ServerRuntime, raw: string): Promise<void> => {
      const task = async (): Promise<void> => {
        const text = raw.trim()
        if (!text) {
          s.instructions = ''
          return
        }
        const ownBytes = Buffer.byteLength(text, 'utf8')
        if (ownBytes > s.cfg.maxInstructionBytes) {
          throw new Error(`instructions too large: ${ownBytes} bytes exceeds maxInstructionBytes ${s.cfg.maxInstructionBytes}`)
        }
        const others = runtimes.filter((r) => r !== s && r.state === 'up' && r.instructions.trim())
        const combined =
          others.length > 0
            ? `${others.map((r) => `### ${r.name}\n${r.instructions.trim()}`).join('\n\n')}\n\n### ${s.name}\n${text}`
            : `### ${s.name}\n${text}`
        if (Buffer.byteLength(combined, 'utf8') > s.cfg.maxInstructionBytes) {
          throw new Error(`instructions too large: combined section exceeds maxInstructionBytes ${s.cfg.maxInstructionBytes} for server "${s.name}"`)
        }
        s.instructions = text
      }
      const next = instructionChain.then(task)
      instructionChain = next.catch(() => {})
      return next
    }

    const executeTool = async (
      s: ServerRuntime,
      raw: string,
      args: unknown,
      tctx: { sessionId?: string; signal?: AbortSignal },
    ): Promise<string> => {
      const started = Date.now()
      let ok = false
      try {
        if (s.state !== 'up' || !s.client) {
          throw new Error(`MCP server '${s.name}' is down${s.lastError ? `: ${s.lastError}` : ''}`)
        }
        const result = (await s.client.callTool({ name: raw, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
          timeout: s.cfg.toolCallTimeoutMs,
          ...(tctx.signal ? { signal: tctx.signal } : {}),
        })) as { content?: unknown; structuredContent?: unknown; isError?: boolean }
        const text = renderMcpResult(result, (m) => ctx.logger('mcp').debug('%s', m))
        if (result.isError) throw new Error(text)
        ok = true
        return text
      } finally {
        ctx.emit('mcp/tool:call', { server: s.name, tool: raw, ms: Date.now() - started, ok })
      }
    }

    const syncGeneration = async (s: ServerRuntime): Promise<void> => {
      if (!s.client) throw new Error('not connected')
      const listed = await s.client.listTools(undefined, { timeout: s.cfg.toolCallTimeoutMs })
      const plan = planMcpGeneration(
        s.name,
        listed.tools.map((t) => t.name),
      )
      if ('invalid' in plan) throw new Error(`invalid tool list: ${plan.invalid}`)
      const entries = listed.tools.map((t, i) => {
        const registered = plan.names[i]
        const existing = ctx.tools.get(registered)
        const ours = s.gen.some((g) => g.registered === registered)
        if (existing && existing.plugin !== 'mcp') {
          throw new Error(`registration conflict: "${registered}" already provided by ${existing.plugin}`)
        }
        if (existing && existing.plugin === 'mcp' && !ours) {
          throw new Error(`registration conflict: "${registered}" already provided by another MCP server`)
        }
        return {
          registered,
          raw: t.name,
          description: typeof t.description === 'string' && t.description ? t.description : `MCP tool ${t.name} from server ${s.name}`,
          parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as JsonSchema,
          // only a server-declared readOnlyHint skips the `risky` approval gate
          risk: (t.annotations?.readOnlyHint === true ? undefined : 'risky') as 'risky' | undefined,
        }
      })
      // Atomic swap: no await between unregister and register, so no caller
      // can ever observe a partial generation (spec §4/§5).
      disposeGen(s)
      s.gen = entries.map((entry) => ({
        registered: entry.registered,
        dispose: ctx.tools.register({
          name: entry.registered,
          description: entry.description,
          parameters: entry.parameters,
          ...(entry.risk ? { risk: entry.risk } : {}),
          execute: (args, tctx) => executeTool(s, entry.raw, args, tctx),
        }),
      }))
    }

    const scheduleBudgetReset = (s: ServerRuntime): void => {
      clearTimer(s)
      s.timer = setTimeout(() => {
        s.timer = undefined
        if (s.stopping || s.state !== 'up') return
        if (s.attempts > 0) ctx.logger('mcp').info('server %c: stable, resetting reconnect budget', s.name)
        s.attempts = 0
      }, s.cfg.reconnect.maxDelayMs)
      s.timer.unref?.()
    }

    const fail = async (s: ServerRuntime, error: unknown, isBootAttempt: boolean): Promise<void> => {
      const message = error instanceof Error ? error.message : String(error)
      s.lastError = message
      s.state = 'down'
      s.reconnectAt = undefined
      ctx.logger('mcp').error('server %c: %s', s.name, message)
      ctx.emit('mcp/server:down', { server: s.name, reason: message })
      if (isBootAttempt && s.cfg.failOnStartupError) {
        throw new Error(`mcp server '${s.name}': ${message}`, { cause: error })
      }
      if (!s.cfg.reconnect.enabled) return
      s.attempts += 1
      if (s.attempts >= s.cfg.reconnect.maxAttempts) {
        s.state = 'exhausted'
        disposeGen(s)
        s.instructions = ''
        ctx.logger('mcp').error('server %c: reconnect budget exhausted after %d attempts; restart to retry', s.name, s.attempts)
        ctx.emit('mcp/server:down', { server: s.name, reason: 'reconnect budget exhausted' })
        return
      }
      const delay = Math.min(s.cfg.reconnect.initialDelayMs * 2 ** (s.attempts - 1), s.cfg.reconnect.maxDelayMs)
      s.reconnectAt = Date.now() + delay
      s.timer = setTimeout(() => {
        s.timer = undefined
        s.reconnectAt = undefined
        void enqueue(s, () => connectOnce(s, false))
      }, delay)
      s.timer.unref?.()
    }

    const onDrop = (s: ServerRuntime, client: Client): void => {
      if (s.stopping || s.client !== client) return
      s.client = undefined
      clearTimer(s)
      void fail(s, new Error('connection closed'), false)
    }

    async function connectOnce(s: ServerRuntime, isBootAttempt: boolean): Promise<void> {
      s.state = 'connecting'
      let client: Client | undefined
      try {
        const cfg = s.cfg
        client = new Client({ name: 'switchboard-sbx', version: '0.2.0' })
        if (cfg.transport === 'stdio') {
          await client.connect(
            new StdioClientTransport({
              command: cfg.command as string,
              args: cfg.args,
              env: childEnv(cfg.env ?? {}),
              ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
            }),
          )
        } else {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(cfg.url as string), {
              requestInit: { headers: cfg.headers },
            }),
          )
        }

        await acceptInstructions(s, client.getInstructions() ?? '')
        s.client = client

        // Drop detection: child crash / transport loss (our own close is
        // guarded by s.stopping and the identity check).
        client.onclose = () => onDrop(s, client as Client)

        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          void enqueue(s, async () => {
            if (s.stopping || s.state !== 'up') return
            try {
              await syncGeneration(s)
            } catch (error) {
              ctx.logger('mcp').error(
                'server %c: tools/list_changed resync failed, keeping previous tools: %s',
                s.name,
                String(error),
              )
            }
          })
        })

        await syncGeneration(s)
        s.state = 'up'
        s.lastError = undefined
        s.reconnectAt = undefined
        scheduleBudgetReset(s)
        ctx.emit('mcp/server:up', { server: s.name })
      } catch (error) {
        const failed = client
        s.client = undefined
        try {
          await failed?.close()
        } catch {
          /* closing a dead client is best-effort */
        }
        await fail(s, error, isBootAttempt)
      }
    }

    const readyPromise = Promise.allSettled(runtimes.map((s) => connectOnce(s, true))).then((results) => {
      const failed = results.find((r) => r.status === 'rejected')
      if (failed) throw (failed as PromiseRejectedResult).reason
    })

    ctx.reflect.provide('mcp', {
      ready: () => readyPromise,
      status,
      instructions,
      origin,
    } satisfies McpServiceApi)

    ctx.effect(() => () => {
      for (const s of runtimes) {
        s.stopping = true
        clearTimer(s)
        disposeGen(s)
        s.instructions = ''
        const client = s.client
        s.client = undefined
        void client?.close().catch(() => {})
      }
    })

    await readyPromise
  },
}
