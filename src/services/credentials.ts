import { Service } from 'cordis'
import type { Context } from 'cordis'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { SettingsError } from './settings-error.js'
import { expandHome } from './session.js'
import type { ProviderEntry } from './providers.js'

/** What any API/UI may ever see about a stored secret (spec §4). */
export interface CredentialDescribe {
  configured: boolean
  source: 'env' | 'local' | 'config' | null
  /** Env var name when `source === 'env'`. */
  envName?: string
  /** Local store timestamp when `source === 'local'`. */
  updatedAt?: number
}

export interface CredentialStoreConfig {
  /** Directory holding `credentials.json`. Default `~/.switchboard`. */
  dir?: string
  /** `config.llm.apiKey` — legacy key for the virtual `default` provider. */
  legacyConfigKey?: string
}

interface CredentialsFile {
  version: 1
  credentials: Record<string, { apiKey: string; updatedAt: number }>
}

const DEFAULT_DIR = '~/.switchboard'
const KEY_MIN = 1
const KEY_MAX = 8192

/**
 * `ctx.credentials` — write-only credential store (spec §4).
 *
 * Secrets live in `credentials.json` (file mode 0600, atomic writes) and are
 * strictly separated from `providers.json`. The console/API only ever receive
 * `describe()` output — `{ configured, source, ... }` — never the key itself.
 *
 * Resolution precedence per provider:
 *   1. `process.env[provider.apiKeyEnv]`      (source `env`)
 *   2. local credential store                 (source `local`)
 *   3. default provider only: `config.llm.apiKey` (source `config`),
 *      then `BOTCONNECTOR_API_KEY` / `OPENAI_API_KEY` (source `env`)
 */
export class CredentialStoreService extends Service {
  static inject: string[] = []

  readonly dir: string
  private readonly legacyConfigKey?: string
  private data: CredentialsFile
  private writeChain: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: CredentialStoreConfig = {}) {
    super(ctx, 'credentials')
    this.dir = path.resolve(expandHome(config.dir ?? DEFAULT_DIR))
    this.legacyConfigKey = config.legacyConfigKey || undefined
    this.data = { version: 1, credentials: {} }
    try {
      const text = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(text) as CredentialsFile
      if (parsed && parsed.version === 1 && typeof parsed.credentials === 'object' && parsed.credentials) {
        this.data = { version: 1, credentials: parsed.credentials }
      }
    } catch {
      /* no file -> nothing stored yet */
    }
  }

  private get file(): string {
    return path.join(this.dir, 'credentials.json')
  }

  private async persist(): Promise<void> {
    const text = JSON.stringify(this.data, null, 2)
    const run = this.writeChain.then(async () => {
      await mkdir(this.dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      // mode 0600 applies on file creation (POSIX); harmless elsewhere.
      await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.file)
    })
    this.writeChain = run.catch(() => {})
    return run
  }

  /** Status only — this shape is the sole credential view any API returns. */
  describe(entry: ProviderEntry): CredentialDescribe {
    if (entry.apiKeyEnv && process.env[entry.apiKeyEnv]) {
      return { configured: true, source: 'env', envName: entry.apiKeyEnv }
    }
    const local = this.data.credentials[entry.id]
    if (local?.apiKey) return { configured: true, source: 'local', updatedAt: local.updatedAt }
    if (entry.id === 'default') {
      if (this.legacyConfigKey) return { configured: true, source: 'config' }
      if (process.env.BOTCONNECTOR_API_KEY) return { configured: true, source: 'env', envName: 'BOTCONNECTOR_API_KEY' }
      if (process.env.OPENAI_API_KEY) return { configured: true, source: 'env', envName: 'OPENAI_API_KEY' }
    }
    return { configured: false, source: null }
  }

  /** Server-side key resolution — never routed to the API layer. */
  resolve(entry: ProviderEntry): string | undefined {
    if (entry.apiKeyEnv) {
      const value = process.env[entry.apiKeyEnv]
      if (value) return value
    }
    const local = this.data.credentials[entry.id]?.apiKey
    if (local) return local
    if (entry.id === 'default') {
      if (this.legacyConfigKey) return this.legacyConfigKey
      return process.env.BOTCONNECTOR_API_KEY || process.env.OPENAI_API_KEY || undefined
    }
    return undefined
  }

  /** Stores a key for one provider (trimmed; 1..8192 chars). */
  async set(id: string, apiKey: unknown): Promise<CredentialDescribe> {
    if (typeof apiKey !== 'string') {
      throw new SettingsError('API key must be text.', { hint: 'Paste the key from your provider dashboard, then save.' })
    }
    const key = apiKey.trim()
    if (key.length < KEY_MIN || key.length > KEY_MAX) {
      throw new SettingsError(`API key must be ${KEY_MIN}-${KEY_MAX} characters.`, {
        hint: 'Paste the full key from your provider dashboard, or leave the field blank to keep the stored key.',
      })
    }
    this.data.credentials[id] = { apiKey: key, updatedAt: Date.now() }
    await this.persist()
    return { configured: true, source: 'local', updatedAt: this.data.credentials[id].updatedAt }
  }

  /** Removes the local key (env/config sources are unaffected). */
  async remove(id: string): Promise<void> {
    if (!this.data.credentials[id]) return
    delete this.data.credentials[id]
    await this.persist()
  }
}

declare module 'cordis' {
  interface Context {
    credentials: CredentialStoreService
  }
}
