// Real session persistence: one JSON file per session under canonical's
// userData directory (sibling to settings.json/cloud/, same storage root
// the Desktop app and CLI already use — no separate config location).
// Stores conversation messages + project/model/mode so /sessions can really
// resume, not just browse. Never stores secrets/tool credentials.
'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { userDataDir } = require('./state.cjs');

function dir() {
  const d = path.join(userDataDir(), 'sessions');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function file(id) { return path.join(dir(), `${id}.json`); }
function newId() { return crypto.randomBytes(6).toString('hex'); }

function titleFrom(prompt) {
  const t = String(prompt || '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > 48 ? t.slice(0, 47) + '…' : t) : 'New session';
}

function messageId() { return `m-${crypto.randomBytes(7).toString('hex')}`; }

function normalizeMessage(message, index = 0) {
  if (!message || typeof message !== 'object') return { id: messageId(), role: 'assistant', content: String(message || ''), at: Date.now() };
  return { id: message.id || `${message.role === 'user' ? 'u' : 'a'}-${index + 1}-${messageId()}`, role: message.role || 'assistant', content: String(message.content || ''), at: message.at || Date.now() };
}

function ensureShape(sess) {
  if (!sess) return sess;
  sess.messages = (Array.isArray(sess.messages) ? sess.messages : []).map(normalizeMessage);
  if (!sess.createdAt) sess.createdAt = Date.now();
  if (!sess.lastUsed) sess.lastUsed = sess.createdAt;
  if (!sess.title) sess.title = 'New session';
  return sess;
}

// Index: lightweight metadata only (no message bodies) for the /sessions list.
function list() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((f) => f.endsWith('.json')); } catch { return []; }
  const rows = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir(), name), 'utf8'));
      rows.push({
        id: raw.id, title: raw.title, project: raw.project, model: raw.model,
        mode: raw.mode, lastUsed: raw.lastUsed, createdAt: raw.createdAt,
        parentSessionId: raw.parentSessionId || null, forkedFromMessageId: raw.forkedFromMessageId || null,
        messageCount: (raw.messages || []).length,
      });
    } catch { /* skip corrupt/partial file */ }
  }
  return rows.sort((a, b) => b.lastUsed - a.lastUsed);
}

function load(id) {
  try { return ensureShape(JSON.parse(fs.readFileSync(file(id), 'utf8'))); } catch { return null; }
}

async function save(sess) { await fsp.writeFile(file(sess.id), JSON.stringify(sess, null, 2)); }

async function create({ project, model, mode }) {
  const now = Date.now();
  const sess = { id: newId(), title: 'New session', project, model, mode, messages: [], summary: null, compaction: null, parentSessionId: null, forkedFromMessageId: null, createdAt: now, lastUsed: now };
  await save(sess);
  return sess;
}

// Appends one user/assistant turn and refreshes metadata; title is derived
// from the first user prompt only.
async function recordTurn(sess, { prompt, answer, project, model, mode }) {
  ensureShape(sess);
  if (sess.title === 'New session' && prompt) sess.title = titleFrom(prompt);
  if (prompt) sess.messages.push({ id: messageId(), role: 'user', content: prompt, at: Date.now() });
  if (answer != null) sess.messages.push({ id: messageId(), role: 'assistant', content: answer, at: Date.now() });
  sess.project = project; sess.model = model; sess.mode = mode;
  sess.lastUsed = Date.now();
  await save(sess);
  return sess;
}

// Returns the {role,content} history the agent loop should replay, in the
// shape runTurn/runTask's new `history` param expects.
function historyFor(sess) {
  ensureShape(sess);
  const all = sess.messages || [];
  if (!sess.compaction || !sess.compaction.compactedThroughMessageId) return all.map((m) => ({ role: m.role, content: m.content }));
  const boundary = all.findIndex((m) => m.id === sess.compaction.compactedThroughMessageId);
  const tail = boundary >= 0 ? all.slice(boundary + 1) : all;
  const summary = sess.compaction.summary || sess.summary;
  return [
    ...(summary ? [{ role: 'system', content: `Durable session summary:\n${summary}` }] : []),
    ...tail.map((m) => ({ role: m.role, content: m.content })),
  ];
}

function timeline(sess) { return ensureShape(sess).messages.slice(); }

async function rename(sess, title) {
  const next = String(title || '').replace(/\s+/g, ' ').trim();
  if (!next) throw new Error('Session title cannot be empty');
  sess.title = next.slice(0, 120);
  sess.lastUsed = Date.now();
  await save(sess);
  return sess;
}

async function fork(sess, forkedFromMessageId = null) {
  ensureShape(sess);
  let messages = sess.messages.slice();
  if (forkedFromMessageId) {
    const at = messages.findIndex((m) => m.id === forkedFromMessageId);
    if (at < 0) throw new Error('Selected timeline message no longer exists');
    messages = messages.slice(0, at + 1).map((m) => ({ ...m }));
  }
  const now = Date.now();
  const child = {
    id: newId(), title: messages.find((m) => m.role === 'user') ? titleFrom(messages.find((m) => m.role === 'user').content) : 'Forked session',
    project: sess.project, model: sess.model, mode: sess.mode, messages,
    summary: forkedFromMessageId ? null : sess.summary, compaction: null,
    parentSessionId: sess.id, forkedFromMessageId, createdAt: now, lastUsed: now,
  };
  await save(child);
  return child;
}

function markdown(sess) {
  ensureShape(sess);
  const L = [`# ${sess.title || 'BotConnector session'}`, '', `- Session ID: ${sess.id}`, `- Project: ${sess.project || '—'}`];
  if (sess.parentSessionId) L.push(`- Parent session: ${sess.parentSessionId}`);
  L.push('');
  for (const m of sess.messages) L.push(`## ${m.role === 'user' ? 'You' : 'BotConnector'}`, '', m.content, '');
  return L.join('\n');
}

function safeValue(value, key = '') {
  if (/(token|secret|password|credential|api[-_]?key|authorization|private[-_]?key|cookie)/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((v) => safeValue(v, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safeValue(v, k)]));
  return value;
}

function safeJson(sess, sanitized = false) {
  ensureShape(sess);
  const data = {
    id: sess.id, title: sess.title, project: sess.project, model: sess.model, mode: sess.mode,
    parentSessionId: sess.parentSessionId || null, forkedFromMessageId: sess.forkedFromMessageId || null,
    createdAt: sess.createdAt, lastUsed: sess.lastUsed, summary: sess.summary || null,
    compaction: sess.compaction || null, messages: sess.messages,
  };
  return sanitized ? safeValue(data) : data;
}

async function exportSession(sess, format = 'markdown', outputDir = path.join(userDataDir(), 'exports')) {
  await fsp.mkdir(outputDir, { recursive: true });
  const base = `${String(sess.title || 'session').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'session'}-${sess.id}`;
  let ext = 'md'; let data = markdown(sess);
  if (format === 'json' || format === 'sanitized-json') { ext = 'json'; data = JSON.stringify(safeJson(sess, format === 'sanitized-json'), null, 2); }
  const out = path.join(outputDir, `${base}.${ext}`);
  await fsp.writeFile(out, data, 'utf8');
  return out;
}

function copyToClipboard(text) {
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'clip.exe' : (process.env.WAYLAND_DISPLAY ? 'wl-copy' : 'xclip');
    const args = process.platform === 'win32' || process.env.WAYLAND_DISPLAY ? [] : ['-selection', 'clipboard'];
    let child;
    try { child = spawn(command, args, { windowsHide: true }); } catch (e) { resolve({ ok: false, error: e.message }); return; }
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => resolve({ ok: false, error: `${e.message}. Install a clipboard helper or use /export.` }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: stderr || `clipboard process exited ${code}` }));
    child.stdin.end(text);
  });
}

function compactSummary(sess, { keep = 12 } = {}) {
  ensureShape(sess);
  const messages = sess.messages;
  if (messages.length <= keep) return { ok: false, reason: 'Session is already compact.' };
  const boundary = messages[messages.length - keep - 1];
  const old = messages.slice(0, messages.length - keep);
  const userGoals = old.filter((m) => m.role === 'user').map((m) => `- ${m.content.replace(/\s+/g, ' ').trim().slice(0, 180)}`);
  const refs = [...new Set(old.flatMap((m) => String(m.content).match(/(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\b/g) || []))].slice(0, 30);
  const todos = old.flatMap((m) => String(m.content).match(/[^\n]*(?:TODO|FIXME|constraint|must|required)[^\n]*/gi) || []).slice(0, 20);
  const summary = ['Goals and decisions:', ...(userGoals.length ? userGoals : ['- Earlier conversation retained in the session timeline.'])];
  if (refs.length) summary.push('', 'Referenced files/projects:', ...refs.map((r) => `- ${r}`));
  if (todos.length) summary.push('', 'Unresolved TODOs and constraints:', ...todos.map((r) => `- ${r.trim().slice(0, 180)}`));
  return { ok: true, compactedThroughMessageId: boundary.id, summary: summary.join('\n'), sourceTokenEstimate: old.reduce((n, m) => n + Math.ceil(String(m.content).length / 4), 0), retainedMessages: keep };
}

async function compact(sess, opts = {}) {
  const result = compactSummary(sess, opts);
  if (!result.ok) return result;
  sess.compaction = { ...result, createdAt: Date.now() };
  sess.summary = result.summary;
  sess.lastUsed = Date.now();
  await save(sess);
  return result;
}

async function remove(id) { try { await fsp.rm(file(id), { force: true }); return true; } catch { return false; } }

module.exports = { list, load, save, create, recordTurn, remove, historyFor, timeline, rename, fork, markdown, safeJson, exportSession, copyToClipboard, compactSummary, compact, titleFrom, newId, messageId, dir };
