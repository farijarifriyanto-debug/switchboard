'use strict';

const agentTools = require('../agent/tools.cjs');

function discover({ mcp = [] } = {}) {
  const rows = [
    { id: 'read_file', name: 'read', description: 'Read workspace files', source: 'BUILTIN' },
    { id: 'list_directory', name: 'list', description: 'List workspace directories', source: 'BUILTIN' },
    { id: 'search_files', name: 'search', description: 'Search workspace text', source: 'BUILTIN' },
    { id: 'edit_file', name: 'write/edit', description: 'Propose approved file edits', source: 'BUILTIN' },
    { id: 'run_command', name: 'shell', description: 'Run explicitly approved commands', source: 'BUILTIN' },
    ...((agentTools && agentTools.createWorkspace) ? [] : []),
  ];
  for (const server of mcp || []) for (const name of server.tools || []) rows.push({ id: `${server.id}:${name}`, name, description: `MCP tool from ${server.name}`, source: 'MCP' });
  return rows;
}

module.exports = { discover };
