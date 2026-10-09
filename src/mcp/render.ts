export interface McpRenderableResult {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
}

export function blockText(block: unknown): string {
  const b = block as Record<string, unknown>
  const type = typeof b?.type === 'string' ? b.type : 'unknown'
  if (type === 'text' && typeof b.text === 'string') return b.text
  if (type === 'resource_link') {
    const name = typeof b.name === 'string' ? b.name : ''
    const uri = typeof b.uri === 'string' ? b.uri : ''
    return name && uri ? `${name} (${uri})` : uri || name
  }
  if (type === 'resource') {
    const r = b.resource as Record<string, unknown> | undefined
    if (typeof r?.text === 'string') return `${typeof r.uri === 'string' ? `${r.uri}\n` : ''}${r.text}`
    return `[resource: ${typeof r?.mimeType === 'string' ? r.mimeType : 'unknown'}, binary omitted]`
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
 * Text takes precedence; structured-only results become bounded JSON. Debug
 * logs report the presence of structured data without printing its values.
 */
export function renderMcpResult(result: McpRenderableResult, log?: (msg: string) => void): string {
  if (result.structuredContent !== undefined && log) {
    log('mcp structuredContent received')
  }
  const content = Array.isArray(result.content) ? result.content : []
  const parts = content.map(blockText).filter((part) => part.length > 0)
  let text = parts.join('\n')
  if (!text && result.structuredContent !== undefined) {
    try { text = JSON.stringify(result.structuredContent) } catch { text = '[structured result could not be serialized]' }
  }
  return text.length > 32_000 ? `${text.slice(0, 32_000)}\n…[MCP result truncated]` : text || '(empty result)'
}
