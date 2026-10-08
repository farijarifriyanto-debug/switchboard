export interface McpRenderableResult {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
}

function blockText(block: unknown): string {
  const b = block as Record<string, unknown>
  const type = typeof b?.type === 'string' ? b.type : 'unknown'
  if (type === 'text' && typeof b.text === 'string') return b.text
  if (type === 'resource_link') {
    const name = typeof b.name === 'string' ? b.name : ''
    const uri = typeof b.uri === 'string' ? b.uri : ''
    return name && uri ? `${name} (${uri})` : uri || name
  }
  const mime = typeof b.mimeType === 'string' ? b.mimeType : 'unknown'
  if (typeof b.data === 'string') {
    const kb = Math.ceil((b.data.length * 3) / 4 / 1024)
    return `[${type}: ${mime}, ${kb} KB omitted — attachment bridge deferred]`
  }
  return `[${type} omitted — attachment bridge deferred]`
}

/**
 * Projects an MCP tool result to the plain string `ToolSpec.execute` returns.
 * Text and resource links pass through; every richer block degrades to a
 * bounded diagnostic (attachment bridge is a later roadmap item, spec §11).
 * `structuredContent` is logged when a logger is given, never returned.
 */
export function renderMcpResult(result: McpRenderableResult, log?: (msg: string) => void): string {
  if (result.structuredContent !== undefined && log) {
    let serialized: string
    try {
      serialized = JSON.stringify(result.structuredContent)
    } catch {
      serialized = String(result.structuredContent)
    }
    log(`mcp structuredContent: ${serialized.slice(0, 2000)}`)
  }
  const content = Array.isArray(result.content) ? result.content : []
  const parts = content.map(blockText).filter((part) => part.length > 0)
  return parts.length ? parts.join('\n') : '(empty result)'
}
