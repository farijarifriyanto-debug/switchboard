'use strict';

const fs = require('fs');
const path = require('path');

function discover({ projectRoot = process.cwd() } = {}) {
  const rows = [
    { id: 'plan', name: 'Plan', description: 'Read-only planning and inspection', mode: 'Plan', source: 'BUILTIN' },
    { id: 'act', name: 'Act', description: 'Approved workspace actions', mode: 'Act', source: 'BUILTIN' },
  ];
  for (const rel of ['.agents/agents', '.claude/agents', '.opencode/agents']) {
    let entries; try { entries = fs.readdirSync(path.join(projectRoot, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      const text = fs.readFileSync(path.join(projectRoot, rel, e.name), 'utf8');
      const heading = text.match(/^#{1,2}\s+(.+)$/m);
      const id = path.basename(e.name, '.md').toLowerCase();
      rows.push({ id, name: heading?.[1] || id, description: text.split(/\r?\n/).find((x) => x.trim() && !x.trim().startsWith('#'))?.trim() || 'Project agent', mode: 'custom', source: rel, path: path.join(projectRoot, rel, e.name) });
    }
  }
  const seen = new Set();
  return rows.filter((r) => !seen.has(r.id) && seen.add(r.id));
}

module.exports = { discover };
