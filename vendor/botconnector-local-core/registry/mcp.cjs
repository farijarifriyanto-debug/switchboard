'use strict';

// TUI-facing MCP registry. Configuration is read from the canonical Store;
// no server names or transports are invented here. Runtime probing remains
// the responsibility of runtime/mcp.cjs and the Desktop manager.
function listConfigured(store) {
  const rows = store && store.get('mcpServers');
  return Array.isArray(rows) ? rows.map((server) => ({
    ...server,
    status: server.enabled === false ? 'Disabled' : 'Configured',
    toolsCount: Array.isArray(server.tools) ? server.tools.length : (server.allowedTools || []).length,
    resourcesCount: Number(server.resourcesCount || 0),
    promptsCount: Number(server.promptsCount || 0),
  })) : [];
}

function zeroState() {
  return { empty: true, label: 'No MCP servers configured.', action: 'Add MCP server in Desktop Settings → MCP' };
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') return { ok: false, error: 'MCP configuration must be an object' };
  const transport = String(config.transport || 'stdio').toLowerCase();
  if (!['stdio', 'sse', 'streamable-http', 'http'].includes(transport)) return { ok: false, error: `Unsupported MCP transport: ${transport}` };
  if (transport === 'stdio' && !String(config.command || '').trim()) return { ok: false, error: 'stdio MCP servers require a command' };
  if (transport !== 'stdio' && !/^https?:\/\//i.test(String(config.url || ''))) return { ok: false, error: 'HTTP MCP servers require an http(s) URL' };
  return { ok: true, config: { ...config, transport } };
}

module.exports = { listConfigured, zeroState, validateConfig };
