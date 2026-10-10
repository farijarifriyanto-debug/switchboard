import type { Context } from 'cordis'
import http from 'node:http'
import { readFile, stat, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { AgentEvent, RunEvent } from '../types.js'
import type { McpServiceApi } from './mcp.js'
import type { BrowserCompanionService } from './browser-companion.js'
import { SettingsError } from '../services/settings-error.js'
import { expandHome } from '../services/session.js'
import { PROTOCOLS } from '../services/providers.js'
import { listModels as discoverModels } from '../llm/discovery.js'
import type { ProviderProfile } from '../llm/adapters.js'
import { evaluateSchedules, getRun, listRuns, listWorkflows, loadScheduleState, newRunId, resolveKeepRuns, runWorkflow, saveScheduleState } from '../ci/index.js'

export interface WebUiConfig {
  /** Port to listen on. Defaults to 7777. */
  port?: number
  /** Interface to bind. Defaults to 127.0.0.1. Any other interface requires `token`. */
  host?: string
  /**
   * Access token. When set, every request needs it (cookie, or `Authorization: Bearer`);
   * the first visit goes through `/?token=<token>`, which sets an HttpOnly SameSite=Strict
   * cookie. Falls back to SWITCHBOARD_WEB_TOKEN. Required for a non-loopback `host`.
   */
  token?: string
  /** Directory holding the static console. Defaults to `<repo>/web`. */
  dir?: string
  /** Local workflow runner gate (copied from SwitchboardConfig.ci by the host). */
  ci?: { enabled?: boolean; keepRuns?: number }
  /** Whether the host loaded an `mcp` config block (copied by the host; state.mcp separates "unavailable" from "not configured"). */
  mcpConfigured?: boolean
  /**
   * Non-secret agent settings echoed by `GET /api/settings` (copied by the
   * host). Never carries the system prompt itself — only its source label.
   */
  agent?: {
    maxSteps?: number
    temperature?: number
    maxPromptTokens?: number
    keepRecent?: number
    systemSource?: 'default' | 'custom'
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Hostnames the settings fence accepts (DNS-rebinding defense, spec §6). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
/**
 * Store links are absent until each marketplace has approved an actual listing.
 * Never link to a guessed ID, redirecting URL, or an arbitrary operator domain.
 */
function verifiedBrowserStoreUrl(kind: 'chrome' | 'edge', input: string | undefined): string | null {
  if (!input || input.length > 2048) return null
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
    if (kind === 'chrome' && url.hostname === 'chromewebstore.google.com'
        && /^\/detail\/[a-z0-9-]+(?:\/[a-p]{32})?$/.test(url.pathname)) return url.href
    if (kind === 'edge' && url.hostname === 'microsoftedge.microsoft.com'
        && /^\/addons\/detail\/[a-z0-9-]+(?:\/[a-p]{32})?$/.test(url.pathname)) return url.href
  } catch { /* Listing not configured or malformed. */ }
  return null
}


/**
 * Guard for every `/api/settings/*` request (spec §6), in order:
 * loopback Host -> same-origin Origin -> JSON content-type on mutations.
 * Returns `{status, error, hint}` to deny, or null to proceed.
 */
function settingsGuard(
  req: http.IncomingMessage,
  opts: { enforceHost?: boolean } = {},
): { status: number; error: string; hint: string } | null {
  const hostHeader = String(req.headers.host ?? '')
  let hostname = ''
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase()
  } catch {
    hostname = ''
  }
  if (opts.enforceHost !== false && !LOOPBACK_HOSTS.has(hostname)) {
    return {
      status: 403,
      error: `Settings are only available through the local console (host "${hostHeader || 'unknown'}" refused).`,
      hint: 'Open Switchboard from http://127.0.0.1 or http://localhost instead of a public hostname.',
    }
  }
  const origin = req.headers.origin
  if (origin && origin !== `http://${hostHeader}`) {
    return {
      status: 403,
      error: 'Cross-origin settings requests are not allowed.',
      hint: `Open the console at http://${hostHeader} and try again.`,
    }
  }
  const method = (req.method ?? 'GET').toUpperCase()
  // Only methods that carry a body need the JSON content-type: a CORS-safelisted
  // text/plain POST would otherwise reach the handler with no preflight.
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const type = req.headers['content-type']
    if (typeof type !== 'string' || !type.startsWith('application/json')) {
      return {
        status: 415,
        error: 'content-type must be application/json',
        hint: 'Send the settings payload as a JSON body, then retry.',
      }
    }
  }
  return null
}

/** Derives the display name of a project: package.json name > folder name. */
async function projectName(root: string): Promise<string> {
  const manifest = path.join(root, 'package.json')
  const text = await readFile(manifest, 'utf8').catch(() => '')
  if (text) {
    try {
      const name = JSON.parse(text)?.name
      if (typeof name === 'string' && name.trim()) return name.trim()
    } catch {
      /* fall through to the folder name */
    }
  }
  return path.basename(root) || 'workspace'
}

/** url -> { modelId: contextWindow } cache; failures resolve to an empty map. */
let catalogPromise: Promise<Record<string, number>> | null = null
let catalogUrl = ''

function contextCatalog(url?: string): Promise<Record<string, number>> {
  if (!url) return Promise.resolve({})
  if (catalogPromise && catalogUrl === url) return catalogPromise
  catalogUrl = url
  catalogPromise = (async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      if (!res.ok) return {}
      const body = (await res.json()) as { models?: Array<{ id?: string; context?: number }> }
      const map: Record<string, number> = {}
      for (const model of body.models ?? []) {
        const context = Number(model.context)
        if (model.id && context > 0) map[model.id] = context
      }
      return map
    } catch {
      return {}
    }
  })()
  return catalogPromise
}

/**
 * `web-ui` — the local operator console.
 *
 * Serves a small static console plus a JSON/SSE API on top of the same
 * services the CLI uses. Binds to loopback by default: it exposes an
 * unauthenticated agent with filesystem and shell tools.
 */
export const webUi = {
  name: 'web-ui',
  inject: ['agent', 'sessions', 'presets', 'compaction', 'automations', 'tools', 'llm', 'metrics', 'workspace', 'undo', 'approvals', 'trace', 'providers', 'credentials'],

  apply(ctx: Context, config: WebUiConfig = {}) {
    const host = config.host ?? '127.0.0.1'
    const token = (config.token ?? process.env.SWITCHBOARD_WEB_TOKEN ?? '').trim()
    if (!token && !LOOPBACK_HOSTS.has(host.toLowerCase())) {
      throw new Error(`web.host "${host}" is not loopback: the console runs tools on this machine, so set web.token (or SWITCHBOARD_WEB_TOKEN) first`)
    }
    const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
    const tokenDigest = token ? digest(token) : null
    const tokenMatches = (candidate: string | null | undefined): boolean =>
      tokenDigest !== null && typeof candidate === 'string' && candidate.length > 0 && timingSafeEqual(digest(candidate), tokenDigest)
    const authorized = (req: http.IncomingMessage): boolean => {
      const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))
      if (bearer && tokenMatches(bearer[1])) return true
      for (const part of String(req.headers.cookie ?? '').split(';')) {
        const [name, ...rest] = part.trim().split('=')
        if (name === 'sbx_token' && tokenMatches(decodeURIComponent(rest.join('='))) ) return true
      }
      return false
    }
    const browserService = ctx.get('browserCompanion', false) as BrowserCompanionService | null | undefined
    const browserStoreUrls = {
      chrome: verifiedBrowserStoreUrl('chrome', process.env.SWITCHBOARD_CHROME_WEB_STORE_URL),
      edge: verifiedBrowserStoreUrl('edge', process.env.SWITCHBOARD_EDGE_ADDONS_URL),
    }
    const port = config.port ?? 7777
    const root = config.dir ?? fileURLToPath(new URL('../../web/', import.meta.url))
    const ciEnabled = config.ci?.enabled === true
    ctx.automations.start() // a running console keeps the schedule
    const keepRuns = resolveKeepRuns(config.ci?.keepRuns)
    const mcpConfigured = config.mcpConfigured === true

    /**
     * `state.mcp` contract: `{ configured: false }` (host has no mcp block),
     * `{ configured: true, servers: null }` (block present but the MCP service
     * is unavailable), or `{ configured: true, servers: [...] }` with the live
     * per-server status. Server fields are coerced to scalars before leaving
     * the API so the console can render them as plain text.
     */
    const mcpState = (): { configured: boolean; servers?: { name: string; state: string; attempts: number; lastError?: string }[] | null } => {
      if (!mcpConfigured) return { configured: false }
      const svc = ctx.get('mcp', false) as McpServiceApi | null | undefined
      if (!svc || typeof svc.status !== 'function') return { configured: true, servers: null }
      try {
        const list = svc.status() ?? []
        return {
          configured: true,
          servers: list.map((s) => ({
            name: String(s?.name ?? '?'),
            state: String(s?.state ?? '?'),
            attempts: Number(s?.attempts ?? 0),
            ...(s?.lastError ? { lastError: String(s.lastError).slice(0, 300) } : {}),
          })),
        }
      } catch {
        return { configured: true, servers: null }
      }
    }

    /** Live runs: sessionId -> AbortController, so Stop cancels the right run. */
    const runs = new Map<string, AbortController>()

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const route = url.pathname

      try {
        if (route.startsWith('/api/browser-companion/') && browserService) {
          return await browserService.handleHttpRequest(req, res, route)
        }
        const extensionOrigin = String(req.headers.origin ?? '');
        const isCompanionChat = (route === '/api/chat' || route === '/api/state' || /^\/api\/runs\/[^/]+\/cancel$/.test(route))
          && /^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin)
          && String(req.headers.authorization ?? '') === 'Bearer ' + (browserService?.currentToken ?? '');
        if (isCompanionChat) {
          res.setHeader('Access-Control-Allow-Origin', extensionOrigin)
          res.setHeader('Vary', 'Origin')
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
          if (req.method === 'OPTIONS') { res.writeHead(204); return void res.end() }
        }
        if (tokenDigest && !authorized(req) && !isCompanionChat) {
          // First visit: `/?token=...` trades the token for an HttpOnly cookie, then drops it from the URL.
          if (req.method === 'GET' && tokenMatches(url.searchParams.get('token'))) {
            url.searchParams.delete('token')
            res.writeHead(302, {
              location: `${url.pathname}${url.search}`,
              'set-cookie': `sbx_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
              'cache-control': 'no-store',
            })
            return void res.end()
          }
          if (route.startsWith('/api/')) {
            return json(res, 401, { error: 'unauthorized', hint: 'Open the URL printed by `sbx web` (it carries the access token).' })
          }
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          return void res.end('Switchboard console: open the URL printed by `sbx web` (it carries the access token).')
        }
        if (route.startsWith('/api/')) return await api(req, res, route)
        return await staticFile(res, route)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger('web-ui').warn('%c %s -> %s', req.method, route, message)
        if (!res.headersSent) {
          // Settings failures carry an HTTP status + recovery hint (spec §6).
          if (error instanceof SettingsError) json(res, error.status, { error: message, hint: error.hint })
          else json(res, 500, { error: message })
        } else res.end()
      }
    })

    // Display-only hint: strip credentials, query and hash; a reported tab
    // is not a guarantee that the browser's active tab will stay unchanged.
    const browserApprovalContext = () => {
      const service = browserService
      if (!service) return null
      const tab = service.getActiveTab()
      let origin: string | null = null
      try {
        const parsed = new URL(tab?.url ?? '')
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin
      } catch { /* The extension may not have reported a tab yet. */ }
      return {
        connected: service.isClientConnected(),
        activeTab: tab ? { id: tab.id, origin } : null,
      }
    }

    // ------------------------------------------------------------------ api

    async function api(req: http.IncomingMessage, res: http.ServerResponse, route: string): Promise<void> {
      // Same fence as /api/settings/* on EVERY api route (CSRF + DNS-rebinding
      // defense). The Host check only applies when the console is bound to
      // loopback; an operator who binds elsewhere on purpose keeps the Origin
      // and JSON content-type checks.
      const origin = String(req.headers.origin ?? '')
      const isCompanionChat = (route === '/api/chat' || route === '/api/state' || /^\/api\/runs\/[^/]+\/cancel$/.test(route))
        && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
        && String(req.headers.authorization ?? '') === 'Bearer ' + (browserService?.currentToken ?? '')
      const fenced = settingsGuard(req, { enforceHost: LOOPBACK_HOSTS.has(host.toLowerCase()) })
      if (isCompanionChat && fenced?.status === 403 && fenced.error === 'Cross-origin settings requests are not allowed.') {
        // A paired browser extension may access only these three endpoints.
      } else if (fenced) return json(res, fenced.status, { error: fenced.error, hint: fenced.hint })
      if (route === '/api/browser-companion-setup/status' && req.method === 'GET') {
        res.setHeader('Cache-Control', 'no-store')
        return json(res, 200, {
          bridgeReady: Boolean(browserService),
          connected: Boolean(browserService?.isClientConnected()),
          storeUrls: browserStoreUrls,
        })
      }

      // One-use onboarding code is shown only after an explicit click in the
      // authenticated local console, never in the state polling response.
      if (route === '/api/browser-companion-setup/code' && req.method === 'GET') {
        res.setHeader('Cache-Control', 'no-store')
        return browserService
          ? json(res, 200, { code: browserService.pairingCode ?? null, validForUpToSeconds: browserService.pairingCode ? 900 : 0 })
          : json(res, 503, { error: 'Local browser bridge is not running' })
      }

      // ------------------------------------------------------------ workspace
      if (route === '/api/workspace' && req.method === 'GET') {
        return json(res, 200, {
          root: ctx.workspace.root,
          name: await projectName(ctx.workspace.root),
          recents: ctx.workspace.recents,
        })
      }
      if (route === '/api/workspace' && req.method === 'POST') {
        const body = await readBody(req)
        const rootPath = String(body.root ?? '').trim()
        if (!rootPath) return json(res, 400, { error: 'root is required' })
        const resolved = await ctx.workspace.use(rootPath)
        return json(res, 200, {
          root: resolved,
          name: await projectName(resolved),
          recents: ctx.workspace.recents,
        })
      }

      // Folder picker for "Switch root": subfolders of any directory (a browser cannot hand a
      // page a real path). Same trust as POST /api/workspace above: fenced, loopback-only by default.
      if (route === '/api/dirs' && req.method === 'GET') {
        const q = new URL(req.url ?? '/', 'http://x').searchParams.get('path')?.trim()
        const dir = path.resolve(expandHome(q || ctx.workspace.root))
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch (error) {
          return json(res, 400, { error: `cannot open ${dir}: ${(error as NodeJS.ErrnoException).code ?? 'error'}` })
        }
        const dirs: string[] = []
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name === 'node_modules') continue
          if (e.isDirectory() || (e.isSymbolicLink() && (await stat(path.join(dir, e.name)).catch(() => null))?.isDirectory())) dirs.push(e.name)
        }
        dirs.sort((a, b) => a.localeCompare(b))
        const parent = path.dirname(dir)
        const drives: string[] = []
        if (process.platform === 'win32') {
          for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (await stat(`${l}:\\`).then(() => true, () => false)) drives.push(`${l}:\\`)
        }
        return json(res, 200, { path: dir, parent: parent === dir ? null : parent, home: os.homedir(), drives, dirs: dirs.slice(0, 500), truncated: dirs.length > 500 })
      }

      // File changes made by the agent in one session, and undo.
      const changesMatch = route.match(/^\/api\/sessions\/([^/]+)\/(changes|undo)$/)
      if (changesMatch) {
        const sid = decodeURIComponent(changesMatch[1])
        if (changesMatch[2] === 'changes' && req.method === 'GET') return json(res, 200, { changes: await ctx.undo.list(sid) })
        if (changesMatch[2] === 'undo' && req.method === 'POST') {
          const body = await readBody(req)
          const count = Math.min(50, Math.max(1, Number(body.count) || 1))
          return json(res, 200, await ctx.undo.undo(sid, count, body.force === true))
        }
      }

      // ---------------------------------------------------------------- files
      // A shallow listing for the workbench file browser.
      const filesMatch = route.match(/^\/api\/files\/?(.*)$/)
      if (filesMatch && req.method === 'GET') {
        const rel = decodeURIComponent(filesMatch[1] ?? '')
        const dir = await ctx.workspace.resolveReal(rel || '.')
        const entries = await readdir(dir, { withFileTypes: true })
        const files = await Promise.all(
          entries
            .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
            .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
            .slice(0, 500)
            .map(async (e) => {
              const full = path.join(dir, e.name)
              const st = await stat(full).catch(() => null)
              return {
                name: e.name,
                type: e.isDirectory() ? 'dir' : 'file',
                size: st?.size ?? 0,
                modifiedAt: st?.mtimeMs ?? 0,
              }
            }),
        )
        return json(res, 200, { dir: rel || '.', files })
      }

      // Content search across the workspace (regex file scan, browser-side cache).
      if (route === '/api/tools/search' && req.method === 'POST') {
        const body = await readBody(req)
        const result = await ctx.tools.call('search_files', { pattern: body.pattern, path: body.path, maxResults: body.maxResults })
        return json(res, 200, { result })
      }

      // -------------------------------------------------------------- plugins
      // User-facing capability view: the tool registry, grouped by plugin.
      // Raw DI internals (services) live under `runtime` for the dev pane.
      if (route === '/api/plugins' && req.method === 'GET') {
        const plugins = [...new Set([
          ...[...ctx.registry.values()].map((runtime) => runtime.name).filter(Boolean),
          ...ctx.tools.list().map((tool) => tool.plugin),
        ])]
        return json(res, 200, {
          plugins,
          capabilities: plugins.map((p) => ({
            name: p,
            tools: ctx.tools.list().filter((t) => t.plugin === p).map((t) => ({ name: t.name, description: t.description })),
          })),
          tools: ctx.tools.list().map((t) => ({ name: t.name, description: t.description, plugin: t.plugin })),
        })
      }
      if (route === '/api/plugins' && req.method === 'POST') {
        const body = await readBody(req)
        const src = String(body.src ?? '').trim()
        if (!src) return json(res, 400, { error: 'src is required' })
        try {
          await ctx.tools.loadPlugins([src], { [src]: body.config })
          return json(res, 200, {
            ok: true,
            plugins: [...new Set(ctx.tools.list().map((t) => t.plugin))],
            tools: ctx.tools.list().map((t) => ({ name: t.name, description: t.description, plugin: t.plugin })),
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return json(res, 400, { error: message })
        }
      }

      // ------------------------------------------------------------ approvals
      if (route === '/api/approvals' && req.method === 'GET') {
        return json(res, 200, {
          mode: ctx.approvals.mode,
          pending: ctx.approvals.pending(),
          recent: ctx.approvals.recent,
          browser: browserApprovalContext(),
        })
      }
      const approvalsDecide = route.match(/^\/api\/approvals\/([^/]+)$/)
      if (approvalsDecide && req.method === 'POST') {
        const body = await readBody(req)
        const decision = body.decision
        if (!['approved', 'approved_session', 'rejected'].includes(decision)) {
          return json(res, 400, { error: 'decision must be "approved", "approved_session" or "rejected"' })
        }
        const id = decodeURIComponent(approvalsDecide[1])
        const ok = ctx.approvals.decide(id, decision)
        return ok ? json(res, 200, { id, decision }) : json(res, 404, { error: 'no such pending approval' })
      }

      // ------------------------------------------------------------ settings
      // Spec §6: guarded settings surface — fence first, then dispatch.
      if (route.startsWith('/api/settings')) {
        const denied = settingsGuard(req)
        if (denied) return json(res, denied.status, { error: denied.error, hint: denied.hint })
        return await settings(req, res, route)
      }

      // ------------------------------------------------------------------ ci
      if (route.startsWith('/api/ci')) {
        if (!ciEnabled) {
          return json(res, 404, { error: 'ci is disabled — set "ci": { "enabled": true } in switchboard.config.jsonc' })
        }
        const wfRoot = ctx.workspace.root
        if (route === '/api/ci/workflows' && req.method === 'GET') {
          const workflows = await listWorkflows(wfRoot)
          const { runs } = await listRuns(wfRoot, { limit: Number.MAX_SAFE_INTEGER })
          return json(
            res,
            200,
            workflows.map((wf) => ({ ...wf, lastRun: runs.find((r) => r.workflow === wf.id) ?? null })),
          )
        }
        if (route === '/api/ci/runs' && req.method === 'GET') {
          const params = new URL(`http://x${req.url}`).searchParams
          const rawLimit = params.get('limit')
          const limit = rawLimit != null && Number.isFinite(Number(rawLimit)) ? Math.min(Math.max(Math.floor(Number(rawLimit)), 1), 100) : 20
          const rawOffset = params.get('offset')
          const offset = rawOffset != null && Number.isFinite(Number(rawOffset)) ? Math.max(Math.floor(Number(rawOffset)), 0) : 0
          const workflow = params.get('workflow') || undefined
          const status = params.get('status') || undefined
          return json(res, 200, await listRuns(wfRoot, { limit, offset, workflow, status }))
        }
        if (route === '/api/ci/runs' && req.method === 'POST') {
          // Only application/json may trigger a run: a CORS-safelisted
          // text/plain POST would otherwise execute local steps with no preflight.
          const type = req.headers['content-type']
          if (typeof type !== 'string' || !type.startsWith('application/json')) {
            return json(res, 415, { error: 'content-type must be application/json' })
          }
          const body = await readBody(req)
          const wanted = String(body.workflow ?? '')
          const list = await listWorkflows(wfRoot)
          const found = list.find((w) => w.id === wanted || w.name === wanted)
          if (!found) {
            return json(res, 400, { error: `unknown workflow "${wanted}" (available: ${list.map((w) => w.id).join(', ') || 'none'})` })
          }
          const runId = newRunId()
          void runWorkflow(wfRoot, found.id, { trigger: 'web', runId, keepRuns }).catch((error) =>
            ctx.logger('web-ui').warn('ci run %s died: %s', runId, String(error)),
          )
          return json(res, 202, { id: runId, workflow: found.id })
        }
        const runMatch = route.match(/^\/api\/ci\/runs\/([^/]+)$/)
        if (runMatch && req.method === 'GET') {
          const record = await getRun(wfRoot, runMatch[1])
          return record ? json(res, 200, record) : json(res, 404, { error: 'no such run' })
        }
        return json(res, 404, { error: 'unknown ci route' })
      }

      if (route === '/api/state' && req.method === 'GET') {
        const models = await ctx.llm.listModels().catch(() => [])
        const catalog = await contextCatalog(ctx.llm.settings.contextCatalogUrl)
        // Spec §8: with a registry the model list unions persisted catalogs
        // with the default provider's live endpoint; without one the live
        // rows still carry provider `default` because the console picker
        // treats `provider` as routing identity, not a vendor label.
        const providerEntries = ctx.providers.list()
        const persistedEntries = providerEntries.filter((entry) => entry.source !== 'config')
        const liveModel = (m: any) => ({
          id: m.id,
          provider: m.owned_by ?? m.provider ?? null,
          route: m.route ?? m.botconnector_route ?? null,
          access: m.botconnector_access,
          tools: m.botconnector_capabilities?.tools ?? null,
          vision: m.botconnector_capabilities?.vision ?? m.vision ?? null,
          reasoning: m.botconnector_capabilities?.reasoning ?? null,
          context: m.context_length ?? m.context_window ?? m.botconnector_capabilities?.context ?? catalog[m.id] ?? null,
        })
        const stateModels = persistedEntries.length
          ? [
              ...persistedEntries.flatMap((entry) =>
                entry.models.map((model) => ({
                  id: model.id,
                  provider: entry.id,
                  providerName: entry.displayName,
                  displayName: model.displayName ?? null,
                  context: model.context ?? null,
                  maxOutput: model.maxOutput ?? null,
                  inputs: model.inputs ?? null,
                  // legacy capability fields so existing checks keep working
                  tools: model.inputs?.tools ?? null,
                  vision: model.inputs?.vision ?? null,
                  reasoning: model.inputs?.reasoning ?? null,
                  route: null,
                  access: null,
                })),
              ),
              ...models.map((m) => ({ ...liveModel(m), provider: 'default', providerName: 'Default (config)' })),
            ]
          : // No registry yet: still label the config-derived rows `default`
            // (spec §8) — `owned_by` is a vendor label, not a provider id, and
            // the picker encodes provider identity into every option value.
            models.map((m) => ({ ...liveModel(m), provider: 'default', providerName: 'Default (config)' }))
        return json(res, 200, {
          endpoint: ctx.llm.settings.baseURL,
          model: ctx.llm.settings.defaultModel,
          default: ctx.providers.default(),
          providers: providerEntries.map((entry) => ({
            id: entry.id,
            displayName: entry.displayName,
            protocol: entry.protocol,
            credential: ctx.credentials.describe(entry),
          })),
          sessionDir: ctx.sessions.dir ?? null,
          workspace: {
            root: ctx.workspace.root,
            name: await projectName(ctx.workspace.root),
            recents: ctx.workspace.recents,
          },
          browserCompanion: {
            bridgeReady: Boolean(browserService),
            connected: Boolean(browserService?.isClientConnected()),
            storeUrls: browserStoreUrls,
          },
          approval: {
            mode: ctx.approvals.mode,
            pending: ctx.approvals.pending(),
            recent: ctx.approvals.recent,
            browser: browserApprovalContext(),
          },
          ci: { enabled: ciEnabled },
          mcp: mcpState(),
          models: stateModels,
          capabilities: [...new Set(ctx.tools.list().map((t) => t.plugin))].map((name) => ({
            name,
            enabled: true,
            health: 'ready',
            tools: ctx.tools.list().filter((t) => t.plugin === name).map((t) => ({ name: t.name, description: t.description })),
          })),
          runtimeServices: [...ctx.registry.values()].map((fiber) => fiber.name).filter(Boolean),
          tools: ctx.tools.list().map((t) => ({ name: t.name, description: t.description, plugin: t.plugin })),
          plugins: [...ctx.registry.values()].map((f) => f.name).filter(Boolean),
          sessions: ctx.sessions.list().map((s) => ({
            id: s.id,
            title: s.title,
            model: s.model,
            // Spec §7: the delete-in-use recovery copy counts sessions per
            // provider client-side, so the identity must travel with state.
            provider: s.provider ?? null,
            projectRoot: s.projectRoot,
            status: s.status ?? 'idle',
            messages: s.messages.length,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
          })),
          metrics: ctx.metrics.summary(),
        })
      }

      // --------------------------------------------------------- automations
      if (route === '/api/automations' && req.method === 'GET') {
        return json(res, 200, { automations: ctx.automations.list().map(({ runs, ...rest }) => ({ ...rest, lastRun: runs[0] ?? null })) })
      }
      if (route === '/api/automations' && req.method === 'POST') {
        return json(res, 201, await ctx.automations.create(await readBody(req)))
      }
      const automationMatch = route.match(/^\/api\/automations\/([^/]+)(?:\/(run|runs))?$/)
      if (automationMatch) {
        const id = decodeURIComponent(automationMatch[1])
        const sub = automationMatch[2]
        if (!sub && req.method === 'PUT') return json(res, 200, await ctx.automations.update(id, await readBody(req)))
        if (!sub && req.method === 'DELETE') {
          await ctx.automations.remove(id)
          return json(res, 200, { ok: true })
        }
        if (sub === 'run' && req.method === 'POST') return json(res, 200, await ctx.automations.runNow(id))
        if (sub === 'runs' && req.method === 'GET') {
          const found = ctx.automations.get(id)
          return found ? json(res, 200, { runs: found.runs }) : json(res, 404, { error: `no automation "${id}"` })
        }
      }
      // --------------------------------------------------------------- skills
      if (route === '/api/skills' && req.method === 'GET') {
        const skills = (await ctx.get('skills', false)?.list()) ?? []
        return json(res, 200, { skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source, files: s.files.length })) })
      }
      // ------------------------------------------------------------- presets
      if (route === '/api/presets' && req.method === 'GET') {
        const known = new Set(ctx.tools.list().map((t) => t.name))
        return json(res, 200, {
          presets: ctx.presets.list().map((p) => ({
            ...p,
            // allow/deny entries that match no registered tool (typo, or a plugin not loaded)
            unknownTools: [...(p.tools?.allow ?? []), ...(p.tools?.deny ?? [])].filter((n) => (n.endsWith('*') ? ![...known].some((k) => k.startsWith(n.slice(0, -1))) : !known.has(n))),
          })),
          dir: ctx.presets.dir,
        })
      }
      if (route === '/api/presets' && req.method === 'POST') {
        const created = await ctx.presets.create(await readBody(req))
        return json(res, 201, created)
      }
      const presetMatch = route.match(/^\/api\/presets\/([^/]+)$/)
      if (presetMatch && req.method === 'PUT') {
        return json(res, 200, await ctx.presets.update(decodeURIComponent(presetMatch[1]), await readBody(req)))
      }
      if (presetMatch && req.method === 'DELETE') {
        await ctx.presets.remove(decodeURIComponent(presetMatch[1]))
        return json(res, 200, { ok: true })
      }
      const compactMatch = route.match(/^\/api\/sessions\/([^/]+)\/compact$/)
      if (compactMatch && req.method === 'POST') {
        const found = ctx.sessions.find(decodeURIComponent(compactMatch[1]))
        if (!found) return json(res, 404, { error: 'no such session' })
        if (runs.has(found.id)) return json(res, 409, { error: 'this session is running; compact it when the run ends' })
        const body = await readBody(req)
        const outcome = await ctx.compaction.compact(found.id, { focus: typeof body.focus === 'string' ? body.focus : undefined })
        return outcome.ok ? json(res, 200, outcome) : json(res, 422, { error: outcome.reason })
      }
      const sessionPresetMatch = route.match(/^\/api\/sessions\/([^/]+)\/preset$/)
      if (sessionPresetMatch && req.method === 'POST') {
        const found = ctx.sessions.find(decodeURIComponent(sessionPresetMatch[1]))
        if (!found) return json(res, 404, { error: 'no such session' })
        const body = await readBody(req)
        const wanted = typeof body.preset === 'string' && body.preset ? body.preset : undefined
        if (wanted && !ctx.presets.get(wanted)) return json(res, 404, { error: `no preset "${wanted}"` })
        return json(res, 200, { id: found.id, preset: ctx.sessions.setPreset(found.id, wanted).preset ?? null })
      }

      const sessionMatch = route.match(/^\/api\/sessions\/([^/]+)$/)
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1])
        const session = ctx.sessions.find(id)
        if (!session) return json(res, 404, { error: `no session "${id}"` })
        if (req.method === 'GET') return json(res, 200, ctx.get('usage', false) ? { ...session, usageSummary: ctx.get('usage', false)!.summary(session.id) } : session)
        if (req.method === 'DELETE') {
          const ac = runs.get(session.id)
          ac?.abort()
          runs.delete(session.id)
          ctx.approvals.clearSessionGrants(session.id)
          ctx.sessions.delete(session.id)
          await ctx.sessions.flush()
          return json(res, 200, { deleted: session.id })
        }
        return json(res, 405, { error: 'method not allowed' })
      }

      if (route === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req)
        const session = ctx.sessions.create({
          title: body.title ?? 'New task',
          model: body.model,
          ...(typeof body.provider === 'string' && body.provider ? { provider: body.provider } : {}),
          ...(typeof body.preset === 'string' && body.preset && ctx.presets.get(body.preset) ? { preset: body.preset } : {}),
          projectRoot: ctx.workspace.root,
        })
        return json(res, 201, session)
      }

      // ------------------------------------------------------- run cancellation
      const cancelMatch = route.match(/^\/api\/runs\/([^/]+)\/cancel$/)
      if (cancelMatch && req.method === 'POST') {
        const id = decodeURIComponent(cancelMatch[1])
        const ac = runs.get(id)
        if (!ac) return json(res, 404, { error: `no running session "${id}"` })
        ac.abort()
        return json(res, 200, { cancelled: id })
      }

      // ----------------------------------------------------------------- trace
      if (route === '/api/trace' && req.method === 'GET') {
        const sessionId = new URL(`http://x${req.url}`).searchParams.get('session') ?? undefined
        const limit = Number(new URL(`http://x${req.url}`).searchParams.get('limit') ?? 200)
        return json(res, 200, { entries: await ctx.trace.list(sessionId || undefined, limit) })
      }

      if (route === '/api/chat' && req.method === 'POST') {
        const body = await readBody(req, 12_000_000)
        const prompt = String(body.prompt ?? '').trim()
        if (!prompt) return json(res, 400, { error: 'prompt is required' })
        const session = body.sessionId ? ctx.sessions.find(String(body.sessionId)) : undefined
        if (body.sessionId && !session) return json(res, 404, { error: `no session "${body.sessionId}"` })
        // Picker values may arrive as `providerId::modelId` (spec §8); an
        // explicit `provider` field wins over the embedded prefix.
        let provider = typeof body.provider === 'string' && body.provider ? body.provider : undefined
        let model = body.model ? String(body.model) : undefined
        if (model?.includes('::')) {
          const [splitProvider, splitModel] = model.split('::')
          if (!provider && splitProvider) provider = splitProvider
          model = splitModel || model
        }
        const wantedModel = model || session?.model || ctx.llm.settings.defaultModel
        const wantedProvider = provider || session?.provider
        // Capability lookup: persisted catalog first, live endpoint as the
        // fallback (spec §8 — works for registry and legacy setups alike).
        const catalogEntry = wantedProvider
          ? ctx.providers.get(wantedProvider)?.models.find((item) => item.id === wantedModel)
          : undefined
        const availableModels = await ctx.llm.listModels().catch(() => [])
        const selected = catalogEntry ? undefined : availableModels.find((item) => item.id === wantedModel)
        const visionOk = catalogEntry
          ? catalogEntry.inputs?.vision === true
          : selected
            ? selected.botconnector_capabilities?.vision === true || selected.vision === true
            : undefined
        const toolsBlocked = catalogEntry
          ? catalogEntry.inputs?.tools === false
          : selected?.botconnector_capabilities?.tools === false
        const attachments = Array.isArray(body.attachments) ? body.attachments : []
        if (attachments.length > 4 || attachments.some((item: any) => !item || typeof item.dataUrl !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(item.dataUrl) || item.dataUrl.length > 7_000_000)) {
          return json(res, 400, { error: 'Attach up to four PNG, JPEG, GIF, or WebP images (under 5 MB each).' })
        }
        if (attachments.length && visionOk !== true) {
          return json(res, 422, { error: 'The selected model does not advertise vision support. Choose a vision-capable model or remove the image.' })
        }
        const needsTools = /\b(read|open|inspect|look at|list|search|find|edit|write|create|make|change|fix|refactor|test|run|execute|git|project|repository|repo|file|folder|directory|command|structure)\b/i.test(prompt)
        if (needsTools && toolsBlocked) {
          return json(res, 422, { error: 'This model does not advertise tool support, so it cannot safely perform project or command tasks. Select a model with tools enabled.' })
        }
        const presetId = typeof body.preset === 'string' && body.preset ? body.preset : undefined
        if (presetId && !ctx.presets.get(presetId)) return json(res, 404, { error: `no preset "${presetId}"` })
        const id = session?.id ?? ctx.sessions.create({ title: prompt.slice(0, 72), model, provider, ...(presetId ? { preset: presetId } : {}), projectRoot: ctx.workspace.root }).id
        if (runs.has(id)) return json(res, 409, { error: 'this session already has an active run' })
        // Model/provider choices are saved for future turns; past transcript entries remain untouched.
        if (session && model) session.model = model
        if (session && provider) session.provider = provider

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        const send = (event: { type: string } & Record<string, unknown>) => {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        }
        send({ type: 'session', sessionId: id })

        const ac = new AbortController()
        runs.set(id, ac)
        let settled = false
        const cleanup = () => {
          if (settled) return
          settled = true
          runs.delete(id)
          void ctx.sessions.flush()
        }
        res.on('close', () => {
          // Only an abandoned response cancels execution. A completed request-body
          // event is not a disconnect, and in-app tab changes do not close this stream.
          if (!settled && !res.writableEnded) ac.abort()
        })

        try {
          for await (const event of ctx.agent.stream(prompt, id, { signal: ac.signal, attachments, provider, ...(presetId ? { preset: presetId } : {}) })) {
            send(event as AgentEvent & { type: string })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!ac.signal.aborted) send({ type: 'error', error: message })
        }
        if (!ac.signal.aborted) res.write('event: end\ndata: {}\n\n')
        res.end()
        cleanup()
        return
      }

      // ------------------------------------------------------ tools (by hand)
      // The same registry the agent loop uses — including the approval gate —
      // so the workbench can run `read_file` for previews or trigger a manual
      // gated call for other tools.
      const toolMatch = route.match(/^\/api\/tools\/([^/]+)$/)
      if (toolMatch && req.method === 'POST') {
        const body = await readBody(req)
        const result = await ctx.tools.call(decodeURIComponent(toolMatch[1]), body.args ?? body ?? {}, { sessionId: body.sessionId })
        return json(res, 200, { result })
      }

      return json(res, 404, { error: 'unknown endpoint' })
    }

    // -------------------------------------------------------------- settings
    /**
     * `/api/settings/*` dispatch (spec §6). The guard already ran; every
     * failure below is a `SettingsError` and the central catch answers
     * `{error, hint}` with its status. Credential values are accepted on
     * write only — every read path returns `credentials.describe(...)`.
     */
    async function settings(req: http.IncomingMessage, res: http.ServerResponse, route: string): Promise<void> {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const describeProviders = () =>
        ctx.providers.list().map((entry) => ({
          id: entry.id,
          displayName: entry.displayName,
          baseURL: entry.baseURL,
          protocol: entry.protocol,
          ...(entry.apiKeyEnv ? { apiKeyEnv: entry.apiKeyEnv } : {}),
          ...(entry.source ? { source: entry.source } : {}),
          modelCount: entry.models.length,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          credential: ctx.credentials.describe(entry),
        }))

      const storage = () => ({
        settingsDir: ctx.providers.dir,
        providersFile: path.join(ctx.providers.dir, 'providers.json'),
        credentialsFile: path.join(ctx.credentials.dir, 'credentials.json'),
        sessionDir: ctx.sessions.dir ?? null,
      })
      const keyPrecedence = [
        'Environment variable named by the provider (env)',
        'Credential stored by Switchboard (local, write-only)',
        'switchboard.config.jsonc llm.apiKey (default provider only)',
        'BOTCONNECTOR_API_KEY / OPENAI_API_KEY (default provider only)',
      ]

      if (route === '/api/settings' && req.method === 'GET') {
        return json(res, 200, {
          general: {
            approvalMode: ctx.approvals.mode,
            storage: storage(),
            keyPrecedence,
            endpoint: ctx.llm.settings.baseURL,
          },
          providers: describeProviders(),
          default: ctx.providers.default(),
          agent: {
            maxSteps: config.agent?.maxSteps ?? 8,
            ...(config.agent?.temperature !== undefined ? { temperature: config.agent.temperature } : {}),
            maxPromptTokens: config.agent?.maxPromptTokens ?? 96_000,
            keepRecent: config.agent?.keepRecent ?? 4,
            systemSource: config.agent?.systemSource ?? 'default',
          },
          mcp: mcpState(),
          supported: {
            protocols: [...PROTOCOLS],
            approvalModes: ['off', 'risky', 'all'],
            discovery: true,
            plugins: true,
            language: ['en'],
            account: false,
          },
        })
      }

      // ---------------------------------------------------------- providers
      if (route === '/api/settings/providers' && req.method === 'GET') {
        return json(res, 200, { providers: describeProviders() })
      }
      if (route === '/api/settings/providers' && req.method === 'POST') {
        const body = await readBody(req)
        const entry = await ctx.providers.create(body)
        return json(res, 201, { ...entry, credential: ctx.credentials.describe(entry) })
      }

      const providerMatch = route.match(/^\/api\/settings\/providers\/([^/]+)$/)
      if (providerMatch && req.method === 'PUT') {
        const id = decodeURIComponent(providerMatch[1])
        const body = await readBody(req)
        const entry = await ctx.providers.update(id, body)
        return json(res, 200, { ...entry, credential: ctx.credentials.describe(entry) })
      }
      if (providerMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(providerMatch[1])
        ctx.providers.require(id)
        const affected = ctx.sessions
          .list()
          .filter((session) => session.provider === id)
          .map((session) => ({ id: session.id, title: session.title }))
        const force = url.searchParams.get('force') === '1'
        if (affected.length && !force) {
          return json(res, 409, {
            error: `Provider "${id}" is still used by ${affected.length} session${affected.length === 1 ? '' : 's'}.`,
            inUse: { sessions: affected },
            hint: 'Delete anyway to detach those sessions (they fall back to the default provider), or point them at another provider first.',
          })
        }
        // `remove()` rejects the reserved default with its own 400 + config hint.
        const deleted = await ctx.providers.remove(id)
        if (affected.length) {
          for (const session of ctx.sessions.list()) {
            if (session.provider === id) session.provider = undefined
          }
          await ctx.sessions.flush()
        }
        return json(res, 200, { deleted, detachedSessions: affected.length, fallback: ctx.providers.default() })
      }

      const modelsMatch = route.match(/^\/api\/settings\/providers\/([^/]+)\/models$/)
      if (modelsMatch && req.method === 'GET') {
        const id = decodeURIComponent(modelsMatch[1])
        return json(res, 200, { models: ctx.providers.models(id) })
      }
      if (modelsMatch && req.method === 'PUT') {
        const id = decodeURIComponent(modelsMatch[1])
        const body = await readBody(req)
        const models = Array.isArray(body) ? body : Array.isArray(body?.models) ? body.models : null
        if (!models) {
          throw new SettingsError('Models payload must be an array.', {
            hint: 'Send { "models": [ { "id": "..." } ] } and try again.',
          })
        }
        return json(res, 200, { models: await ctx.providers.setModels(id, models) })
      }

      const credentialMatch = route.match(/^\/api\/settings\/providers\/([^/]+)\/credential$/)
      if (credentialMatch && req.method === 'GET') {
        const entry = ctx.providers.require(decodeURIComponent(credentialMatch[1]))
        return json(res, 200, ctx.credentials.describe(entry))
      }
      if (credentialMatch && req.method === 'PUT') {
        const id = decodeURIComponent(credentialMatch[1])
        ctx.providers.require(id)
        const body = await readBody(req)
        return json(res, 200, await ctx.credentials.set(id, body.apiKey))
      }
      if (credentialMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(credentialMatch[1])
        ctx.providers.require(id)
        await ctx.credentials.remove(id)
        return json(res, 200, { cleared: true })
      }

      // ------------------------------------------------------------ discover
      // One-shot draft probe: the key travels with this request only and is
      // never written to providers.json or credentials.json (spec §6).
      if (route === '/api/settings/discover' && req.method === 'POST') {
        const body = await readBody(req)
        const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim().replace(/\/+$/, '') : ''
        let validUrl = false
        try {
          const parsed = new URL(baseURL)
          validUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:'
        } catch {
          validUrl = false
        }
        if (!validUrl) {
          throw new SettingsError(`"${baseURL}" is not a valid Base URL.`, {
            hint: 'Use a full http(s) URL, e.g. https://api.example.com/v1.',
          })
        }
        if (typeof body.protocol !== 'string' || !PROTOCOLS.includes(body.protocol as ProviderProfile['protocol'])) {
          throw new SettingsError(`Unknown protocol "${String(body.protocol)}".`, {
            hint: `Choose one of: ${PROTOCOLS.join(', ')}.`,
          })
        }
        const profile: ProviderProfile = {
          id: 'draft',
          displayName: 'Draft',
          baseURL,
          protocol: body.protocol as ProviderProfile['protocol'],
          ...(typeof body.apiKey === 'string' && body.apiKey ? { apiKey: body.apiKey } : {}),
          ...(body.headers && typeof body.headers === 'object' ? { headers: body.headers } : {}),
        }
        try {
          const models = await discoverModels(profile)
          return json(res, 200, { models })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new SettingsError(message, {
            status: 502,
            hint: 'Check the Base URL, protocol and API key, then fetch again.',
          })
        }
      }

      // ------------------------------------------------------- default/general
      if (route === '/api/settings/default' && req.method === 'GET') {
        return json(res, 200, ctx.providers.default())
      }
      if (route === '/api/settings/default' && req.method === 'PUT') {
        const body = await readBody(req)
        return json(res, 200, await ctx.providers.setDefault({ provider: body.provider, model: body.model }))
      }
      if (route === '/api/settings/general' && req.method === 'GET') {
        return json(res, 200, { approvalMode: ctx.approvals.mode, endpoint: ctx.llm.settings.baseURL, storage: storage(), keyPrecedence })
      }
      if (route === '/api/settings/general' && req.method === 'PUT') {
        const body = await readBody(req)
        return json(res, 200, { approvalMode: ctx.approvals.setMode(body.approvalMode) })
      }

      return json(res, 404, { error: 'unknown settings route', hint: 'Reload the console to pick up the current Settings API.' })
    }

    // --------------------------------------------------------------- static

    async function staticFile(res: http.ServerResponse, route: string): Promise<void> {
      const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '')
      const target = path.resolve(root, rel)
      // Refuse anything that escapes the console directory.
      if (target !== path.resolve(root) && !target.startsWith(path.resolve(root) + path.sep)) {
        return json(res, 403, { error: 'forbidden' })
      }
      const data = await readFile(target).catch(() => null)
      if (!data) return json(res, 404, { error: 'not found' })
      const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(data)
    }

    // -------------------------------------------------------------- startup

    const started = new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') reject(new Error(`port ${port} on ${host} is already in use (another \`sbx web\` still running? stop it, or choose a port with --port <n>)`))
        else reject(error)
      })
      server.listen(port, host, () => resolve())
    })
    void started.catch(() => undefined) // reported by ready(); must not crash the process first

    ctx.effect(() => () => {
      for (const ac of runs.values()) ac.abort()
      server.close()
    })

    /** The port actually in use (`port: 0` asks the OS for a free one). */
    function bound(): { port: number; host: string } {
      const addr = server.address()
      if (addr && typeof addr === 'object') return { port: addr.port, host: addr.address }
      return { port, host }
    }

    // -------------------------------------------------------------- scheduler
    async function schedulerTick(now: Date = new Date()): Promise<{ fired: string[]; skipped: string[] }> {
      if (!ciEnabled) return { fired: [], skipped: [] }
      const root = ctx.workspace.root
      try {
        const listed = await listWorkflows(root)
        const candidates = listed.filter((wf) => wf.schedule.length > 0).map((wf) => ({ id: wf.id, schedule: wf.schedule }))
        if (!candidates.length) return { fired: [], skipped: [] }
        const state = await loadScheduleState(root)
        const { runs } = await listRuns(root, { limit: Number.MAX_SAFE_INTEGER })
        // spec §4: the overlap check uses each workflow's LAST run (list is newest-first → first occurrence wins)
        const lastRun = new Map<string, { status: string }>()
        for (const run of runs) if (!lastRun.has(run.workflow)) lastRun.set(run.workflow, run)
        const running = new Set([...lastRun].filter(([, r]) => r.status === 'running').map(([id]) => id))
        const decision = evaluateSchedules(candidates, state, now, running)
        if (decision.changed) await saveScheduleState(root, decision.state)
        for (const id of decision.skipped) ctx.logger('web-ui').info('ci schedule: %s still running, skipped', id)
        for (const id of decision.toFire) {
          const runId = newRunId()
          void runWorkflow(root, id, { trigger: 'schedule', runId, keepRuns }).catch((error) =>
            ctx.logger('web-ui').warn('ci scheduled run %s died: %s', runId, String(error)),
          )
        }
        return { fired: decision.toFire, skipped: decision.skipped }
      } catch (error) {
        ctx.logger('web-ui').warn('ci scheduler tick failed: %s', String(error))
        return { fired: [], skipped: [] }
      }
    }

    if (ciEnabled) {
      const timer = setInterval(() => void schedulerTick(), 30_000)
      ctx.effect(() => () => clearInterval(timer))
    }

    ctx.reflect.provide('web', {
      /** Resolves once the console is accepting connections. */
      async ready(): Promise<{ url: string; accessUrl: string; port: number; host: string }> {
        await started
        const live = bound()
        const url = `http://${host}:${live.port}/`
        return { url, accessUrl: token ? `${url}?token=${encodeURIComponent(token)}` : url, port: live.port, host }
      },
      address(): { port: number; host: string } {
        return bound()
      },
      schedulerTick,
    })
  },
}

declare module 'cordis' {
  interface Context {
    web: {
      ready(): Promise<{ url: string; accessUrl: string; port: number; host: string }>
      address(): { port: number; host: string }
      schedulerTick(now?: Date): Promise<{ fired: string[]; skipped: string[] }>
    }
  }
}

/** Re-export so tsc keeps the RunEvent import used for typing the SSE relay. */
export type { RunEvent }
