import type { Context } from 'cordis'
import type { ToolSpec } from '../services/tools.js'
import { assertPublicUrl } from '../services/netguard.js'

export interface SearchConfig {
  /** Keenable API key for BYOK. Falls back to the KEENABLE_API_KEY env var; without one the keyless public endpoint is used. */
  apiKey?: string
  /** Search API base URL. Falls back to KEENABLE_API_URL, then the Keenable default. */
  apiUrl?: string
  /** Attribution title sent to the keyless endpoint. Falls back to KEENABLE_TITLE. */
  title?: string
  /** Default number of results. */
  maxResults?: number
  /** Request timeout, in ms. */
  timeoutMs?: number
  /**
   * `keenable` (default) keeps the keyless public endpoint — no quota, no
   * billing. `botconnector` opts into the native BotConnector Cloud endpoint
   * (tried first, with automatic Keenable fallback on error/empty/no-key).
   */
  provider?: 'keenable' | 'botconnector'
  /** Native endpoint base URL (including /v1). Defaults to the public BotConnector API. */
  botconnectorBaseURL?: string
  /** API key for the native endpoint. Falls back to the BOTCONNECTOR_API_KEY env var. */
  botconnectorApiKey?: string
}

export interface WebConfig {
  /** Max characters returned per page. */
  maxChars?: number
  /** Request timeout, in ms. */
  timeoutMs?: number
  /** User-Agent header. */
  userAgent?: string
  /** Let `web_fetch` reach loopback/private addresses (off by default: SSRF guard). */
  allowPrivateNetwork?: boolean
  /** `web_search` provider settings (Keenable). */
  search?: SearchConfig
}

/** `tools-web` — search the web and fetch a URL as plain text. */
export const toolsWeb = {
  name: 'tools-web',
  inject: ['tools'],

  apply(ctx: Context, config: WebConfig = {}) {
    const maxChars = config.maxChars ?? 20_000
    const timeoutMs = config.timeoutMs ?? 20_000
    const userAgent = config.userAgent ?? 'switchboard/0.2 (+https://botconnector.id)'

    const searchCfg = config.search ?? {}
    const searchKey = searchCfg.apiKey || process.env.KEENABLE_API_KEY || ''
    const searchBase = (searchCfg.apiUrl || process.env.KEENABLE_API_URL || 'https://api.keenable.ai').replace(/\/+$/, '')
    const searchTitle = searchCfg.title || process.env.KEENABLE_TITLE || 'Switchboard'
    const searchMax = Math.max(1, Math.min(searchCfg.maxResults ?? 8, 20))
    const searchTimeout = searchCfg.timeoutMs ?? 15_000
    const nativeEnabled = searchCfg.provider === 'botconnector'
    const nativeBase = (searchCfg.botconnectorBaseURL || 'https://api.botconnector.id/v1').replace(/\/+$/, '')
    const nativeKey = searchCfg.botconnectorApiKey || process.env.BOTCONNECTOR_API_KEY || ''

    const def: ToolSpec = {
      name: 'web_fetch',
      description: 'Fetch a URL and return its text content (HTML tags stripped).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL.' },
        },
        required: ['url'],
      },
      async execute(args: { url: string }) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          // Follow redirects by hand so every hop is checked, not just the first URL.
          let target = String(args.url)
          let res: Response | undefined
          for (let hop = 0; hop <= 5; hop += 1) {
            const checked = config.allowPrivateNetwork ? new URL(target) : await assertPublicUrl(target)
            res = await fetch(checked, { headers: { 'user-agent': userAgent }, signal: controller.signal, redirect: 'manual' })
            const next = res.headers.get('location')
            if (res.status >= 300 && res.status < 400 && next) {
              await res.body?.cancel()
              target = new URL(next, checked).href
              continue
            }
            break
          }
          if (!res || (res.status >= 300 && res.status < 400)) throw new Error('too many redirects')
          // Read at most ~4 bytes per kept character, then stop: a huge body must not fill memory.
          const limit = maxChars * 4
          const reader = res.body?.getReader()
          const parts: Uint8Array[] = []
          let size = 0
          while (reader && size < limit) {
            const { done, value } = await reader.read()
            if (done) break
            parts.push(value)
            size += value.length
          }
          await reader?.cancel().catch(() => undefined)
          const text = Buffer.concat(parts).toString('utf8')
          const plain = text
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
          return `HTTP ${res.status}\n${plain.slice(0, maxChars)}`
        } finally {
          clearTimeout(timer)
        }
      },
    }

    const searchDef: ToolSpec = {
      name: 'web_search',
      description:
        'Search the web and return ranked results (title, url, snippet). Use it to discover pages, then web_fetch to read one.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          max_results: { type: 'number', description: `How many results to return (default ${searchMax}, max 20).` },
        },
        required: ['query'],
      },
      async execute(args: { query: string; max_results?: number }) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), searchTimeout)
        try {
          const want = Math.max(1, Math.min(Number(args.max_results) || searchMax, 20))
          type SearchResult = { title?: string; url?: string; snippet?: string; description?: string }
          const format = (results: SearchResult[]) => {
            const lines = results.slice(0, want).map((r, i) => {
              const snippet = String(r.snippet || r.description || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 600)
              return `${i + 1}. ${r.title || '(no title)'}\n   ${r.url || ''}${snippet ? `\n   ${snippet}` : ''}`
            })
            return `Results for: ${args.query} (${results.length} shown)\n\n${lines.join('\n\n')}`.slice(0, maxChars)
          }
          const readResults = (body: { results?: unknown }): SearchResult[] =>
            Array.isArray(body.results) ? (body.results as SearchResult[]) : []
          const failReason = (error: unknown) => {
            const err = error as { name?: string; message?: string }
            return err?.name === 'AbortError' ? 'timed out' : err?.message || String(error)
          }
          const errors: string[] = []

          // Opt-in native BotConnector endpoint: tried first; any failure or an
          // empty payload falls through to Keenable below.
          if (nativeEnabled && nativeKey) {
            try {
              const res = await fetch(`${nativeBase}/web/search`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${nativeKey}` },
                body: JSON.stringify({ query: args.query, max_results: want }),
                signal: controller.signal,
              })
              const body = (await res.json().catch(() => ({}))) as { results?: unknown }
              if (!res.ok) throw new Error(`HTTP ${res.status}`)
              const results = readResults(body)
              if (results.length) return format(results)
              errors.push('BotConnector: no results')
            } catch (error) {
              errors.push(`BotConnector: ${failReason(error)}`)
            }
          }

          // Keenable: the default path, and the safety net for the native endpoint.
          try {
            const keyed = Boolean(searchKey)
            const headers: Record<string, string> = { 'content-type': 'application/json' }
            if (keyed) headers['x-api-key'] = searchKey
            else headers['x-keenable-title'] = searchTitle
            const res = await fetch(`${searchBase}/v1/search${keyed ? '' : '/public'}`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ query: args.query, max_results: want }),
              signal: controller.signal,
            })
            const body = (await res.json().catch(() => ({}))) as { results?: unknown }
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const results = readResults(body)
            if (!results.length) return 'No results.'
            return format(results)
          } catch (error) {
            errors.push(`Keenable: ${failReason(error)}`)
            return `Error: web search failed (${errors.join('; ')}).`
          }
        } finally {
          clearTimeout(timer)
        }
      },
    }

    ctx.effect(() => ctx.tools.register(def))
    ctx.effect(() => ctx.tools.register(searchDef))
  },
}
