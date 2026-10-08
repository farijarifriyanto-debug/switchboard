import { createHash } from 'node:crypto'

export const MCP_NAME_PREFIX = 'mcp__'
export const MCP_MAX_NAME = 64
export const MCP_HASH_LEN = 12

const ILLEGAL = /[^A-Za-z0-9_-]/g
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

function hash12(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, MCP_HASH_LEN)
}

/**
 * Public tool name for one MCP tool: a pure function of (serverName, rawName).
 * Normalization to `[A-Za-z0-9_-]`/64 chars; whenever normalization or
 * truncation changes the name, `-` + a 12-hex SHA-256 of `(serverName,
 * rawName)` keeps distinct identities from collapsing (spec §4).
 */
export function mcpToolName(serverName: string, rawName: string): string {
  if (typeof serverName !== 'string' || !SERVER_NAME_RE.test(serverName)) {
    throw new Error(`mcp: invalid server name "${serverName}" (expected [A-Za-z0-9_-]{1,32})`)
  }
  if (typeof rawName !== 'string' || !rawName) throw new Error('mcp: invalid tool name')
  const normalized = rawName.replace(ILLEGAL, '_') || 'tool'
  const base = `${MCP_NAME_PREFIX}${serverName}__${normalized}`
  if (normalized === rawName && base.length <= MCP_MAX_NAME) return base
  const suffix = `-${hash12(`${serverName}\u0000${rawName}`)}`
  return `${base.slice(0, MCP_MAX_NAME - suffix.length)}${suffix}`
}

export type McpGenerationPlan = { names: string[] } | { invalid: string }

/**
 * Plans the registered names for one tools/list response. A list with a
 * duplicate or unusable raw name is rejected as a whole (spec §4) — the
 * caller keeps the previous generation.
 */
export function planMcpGeneration(serverName: string, rawNames: string[]): McpGenerationPlan {
  const names: string[] = []
  const seenRaw = new Set<string>()
  const seenName = new Set<string>()
  for (const raw of rawNames) {
    if (typeof raw !== 'string' || !raw) return { invalid: 'tool name is empty' }
    if (seenRaw.has(raw)) return { invalid: `duplicate tool "${raw}"` }
    seenRaw.add(raw)
    let name: string
    try {
      name = mcpToolName(serverName, raw)
    } catch (error) {
      return { invalid: error instanceof Error ? error.message : String(error) }
    }
    if (seenName.has(name)) return { invalid: `tool name collision for "${raw}"` }
    seenName.add(name)
    names.push(name)
  }
  return { names }
}
