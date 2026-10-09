import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { GenerateResult, ModelInfo, ModelUsage, UsageSummary } from '../types.js'

/** USD per 1M tokens. `cachedInput` / `cacheWrite` default to the plain input price. */
export interface PriceConfig {
  input: number
  output: number
  cachedInput?: number
  cacheWrite?: number
}

export interface UsageConfig {
  /** Prices by model id; they win over whatever the endpoint advertises. */
  pricing?: Record<string, PriceConfig>
  /** How long the endpoint's price list is trusted before it is fetched again. */
  refreshMs?: number
}

const FREE: PriceConfig = { input: 0, output: 0 }
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined)

/** Reads a price from a model entry: BotConnector's `botconnector_pricing`, or OpenRouter-style `pricing` (per token). */
export function priceFromModel(model: ModelInfo): PriceConfig | undefined {
  const bc = model.botconnector_pricing as Record<string, unknown> | null | undefined
  if (bc && typeof bc === 'object') {
    const input = finite(bc.input)
    const output = finite(bc.output)
    if (input !== undefined && output !== undefined) return { input, output, ...(finite(bc.cachedInput) !== undefined && { cachedInput: finite(bc.cachedInput) }), ...(finite(bc.cacheWrite) !== undefined && { cacheWrite: finite(bc.cacheWrite) }) }
  }
  const per = model.pricing as Record<string, unknown> | undefined
  if (per && typeof per === 'object') {
    const perToken = (v: unknown): number | undefined => {
      const n = typeof v === 'string' ? Number(v) : v
      return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined
    }
    const input = perToken(per.prompt)
    const output = perToken(per.completion)
    if (input !== undefined && output !== undefined) return { input, output, ...(perToken(per.input_cache_read) !== undefined && { cachedInput: perToken(per.input_cache_read) }) }
  }
  // A free model advertises no price at all; do not mistake that for "unknown".
  if (model.botconnector_access === 'free') return FREE
  return undefined
}

/** USD for one model's tokens. `prompt` includes the cached and cache-write tokens. */
export function costOf(row: ModelUsage, price: PriceConfig): number {
  const cached = Math.min(row.cachedTokens, row.promptTokens)
  const written = Math.min(row.cacheWriteTokens, Math.max(0, row.promptTokens - cached))
  const fresh = Math.max(0, row.promptTokens - cached - written)
  return (fresh * price.input + cached * (price.cachedInput ?? price.input) + written * (price.cacheWrite ?? price.input) + row.completionTokens * price.output) / 1_000_000
}

/**
 * `ctx.usage` — per-session token totals and an estimated cost.
 *
 * Tokens are recorded on the session as they are reported; cost is computed when asked,
 * from the prices known at that moment, so a price list that loads late still counts.
 * It is an estimate: a model with no known price is listed in `unpriced`, never counted as free.
 */
export class UsageService extends Service {
  static inject: string[] = []

  private prices = new Map<string, PriceConfig>()
  private fromEndpoint = new Map<string, PriceConfig>()
  private loadedAt = 0
  private loading?: Promise<void>
  private readonly refreshMs: number

  constructor(ctx: Context, private config: UsageConfig = {}) {
    super(ctx, 'usage')
    this.refreshMs = config.refreshMs ?? 10 * 60_000
    for (const [model, price] of Object.entries(config.pricing ?? {})) this.prices.set(model, price)
    ctx.on('llm/metrics', (result: GenerateResult) => {
      if (!result.sessionId) return
      this.ctx.get('sessions', false)?.addUsage(result.sessionId, result.model, result.usage)
      this.ensure()
    })
    // Fetch prices when a turn starts, so the first answer already has a cost.
    ctx.on('run/event', (event) => {
      if (event.type === 'turn_started') this.ensure()
    })
  }

  private ensure(): void {
    if (Date.now() - this.loadedAt > this.refreshMs) void this.refresh()
  }

  /** Fetches the endpoint's price list (best effort; never throws). */
  refresh(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const models = (await this.ctx.get('llm', false)?.listModels()) ?? []
        const next = new Map<string, PriceConfig>()
        for (const model of models) {
          const price = priceFromModel(model)
          if (price) next.set(model.id, price)
        }
        this.fromEndpoint = next
      } catch {
        /* an unreachable endpoint just leaves costs unknown */
      } finally {
        this.loadedAt = Date.now()
        this.loading = undefined
      }
    })()
    return this.loading
  }

  priceOf(model: string): PriceConfig | undefined {
    const bare = model.includes(':') ? model.slice(model.indexOf(':') + 1) : model
    return this.prices.get(model) ?? this.prices.get(bare) ?? this.fromEndpoint.get(model) ?? this.fromEndpoint.get(bare)
  }

  /** Totals for a session, folding in the subagent sessions it started. */
  summary(sessionId: string, options: { workersOnly?: boolean } = {}): UsageSummary {
    const sessions = this.ctx.get('sessions', false)
    if (!sessions) return { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, complete: true, unpriced: [], subagents: 0 }
    const ids = [...(options.workersOnly ? [] : [sessionId]), ...sessions.list().filter((s) => s.parentSessionId === sessionId && s.kind === 'subagent').map((s) => s.id)]
    const out: UsageSummary = { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, complete: true, unpriced: [], subagents: ids.length - (options.workersOnly ? 0 : 1) }
    let cost = 0
    let priced = false
    for (const id of ids) {
      for (const [model, row] of Object.entries(sessions.get(id)?.usage?.byModel ?? {})) {
        out.calls += row.calls
        out.promptTokens += row.promptTokens
        out.completionTokens += row.completionTokens
        out.cachedTokens += row.cachedTokens
        out.cacheWriteTokens += row.cacheWriteTokens
        const price = this.priceOf(model)
        if (price) {
          cost += costOf(row, price)
          priced = true
        } else if (!out.unpriced.includes(model)) {
          out.unpriced.push(model)
          out.complete = false
        }
      }
    }
    if (priced) out.costUsd = cost
    return out
  }
}

/** "12.3k in · 1.1k out · ≈ $0.0123" — what the console, Telegram and CLI show. */
export function formatUsage(u: UsageSummary): string {
  if (!u.calls) return 'no model calls yet'
  const k = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const parts = [`${k(u.promptTokens)} in`, `${k(u.completionTokens)} out`]
  if (u.cachedTokens) parts.push(`${k(u.cachedTokens)} cached`)
  if (u.costUsd !== undefined) parts.push(`${u.complete ? '≈' : '≥'} $${u.costUsd < 0.01 && u.costUsd > 0 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)}`)
  else parts.push('cost unknown')
  if (u.subagents) parts.push(`incl. ${u.subagents} subagent${u.subagents === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

declare module 'cordis' {
  interface Context {
    usage: UsageService
  }
}
