'use strict';

const fs = require('fs');
const path = require('path');
const skills = require('./skills.cjs');

const BUILTINS = [
  ['new', 'New session', 'Start a fresh session', 'Workspace', 'new'],
  ['init', 'Initialize instructions', 'Create or inspect project AGENTS.md', 'Workspace', 'init'],
  ['sessions', 'Sessions', 'Resume or delete sessions', 'Workspace', 'sessions'],
  ['timeline', 'Timeline', 'Browse the complete persisted session history', 'Workspace', 'timeline'],
  ['fork', 'Fork session', 'Create a child session from this transcript', 'Workspace', 'fork'],
  ['rename', 'Rename session', 'Rename the current session', 'Workspace', 'rename'],
  ['copy', 'Copy transcript', 'Copy a safe Markdown transcript to the clipboard', 'Workspace', 'copy'],
  ['export', 'Export session', 'Export this session as Markdown or safe JSON', 'Workspace', 'export'],
  ['project', 'Open project', 'Switch workspace/project', 'Workspace', 'project'],
  ['launch', 'Launch integration', 'Launch a registered coding agent, assistant, editor, or BotConnector terminal', 'Workspace', 'launch'],
  ['agents', 'Agents', 'Choose an available agent or mode', 'Agent', 'agents'],
  ['skills', 'Skills', 'Discover project and global agent skills', 'Agent', 'skills'],
  ['permissions', 'Permissions', 'Approval and execution policy', 'System', 'permissions'],
  ['plan', 'Plan mode', 'Read-only planning mode', 'Agent', 'plan'],
  ['act', 'Act mode', 'Enable approved workspace actions', 'Agent', 'act'],
  ['diff', 'Changes and diff', 'Inspect actual Git changes', 'Code', 'diff'],
  ['review', 'Review changes', 'Ask the active model for a read-only code review', 'Code', 'review'],
  ['undo', 'Undo last change', 'Revert a tracked BotConnector mutation', 'Code', 'undo'],
  ['redo', 'Redo change', 'Reapply a reverted BotConnector mutation', 'Code', 'redo'],
  ['editor', 'Open editor', 'Open the current project in EDITOR', 'Tools', 'editor'],
  ['tools', 'Tools', 'Show tools registered for this agent', 'Tools', 'tools'],
  ['shell', 'Shell command', 'Run an explicitly approved shell command', 'Tools', 'shell'],
  ['model', 'Change model', 'Choose a chat-capable model', 'AI', 'model'],
  ['mcp', 'MCP servers', 'Inspect configured MCP servers and capabilities', 'Tools', 'mcp'],
  ['context', 'Context usage', 'Show current context usage', 'AI', 'context'],
  ['compact', 'Compact context', 'Compact the active session context', 'AI', 'compact'],
  ['thinking', 'Thinking display', 'Toggle display of available reasoning blocks', 'AI', 'thinking'],
  ['status', 'Status', 'Show runtime and session status', 'System', 'status'],
  ['doctor', 'Doctor', 'Diagnose runtime and model setup', 'System', 'doctor'],
  ['settings', 'Settings', 'Open BotConnector settings', 'System', 'settings'],
  ['theme', 'Theme', 'Choose an installed terminal theme', 'System', 'theme'],
  ['commands', 'Commands', 'Browse the complete command registry', 'System', 'commands'],
  ['connect', 'Connect provider', 'Configure a provider through its real registry', 'System', 'connect'],
  ['help', 'Help', 'Show command and keyboard help', 'System', 'help'],
  ['exit', 'Exit', 'Quit BotConnector', 'System', 'exit'],
  ['clear', 'Clear conversation', 'Clear the current transcript', 'Workspace', 'clear'],
  ['details', 'Runtime details', 'Show exact runtime diagnostics', 'System', 'details'],
  ['debug', 'Debug mode', 'Toggle diagnostic activity', 'System', 'debug'],
];

const ALIASES = { models: 'model', mcps: 'mcp', agent: 'agents', skill: 'skills', session: 'sessions', summarize: 'compact', themes: 'theme', quit: 'exit', q: 'exit' };

function parseCommandFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const heading = text.match(/^#{1,2}\s+(.+?)\s*$/m);
  const body = text.replace(/^---[\s\S]*?---\s*/, '').trim();
  const first = body.split(/\r?\n/).map((x) => x.trim()).find(Boolean);
  const id = path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return { id, slash: '/' + id, title: heading?.[1] || id, description: first || 'Project command', body, path: file, source: 'PROJECT_COMMAND' };
}

function discoverProjectCommands(projectRoot) {
  const dirs = [
    ['.botconnector/commands', 'project'],
    ['.claude/commands', 'project'],
    ['.agents/commands', 'project'],
    ['.opencode/commands', 'project'],
  ];
  const out = [];
  for (const [rel] of dirs) {
    let entries;
    try { entries = fs.readdirSync(path.join(projectRoot, rel), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      const item = parseCommandFile(path.join(projectRoot, rel, entry.name));
      if (item) out.push(item);
    }
  }
  const seen = new Set();
  return out.filter((item) => !seen.has(item.id) && seen.add(item.id));
}

function availability(id, ctx) {
  const journalStatus = typeof ctx.journalStatus === 'function' ? ctx.journalStatus() : ctx.journalStatus;
  if (id === 'diff' && ctx.workspace && ctx.gitAvailable === false) return { enabled: false, disabledReason: 'Not a Git repository' };
  if (id === 'editor' && !process.env.EDITOR && !process.env.VISUAL) return { enabled: false, disabledReason: 'EDITOR/VISUAL is not configured' };
  if (id === 'undo' && journalStatus && !journalStatus.canUndo) return { enabled: false, disabledReason: 'No reversible BotConnector mutation is available' };
  if (id === 'redo' && journalStatus && !journalStatus.canRedo) return { enabled: false, disabledReason: 'Nothing to redo' };
  if (id === 'theme') return { enabled: false, disabledReason: 'Only the default theme is currently installed' };
  return { enabled: true, disabledReason: '' };
}

function createCommandRegistry(ctx = {}) {
  const projectRoot = ctx.workspace || process.cwd();
  let current = [];
  let skillList = [];

  function refresh() {
    skillList = skills.discover({ projectRoot, homeDir: ctx.homeDir });
    const builtins = BUILTINS.map(([id, title, description, category, handler]) => ({
      id, slash: '/' + id, title, description, category, aliases: Object.entries(ALIASES).filter(([, target]) => target === id).map(([alias]) => '/' + alias), keybind: '', available: true, disabledReason: '', handler, source: 'BUILTIN',
    }));
    const skillCommands = skillList.filter((s) => s.enabled && s.slashVisible).map((s) => ({
      id: s.id, slash: '/' + s.id, title: s.name, description: s.description, category: 'Agent', aliases: [], keybind: '', available: true, disabledReason: '', handler: 'skill', source: 'SKILL', skill: s,
    }));
    const custom = discoverProjectCommands(projectRoot).map((c) => ({ ...c, category: 'Workspace', aliases: [], keybind: '', available: true, disabledReason: '', handler: 'project-command' }));
    const mcpPrompts = (typeof ctx.mcpPrompts === 'function' ? ctx.mcpPrompts() : []).map((p) => ({
      id: `mcp-${String(p.server || 'server')}-${String(p.name || 'prompt')}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
      slash: '/' + String(p.name || 'prompt').toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
      title: p.title || p.name || 'MCP prompt', description: p.description || 'MCP prompt', category: 'Tools', aliases: [], keybind: '', available: true, disabledReason: '', handler: 'mcp-prompt', source: 'MCP_PROMPT', prompt: p,
    }));
    const seen = new Set();
    // Keep the root menu useful by presenting core commands first. A project
    // definition still wins a slash collision through the final map write.
    const ordered = [...builtins, ...skillCommands, ...mcpPrompts, ...custom];
    const bySlash = new Map(); for (const item of ordered) bySlash.set(item.slash.toLowerCase(), item);
    current = ordered.filter((item) => bySlash.get(item.slash.toLowerCase()) === item).filter((item) => {
      const key = item.slash.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true;
    });
    return current;
  }

  function evaluated() {
    return current.map((command) => {
      const result = typeof ctx.availability === 'function' ? ctx.availability(command, ctx) : availability(command.id, ctx);
      return { ...command, ...(result || {}) };
    });
  }

  function resolve(name) {
    const needle = String(name || '').toLowerCase();
    return evaluated().find((c) => c.slash === needle || (c.aliases || []).includes(needle)) || null;
  }

  function filter(query = '', { includeDisabled = true } = {}) {
    const q = String(query || '').replace(/^\//, '').toLowerCase();
    const rows = evaluated().filter((c) => includeDisabled || c.available !== false);
    const ranked = rows.map((command, order) => {
      const fields = [command.slash, ...(command.aliases || []), command.title, command.description, command.category].map((v) => String(v).toLowerCase());
      let score = q ? 99 : 0;
      if (q) {
        if (fields[0].slice(1).startsWith(q)) score = 0;
        else if (fields.some((v) => v.startsWith(q))) score = 1;
        else if (fields.some((v) => v.includes(q))) score = 2;
        else return null;
      }
      return { command, score, order };
    }).filter(Boolean).sort((a, b) => a.score - b.score || a.order - b.order);
    const direct = ranked.filter((x) => x.score < 2);
    return (direct.length ? direct : ranked).map((x) => x.command);
  }

  refresh();
  return { refresh, all: evaluated, filter, resolve, skills: () => skillList.slice(), projectCommands: () => discoverProjectCommands(projectRoot) };
}

module.exports = { createCommandRegistry, BUILTINS, ALIASES, discoverProjectCommands, availability };
