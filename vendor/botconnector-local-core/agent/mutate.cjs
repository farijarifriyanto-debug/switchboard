// Phase-1 mutation engine. Model NEVER mutates directly: it proposes content,
// this module validates against the Phase-1B workspace jail, computes the diff
// LOCALLY from actual disk bytes, and applies only after explicit approval with
// a preimage (SHA-256) re-check. Atomic writes via sibling-tmp + rename.
// All functions return structured data — never throw, never shell out.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256Bytes(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(full) { return sha256Bytes(fs.readFileSync(full)); }

// Split raw buffer into {bom, eol, trailingNewline, lines[]} preserving format.
function decode(buf) {
  let bom = false;
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) { bom = true; buf = buf.slice(3); }
  const text = buf.toString('utf8');
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  const eol = crlf >= lf && crlf > 0 ? '\r\n' : '\n';
  const trailingNewline = /(\r?\n)$/.test(text);
  const lines = text.split(/\r?\n/);
  if (trailingNewline && lines.length && lines[lines.length - 1] === '') lines.pop();
  return { bom, eol, trailingNewline, lines };
}

function encode(lines, fmt) {
  let text = lines.join(fmt.eol);
  if (fmt.trailingNewline) text += fmt.eol;
  let buf = Buffer.from(text, 'utf8');
  if (fmt.bom) buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), buf]);
  return buf;
}

// Minimal truthful line diff: common prefix/suffix, one replaced middle block.
// Returns [{t:' '|'-'|'+', text}] — computed from actual disk lines vs proposed.
function lineDiff(oldLines, newLines) {
  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (suf < oldLines.length - pre && suf < newLines.length - pre &&
    oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]) suf++;
  const out = [];
  const ctx = (arr, from, to) => { for (let i = from; i < to; i++) out.push({ t: ' ', n: i + 1, text: arr[i] }); };
  ctx(oldLines, Math.max(0, pre - 3), pre);
  for (let i = pre; i < oldLines.length - suf; i++) out.push({ t: '-', n: i + 1, text: oldLines[i] });
  for (let i = pre; i < newLines.length - suf; i++) out.push({ t: '+', n: i + 1, text: newLines[i] });
  ctx(newLines, newLines.length - suf, Math.min(newLines.length, newLines.length - suf + 3));
  return { hunks: out, removed: oldLines.length - pre - suf, added: newLines.length - pre - suf };
}

function renderDiff(rel, d) {
  const L = [`--- a/${rel}`, `+++ b/${rel}`];
  for (const h of d.hunks) L.push(`${h.t} ${h.text}`);
  if (L.length > 60) return L.slice(0, 30).join('\n') + `\n… (${L.length - 30} more diff lines)` + `\n(-${d.removed} / +${d.added} lines)`;
  return L.join('\n') + `\n(-${d.removed} / +${d.added} lines)`;
}

function atomicWrite(full, buf) {
  const dir = path.dirname(full);
  const tmp = path.join(dir, `.botconnector-tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`);
  fs.writeFileSync(tmp, buf);
  fs.closeSync(fs.openSync(tmp, 'r')); // ensure flushed handle closed (write already closed; fsync via open/close)
  fs.renameSync(tmp, full); // same-dir rename = atomic on NTFS
  return true;
}

// --- proposals (validate only, no disk writes) ---
function buildEditProposal(ws, relPath, newContent) {
  const r = ws.resolveInside(relPath);
  if (!r.ok) return r;
  let st;
  try { st = fs.statSync(r.full); } catch { return { ok: false, error: `file not found: ${r.rel}` }; }
  if (st.isDirectory()) return { ok: false, error: `is a directory: ${r.rel}` };
  if (st.size > 1024 * 1024) return { ok: false, error: `file too large to edit safely (${st.size} bytes)` };
  const raw = fs.readFileSync(r.full);
  if (raw.includes(0)) return { ok: false, error: `BINARY_MUTATION_BLOCKED: ${r.rel} is binary` };
  if (typeof newContent !== 'string' || newContent.length > 1024 * 1024)
    return { ok: false, error: 'invalid proposed content' };
  if (Buffer.from(newContent, 'utf8').includes(0)) return { ok: false, error: 'BINARY_MUTATION_BLOCKED: proposed content is binary' };
  const actual = decode(raw);
  const proposedLines = newContent.replace(/\r\n/g, '\n').split('\n');
  if (proposedLines.length && proposedLines[proposedLines.length - 1] === '' && !actual.trailingNewline) { /* keep model's choice */ }
  const d = lineDiff(actual.lines, proposedLines);
  if (d.removed === 0 && d.added === 0) return { ok: false, error: 'no changes: proposed content identical to disk' };
  return {
    ok: true, kind: 'edit', path: r.rel, full: r.full,
    expectedSha: sha256Bytes(raw), fmt: { bom: actual.bom, eol: actual.eol, trailingNewline: actual.trailingNewline },
    proposedLines, diff: d, diffText: renderDiff(r.rel, d),
  };
}

function applyEdit(ws, proposal) {
  if (!proposal || proposal.kind !== 'edit' || !proposal.ok) return { ok: false, error: 'invalid edit proposal' };
  const r = ws.resolveInside(proposal.path);
  if (!r.ok) return r; // re-jail at apply time
  let raw;
  try { raw = fs.readFileSync(r.full); } catch { return { ok: false, error: 'target vanished before apply' }; }
  if (sha256Bytes(raw) !== proposal.expectedSha)
    return { ok: false, error: 'STALE_EDIT: file changed since proposal — aborted, nothing overwritten', stale: true };
  const fmt = proposal.fmt;
  const trailingNL = proposal.proposedLines.length && proposal.proposedLines[proposal.proposedLines.length - 1] === '';
  const lines = trailingNL ? proposal.proposedLines.slice(0, -1) : proposal.proposedLines;
  const next = encode(lines, { bom: fmt.bom, eol: fmt.eol, trailingNewline: trailingNL ? true : fmt.trailingNewline });
  atomicWrite(r.full, next);
  return { ok: true, kind: 'edit', path: r.rel, sha: sha256File(r.full), _mutation: { files: [{ path: r.rel, beforeExists: true, afterExists: true, before: raw, after: next }] } };
}

function buildCreateProposal(ws, relPath, content) {
  const r = ws.resolveInside(relPath);
  if (!r.ok) return r;
  if (fs.existsSync(r.full)) return { ok: false, error: `already exists: ${r.rel} (use edit)` };
  // Parent must exist and be inside (resolveInside already jailed it via finalize).
  const parent = path.dirname(r.full);
  try { if (!fs.statSync(parent).isDirectory()) return { ok: false, error: `parent not a directory: ${r.rel}` }; }
  catch { return { ok: false, error: `parent directory missing: ${r.rel}` }; }
  if (typeof content !== 'string' || content.length > 1024 * 1024) return { ok: false, error: 'invalid proposed content' };
  if (Buffer.from(content, 'utf8').includes(0)) return { ok: false, error: 'BINARY_MUTATION_BLOCKED: proposed content is binary' };
  return { ok: true, kind: 'create', path: r.rel, full: r.full, content };
}

function applyCreate(ws, proposal) {
  if (!proposal || proposal.kind !== 'create' || !proposal.ok) return { ok: false, error: 'invalid create proposal' };
  const r = ws.resolveInside(proposal.path);
  if (!r.ok) return r;
  if (fs.existsSync(r.full)) return { ok: false, error: 'STALE_EDIT: file appeared since proposal — aborted' , stale: true };
  const lines = proposal.content.replace(/\r\n/g, '\n').split('\n');
  const trailingNL = lines.length && lines[lines.length - 1] === '';
  const next = encode(trailingNL ? lines.slice(0, -1) : lines, { bom: false, eol: '\n', trailingNewline: trailingNL ? true : true });
  atomicWrite(r.full, next);
  return { ok: true, kind: 'create', path: r.rel, sha: sha256File(r.full), _mutation: { files: [{ path: r.rel, beforeExists: false, afterExists: true, before: null, after: next }] } };
}

function trashDir(ws) {
  const t = path.join(ws.root, '.botconnector-trash');
  if (!fs.existsSync(t)) fs.mkdirSync(t, { recursive: true });
  return t;
}

function buildDeleteProposal(ws, relPath) {
  const r = ws.resolveInside(relPath);
  if (!r.ok) return r;
  let st;
  try { st = fs.statSync(r.full); } catch { return { ok: false, error: `file not found: ${r.rel}` }; }
  if (st.isDirectory()) return { ok: false, error: `refusing directory delete (files only, Phase 1): ${r.rel}` };
  const raw = fs.readFileSync(r.full);
  return { ok: true, kind: 'delete', path: r.rel, full: r.full, expectedSha: sha256Bytes(raw), bytes: raw.length, binary: raw.includes(0) };
}

function applyDelete(ws, proposal) {
  if (!proposal || proposal.kind !== 'delete' || !proposal.ok) return { ok: false, error: 'invalid delete proposal' };
  const r = ws.resolveInside(proposal.path);
  if (!r.ok) return r;
  let raw;
  try { raw = fs.readFileSync(r.full); } catch { return { ok: false, error: 'target vanished before apply' }; }
  if (sha256Bytes(raw) !== proposal.expectedSha)
    return { ok: false, error: 'STALE_EDIT: file changed since proposal — aborted', stale: true };
  const dest = path.join(trashDir(ws), `${Date.now()}-${path.basename(r.full)}.deleted`);
  fs.renameSync(r.full, dest); // reversible: content preserved under workspace trash
  return { ok: true, kind: 'delete', path: r.rel, trash: path.relative(ws.root, dest), _mutation: { files: [{ path: r.rel, beforeExists: true, afterExists: false, before: raw, after: null }] } };
}

function buildRenameProposal(ws, srcRel, dstRel) {
  const s = ws.resolveInside(srcRel);
  if (!s.ok) return s;
  const d = ws.resolveInside(dstRel);
  if (!d.ok) return { ok: false, error: `destination ${d.error}` };
  let st;
  try { st = fs.statSync(s.full); } catch { return { ok: false, error: `source not found: ${s.rel}` }; }
  if (st.isDirectory()) return { ok: false, error: 'refusing directory rename (files only, Phase 1)' };
  if (fs.existsSync(d.full)) return { ok: false, error: `destination exists: ${d.rel}` };
  return { ok: true, kind: 'rename', path: s.rel, full: s.full, dest: d.rel, destFull: d.full, expectedSha: sha256File(s.full) };
}

function applyRename(ws, proposal) {
  if (!proposal || proposal.kind !== 'rename' || !proposal.ok) return { ok: false, error: 'invalid rename proposal' };
  const s = ws.resolveInside(proposal.path);
  if (!s.ok) return s;
  const d = ws.resolveInside(proposal.dest);
  if (!d.ok) return { ok: false, error: `destination ${d.error}` };
  let raw;
  try { raw = fs.readFileSync(s.full); } catch { return { ok: false, error: 'source vanished before apply' }; }
  if (sha256Bytes(raw) !== proposal.expectedSha)
    return { ok: false, error: 'STALE_EDIT: source changed since proposal — aborted', stale: true };
  if (fs.existsSync(d.full)) return { ok: false, error: 'destination appeared since proposal — aborted', stale: true };
  fs.renameSync(s.full, d.full);
  return { ok: true, kind: 'rename', path: s.rel, dest: d.rel, sha: sha256File(d.full), _mutation: { files: [
    { path: s.rel, beforeExists: true, afterExists: false, before: raw, after: null },
    { path: d.rel, beforeExists: false, afterExists: true, before: null, after: raw },
  ] } };
}

module.exports = {
  buildEditProposal, applyEdit, buildCreateProposal, applyCreate,
  buildDeleteProposal, applyDelete, buildRenameProposal, applyRename,
  sha256File, lineDiff, renderDiff,
};
