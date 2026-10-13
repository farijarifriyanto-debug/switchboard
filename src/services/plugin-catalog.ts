import { Service } from 'cordis'
import type { Context } from 'cordis'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { expandHome } from './session.js'
import type { McpServerConfig } from '../config.js'
import type { McpServiceApi } from '../plugins/mcp.js'
import { startLocalSandbox, stopLocalSandbox, type ManagedLocal } from './local-opensandbox.js'

export type CatalogId = 'semgrep' | 'opensandbox'
const CATALOG: Record<CatalogId, { title: string; description: string; version: string }> = {
  semgrep: { title: 'Semgrep', description: 'Scan Python, JavaScript and other source code through the official MCP server.', version: '1.180.0' },
  opensandbox: { title: 'OpenSandbox', description: 'Run commands inside a separate sandbox through the official MCP server.', version: '1.1.1' },
}
const IDS = ['semgrep', 'opensandbox'] as const
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/i
const TAILSCALE_HOST = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):([1-9][0-9]{0,4})$/
const SECRET_ID = 'plugin.opensandbox'
interface Installed { id: CatalogId; endpoint?: string; local?: ManagedLocal }
interface RegistryFile { version: 1; installed: Installed[] }
export interface CatalogItem {
  id: CatalogId
  name: string
  description: string
  version: string
  installed: boolean
  managed: boolean
  state: string
  toolCount: number
  needsEndpoint: boolean
  credentialConfigured: boolean
  mode?: 'local' | 'private' | 'not-installed'
}

export class PluginCatalogService extends Service {
  static inject: string[] = ['credentials']
  readonly dir: string
  private installed = new Map<CatalogId, Installed>()
  private mutation: Promise<void> = Promise.resolve()
  private mcp: McpServiceApi | undefined
  private manual = new Set<string>()

  constructor(ctx: Context, config: { dir?: string } = {}) {
    super(ctx, 'pluginCatalog')
    this.dir = path.resolve(expandHome(config.dir ?? '~/.switchboard'))
    try {
      const doc = JSON.parse(readFileSync(this.file, 'utf8')) as RegistryFile
      if (doc?.version !== 1 || !Array.isArray(doc.installed)) throw new Error('Invalid plugin registry')
      for (const entry of doc.installed) {
        if (!entry || !IDS.includes(entry.id) || this.installed.has(entry.id)) throw new Error('Invalid installed plugin')
        if (entry.id === 'opensandbox') {
          if (typeof entry.endpoint !== 'string') throw new Error('OpenSandbox endpoint is missing')
          this.validateEndpoint(entry.endpoint)
          if (entry.local) {
            const managed = entry.local as ManagedLocal
            if (!/^[0-9a-f-]{36}$/i.test(managed.installId)
                || !/^sbx-opensandbox-[0-9a-f]{12}$/.test(managed.containerName)
                || !Number.isInteger(managed.port) || managed.port < 1 || managed.port > 65535
                || entry.endpoint !== `127.0.0.1:${managed.port}`) throw new Error('Invalid managed OpenSandbox metadata')
          }
        }
        this.installed.set(entry.id, { id: entry.id, ...(entry.endpoint ? { endpoint: entry.endpoint } : {}), ...(entry.local ? { local: entry.local } : {}) })
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        // An invalid file must never result in silent overwrite or implicit installation.
        throw new Error('Plugin registry is invalid; preserve it and repair manually', { cause: error })
      }
    }
  }

  /** MCP supervisor starts after credentials; attach its API when booted. */
  attachMcp(mcp: McpServiceApi | undefined): void { this.mcp = mcp }
  setManualMcpNames(names: string[]): void { this.manual = new Set(names) }

  private get file(): string { return path.join(this.dir, 'installed-mcp.json') }
  private key(entry?: Installed): string | undefined {
    // Managed-local keys must never be superseded by an unrelated provider env key.
    return this.ctx.credentials.resolve({ id: SECRET_ID, ...(entry?.local ? {} : { apiKeyEnv: 'OPEN_SANDBOX_API_KEY' }) } as any)
  }
  private validateEndpoint(endpoint: string): string {
    if (typeof endpoint !== 'string' || endpoint.length > 100 || !/^[-.0-9A-Za-z:\[\]]+$/.test(endpoint)) throw new Error('Invalid OpenSandbox endpoint')
    const local = LOCAL_HOST.exec(endpoint)
    const tailnet = TAILSCALE_HOST.exec(endpoint)
    if (!local && !tailnet) throw new Error('Use a local endpoint or Tailscale address. Public HTTP endpoints are not supported.')
    const port = Number(local?.[1] ?? tailnet?.[4])
    if (port < 1 || port > 65535) throw new Error('OpenSandbox port must be 1-65535')
    if (tailnet) {
      const parts = tailnet.slice(1, 4).map(Number)
      if (parts[0] < 64 || parts[0] > 127 || parts[1] > 255 || parts[2] > 255) throw new Error('Expected an address inside Tailscale CGNAT range')
    }
    return endpoint
  }
  private config(entry: Installed): McpServerConfig | undefined {
    if (entry.id === 'semgrep') return {
      transport: 'stdio', command: 'uvx', args: ['--from', 'semgrep==1.180.0', 'semgrep', 'mcp', '--transport', 'stdio'],
      env: { SEMGREP_MCP_DISABLE_TRACING: 'true', SEMGREP_SEND_METRICS: 'off' },
      toolCallTimeoutMs: 60_000,
    }
    if (!entry.endpoint || !this.key(entry)) return undefined
    return {
      transport: 'stdio', command: 'uvx',
      args: ['--from', 'opensandbox-mcp==1.1.1', 'opensandbox-mcp', '--domain', entry.endpoint, '--protocol', 'http', '--use-server-proxy'],
      env: { OPEN_SANDBOX_API_KEY: this.key(entry)! }, toolCallTimeoutMs: 90_000,
    }
  }
  /** The user's manually configured MCP entries remain authoritative. */
  startupServers(manual: Record<string, McpServerConfig> = {}): Record<string, McpServerConfig> {
    const servers: Record<string, McpServerConfig> = {}
    for (const entry of this.installed.values()) {
      if (manual[entry.id]) continue
      const cfg = this.config(entry)
      if (cfg) servers[entry.id] = cfg
    }
    return servers
  }
  list(): CatalogItem[] {
    const states = this.mcp?.status() ?? []
    return IDS.map((id) => {
      const state = states.find((s) => s.name === id)
      return {
        id, name: CATALOG[id].title, description: CATALOG[id].description, version: CATALOG[id].version,
        installed: Boolean(state || this.installed.has(id)), managed: this.installed.has(id) && !this.manual.has(id),
        state: state?.state ?? (this.installed.has(id) ? 'needs-setup' : 'not-installed'),
        toolCount: state?.tools.length ?? 0,
        needsEndpoint: id === 'opensandbox' && !this.installed.get(id)?.local,
        credentialConfigured: id === 'opensandbox' ? Boolean(this.key(this.installed.get(id))) : true,
        mode: id === 'opensandbox' ? this.installed.get(id)?.local ? 'local' : this.installed.has(id) ? 'private' : 'not-installed' : undefined,
      }
    })
  }
  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.mutation.then(run)
    this.mutation = operation.then(() => {}, () => {})
    return operation
  }
  private async persist(): Promise<void> {
    const doc: RegistryFile = { version: 1, installed: [...this.installed.values()] }
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(tmp, this.file)
  }
  async install(id: string, input: { mode?: unknown; endpoint?: unknown; apiKey?: unknown } = {}): Promise<CatalogItem> {
    return this.serialized(async () => {
      if (!IDS.includes(id as CatalogId)) throw new Error('Unknown plugin ID')
      const name = id as CatalogId
      if (this.manual.has(name)) throw new Error('This MCP is configured manually; the existing configuration takes precedence')
      if (this.installed.has(name)) return this.list().find((p) => p.id === name)!
      const live = this.mcp
      if (!live) throw new Error('MCP bridge is not available in this session')
      if (live.status().some((s) => s.name === name)) throw new Error('This MCP is already configured manually; manage it through your existing MCP config')
      // Installing an official pinned tool is one explicit operator action. No arbitrary package/command input.
      const probe = spawnSync('uvx', ['--version'], { timeout: 5000, encoding: 'utf8', windowsHide: true })
      if (probe.error || probe.status !== 0) throw new Error('Install uv (uvx) first, then try again')
      let entry: Installed
      let savedKey = false
      let createdLocal: ManagedLocal | undefined
      if (name === 'semgrep') {
        if (Object.keys(input).length) throw new Error('Semgrep does not need connection settings')
        entry = { id: name }
      } else if (input.mode === 'local') {
        if (Object.keys(input).some((key) => key !== 'mode')) throw new Error('Local OpenSandbox generates its own key and endpoint')
        if (this.key({ id: name, local: { installId: '', containerName: '', port: 0 } })) throw new Error('An OpenSandbox credential already exists; remove it before installing a local runtime')
        const provisioned = await startLocalSandbox(this.dir)
        createdLocal = provisioned.managed
        try {
          await this.ctx.credentials.set(SECRET_ID, provisioned.apiKey)
          savedKey = true
        } catch (error) {
          await stopLocalSandbox(this.dir, createdLocal)
          throw error
        }
        entry = { id: name, endpoint: provisioned.endpoint, local: createdLocal }
      } else {
        if (input.mode !== undefined && input.mode !== 'private') throw new Error('Unsupported OpenSandbox installation mode')
        const endpoint = this.validateEndpoint(String(input.endpoint ?? ''))
        if (typeof input.apiKey !== 'string' || !input.apiKey.trim()) throw new Error('OpenSandbox API key is required')
        if (this.key()) throw new Error('OpenSandbox credential already configured: remove it separately before replacing')
        await this.ctx.credentials.set(SECRET_ID, input.apiKey)
        savedKey = true
        entry = { id: name, endpoint }
      }
      try {
        const cfg = this.config(entry)
        if (!cfg) throw new Error('Plugin configuration is incomplete')
        await live.addServer(name, cfg)
        this.installed.set(name, entry)
        try { await this.persist() } catch (error) {
          this.installed.delete(name)
          await live.removeServer(name)
          throw error
        }
        return this.list().find((p) => p.id === name)!
      } catch (error) {
        if (createdLocal) {
          try { await stopLocalSandbox(this.dir, createdLocal) }
          catch { throw new Error('Local OpenSandbox installation failed; Docker cleanup also failed. Check the owned container before retrying.', { cause: error }) }
        }
        if (savedKey) await this.ctx.credentials.remove(SECRET_ID).catch(() => {})
        throw error
      }
    })
  }
  async uninstall(id: string): Promise<void> {
    return this.serialized(async () => {
      if (!IDS.includes(id as CatalogId) || !this.installed.has(id as CatalogId)) throw new Error('Not installed from this catalog')
      const name = id as CatalogId
      if (this.manual.has(name)) throw new Error('Cannot remove a manually configured MCP from the catalog')
      const entry = this.installed.get(name)!
      const live = this.mcp
      await live?.removeServer(name)
      if (entry.local) {
        try { await stopLocalSandbox(this.dir, entry.local) }
        catch (error) {
          const cfg = this.config(entry)
          if (cfg) await live?.addServer(name, cfg).catch(() => {})
          throw error
        }
      }
      this.installed.delete(name)
      try { await this.persist() } catch (error) {
        this.installed.set(name, entry)
        const cfg = this.config(entry)
        if (cfg) await live?.addServer(name, cfg).catch(() => {})
        throw error
      }
      if (name === 'opensandbox') await this.ctx.credentials.remove(SECRET_ID)
    })
  }
}

declare module 'cordis' {
  interface Context { pluginCatalog: PluginCatalogService }
}
