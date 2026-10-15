/**
 * Adapter for an EXISTING BotConnector Local Core llama.cpp inference server.
 * Switchboard never installs runtimes, downloads models, or owns its process.
 * This adapter only probes loopback and registers a provider after an explicit
 * user action. Avoid claiming port 11435 is owned by BotConnector/llama-swap.
 */
import { SettingsError } from './settings-error.js'
import type { ProviderRegistryService } from './providers.js'

export const BOTCONNECTOR_LOCAL_PROVIDER = 'local-botconnector'
const DEFAULT_PORT = 11435
const MAX_MODELS = 128
const MAX_RESPONSE_BYTES = 256 * 1024

export function localCorePort(value = process.env.SWITCHBOARD_LOCAL_CORE_PORT): number {
  if (value === undefined || value === '') return DEFAULT_PORT
  if (!/^\d{4,5}$/.test(value)) throw new Error('Invalid SWITCHBOARD_LOCAL_CORE_PORT (1024–65535).')
  const port = Number(value)
  if (port < 1024 || port > 65535) throw new Error('Invalid SWITCHBOARD_LOCAL_CORE_PORT (1024–65535).')
  return port
}

export function localCoreURL(port = localCorePort()): string {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port.')
  // Never accept a remote URL, a hostname, or URL supplied by a web request.
  return 'http://127.0.0.1:' + port
}

type LocalModel = { id: string; name?: string }
export type LocalCoreStatus = {
  running: boolean
  endpoint: string
  models: LocalModel[]
  authRequired: boolean
  reason?: string
}

async function safeJSON(response: Response): Promise<any> {
  const size = Number(response.headers.get('content-length') ?? 0)
  if (size > MAX_RESPONSE_BYTES) throw new Error('Local model catalog is too large.')
  if (!response.body) throw new Error('Empty model catalog.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    bytes += next.value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('Local model catalog is too large.')
    }
    chunks.push(next.value)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function discoverBotConnectorLocal(port = localCorePort()): Promise<LocalCoreStatus> {
  const endpoint = localCoreURL(port)
  const offline = (reason: string, authRequired = false): LocalCoreStatus => ({
    running: false, endpoint: endpoint + '/v1', models: [], authRequired, reason,
  })
  try {
    const health = await fetch(endpoint + '/health', {
      signal: AbortSignal.timeout(1600), redirect: 'error',
    })
    if (!health.ok) return offline('Local inference server is not healthy (HTTP ' + health.status + ').')
    const headers: Record<string, string> = { accept: 'application/json' }
    // Only this explicit local key can reach the local endpoint.
    if (process.env.BOTCONNECTOR_LOCAL_API_KEY) {
      headers.authorization = 'Bearer ' + process.env.BOTCONNECTOR_LOCAL_API_KEY
    }
    const response = await fetch(endpoint + '/v1/models', {
      headers, signal: AbortSignal.timeout(2000), redirect: 'error',
    })
    if (response.status === 401 || response.status === 403) {
      return offline('Local runtime requires BOTCONNECTOR_LOCAL_API_KEY.', true)
    }
    if (!response.ok) return offline('Local model catalog returned HTTP ' + response.status + '.')
    const payload = await safeJSON(response)
    const list = Array.isArray(payload?.data) ? payload.data : []
    const seen = new Set<string>()
    const models: LocalModel[] = []
    for (const item of list) {
      if (models.length >= MAX_MODELS) break
      const id = item && typeof item.id === 'string' ? item.id.trim() : ''
      if (!id || id.length > 160 || /[\u0000-\u001f]/.test(id) || /:cloud$/i.test(id) || seen.has(id)) continue
      seen.add(id)
      models.push({ id })
    }
    if (!models.length) return offline('No running local model reported. Open BotConnector Local and start a GGUF model.')
    return { running: true, endpoint: endpoint + '/v1', models, authRequired: false }
  } catch {
    // Never interpret a failed local discovery as permission to use Cloud.
    return offline('Local runtime unavailable. Start a model in BotConnector Local, then refresh.')
  }
}

export async function connectBotConnectorLocal(registry: ProviderRegistryService, model: string) {
  const status = await discoverBotConnectorLocal()
  if (!status.running) throw new SettingsError(status.reason || 'Local runtime unavailable.', { status: 409 })
  if (typeof model !== 'string' || !status.models.some(row => row.id === model)) {
    throw new SettingsError('Choose a model currently running in BotConnector Local.', { status: 400 })
  }
  const old = registry.get(BOTCONNECTOR_LOCAL_PROVIDER)
  if (old && (old.baseURL !== status.endpoint || old.protocol !== 'openai-chat')) {
    throw new SettingsError('Existing local provider has different settings; inspect it before reconnecting.', { status: 409 })
  }
  const models = status.models.map(row => ({ id: row.id }))
  if (!old) {
    await registry.create({
      id: BOTCONNECTOR_LOCAL_PROVIDER,
      displayName: 'AI Lokal (BotConnector)',
      baseURL: status.endpoint,
      protocol: 'openai-chat',
      apiKeyEnv: 'BOTCONNECTOR_LOCAL_API_KEY',
      models,
    })
  } else {
    await registry.setModels(BOTCONNECTOR_LOCAL_PROVIDER, models)
  }
  // Explicit button selection only: never silently replace the active model.
  await registry.setDefault({ provider: BOTCONNECTOR_LOCAL_PROVIDER, model })
  return { provider: BOTCONNECTOR_LOCAL_PROVIDER, model, endpoint: status.endpoint }
}
