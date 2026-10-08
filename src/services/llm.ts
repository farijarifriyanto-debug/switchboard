import { Service } from 'cordis'
import type { Context } from 'cordis'
import { buildRequest, parseStream } from '../llm/adapters.js'
import type { AdapterRequest, ProviderProfile } from '../llm/adapters.js'
import type {
  AgentMessage,
  GenerateOptions,
  GenerateResult,
  LLMEvent,
  ModelInfo,
  Usage,
} from '../types.js'

export interface LLMConfig {
  /** OpenAI-compatible base URL. Defaults to the BotConnector Cloud API. */
  baseURL?: string
  /** API key. Falls back to BOTCONNECTOR_API_KEY / OPENAI_API_KEY env vars. */
  apiKey?: string
  /** Model used when a call does not specify one. */
  defaultModel?: string
  /** Hard timeout for a single request, in ms. */
  timeoutMs?: number
  /** Extra request headers. */
  headers?: Record<string, string>
  /** Extra body fields merged into every request (e.g. provider routing hints). */
  extraBody?: Record<string, unknown>
  /** Retry attempts for transient failures (network, 429, 5xx). 0 disables them. */
  retries?: number
  /** Base delay for exponential backoff, in ms. */
  retryDelayMs?: number
  /** Cap for a single backoff delay, in ms. */
  retryMaxDelayMs?: number
  /**
   * Optional catalog JSON (`{ models: [{ id, context }] }`) consulted for each
   * model's context window when the endpoint itself does not advertise one.
   */
  contextCatalogUrl?: string
}

const DEFAULTS: Required<Pick<LLMConfig, 'baseURL' | 'defaultModel' | 'timeoutMs'>> = {
  baseURL: 'https://api.botconnector.id/v1',
  defaultModel: 'agnes-3.0-flash',
  timeoutMs: 180_000,
}

/** HTTP statuses worth another attempt: rate limits, timeouts, server faults. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/** Re-exported for compatibility: both live with the protocol adapters now. */
export { InlineReasoningSplitter } from '../llm/adapters.js'
export type { Piece } from '../llm/adapters.js'

/**
 * `ctx.llm` — provider-agnostic chat completion service.
 *
 * Any OpenAI-compatible endpoint works (BotConnector Cloud, Ollama, vLLM,
 * OpenRouter, ...). Switchboard ships with BotConnector Cloud as the default.
 */
export class LLMService extends Service {
  static inject: string[] = []

  readonly settings: Required<Pick<LLMConfig, 'baseURL' | 'defaultModel' | 'timeoutMs'>> & LLMConfig

  /** Metrics of the most recent call — handy for `/stats` style plugins. */
  lastMetrics: GenerateResult | null = null

  constructor(ctx: Context, config: LLMConfig = {}) {
    super(ctx, 'llm')
    this.settings = { ...DEFAULTS, ...config }
  }

  resolveModel(model?: string): string {
    return model || this.settings.defaultModel
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(this.settings.headers || {}),
    }
    const key =
      this.settings.apiKey ||
      process.env.BOTCONNECTOR_API_KEY ||
      process.env.OPENAI_API_KEY
    if (key) headers.authorization = `Bearer ${key}`
    return headers
  }

  private url(path: string): string {
    return `${this.settings.baseURL.replace(/\/+$/, '')}${path}`
  }

  /** List models advertised by the endpoint. */
  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(this.url('/models'), { headers: this.headers() })
    if (!res.ok) throw new Error(`GET /models -> HTTP ${res.status}`)
    const json = (await res.json()) as { data?: ModelInfo[] }
    return json.data ?? []
  }

  /** Non-streaming helper: drains `stream()` and returns the final result. */
  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    let done: GenerateResult | undefined
    for await (const ev of this.stream(opts)) {
      if (ev.type === 'done') done = ev.result
    }
    if (!done) throw new Error('llm: stream ended without a result')
    return done
  }

  /**
   * Token accounting for the last call.
   *
   * Many providers only report prompt tokens in the final usage frame (or not at
   * all while streaming), so the output side is estimated from the response
   * text: English/Indonesian lands around four characters per token, CJK around
   * one and a half. `cachedTokens` never exceeds what the prompt held.
   */
  usageReport(usage: Usage, content: string, reasoning = ''): Usage {
    const cjk = (reasoning + content).match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0
    const other = Math.max(0, content.length - cjk)
    const estimated = cjk / 1.5 + other / 4
    const completionTokens = usage.completionTokens ?? (estimated ? Math.round(estimated) : 0)
    const cachedTokens =
      usage.cachedTokens === undefined
        ? undefined
        : Math.min(usage.cachedTokens, usage.promptTokens ?? usage.cachedTokens)
    return {
      ...usage,
      completionTokens,
      cachedTokens,
      ...(usage.totalTokens === undefined && (usage.promptTokens ?? completionTokens)
        ? { totalTokens: (usage.promptTokens ?? 0) + completionTokens }
        : {}),
    }
  }

  /**
   * Issues the request with exponential backoff on transient faults.
   *
   * Client errors (400, 401, 403, 404, ...) are returned immediately: retrying
   * them would only burn quota.
   */
  private async fetchWithRetry(request: AdapterRequest, controller: AbortController, signal?: AbortSignal, sessionId?: string): Promise<Response> {
    const maxRetries = Math.max(0, this.settings.retries ?? 0)
    const base = this.settings.retryDelayMs ?? 500
    const cap = this.settings.retryMaxDelayMs ?? 8000

    for (let attempt = 0; ; attempt += 1) {
      if (controller.signal.aborted) throw new Error('llm: aborted')
      let retryableStatus = false
      let reason = ''
      try {
        const res = await fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: controller.signal,
        })
        if (res.ok || !isRetryableStatus(res.status)) return res
        retryableStatus = true
        const text = await res.text().catch(() => '')
        reason = `llm HTTP ${res.status}: ${text.slice(0, 300)}`
      } catch (error) {
        if (controller.signal.aborted) throw error
        reason = error instanceof Error ? error.message : String(error)
        if (attempt >= maxRetries) throw error
      }
      // Exhausted the budget on a retryable status: surface the last failure.
      if (retryableStatus && attempt >= maxRetries) throw new Error(reason)
      // Jittered exponential backoff so parallel sessions do not sync up.
      const delay = Math.round(Math.min(cap, base * 2 ** attempt) * (0.5 + Math.random() * 0.5))
      this.ctx.emit('llm/retry', { attempt: attempt + 1, max: maxRetries, delayMs: delay, error: reason, sessionId })
      await sleep(delay, signal)
    }
  }

  /**
   * Resolves the provider profile for ONE request (spec §7 hot-apply).
   *
   * Taken once at `stream()` start: retries and every parse frame use this
   * snapshot, so a settings save during the run cannot change the endpoint or
   * the credentials of an in-flight call. Without a registry (or for an
   * unknown / deleted provider) the config `llm` block answers exactly as
   * before — existing installs keep today's behavior byte-for-byte.
   */
  private profileFor(providerId?: string): ProviderProfile {
    const providers = this.ctx.get('providers', false)
    const credentials = this.ctx.get('credentials', false)
    const legacy: ProviderProfile = {
      id: 'default',
      displayName: 'Default (config)',
      baseURL: this.settings.baseURL,
      protocol: 'openai-chat',
      headers: this.settings.headers,
      apiKey: this.settings.apiKey || process.env.BOTCONNECTOR_API_KEY || process.env.OPENAI_API_KEY || undefined,
      extraBody: this.settings.extraBody,
      contextCatalogUrl: this.settings.contextCatalogUrl,
    }
    if (!providers) return legacy
    const entry = providers.get(providerId || 'default')
    if (!entry) return legacy
    if (entry.id === 'default') {
      // Virtual default: same config block + credential precedence
      // (env(apiKeyEnv) > local store > config key > legacy env vars).
      return { ...legacy, apiKey: credentials?.resolve(entry) || legacy.apiKey }
    }
    return {
      id: entry.id,
      displayName: entry.displayName,
      baseURL: entry.baseURL,
      protocol: entry.protocol,
      headers: { ...(this.settings.headers || {}), ...(entry.headers || {}) },
      // NO legacy key fallback here: sending the config key to a third-party
      // endpoint would leak it. Unconfigured providers go out without auth and
      // come back with an HTTP 401 whose hint points at Settings → Models.
      apiKey: credentials?.resolve(entry),
      extraBody: this.settings.extraBody,
      contextCatalogUrl: this.settings.contextCatalogUrl,
    }
  }

  /**
   * Streaming chat completion. Yields incremental deltas, accumulated tool
   * calls and a final result carrying latency metrics.
   */
  async *stream(opts: GenerateOptions): AsyncGenerator<LLMEvent> {
    const model = this.resolveModel(opts.model)
    const started = Date.now()

    // Snapshot once, here (spec §7): the request below never re-reads settings.
    const profile = this.profileFor(opts.provider)
    const request = buildRequest(profile, {
      model,
      messages: opts.messages,
      tools: opts.tools,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    })

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs)

    let ttftMs = 0
    try {
      const res = await this.fetchWithRetry(request, controller, opts.signal, opts.sessionId)
      // The adapter parses the wire format per protocol into the same events
      // the console has always seen; `tool_call` events arrive before `done`.
      const events = parseStream(res, profile)
      let step = await events.next()
      while (!step.done) {
        const event = step.value
        if (!ttftMs && (event.type === 'delta' || event.type === 'reasoning')) ttftMs = Date.now() - started
        yield event
        step = await events.next()
      }
      const summary = step.value

      const totalMs = Date.now() - started
      if (!ttftMs) ttftMs = totalMs
      const reported = this.usageReport(summary.usage, summary.content, summary.reasoning)
      const outputTokens = reported.completionTokens ?? 0
      // Rate over the whole call: a provider that flushes the stream as one
      // burst would otherwise report a meaningless spike from a 1 ms window.
      const rateMs = Math.max(totalMs, 1)
      const result: GenerateResult = {
        model,
        content: summary.content,
        reasoning: summary.reasoning,
        toolCalls: summary.toolCalls,
        finishReason: summary.finishReason,
        usage: reported,
        ttftMs,
        totalMs,
        tokensPerSec: Math.round((outputTokens / rateMs) * 1000 * 10) / 10,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      }

      this.lastMetrics = result
      this.ctx.emit('llm/metrics', result)
      yield { type: 'done', result }
    } finally {
      clearTimeout(timer)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
    }
  }
}

declare module 'cordis' {
  interface Context {
    llm: LLMService
  }
}

export type { AgentMessage }
