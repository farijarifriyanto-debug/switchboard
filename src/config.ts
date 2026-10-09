import { promises as fs } from 'node:fs'
import path from 'node:path'

export type PluginSpec = string | { src: string; config?: Record<string, any> }

export interface SwitchboardConfig {
  /** Language-model provider settings. */
  llm?: {
    baseURL?: string
    apiKey?: string
    defaultModel?: string
    timeoutMs?: number
    headers?: Record<string, string>
    extraBody?: Record<string, unknown>
    /** Retry attempts for transient failures (network, 429, 5xx). */
    retries?: number
    /** Base delay for exponential backoff, in ms. */
    retryDelayMs?: number
    /** Cap for a single backoff delay, in ms. */
    retryMaxDelayMs?: number
    /** Catalog JSON consulted for model context windows the endpoint omits. */
    contextCatalogUrl?: string
    /** Fallback chain when a call fails before any output: `[{ provider?, model? }, ...]`. */
    fallbacks?: Array<{ provider?: string; model?: string }>
    /** Skip a failing target for this many ms (default 60000, 0 disables). */
    fallbackCooldownMs?: number
  }
  /** Before-images of files written by the file tools (`/undo`, `/changes`). */
  undo?: { enabled?: boolean; dir?: string; maxEntries?: number; maxFileBytes?: number }
  /** Agent loop settings. */
  agent?: {
    system?: string
    maxSteps?: number
    temperature?: number
    maxTokens?: number
    /** Soft ceiling for the prompt sent each turn (characters/4 estimate). */
    maxPromptTokens?: number
    /** Recent messages always kept while trimming. */
    keepRecent?: number
    /** Truncate a single tool result to this many characters. */
    maxToolResultChars?: number
  }
  /** Built-in tool plugin settings. */
  tools?: {
    fs?: { root?: string; maxBytes?: number }
    shell?: { cwd?: string; timeoutMs?: number; disabled?: boolean; sandbox?: import('./services/sandbox.js').SandboxConfig }
    web?: {
      maxChars?: number
      timeoutMs?: number
      userAgent?: string
      /** Allow web_fetch to reach loopback/private addresses (default false). */
      allowPrivateNetwork?: boolean
      /**
       * `web_search` provider. Default `keenable` (keyless public endpoint, set
       * apiKey for BYOK). `botconnector` opts into the native BotConnector Cloud
       * endpoint (key from botconnectorApiKey or BOTCONNECTOR_API_KEY) with
       * automatic Keenable fallback.
       */
      search?: {
        provider?: 'keenable' | 'botconnector'
        botconnectorBaseURL?: string
        botconnectorApiKey?: string
        apiKey?: string
        apiUrl?: string
        title?: string
        maxResults?: number
        timeoutMs?: number
      }
    }
  }
  /** Latency telemetry. */
  metrics?: { limit?: number; persist?: string; load?: boolean }
  /** Conversation store. Set `dir: ""` to keep sessions in memory only. */
  sessions?: { dir?: string; load?: boolean; autosave?: boolean; max?: number }
  /** Workspace concept: the boundary filesystem/shell tools operate inside. */
  workspace?: {
    /** Initial workspace root. Defaults to the process cwd. */
    root?: string
    /** Remember selected roots in ~/.switchboard/workspaces.json (recent list). */
    remember?: boolean
  }
  /**
   * Tool approval gate. `risky` (default) gates mutating/dangerous tools
   * (run_command, write_file, and every MCP tool without a readOnlyHint), `off`
   * runs tools immediately, `all` gates every tool.
   * "Allow for this session" grants are stored per (tool, session) with a TTL.
   */
  approval?: { mode?: 'off' | 'risky' | 'all'; timeoutMs?: number }
  /** Durable protocol trace (LLM latency/usage, retries, tool calls, approvals). */
  trace?: { limit?: number; dir?: string }
  /**
   * Local operator console (`sbx web`). Off by default: it serves an
   * unauthenticated agent, so binding it is an explicit choice.
   */
  web?: {
    enabled?: boolean
    port?: number
    host?: string
    /** Access token (cookie or Bearer). Required when `host` is not loopback; also SWITCHBOARD_WEB_TOKEN. */
    token?: string
    /** Directory holding the static console. Defaults to the bundled `web/`. */
    dir?: string
  }
  /**
   * Settings storage (provider registry + credential store). Holds
   * `providers.json` and `credentials.json` (mode 0600). Defaults to `~/.switchboard`.
   */
  settings?: { dir?: string }
  /**
   * Local workflow runner (`sbx ci`). Off unless `enabled: true` — without it
   * there is no command, no `/api/ci/*` routes and no console panel.
   */
  ci?: { enabled?: boolean; keepRuns?: number }
  /**
   * MCP servers (`sbx` acts as an MCP client). Each entry spawns or connects
   * one server and exposes its tools as `mcp__<server>__<tool>`. Absent = no
   * MCP bridge loaded at all.
   */
  mcp?: McpConfig
  /**
   * Subagent delegation (`task` tool): isolated worker sessions, parallel
   * batches and background jobs. Absent = defaults (feature ON — unlike
   * `mcp`, only `enabled: false` turns it off).
   */
  subagent?: SubagentConfig
  /** Scheduled agent runs. Always available; the scheduler only ticks in `sbx web` / `sbx channels`. */
  automations?: { dir?: string; runTimeoutMs?: number }
  /** Token/cost accounting: prices come from the endpoint's model list; `pricing` (USD per 1M tokens, by model id) overrides them. */
  usage?: { pricing?: Record<string, { input: number; output: number; cachedInput?: number; cacheWrite?: number }>; refreshMs?: number }
  /** A small notebook (MEMORY.md) read into every prompt; notes are added only with approval. On unless `enabled: false`. */
  memory?: { enabled?: boolean; globalFile?: string; projectFile?: string }
  /** Chat channels that drive the agent (Telegram). Off unless `enabled` and fully configured. */
  channels?: { telegram?: import('./channels/telegram.js').TelegramConfig; discord?: import('./channels/discord.js').DiscordConfig }
  /** Context compaction: summarize old history instead of dropping it. On unless `enabled: false`. */
  compaction?: { enabled?: boolean; triggerRatio?: number; keepRecent?: number; summaryTokens?: number }
  /**
   * Skills (SKILL.md folders): advertised in the system prompt, loaded on demand
   * with `load_skill` or run with `/name`. On unless `enabled: false`.
   */
  skills?: { enabled?: boolean; globalDir?: string; projectDir?: string; draftsDir?: string }
  /** Extra plugins: npm package names or local paths. */
  plugins?: PluginSpec[]
}

export const DEFAULT_CONFIG: SwitchboardConfig = {
  llm: {
    baseURL: 'https://api.botconnector.id/v1',
    defaultModel: 'agnes-3.0-flash',
    timeoutMs: 180_000,
    retries: 2,
    retryDelayMs: 500,
    retryMaxDelayMs: 8_000,
  },
  agent: {
    maxSteps: 8,
    temperature: 0.2,
    maxPromptTokens: 96_000,
    keepRecent: 4,
  },
  tools: {},
  metrics: { limit: 1000, persist: '~/.switchboard/metrics.jsonl', load: true },
  sessions: { dir: '~/.switchboard/sessions', load: true, autosave: true },
  workspace: { root: process.cwd(), remember: true },
  approval: { mode: 'risky', timeoutMs: 120_000 },
  trace: { limit: 400, dir: '~/.switchboard/trace' },
  web: { enabled: false, port: 7777, host: '127.0.0.1' },
  plugins: [],
}

/** Shallow-merges user config over the defaults, one level deep per section. */
export function mergeConfig(user: SwitchboardConfig = {}): SwitchboardConfig {
  const merged: SwitchboardConfig = { ...DEFAULT_CONFIG }
  for (const key of Object.keys(user) as (keyof SwitchboardConfig)[]) {
    const value = user[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      ;(merged as any)[key] = { ...(DEFAULT_CONFIG as any)[key], ...value }
    } else if (value !== undefined) {
      ;(merged as any)[key] = value
    }
  }
  return merged
}

/** Strips `//` and `/* *\/` comments plus trailing commas, then parses JSON. */
export function parseJsonc(text: string): SwitchboardConfig {
  const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const withoutLine = withoutBlock
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
  const withoutTrailingCommas = withoutLine.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(withoutTrailingCommas) as SwitchboardConfig
}

/** Loads and merges a `.json`/`.jsonc` config file. Missing files are fine. */
export async function loadConfig(file?: string): Promise<SwitchboardConfig> {
  if (!file) return mergeConfig()
  const resolved = path.resolve(file)
  const text = await fs.readFile(resolved, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (text === null) return mergeConfig()
  return mergeConfig(parseJsonc(text))
}

/** Resolves a plugin entry to an importable specifier (local paths -> file URL). */
export function resolvePluginSrc(src: string): string {
  if (src.startsWith('.') || src.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(src)) {
    return new URL(src, `file://${process.cwd()}/`).href
  }
  return src
}

// ---------------------------------------------------------------------------
// MCP client bridge configuration
// ---------------------------------------------------------------------------

/** Backoff policy for a server whose connection drops or fails at boot. */
export interface McpReconnectConfig {
  enabled?: boolean
  initialDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
}

/** One MCP server entry in the `mcp.servers` block. */
export interface McpServerConfig {
  transport?: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
  maxInstructionBytes?: number
  failOnStartupError?: boolean
  reconnect?: McpReconnectConfig
}

/** The `mcp` config block: one supervisor per server entry. */
export interface McpConfig {
  servers?: Record<string, McpServerConfig>
}

/** A server entry after validation and default resolution. */
export interface ResolvedMcpServer {
  transport: 'stdio' | 'streamable-http'
  command?: string
  /** stdio only. */
  args?: string[]
  /** stdio only (after interpolation). */
  env?: Record<string, string>
  cwd?: string
  /** streamable-http only. */
  url?: string
  /** streamable-http only (after interpolation). */
  headers?: Record<string, string>
  toolCallTimeoutMs: number
  maxInstructionBytes: number
  failOnStartupError: boolean
  reconnect: { enabled: boolean; initialDelayMs: number; maxDelayMs: number; maxAttempts: number }
}

/** Server keys allowed in config (`mcp.servers` object keys). */
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
/** Ambient variable names that must never reach an MCP child process. */
export const MCP_ENV_SCRUB_RE = /KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL/i

/** Resolves every `${VAR}` against `env`; unknown names become "" and are reported. */
export function interpolateMcp(value: string, env: NodeJS.ProcessEnv = process.env): { value: string; missing: string[] } {
  const missing: string[] = []
  const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const v = env[name]
    if (v === undefined) {
      missing.push(name)
      return ''
    }
    return v
  })
  return { value: resolved, missing }
}

/**
 * Environment handed to stdio MCP children: ambient vars minus names that
 * look like secrets and minus BOTCONNECTOR_* (the platform key never leaks),
 * then the server's own `env` entries on top.
 */
export function childEnv(configEnv: Record<string, string>, ambient: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(ambient)) {
    if (value === undefined) continue
    if (key.startsWith('BOTCONNECTOR_')) continue
    if (MCP_ENV_SCRUB_RE.test(key)) continue
    out[key] = value
  }
  return { ...out, ...configEnv }
}

const MCP_SERVER_FIELDS = new Set([
  'transport', 'command', 'args', 'env', 'cwd', 'url', 'headers',
  'toolCallTimeoutMs', 'maxInstructionBytes', 'failOnStartupError', 'reconnect',
])
const MCP_RECONNECT_FIELDS = new Set(['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'])

/**
 * Validates the `mcp` block and resolves every default. Throws on anything a
 * human must fix (bad server name, mixed transports, wrong types); unknown
 * fields only warn. `warn` receives human-readable messages.
 */
export function validateMcpServers(mcp: McpConfig | undefined, warn: (msg: string) => void): Record<string, ResolvedMcpServer> {
  const out: Record<string, ResolvedMcpServer> = {}
  if (mcp === undefined) return out
  if (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp)) throw new Error('mcp: config must be an object')
  if (mcp.servers === undefined) return out
  if (typeof mcp.servers !== 'object' || mcp.servers === null || Array.isArray(mcp.servers)) {
    throw new Error('mcp: "servers" must be an object keyed by server name')
  }
  for (const [name, raw] of Object.entries(mcp.servers)) {
    if (!MCP_SERVER_NAME_RE.test(name)) throw new Error(`mcp: invalid server name "${name}" (expected [A-Za-z0-9_-]{1,32})`)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`mcp: ${name}: server config must be an object`)
    for (const key of Object.keys(raw)) {
      if (!MCP_SERVER_FIELDS.has(key)) warn(`mcp: ${name}: unknown field "${key}"`)
    }

    const transport = raw.transport ?? 'stdio'
    if (transport !== 'stdio' && transport !== 'streamable-http') {
      throw new Error(`mcp: ${name}: unknown transport "${String(transport)}" (expected "stdio" or "streamable-http")`)
    }
    const isStdio = transport === 'stdio'
    if (isStdio) {
      if (raw.url !== undefined || raw.headers !== undefined) {
        throw new Error(`mcp: ${name}: "url"/"headers" are only valid with transport "streamable-http"`)
      }
      if (typeof raw.command !== 'string' || !raw.command) throw new Error(`mcp: ${name}: stdio transport requires "command"`)
      if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string'))) {
        throw new Error(`mcp: ${name}: "args" must be an array of strings`)
      }
      if (raw.env !== undefined && (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env) || Object.values(raw.env).some((v) => typeof v !== 'string'))) {
        throw new Error(`mcp: ${name}: "env" must be a string map`)
      }
      if (raw.cwd !== undefined && typeof raw.cwd !== 'string') throw new Error(`mcp: ${name}: "cwd" must be a string`)
    } else {
      if (raw.command !== undefined || raw.args !== undefined || raw.env !== undefined || raw.cwd !== undefined) {
        throw new Error(`mcp: ${name}: "command"/"args"/"env"/"cwd" are only valid with transport "stdio"`)
      }
      if (typeof raw.url !== 'string' || !raw.url) throw new Error(`mcp: ${name}: streamable-http transport requires "url"`)
      if (raw.headers !== undefined && (typeof raw.headers !== 'object' || raw.headers === null || Array.isArray(raw.headers) || Object.values(raw.headers).some((v) => typeof v !== 'string'))) {
        throw new Error(`mcp: ${name}: "headers" must be a string map`)
      }
    }

    const num = (key: string, value: unknown, def: number): number => {
      if (value === undefined) return def
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`mcp: ${name}: "${key}" must be a positive number`)
      return value
    }
    const bool = (key: string, value: unknown, def: boolean): boolean => {
      if (value === undefined) return def
      if (typeof value !== 'boolean') throw new Error(`mcp: ${name}: "${key}" must be a boolean`)
      return value
    }
    const reconnectRaw = raw.reconnect ?? {}
    if (typeof reconnectRaw !== 'object' || reconnectRaw === null || Array.isArray(reconnectRaw)) {
      throw new Error(`mcp: ${name}: "reconnect" must be an object`)
    }
    for (const key of Object.keys(reconnectRaw)) {
      if (!MCP_RECONNECT_FIELDS.has(key)) warn(`mcp: ${name}: unknown field "reconnect.${key}"`)
    }
    const interpolateMap = (map: Record<string, string>, label: string): Record<string, string> => {
      const resolved: Record<string, string> = {}
      for (const [k, v] of Object.entries(map)) {
        const r = interpolateMcp(v)
        for (const missingName of r.missing) warn(`mcp: ${name}: unresolved \${${missingName}} in ${label}.${k} (empty string used)`)
        resolved[k] = r.value
      }
      return resolved
    }

    out[name] = {
      transport,
      ...(isStdio
        ? { command: raw.command as string, args: (raw.args ?? []) as string[], env: interpolateMap(raw.env ?? {}, 'env'), ...(raw.cwd ? { cwd: raw.cwd } : {}) }
        : { url: raw.url as string, headers: interpolateMap(raw.headers ?? {}, 'headers') }),
      toolCallTimeoutMs: num('toolCallTimeoutMs', raw.toolCallTimeoutMs, 60_000),
      maxInstructionBytes: num('maxInstructionBytes', raw.maxInstructionBytes, 32_768),
      failOnStartupError: bool('failOnStartupError', raw.failOnStartupError, false),
      reconnect: {
        enabled: bool('reconnect.enabled', reconnectRaw.enabled, true),
        initialDelayMs: num('reconnect.initialDelayMs', reconnectRaw.initialDelayMs, 500),
        maxDelayMs: num('reconnect.maxDelayMs', reconnectRaw.maxDelayMs, 30_000),
        maxAttempts: num('reconnect.maxAttempts', reconnectRaw.maxAttempts, 10),
      },
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Subagent delegation configuration (spec §3)
// ---------------------------------------------------------------------------

/** The `subagent` config block. Absent = defaults (feature ON). */
export interface SubagentConfig {
  enabled?: boolean
  maxParallel?: number
  maxSteps?: number
  autoResume?: boolean
  /** Workers one session may start in total (blocking + background). */
  maxWorkers?: number
  /** Tokens (prompt + completion, summed over calls) all workers of a session may use; 0 = no limit. */
  maxTokens?: number
  /** Estimated USD all workers of a session may cost (needs known prices); unset = no limit. */
  maxCostUsd?: number
  /** Tokens one worker may use before it is stopped; 0 = no limit. */
  maxWorkerTokens?: number
}

/** The block after validation and default resolution. */
export interface ResolvedSubagent {
  enabled: boolean
  maxParallel: number
  maxSteps: number
  autoResume: boolean
  maxWorkers: number
  maxTokens: number
  maxCostUsd?: number
  maxWorkerTokens: number
}

export const SUBAGENT_DEFAULTS: ResolvedSubagent = { enabled: true, maxParallel: 3, maxSteps: 8, autoResume: true, maxWorkers: 12, maxTokens: 1_000_000, maxWorkerTokens: 300_000 }
const SUBAGENT_FIELDS = new Set(['enabled', 'maxParallel', 'maxSteps', 'autoResume', 'maxWorkers', 'maxTokens', 'maxCostUsd', 'maxWorkerTokens'])

/**
 * Validates the `subagent` block and resolves every default (pola
 * `validateMcpServers`). Booleans must be booleans; counts must be integers
 * >= 1 (`Number.isInteger` already rejects `2.5`, `NaN`, `Infinity`);
 * a violation throws naming the key, unknown fields only warn.
 */
export function validateSubagent(sub: SubagentConfig | undefined, warn: (msg: string) => void): ResolvedSubagent {
  if (sub === undefined) return { ...SUBAGENT_DEFAULTS }
  if (typeof sub !== 'object' || sub === null || Array.isArray(sub)) throw new Error('subagent: config must be an object')
  for (const key of Object.keys(sub)) {
    if (!SUBAGENT_FIELDS.has(key)) warn(`subagent: unknown field "${key}"`)
  }
  const bool = (key: 'enabled' | 'autoResume', value: unknown, def: boolean): boolean => {
    if (value === undefined) return def
    if (typeof value !== 'boolean') throw new Error(`subagent: "${key}" must be a boolean`)
    return value
  }
  const count = (key: 'maxParallel' | 'maxSteps' | 'maxWorkers', value: unknown, def: number): number => {
    if (value === undefined) return def
    if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value) || value < 1) {
      throw new Error(`subagent: "${key}" must be an integer >= 1`)
    }
    return value
  }
  // budgets: a whole number >= 0, where 0 switches the limit off
  const budget = (key: 'maxTokens' | 'maxWorkerTokens', value: unknown, def: number): number => {
    if (value === undefined) return def
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`subagent: "${key}" must be an integer >= 0 (0 = no limit)`)
    return value
  }
  if (sub.maxCostUsd !== undefined && (typeof sub.maxCostUsd !== 'number' || !Number.isFinite(sub.maxCostUsd) || sub.maxCostUsd <= 0)) throw new Error('subagent: "maxCostUsd" must be a number > 0')
  return {
    enabled: bool('enabled', sub.enabled, SUBAGENT_DEFAULTS.enabled),
    autoResume: bool('autoResume', sub.autoResume, SUBAGENT_DEFAULTS.autoResume),
    maxParallel: count('maxParallel', sub.maxParallel, SUBAGENT_DEFAULTS.maxParallel),
    maxSteps: count('maxSteps', sub.maxSteps, SUBAGENT_DEFAULTS.maxSteps),
    maxWorkers: count('maxWorkers', sub.maxWorkers, SUBAGENT_DEFAULTS.maxWorkers),
    maxTokens: budget('maxTokens', sub.maxTokens, SUBAGENT_DEFAULTS.maxTokens),
    ...(sub.maxCostUsd !== undefined ? { maxCostUsd: sub.maxCostUsd } : {}),
    maxWorkerTokens: budget('maxWorkerTokens', sub.maxWorkerTokens, SUBAGENT_DEFAULTS.maxWorkerTokens),
  }
}
