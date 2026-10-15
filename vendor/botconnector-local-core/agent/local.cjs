// BotConnector local model adapter (Native Agent, canonical integration).
// Talks to llama.cpp's OpenAI-compatible endpoint using Node built-ins only
// (no SDK dependency). Local-only: NEVER falls back to cloud — every failure
// surfaces as an explicit error string for the TUI. resolveEndpoint() below
// finds the ACTIVE port via the same ownership lock the Desktop app and CLI
// already share, instead of assuming a fixed port.
'use strict';
const http = require('http');
const https = require('https');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11435/v1';

function post(endpoint, path, body, { timeoutMs = 10000, signal = null } = {}) {
  const url = new URL(endpoint.replace(/\/$/, '') + path);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = lib.request(url, {
      method: 'POST',
      agent: false, // fresh connection per request: llama.cpp closes idle keep-alive sockets aggressively
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let err = '';
        res.on('data', (c) => { err += c; });
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${err.slice(0, 200)}`)));
        return;
      }
      resolve(res);
    });
    const timer = setTimeout(() => { req.destroy(new Error('timeout')); }, timeoutMs);
    const done = (fn) => (...a) => { clearTimeout(timer); fn(...a); };
    req.on('error', done(reject));
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('aborted')); return; }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.on('response', done(() => {}));
    req.on('close', () => clearTimeout(timer));
    req.write(payload);
    req.end();
  });
}

function get(endpoint, path, { timeoutMs = 5000, signal = null } = {}) {
  const url = new URL(endpoint.replace(/\/$/, '') + path);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, { agent: false }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        resolve(data);
      });
    });
    const timer = setTimeout(() => { req.destroy(new Error('timeout')); }, timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => clearTimeout(timer));
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('aborted')); return; }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
  });
}

// Compact friendly name from a llama.cpp model id (usually a file path).
// Keeps exact id intact; only derives display text.
// "…/Spark-X2.5-4B-Q4_K_M.gguf" -> "Spark X2.5 4B"
function friendlyName(id) {
  const base = String(id || '').split(/[\\/]/).pop().replace(/\.gguf$/i, '');
  const noQuant = base.replace(/[-_](Q\d+_K_[SML]|Q\d+|F16|F32|BF16|IQ\d.*)$/i, '');
  return noQuant.replace(/[-_]+/g, ' ').trim() || 'local model';
}

// GET /v1/models — never throws; returns {ok:true,...} or {ok:false, reason}.
async function discoverLocalModel({ endpoint = DEFAULT_ENDPOINT, timeoutMs = 5000 } = {}) {
  let raw;
  try {
    raw = await get(endpoint, '/models', { timeoutMs });
  } catch (e) {
    const msg = /timeout/.test(e.message) ? 'timed out' : e.message;
    return { ok: false, reason: `Local runtime is not available at ${endpoint}. ${msg}. Start or load a model first.` };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, reason: `Malformed /v1/models response from ${endpoint}.` }; }
  const list = parsed.data || parsed.models || [];
  if (!Array.isArray(list) || list.length === 0)
    return { ok: false, reason: `No model loaded on ${endpoint}. Load a model first.` };
  const first = list[0];
  const id = first.id || first.model || first.name;
  if (!id) return { ok: false, reason: `Model entry has no id on ${endpoint}.` };
  const meta = first.meta || {};
  return {
    ok: true,
    id,                                   // exact id — use for chat requests
    friendly: friendlyName(id),           // display only
    nCtx: Number(meta.n_ctx) || null,     // actual runtime context when reported
    nParams: Number(meta.n_params) || null,
    endpoint,
  };
}

// Non-streaming chat. Returns {ok, content, reasoning, usage, finish} — never throws.
async function localChat({ endpoint, model, messages, maxTokens = 512, timeoutMs = 120000, signal = null }) {
  let res;
  try {
    res = await post(endpoint, '/chat/completions',
      { model, messages, max_tokens: maxTokens, stream: false },
      { timeoutMs, signal });
  } catch (e) {
    return { ok: false, reason: e.message === 'aborted' ? 'cancelled' : `Local inference failed: ${e.message}. No cloud fallback — local only.`, content: '', reasoning: '', usage: null };
  }
  let data = '';
  res.on('data', (c) => { data += c; });
  return new Promise((resolve) => {
    res.on('end', () => {
      try {
        const j = JSON.parse(data);
        const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
        resolve({
          ok: true,
          content: typeof m.content === 'string' ? m.content : '',
          reasoning: typeof m.reasoning_content === 'string' ? m.reasoning_content : '',
          finish: j.choices[0].finish_reason || null,
          usage: j.usage || null,
        });
      } catch { resolve({ ok: false, reason: 'Malformed chat completion response.', content: '', reasoning: '', usage: null }); }
    });
    res.on('error', (e) => resolve({ ok: false, reason: `Local inference failed: ${e.message}.`, content: '', reasoning: '', usage: null }));
  });
}

// Streaming chat (SSE: `data: {...}` frames, `data: [DONE]` terminator — as
// returned by llama.cpp b10930). onToken receives visible content deltas as
// they arrive; reasoning deltas are collected, never rendered (debug only).
// Abort via signal: destroys only the HTTP request, never the runtime.
async function localChatStream({ endpoint, model, messages, maxTokens = 512, timeoutMs = 180000, signal = null, onToken = null, onReasoning = null }) {
  let res;
  try {
    res = await post(endpoint, '/chat/completions',
      { model, messages, max_tokens: maxTokens, stream: true },
      { timeoutMs, signal });
  } catch (e) {
    return { ok: false, reason: e.message === 'aborted' ? 'cancelled' : `Local inference failed: ${e.message}. No cloud fallback — local only.`, content: '', reasoning: '' };
  }
  return new Promise((resolve) => {
    let buf = '', content = '', reasoning = '', finish = null, firstTokenAt = null, aborted = false;
    const finishOk = () => resolve({ ok: true, content, reasoning, finish, firstTokenAt, aborted });
    const finishErr = (reason) => resolve({ ok: false, reason, content, reasoning, aborted });
    if (signal) signal.addEventListener('abort', () => { aborted = true; try { res.destroy(); } catch {} }, { once: true });
    res.on('data', (c) => {
      buf += c.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { finishOk(); return; }
        try {
          const j = JSON.parse(payload);
          const choice = (j.choices && j.choices[0]) || {};
          const d = choice.delta || {};
          if (choice.finish_reason) finish = choice.finish_reason;
          if (typeof d.content === 'string' && d.content) {
            if (!firstTokenAt) firstTokenAt = Date.now();
            content += d.content;
            if (onToken) onToken(d.content);
          }
          if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
            reasoning += d.reasoning_content;
            if (onReasoning) onReasoning(d.reasoning_content);
          }
        } catch { /* skip malformed SSE line, keep stream alive */ }
      }
    });
    res.on('end', () => {
      if (aborted) return resolve({ ok: false, reason: 'cancelled', content, reasoning, aborted: true });
      finishOk();
    });
    res.on('aborted', () => resolve({ ok: false, reason: 'cancelled', content, reasoning, aborted: true }));
    res.on('error', (e) => {
      if (aborted || /aborted/i.test(e.message)) return resolve({ ok: false, reason: 'cancelled', content, reasoning, aborted: true });
      finishErr(`Local inference failed: ${e.message}.`);
    });
  });
}

// Resolve the ACTIVE runtime endpoint via canonical's shared ownership lock
// (runtime/ownership.cjs) — the same lock the Electron Desktop app and the
// existing `botconnector` CLI already use. This is how the TUI finds a
// runtime started by either interface instead of assuming a fixed port.
// Falls back to the llama.cpp default port when nothing owns the lock yet
// (matches the CLI's own `--port` default) — discoverLocalModel's own
// /v1/models probe is still the authoritative "is it actually up" check.
async function resolveEndpoint() {
  try {
    const { readOwnership, statePath, pidAlive } = require('../runtime/ownership.cjs');
    const owner = await readOwnership(statePath());
    const alive = owner && pidAlive(owner.childPid != null ? owner.childPid : owner.ownerPid);
    if (alive && owner.port) {
      return { endpoint: `http://127.0.0.1:${owner.port}/v1`, ownerType: owner.ownerType, port: Number(owner.port), owned: true };
    }
  } catch { /* ownership module unavailable or state unreadable — fall through */ }
  return { endpoint: DEFAULT_ENDPOINT, ownerType: null, port: 11435, owned: false };
}

module.exports = { discoverLocalModel, localChat, localChatStream, friendlyName, resolveEndpoint, DEFAULT_ENDPOINT };
