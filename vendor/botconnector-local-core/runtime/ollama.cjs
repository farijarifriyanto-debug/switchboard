// Ollama discovery — treats an installed Ollama as just another local
// provider. Never required: if it's not running, BotConnector-managed
// llama.cpp stays first-class and this simply reports {ok:false}.
'use strict';
const http = require('http');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

function get(endpoint, p, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(endpoint.replace(/\/$/, '') + p, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`));
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// GET /api/tags — never throws. Short default timeout: this is a presence
// probe called from the home screen / model picker, must not stall the UI.
async function discoverOllama({ endpoint = DEFAULT_ENDPOINT, timeoutMs = 800 } = {}) {
  let raw;
  try { raw = await get(endpoint, '/api/tags', timeoutMs); }
  catch (e) { return { ok: false, reason: e.message, endpoint }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: 'malformed response', endpoint }; }
  const models = (parsed.models || []).map((m) => ({
    id: m.name || m.model,
    name: String(m.name || m.model || '').replace(/:latest$/, ''),
    bytes: m.size || null,
    family: m.details && m.details.family,
    quant: m.details && m.details.quantization_level,
  }));
  return { ok: true, endpoint, models };
}

module.exports = { discoverOllama, DEFAULT_ENDPOINT };
