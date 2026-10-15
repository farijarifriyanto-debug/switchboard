'use strict';

// Agent-Skills compatible discovery. Bodies stay on disk and are only read
// when a caller explicitly selects a skill; menus contain metadata only.
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOTS = [
  ['.agents/skills', 'project'],
  ['.claude/skills', 'project'],
  ['.opencode/skills', 'project'],
];
const GLOBAL_ROOTS = [
  ['.agents/skills', 'global'],
  ['.claude/skills', 'global'],
  ['.opencode/skills', 'global'],
];

function slug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function frontMatter(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return out;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function metadata(file, scope, root) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').slice(0, 32768); } catch { return null; }
  const fm = frontMatter(text);
  const heading = text.match(/^#{1,2}\s+(.+?)\s*$/m);
  const first = text.split(/\r?\n/).map((x) => x.trim()).find((x) => x && !x.startsWith('#') && x !== '---');
  const id = slug(fm.id || path.basename(path.dirname(file)));
  if (!id) return null;
  return {
    id,
    name: String(fm.name || heading?.[1] || id),
    description: String(fm.description || first || 'Agent skill'),
    path: file,
    source: root,
    scope,
    enabled: !/^(false|no|off)$/i.test(String(fm.enabled || 'true')),
    slashVisible: !/^(false|no|off)$/i.test(String(fm.slashVisible || fm['slash-visible'] || 'true')),
    metadata: fm,
  };
}

function walk(root, scope, source, out) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const skillFile = path.join(full, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const item = metadata(skillFile, scope, source);
        if (item) out.push(item);
      }
    }
  }
}

function discover({ projectRoot = process.cwd(), homeDir = os.homedir() } = {}) {
  const found = [];
  for (const [rel, scope] of ROOTS) walk(path.join(projectRoot, rel), scope, rel, found);
  for (const [rel, scope] of GLOBAL_ROOTS) walk(path.join(homeDir, rel), scope, rel, found);
  // Project scope wins over global scope. The first project ecosystem root
  // also wins when the same skill is mirrored in multiple conventions.
  const byId = new Map();
  for (const item of found) {
    const previous = byId.get(item.id);
    if (!previous || (previous.scope !== 'project' && item.scope === 'project')) byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readBody(skill) {
  if (!skill?.path) return null;
  try { return fs.readFileSync(skill.path, 'utf8'); } catch { return null; }
}

module.exports = { discover, readBody, slug, frontMatter };
