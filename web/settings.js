/**
 * Settings panel helpers (spec §9) — pure functions only: no DOM, no network.
 * Loaded as a classic script by index.html (badge.js pattern) and evaluated
 * in Node by scripts/test-settings-ui.mjs via `new Function`.
 *
 * All copy is English; validation messages double as recovery guidance by
 * naming the expected shape (URL example, protocol list, env-name pattern).
 */

/** Wire protocols the console actually serves — the tested trio (spec §5). */
const PROTOCOL_OPTIONS = ['openai-chat', 'openai-responses', 'anthropic-messages']

/**
 * Client-side pre-validation mirroring the server rules (providers.ts).
 * Returns `[]` when the form is acceptable, otherwise one issue per bad
 * field: `{ field, message }` — all problems reported at once so the form
 * can highlight everything in a single pass.
 */
function validateProviderForm(form) {
  const issues = []
  const source = form || {}

  const name = typeof source.displayName === 'string' ? source.displayName.trim() : ''
  if (!name) {
    issues.push({ field: 'displayName', message: 'Display name is required.' })
  } else if (name.length > 80) {
    issues.push({ field: 'displayName', message: 'Display name must be 80 characters or fewer.' })
  }

  const rawUrl = typeof source.baseURL === 'string' ? source.baseURL.trim() : ''
  let urlOk = false
  try {
    const parsed = new URL(rawUrl)
    urlOk = parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    urlOk = false
  }
  if (!urlOk) {
    issues.push({ field: 'baseURL', message: 'Enter a full http(s) URL, e.g. https://api.example.com/v1.' })
  }

  if (!PROTOCOL_OPTIONS.includes(source.protocol)) {
    issues.push({ field: 'protocol', message: `Choose one of: ${PROTOCOL_OPTIONS.join(', ')}.` })
  }

  const id = typeof source.id === 'string' ? source.id.trim() : ''
  if (id && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
    issues.push({
      field: 'id',
      message: 'Use 1-40 lowercase letters, digits or hyphens, starting with a letter or digit.',
    })
  }

  const env = typeof source.apiKeyEnv === 'string' ? source.apiKeyEnv.trim() : ''
  if (env && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) {
    issues.push({ field: 'apiKeyEnv', message: 'Use a name like OPENAI_API_KEY — only the variable name is stored.' })
  }

  return issues
}

/**
 * Buckets model rows by `provider` for `<optgroup>` rendering, keeping
 * first-seen provider order and row order inside each group. Rows without
 * provider identity (legacy state payloads) land in the `default` group.
 */
function groupModelsByProvider(models) {
  const order = []
  const byProvider = new Map()
  for (const model of Array.isArray(models) ? models : []) {
    const provider = typeof model.provider === 'string' && model.provider ? model.provider : 'default'
    if (!byProvider.has(provider)) {
      const label = typeof model.providerName === 'string' && model.providerName ? model.providerName : provider
      byProvider.set(provider, { provider, providerName: label, models: [] })
      order.push(provider)
    }
    byProvider.get(provider).models.push(model)
  }
  return order.map((key) => byProvider.get(key))
}

/**
 * Human label for a `credentials.describe()` payload. Fixed vocabulary —
 * never renders a stored value, so nothing secret-shaped can leak.
 */
function credentialSourceLabel(credential) {
  if (!credential || credential.configured !== true) return 'not configured'
  if (credential.source === 'env') return `configured via env${credential.envName ? ` (${credential.envName})` : ''}`
  if (credential.source === 'local') return 'configured via local store'
  if (credential.source === 'config') return 'configured via config file'
  return 'configured'
}

/**
 * Copy for the delete-in-use confirmation (spec §6/§9): names the provider,
 * counts and lists the affected sessions, and states the fallback. With no
 * sessions the body simply confirms nothing depends on the provider.
 */
function deleteRecoveryCopy(provider, sessions, fallback) {
  const name = provider && provider.displayName ? provider.displayName : 'this provider'
  const list = Array.isArray(sessions) ? sessions : []
  const fallbackProvider = fallback && fallback.provider ? fallback.provider : 'default'
  const fallbackModel = fallback && fallback.model ? ` · ${fallback.model}` : ''

  let body
  if (list.length) {
    const titles = list
      .slice(0, 5)
      .map((session) => (session && session.title ? session.title : session && session.id ? session.id : '?'))
      .join(', ')
    const more = list.length > 5 ? ` and ${list.length - 5} more` : ''
    body = `It is used by ${list.length} session${list.length === 1 ? '' : 's'} (${titles}${more}). Deleting detaches them — they fall back to ${fallbackProvider}${fallbackModel}.`
  } else {
    body = `Nothing depends on it. Deleting is safe — the default stays ${fallbackProvider}${fallbackModel}.`
  }

  return {
    title: `Delete "${name}"?`,
    body,
    confirm: 'Delete and detach',
  }
}

/**
 * Splits a discovery response into candidates the user has not saved yet:
 * `status: 'dup'` when the id already exists in the catalog, `'new'` otherwise.
 * The user picks which candidates to merge; nothing is written automatically.
 */
function diffDiscovery(existingIds, candidates) {
  const have = new Set(Array.isArray(existingIds) ? existingIds : [])
  return (Array.isArray(candidates) ? candidates : []).map((candidate) => ({
    ...candidate,
    status: have.has(candidate.id) ? 'dup' : 'new',
  }))
}

/** Picker option value: `providerId::modelId`; bare for the default provider. */
function encodeModelOption(provider, model) {
  const id = typeof model === 'string' ? model : ''
  return provider ? `${provider}::${id}` : id
}

/** Inverse of encodeModelOption — bare ids map to the default provider (spec §8). */
function parseModelOption(value) {
  const raw = typeof value === 'string' ? value : ''
  const at = raw.indexOf('::')
  if (at < 0) return { provider: 'default', model: raw }
  return { provider: raw.slice(0, at) || 'default', model: raw.slice(at + 2) }
}
