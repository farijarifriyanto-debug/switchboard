'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 }); }
  catch (e) { return e.stdout ? String(e.stdout) : ''; }
}

function isGitRepository(cwd) {
  try { return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true'; }
  catch { return false; }
}

function lineCount(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((x, i, a) => i < a.length - 1 || x).length; } catch { return 0; }
}

function numstat(cwd, args) {
  const rows = new Map();
  for (const line of git(cwd, ['diff', ...args, '--numstat', '--']).split(/\r?\n/)) {
    const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (m) rows.set(m[3], { added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) });
  }
  return rows;
}

function collect(cwd, view = 'all') {
  if (!isGitRepository(cwd)) return { ok: false, error: 'Not a Git repository', files: [] };
  const status = git(cwd, ['status', '--short']);
  const staged = numstat(cwd, ['--cached']);
  const unstaged = numstat(cwd, []);
  const files = [];
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    const code = line.slice(0, 2);
    const rel = line.slice(3).trim().replace(/^"|"$/g, '');
    const full = path.join(cwd, rel);
    if (view === 'staged' && !code[0]?.trim()) continue;
    if (view === 'unstaged' && !code[1]?.trim() && code !== '??') continue;
    const stat = view === 'staged' ? staged.get(rel) : view === 'unstaged' ? unstaged.get(rel) : {
      added: (staged.get(rel)?.added || 0) + (unstaged.get(rel)?.added || 0),
      removed: (staged.get(rel)?.removed || 0) + (unstaged.get(rel)?.removed || 0),
    };
    const actual = stat && (stat.added || stat.removed) ? stat : { added: code === '??' ? lineCount(full) : 0, removed: 0 };
    let patch = '';
    if (code === '??') {
      let content = ''; try { content = fs.readFileSync(full, 'utf8'); } catch {}
      patch = [`--- /dev/null`, `+++ b/${rel}`, ...content.split(/\r?\n/).filter((x, i, a) => i < a.length - 1 || x).map((x) => '+ ' + x)].join('\n');
    } else {
      const args = view === 'staged' ? ['--cached'] : view === 'all' ? ['HEAD'] : [];
      patch = git(cwd, ['diff', ...args, '--', rel]);
    }
    files.push({ path: rel, code, added: actual.added, removed: actual.removed, patch });
  }
  return { ok: true, view, files };
}

module.exports = { isGitRepository, collect };
