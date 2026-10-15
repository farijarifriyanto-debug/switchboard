// Phase-1B real read-only workspace tools. All paths are jailed inside one
// workspace root. Every method returns structured {ok,...} data — never throws,
// never mutates, never shells out. No edit/write/shell/MCP here by design.
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_READ_BYTES = 64 * 1024;   // per read_file call
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_MATCHES = 50;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'cache', '.next', 'coverage',
  '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode',
]);

function createWorkspace(root) {
  const wsRoot = path.resolve(root);
  let realRoot = wsRoot;
  try { realRoot = fs.realpathSync(wsRoot); } catch {}

  // Resolve user/model-supplied path inside the workspace. Blocks .., absolute
  // / drive / UNC escapes, symlink/junction escapes, NUL + malformed input.
  // Returns {ok:true, full, rel} or {ok:false, error}.
  function resolveInside(input) {
    if (typeof input !== 'string' || input.length === 0 || input.length > 1024)
      return { ok: false, error: 'invalid path: empty or overlong' };
    if (input.includes('\0')) return { ok: false, error: 'invalid path: NUL byte rejected' };
    const s = input.trim().replace(/\//g, path.sep);
    if (/^(\\\\|\/\/|[A-Za-z]:)/.test(input.trim()) || path.isAbsolute(s)) {
      // Absolute/UNC/drive paths only allowed if they land inside the workspace.
      const full = path.normalize(s);
      if (!contained(full)) return { ok: false, error: `outside workspace: absolute path escapes ${wsRoot}` };
      return finalize(full);
    }
    const full = path.normalize(path.join(wsRoot, s));
    if (!contained(full)) return { ok: false, error: `outside workspace: path escapes ${wsRoot}` };
    return finalize(full);
  }

  function contained(full) {
    const rel = path.relative(wsRoot, full);
    if (rel === '') return true;
    if (rel === '..' || rel.startsWith('..' + path.sep)) return false;
    if (path.isAbsolute(rel)) return false; // different drive (Windows)
    return true;
  }

  function finalize(full) {
    // Symlink/junction escape: real path must stay inside the real root.
    // For nonexistent paths, resolve the nearest existing ancestor.
    let real = full, suffix = '';
    let cur = full;
    for (let i = 0; i < 64; i++) {
      try { real = fs.realpathSync(cur) + suffix; break; }
      catch {
        const parent = path.dirname(cur);
        if (parent === cur) return { ok: false, error: 'outside workspace (unresolvable path)' };
        suffix = cur.slice(parent.length) + suffix;
        cur = parent;
      }
    }
    const rr = realRoot.toLowerCase(), rp = real.toLowerCase();
    if (rp !== rr && !rp.startsWith(rr + path.sep.toLowerCase()))
      return { ok: false, error: 'outside workspace: link escapes workspace root' };
    return { ok: true, full, rel: path.relative(wsRoot, full) || '.' };
  }

  function listDirectory(rel = '.') {
    const r = resolveInside(rel);
    if (!r.ok) return r;
    let entries;
    try {
      const st = fs.statSync(r.full);
      if (!st.isDirectory()) return { ok: false, error: `not a directory: ${r.rel}` };
      entries = fs.readdirSync(r.full, { withFileTypes: true });
    } catch (e) { return { ok: false, error: `cannot list ${r.rel}: ${e.message}` }; }
    const out = entries
      .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file' }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      .slice(0, MAX_LIST_ENTRIES);
    return { ok: true, op: 'list_directory', path: r.rel, entries: out, truncated: entries.length > out.length };
  }

  function readFile(rel, { offset = 1, limit = 200 } = {}) {
    const r = resolveInside(rel);
    if (!r.ok) return r;
    let st;
    try { st = fs.statSync(r.full); }
    catch { return { ok: false, error: `file not found: ${r.rel}` }; }
    if (st.isDirectory()) return { ok: false, error: `is a directory, not a file: ${r.rel}` };
    let buf;
    try {
      const fd = fs.openSync(r.full, 'r');
      try {
        const n = Math.min(st.size, MAX_READ_BYTES);
        buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, 0);
      } finally { fs.closeSync(fd); }
    } catch (e) { return { ok: false, error: `cannot read ${r.rel}: ${e.message}` }; }
    if (buf.includes(0))
      return { ok: true, op: 'read_file', path: r.rel, binary: true, bytes: st.size, error: `binary file not shown: ${r.rel} (${st.size} bytes)` };
    const text = buf.toString('utf8');
    const allLines = text.split('\n');
    // If file exceeds cap, line count is a lower bound — say so honestly.
    const complete = st.size <= MAX_READ_BYTES;
    const start = Math.max(1, offset);
    const slice = allLines.slice(start - 1, start - 1 + limit);
    return {
      ok: true, op: 'read_file', path: r.rel,
      lines: slice.map((t, i) => ({ n: start + i, text: t })),
      range: { from: start, to: start + slice.length - 1 },
      truncated: !complete || (start - 1 + limit) < allLines.length,
      bytesTotal: st.size, bytesShown: buf.length, fileComplete: complete,
    };
  }

  function searchFiles(query, { signal = null } = {}) {
    if (typeof query !== 'string' || query.length === 0 || query.length > 256)
      return { ok: false, error: 'invalid query: empty or overlong' };
    const matches = [];
    let filesScanned = 0, cancelled = false;
    const walk = (dir) => {
      if (matches.length >= MAX_SEARCH_MATCHES || cancelled) return;
      if (signal && signal.aborted) { cancelled = true; return; }
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (matches.length >= MAX_SEARCH_MATCHES || cancelled) break;
        if (signal && signal.aborted) { cancelled = true; break; }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          const r = resolveInside(path.relative(wsRoot, full));
          if (!r.ok) continue; // do not follow escaping links
          walk(full);
        } else if (e.isFile()) {
          let st;
          try { st = fs.statSync(full); } catch { continue; }
          if (st.size === 0 || st.size > MAX_SEARCH_FILE_BYTES) continue;
          if (/\.(png|jpe?g|gif|ico|exe|dll|zip|gz|pdf|bin|dat|node|pdb)$/i.test(e.name)) continue;
          let head;
          try {
            const fd = fs.openSync(full, 'r');
            try { head = Buffer.alloc(Math.min(st.size, 8192)); fs.readSync(fd, head, 0, head.length, 0); }
            finally { fs.closeSync(fd); }
          } catch { continue; }
          if (head.includes(0)) continue; // binary
          filesScanned++;
          let lines;
          try { lines = fs.readFileSync(full, 'utf8').split('\n'); }
          catch { continue; }
          lines.forEach((line, i) => {
            if (matches.length >= MAX_SEARCH_MATCHES) return;
            if (line.includes(query))
              matches.push({ path: path.relative(wsRoot, full), line: i + 1, snippet: line.trim().slice(0, 200) });
          });
        }
      }
    };
    walk(realRoot);
    if (cancelled) return { ok: false, error: 'search cancelled', cancelled: true };
    return { ok: true, op: 'search_files', query, matches, filesScanned, truncated: matches.length >= MAX_SEARCH_MATCHES };
  }

  return { root: wsRoot, resolveInside, listDirectory, readFile, searchFiles };
}

module.exports = { createWorkspace, MAX_READ_BYTES, MAX_LIST_ENTRIES, MAX_SEARCH_MATCHES };
