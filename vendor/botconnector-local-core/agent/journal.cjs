'use strict';

// Reversible journal for mutations BotConnector itself applied. It is
// intentionally independent of Git: undo never resets a repository and only
// touches files whose current hash still matches BotConnector's last write.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { userDataDir } = require('../state.cjs');

function hash(buf) { return crypto.createHash('sha256').update(buf || Buffer.alloc(0)).digest('hex'); }
function filePath() { return path.join(userDataDir(), 'mutation-journal.json'); }
function load() { try { const x = JSON.parse(fs.readFileSync(filePath(), 'utf8')); return x && Array.isArray(x.entries) ? x : { entries: [], redo: [] }; } catch { return { entries: [], redo: [] }; } }
async function save(db) { await fsp.mkdir(userDataDir(), { recursive: true }); await fsp.writeFile(filePath(), JSON.stringify(db, null, 2)); }

function normalizeMutation(mutation, { sessionId = null, messageId = null, workspace } = {}) {
  if (!mutation || !workspace || !Array.isArray(mutation.files) || !mutation.files.length) return null;
  return {
    transactionId: `tx-${crypto.randomBytes(8).toString('hex')}`, sessionId, messageId, timestamp: Date.now(), workspace: path.resolve(workspace),
    files: mutation.files.map((f) => ({ path: f.path, beforeExists: !!f.beforeExists, afterExists: !!f.afterExists, beforeHash: f.beforeExists ? (f.beforeHash || hash(f.before)) : null, afterHash: f.afterExists ? (f.afterHash || hash(f.after)) : null, before: f.before == null ? null : Buffer.from(f.before).toString('base64'), after: f.after == null ? null : Buffer.from(f.after).toString('base64') })),
    reversible: mutation.reversible !== false, reason: mutation.reason || '',
  };
}

async function record(mutation, opts = {}) {
  const entry = normalizeMutation(mutation, opts);
  if (!entry) return { ok: false, reason: 'No reversible BotConnector mutation to journal' };
  const db = load(); db.entries.push(entry); db.redo = []; await save(db); return { ok: true, entry };
}

function resolve(workspace, rel) {
  const root = path.resolve(workspace); const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`journal path escapes workspace: ${rel}`);
  return full;
}
function current(full) { try { return fs.readFileSync(full); } catch { return null; } }
function writeState(full, exists, encoded) {
  if (!exists) { try { fs.rmSync(full, { force: true }); } catch {} return; }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.botconnector-undo-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, Buffer.from(encoded || '', 'base64')); fs.renameSync(tmp, full);
}

async function move(direction, { workspace, sessionId = null } = {}) {
  const db = load();
  const source = direction === 'undo' ? db.entries : db.redo;
  if (!source.length) return { ok: false, reason: direction === 'undo' ? 'No reversible BotConnector mutation to undo.' : 'Nothing to redo.' };
  const entry = source[source.length - 1];
  if (path.resolve(entry.workspace) !== path.resolve(workspace)) return { ok: false, reason: 'The last mutation belongs to another workspace.' };
  if (sessionId && entry.sessionId && entry.sessionId !== sessionId) return { ok: false, reason: 'The last mutation belongs to another session.' };
  if (!entry.reversible) return { ok: false, reason: entry.reason || 'This mutation is not reversible.' };
  const from = direction === 'undo' ? 'after' : 'before';
  const to = direction === 'undo' ? 'before' : 'after';
  for (const f of entry.files) {
    const full = resolve(workspace, f.path); const now = current(full); const expected = f[`${from}Hash`];
    if ((now ? hash(now) : null) !== (expected || null)) return { ok: false, conflict: true, reason: `UNDO_EXTERNAL_CONFLICT_REFUSED: ${f.path} changed outside BotConnector.` };
  }
  for (const f of entry.files) writeState(resolve(workspace, f.path), f[`${to}Exists`], f[to]);
  if (direction === 'undo') { db.entries.pop(); db.redo.push(entry); } else { db.redo.pop(); db.entries.push(entry); }
  await save(db); return { ok: true, entry };
}

function status({ workspace, sessionId = null } = {}) {
  const db = load();
  const entries = db.entries.filter((e) => path.resolve(e.workspace) === path.resolve(workspace) && (!sessionId || !e.sessionId || e.sessionId === sessionId));
  return { canUndo: entries.some((e) => e.reversible), canRedo: db.redo.some((e) => path.resolve(e.workspace) === path.resolve(workspace)), entries: entries.length };
}

module.exports = { filePath, load, record, undo: (opts) => move('undo', opts), redo: (opts) => move('redo', opts), status, hash };
