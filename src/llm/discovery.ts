/**
 * Model discovery for settings providers (spec §5).
 *
 * `listModels(profile)` asks the endpoint what it serves so the console can
 * import a catalog in one click. Uses the same auth scheme as chat requests;
 * failures carry the same provider id + recovery hint as `adapterError`.
 */
import { adapterError, authHeaders, type ProviderProfile } from './adapters.js'

export interface DiscoveredModel {
  id: string
  displayName?: string
}

function stripTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '')
}

function modelsUrl(profile: ProviderProfile): string {
  const base = stripTrailingSlash(profile.baseURL)
  if (profile.protocol === 'anthropic-messages') return `${base.replace(/\/v1$/, '')}/v1/models`
  return `${base}/models`
}

/** Lists models advertised by the provider endpoint. */
export async function listModels(profile: ProviderProfile, signal?: AbortSignal): Promise<DiscoveredModel[]> {
  const res = await fetch(modelsUrl(profile), {
    method: 'GET',
    headers: { accept: 'application/json', ...authHeaders(profile) },
    ...(signal ? { signal } : {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw adapterError(profile.id, res.status, text)
  }
  const json = (await res.json().catch(() => ({}))) as { data?: unknown }
  const rows = Array.isArray(json.data) ? json.data : []
  const out: DiscoveredModel[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id) continue
    const name = typeof record.name === 'string' ? record.name : typeof record.display_name === 'string' ? record.display_name : undefined
    out.push({ id: record.id, ...(name ? { displayName: name } : {}) })
  }
  return out
}
