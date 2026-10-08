import { Service } from 'cordis'
import type { Context } from 'cordis'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { SettingsError } from './settings-error.js'
import { expandHome } from './session.js'

/** Wire protocols the console can actually serve (spec §5 — tested trio only). */
export type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages'
export const PROTOCOLS: readonly Protocol[] = ['openai-chat', 'openai-responses', 'anthropic-messages']

/** One model in a provider's persisted catalog (spec §3). */
export interface ProviderModel {
  id: string
  displayName?: string
  /** Context window in tokens. */
  context?: number
  /** Output (completion) limit in tokens. */
  maxOutput?: number
  inputs?: { vision?: boolean; tools?: boolean; reasoning?: boolean }
  /** True when the row was typed by hand (endpoint has no catalog). */
  manual?: boolean
}

/** One configurable provider. Never contains secrets. */
export interface ProviderEntry {
  /** Stable slug; immutable after create. */
  id: string
  displayName: string
  baseURL: string
  protocol: Protocol
  headers?: Record<string, string>
  /** NAME of an env var holding the key — the value is never stored here. */
  apiKeyEnv?: string
  models: ProviderModel[]
  /** Virtual legacy provider derived from `config.llm`. */
  source?: 'config'
  createdAt: number
  updatedAt: number
}

export interface ProvidersFile {
  version: 1
  defaultProvider?: string
  defaultModel?: string
  providers: ProviderEntry[]
}

export interface ProviderRegistryConfig {
  /** Directory holding `providers.json` + `credentials.json`. Default `~/.switchboard`. */
  dir?: string
  /** The legacy `config.llm` block — shapes the virtual `default` provider. */
  legacy?: { baseURL?: string; defaultModel?: string }
}

/** Stable provider id: lowercase slug, immutable after create (spec §3). */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
/** `default` describes the config-derived provider and can never be a user entry. */
export const RESERVED_ID = 'default'

const LEGACY_DEFAULTS = { baseURL: 'https://api.botconnector.id/v1', defaultModel: 'agnes-3.0-flash' }

/** Display name -> candidate slug (`"My Stub API"` -> `"my-stub-api"`). */
export function slugifyProviderId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'provider'
}

function bad(message: string, hint: string, status = 400): SettingsError {
  return new SettingsError(message, { status, hint })
}

function validateProtocol(value: unknown): Protocol {
  if (typeof value !== 'string' || !PROTOCOLS.includes(value as Protocol)) {
    throw bad(
      `Unknown protocol "${String(value)}".`,
      `Choose one of: ${PROTOCOLS.join(', ')}.`,
    )
  }
  return value as Protocol
}

function validateBaseURL(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw bad('Base URL is required.', 'Enter the provider endpoint, e.g. https://api.example.com/v1.')
  }
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw bad(`"${value}" is not a valid Base URL.`, 'Use a full http(s) URL, e.g. https://api.example.com/v1.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw bad(`Base URL "${value}" must be an http(s) URL.`, 'Use a full http(s) URL, e.g. https://api.example.com/v1.')
  }
  return value.trim().replace(/\/+$/, '')
}

function validateDisplayName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw bad('Display name is required.', 'Give the provider a short name, e.g. "OpenRouter".')
  }
  const name = value.trim()
  if (name.length > 80) throw bad('Display name must be 80 characters or fewer.', 'Shorten the name and save again.')
  return name
}

function validateId(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER_ID_RE.test(value)) {
    throw bad(
      `Provider id "${String(value)}" is invalid.`,
      'Use 1-40 lowercase letters, digits or hyphens, starting with a letter or digit.',
    )
  }
  if (value === RESERVED_ID) {
    throw bad(
      `Provider id "${RESERVED_ID}" is reserved.`,
      '"default" is the built-in provider from switchboard.config.jsonc — pick another id.',
    )
  }
  return value
}

function validateHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw bad('Headers must be a set of name/value pairs.', 'Remove the headers field or provide an object of strings.')
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim() || typeof entry !== 'string' || !entry.trim() || key.length > 200 || entry.length > 1000) {
      throw bad(`Header "${key}" is invalid.`, 'Each header needs a non-empty name and value (short strings).')
    }
    out[key.trim()] = entry
  }
  if (Object.keys(out).length > 32) throw bad('Too many headers.', 'Keep at most 32 custom headers per provider.')
  return out
}

function validateApiKeyEnv(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw bad(
      `"${String(value)}" is not a valid environment variable name.`,
      'Use a name like OPENAI_API_KEY — the console stores only the name, never the value.',
    )
  }
  return value
}

/** Validates one catalog row (spec §4 model fields). */
export function validateModel(raw: unknown, index: number): ProviderModel {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw bad(`Model #${index + 1} must be an object.`, 'Each model needs at least an id.')
  }
  const model = raw as Record<string, unknown>
  if (typeof model.id !== 'string' || !model.id.trim() || model.id.length > 200) {
    throw bad(`Model id for entry #${index + 1} is missing or invalid.`, 'Provide the exact model id the endpoint expects (1-200 characters).')
  }
  const num = (key: 'context' | 'maxOutput', label: string): number | undefined => {
    const value = model[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw bad(`${label} for "${model.id}" must be a positive whole number.`, `Enter tokens like 131072, or leave it empty.`)
    }
    return value
  }
  const context = num('context', 'Context window')
  const maxOutput = num('maxOutput', 'Output limit')
  const out: ProviderModel = { id: model.id.trim() }
  if (typeof model.displayName === 'string' && model.displayName.trim()) out.displayName = model.displayName.trim().slice(0, 120)
  if (context !== undefined) out.context = context
  if (maxOutput !== undefined) out.maxOutput = maxOutput
  if (typeof model.manual === 'boolean') out.manual = model.manual
  if (model.inputs !== undefined && model.inputs !== null) {
    const inputs = model.inputs
    if (typeof inputs !== 'object' || Array.isArray(inputs)) {
      throw bad(`Capabilities for "${model.id}" must be an object.`, 'Use { vision, tools, reasoning } booleans or leave it empty.')
    }
    const clean: { vision?: boolean; tools?: boolean; reasoning?: boolean } = {}
    for (const key of ['vision', 'tools', 'reasoning'] as const) {
      const value = (inputs as Record<string, unknown>)[key]
      if (value !== undefined) {
        if (typeof value !== 'boolean') throw bad(`Capability "${key}" for "${model.id}" must be true or false.`, 'Toggle the capability checkboxes instead of typing a value.')
        if (value) clean[key] = true
      }
    }
    if (Object.keys(clean).length) out.inputs = clean
  }
  return out
}

const DEFAULT_DIR = '~/.switchboard'

/**
 * `ctx.providers` — the provider registry (spec §3).
 *
 * Owns `providers.json` under the settings dir: stable-id provider entries +
 * their model catalogs + the default provider/model selection. Every mutation
 * validates first, then persists atomically (tmp file + rename) and updates the
 * in-memory copy — readers always see complete state, and `LLMService` snapshots
 * a profile per request so saves apply to the NEXT request only (spec §7).
 *
 * When no file exists yet, the registry exposes a read-only virtual `default`
 * provider built from `config.llm`, so existing installs behave exactly as before.
 */
export class ProviderRegistryService extends Service {
  static inject: string[] = []

  readonly dir: string
  private readonly legacy: { baseURL: string; defaultModel: string }
  private data: ProvidersFile
  private writeChain: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: ProviderRegistryConfig = {}) {
    super(ctx, 'providers')
    this.dir = path.resolve(expandHome(config.dir ?? DEFAULT_DIR))
    this.legacy = {
      baseURL: config.legacy?.baseURL ?? LEGACY_DEFAULTS.baseURL,
      defaultModel: config.legacy?.defaultModel ?? LEGACY_DEFAULTS.defaultModel,
    }
    this.data = { version: 1, providers: [] }
    try {
      const text = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(text) as ProvidersFile
      if (parsed && parsed.version === 1 && Array.isArray(parsed.providers)) {
        this.data = {
          version: 1,
          ...(typeof parsed.defaultProvider === 'string' ? { defaultProvider: parsed.defaultProvider } : {}),
          ...(typeof parsed.defaultModel === 'string' ? { defaultModel: parsed.defaultModel } : {}),
          providers: parsed.providers,
        }
      }
    } catch {
      /* missing or unreadable file -> start with the virtual default only */
    }
  }

  private get file(): string {
    return path.join(this.dir, 'providers.json')
  }

  /** The read-only provider derived from `config.llm` (never persisted). */
  private virtual(): ProviderEntry {
    const now = Date.now()
    return {
      id: RESERVED_ID,
      displayName: 'Default (config)',
      baseURL: this.legacy.baseURL,
      protocol: 'openai-chat',
      models: [],
      source: 'config',
      createdAt: now,
      updatedAt: now,
    }
  }

  // ---------------------------------------------------------------- reading

  /** All providers: persisted entries first, then the virtual config default. */
  list(): ProviderEntry[] {
    const entries = [...this.data.providers]
    if (!entries.some((entry) => entry.id === RESERVED_ID)) entries.push(this.virtual())
    return entries
  }

  get(id: string): ProviderEntry | undefined {
    return this.list().find((entry) => entry.id === id)
  }

  isVirtual(id: string): boolean {
    return id === RESERVED_ID
  }

  require(id: string): ProviderEntry {
    const found = this.get(id)
    if (!found) {
      throw new SettingsError(`Unknown provider "${id}".`, {
        status: 404,
        hint: 'Open Settings → Models and pick a provider from the list.',
      })
    }
    return found
  }

  /** Current default selection, resilient to a deleted provider/model. */
  default(): { provider: string; model: string } {
    const provider = this.data.defaultProvider && this.get(this.data.defaultProvider) ? this.data.defaultProvider : RESERVED_ID
    const model = this.data.defaultModel || this.legacy.defaultModel
    return { provider, model }
  }

  /** Catalog rows for one provider (virtual default has none — it lists live). */
  models(id: string): ProviderModel[] {
    if (id === RESERVED_ID) {
      throw new SettingsError('The default provider uses the live endpoint catalog.', {
        hint: 'Add your own provider in Settings → Models to edit a model catalog.',
      })
    }
    return [...this.require(id).models]
  }

  // --------------------------------------------------------------- writing

  private async persist(): Promise<void> {
    const text = JSON.stringify(this.data, null, 2)
    const run = this.writeChain.then(async () => {
      await mkdir(this.dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, this.file)
    })
    // Keep the chain alive even when this write fails (next write retries).
    this.writeChain = run.catch(() => {})
    return run
  }

  private touch(entry: ProviderEntry, now: number): void {
    entry.updatedAt = now
  }

  /** Creates a provider; explicit ids must pass the slug rules, generated ids never collide. */
  async create(input: Record<string, unknown>): Promise<ProviderEntry> {
    const displayName = validateDisplayName(input.displayName)
    let id: string
    if (input.id !== undefined && input.id !== null && input.id !== '') {
      id = validateId(input.id)
      if (this.get(id)) {
        throw new SettingsError(`Provider id "${id}" already exists.`, {
          status: 409,
          hint: 'Pick a different id, or edit the existing provider instead.',
        })
      }
    } else {
      const base = slugifyProviderId(displayName)
      id = base === RESERVED_ID ? 'provider' : base
      let suffix = 2
      while (this.get(id)) {
        id = `${base.slice(0, 36)}-${suffix}`
        suffix += 1
      }
    }
    const entry: ProviderEntry = {
      id,
      displayName,
      baseURL: validateBaseURL(input.baseURL),
      protocol: validateProtocol(input.protocol),
      ...(validateHeaders(input.headers) ? { headers: validateHeaders(input.headers) } : {}),
      ...(validateApiKeyEnv(input.apiKeyEnv) ? { apiKeyEnv: validateApiKeyEnv(input.apiKeyEnv) } : {}),
      models: Array.isArray(input.models) ? input.models.map((model, i) => validateModel(model, i)) : [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.data.providers.push(entry)
    await this.persist()
    return { ...entry, models: [...entry.models] }
  }

  /** Field-level update. The id and `source: config` provider are immutable. */
  async update(id: string, patch: Record<string, unknown>): Promise<ProviderEntry> {
    if (id === RESERVED_ID) {
      throw new SettingsError('The default provider comes from switchboard.config.jsonc.', {
        hint: 'Edit the "llm" block in switchboard.config.jsonc, or add a new provider in Settings → Models.',
      })
    }
    if (patch.id !== undefined && patch.id !== id) {
      throw new SettingsError('Provider id is immutable.', {
        hint: 'Create a new provider with the id you want, move sessions to it, then delete this one.',
      })
    }
    const entry = this.require(id)
    if (patch.displayName !== undefined) entry.displayName = validateDisplayName(patch.displayName)
    if (patch.baseURL !== undefined) entry.baseURL = validateBaseURL(patch.baseURL)
    if (patch.protocol !== undefined) entry.protocol = validateProtocol(patch.protocol)
    if (patch.headers !== undefined) entry.headers = validateHeaders(patch.headers)
    if (patch.apiKeyEnv !== undefined) entry.apiKeyEnv = validateApiKeyEnv(patch.apiKeyEnv)
    this.touch(entry, Date.now())
    await this.persist()
    return { ...entry, models: [...entry.models] }
  }

  /** Removes a provider (the route handles session detach + force, spec §6). */
  async remove(id: string): Promise<ProviderEntry> {
    if (id === RESERVED_ID) {
      throw new SettingsError('The default provider comes from switchboard.config.jsonc.', {
        hint: 'Edit the "llm" block in switchboard.config.jsonc instead of deleting it here.',
      })
    }
    const index = this.data.providers.findIndex((entry) => entry.id === id)
    if (index === -1) {
      throw new SettingsError(`Unknown provider "${id}".`, {
        status: 404,
        hint: 'It may already be deleted — reload Settings → Models.',
      })
    }
    const [deleted] = this.data.providers.splice(index, 1)
    if (this.data.defaultProvider === id) {
      delete this.data.defaultProvider
      delete this.data.defaultModel
    }
    await this.persist()
    return deleted
  }

  /** Replaces a provider's model catalog atomically (validated, spec §4). */
  async setModels(id: string, models: unknown[]): Promise<ProviderModel[]> {
    if (id === RESERVED_ID) {
      throw new SettingsError('The default provider uses the live endpoint catalog.', {
        hint: 'Add your own provider in Settings → Models to edit a model catalog.',
      })
    }
    const entry = this.require(id)
    const clean = models.map((model, i) => validateModel(model, i))
    if (clean.length > 500) {
      throw bad('Catalog too large (max 500 models).', 'Trim the list or keep only the models you use.')
    }
    entry.models = clean
    this.touch(entry, Date.now())
    await this.persist()
    return [...clean]
  }

  /** Validates and stores the default provider/model pair (spec §6). */
  async setDefault(selection: { provider?: unknown; model?: unknown }): Promise<{ provider: string; model: string }> {
    const providerId = typeof selection.provider === 'string' && selection.provider ? selection.provider : RESERVED_ID
    const provider = this.require(providerId)
    const model = typeof selection.model === 'string' ? selection.model.trim() : ''
    if (!model) {
      throw bad('Model is required.', 'Pick a model from the list, or type a model id for a catalog-less provider.')
    }
    if (provider.models.length && !provider.models.some((entry) => entry.id === model)) {
      throw new SettingsError(`Model "${model}" is not in the "${provider.displayName}" catalog.`, {
        hint: 'Choose a listed model, or add it under the provider first.',
      })
    }
    this.data.defaultProvider = providerId
    this.data.defaultModel = model
    await this.persist()
    return { provider: providerId, model }
  }
}

declare module 'cordis' {
  interface Context {
    providers: ProviderRegistryService
  }
}

export { SettingsError }
