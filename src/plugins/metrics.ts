import { Service } from 'cordis'
import type { Context } from 'cordis'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { GenerateResult } from '../types.js'

export interface MetricsConfig {
  /** Max in-memory samples kept. */
  limit?: number
  /** Optional JSONL file to append samples to (enables cross-process `sbx metrics`). */
  persist?: string
  /** Load existing samples from `persist` on startup. */
  load?: boolean
}

export interface LatencySample {
  at: number
  model: string
  ttftMs: number
  totalMs: number
  tokensPerSec: number
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
}

/**
 * `ctx.metrics` — collects per-call latency telemetry.
 *
 * This is the plugin that turns the harness into something you can tune:
 * keep it loaded and every model call feeds p50/p95 latency numbers.
 */
export class MetricsService extends Service {
  static inject: string[] = []

  samples: LatencySample[] = []
  private limit: number
  private persist?: string

  constructor(ctx: Context, config: MetricsConfig = {}) {
    super(ctx, 'metrics')
    this.limit = config.limit ?? 500
    this.persist = config.persist
      ? config.persist.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE ?? process.env.HOME ?? '.')
      : undefined
    ctx.on('llm/metrics', (m: GenerateResult) => {
      this.record(m)
      void this.flush(m)
    })
    if (config.persist && config.load) void this.hydrate()
  }

  /** Loads previously persisted samples (used by the `sbx metrics` view). */
  async hydrate(): Promise<number> {
    if (!this.persist) return 0
    const text = await readFile(this.persist, 'utf8').catch(() => '')
    if (!text) return 0
    const lines = text.split(/\r?\n/).filter(Boolean).slice(-this.limit)
    const loaded: LatencySample[] = []
    for (const line of lines) {
      try {
        loaded.push(JSON.parse(line) as LatencySample)
      } catch {
        /* skip malformed line */
      }
    }
    this.samples = loaded
    return loaded.length
  }

  private async flush(m: GenerateResult): Promise<void> {
    if (!this.persist) return
    const sample: LatencySample = {
      at: Date.now(),
      model: m.model,
      ttftMs: m.ttftMs,
      totalMs: m.totalMs,
      tokensPerSec: m.tokensPerSec,
      promptTokens: m.usage.promptTokens,
      completionTokens: m.usage.completionTokens,
      cachedTokens: m.usage.cachedTokens,
    }
    try {
      await mkdir(path.dirname(this.persist), { recursive: true })
      await appendFile(this.persist, JSON.stringify(sample) + '\n', 'utf8')
    } catch {
      /* telemetry must never break a run */
    }
  }

  record(m: GenerateResult): void {
    this.samples.push({
      at: Date.now(),
      model: m.model,
      ttftMs: m.ttftMs,
      totalMs: m.totalMs,
      tokensPerSec: m.tokensPerSec,
      promptTokens: m.usage.promptTokens,
      completionTokens: m.usage.completionTokens,
      cachedTokens: m.usage.cachedTokens,
    })
    if (this.samples.length > this.limit) this.samples.splice(0, this.samples.length - this.limit)
  }

  /** Aggregates samples per model. */
  summary(): Record<string, { calls: number; ttftP50: number; ttftP95: number; tpsP50: number }> {
    const groups = new Map<string, LatencySample[]>()
    for (const s of this.samples) {
      const list = groups.get(s.model) ?? []
      list.push(s)
      groups.set(s.model, list)
    }
    const percentile = (values: number[], p: number) => {
      if (!values.length) return 0
      const sorted = [...values].sort((a, b) => a - b)
      const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
      return Math.round(sorted[idx])
    }
    const out: Record<string, { calls: number; ttftP50: number; ttftP95: number; tpsP50: number }> = {}
    for (const [model, list] of groups) {
      out[model] = {
        calls: list.length,
        ttftP50: percentile(list.map((s) => s.ttftMs), 50),
        ttftP95: percentile(list.map((s) => s.ttftMs), 95),
        tpsP50: percentile(list.map((s) => s.tokensPerSec), 50),
      }
    }
    return out
  }

  clear(): void {
    this.samples = []
  }
}

declare module 'cordis' {
  interface Context {
    metrics: MetricsService
  }
}
