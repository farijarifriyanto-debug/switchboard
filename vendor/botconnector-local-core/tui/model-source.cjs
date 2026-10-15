// Composes the /model picker's unified list from canonical Core: installed
// local GGUF models (scanInstalled), Ollama (if present), and a Cloud entry
// reflecting real configured-provider state. This is TUI presentation glue
// — it reads Core, it never re-implements it.
'use strict';
const path = require('path');
const { scanInstalled } = require('../runtime/installed.cjs');
const ollama = require('../runtime/ollama.cjs');
const local = require('../agent/local.cjs');

function fmtBytes(n) {
  if (!n) return '';
  const gb = n / 1e9;
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)}GB` : `${Math.round(n / 1e6)}MB`;
}

async function listModels(s) {
  const items = [{ id: '__auto__', label: 'Auto', provider: 'Routing', kind: 'auto', status: 'Automatic', detail: 'Use the active runtime/provider policy', selectable: true, active: s.model.name === 'Auto' }];
  const recent = Array.isArray(s.store.get('tuiRecentModels')) ? s.store.get('tuiRecentModels') : [];
  const favorites = new Set(Array.isArray(s.store.get('tuiFavoriteModels')) ? s.store.get('tuiFavoriteModels') : []);

  const resolved = await local.resolveEndpoint();
  const probe = await local.discoverLocalModel({ endpoint: resolved.endpoint, timeoutMs: 1500 });
  const installed = await scanInstalled(s.store.get('modelsDir'));

  const chatInstalled = installed.filter(isChatCapableModel);
  if (chatInstalled.length) {
    for (const m of chatInstalled) {
      items.push({
        id: m.path,
        label: `${m.repoId || path.basename(m.dir)}${m.quant ? '@' + m.quant : ''}`,
        provider: 'BotConnector Local',
        kind: 'local',
        status: probe.ok && probe.id === m.path ? 'Running' : 'Installed',
        detail: `Local · ${fmtBytes(m.size)}${probe.ok && probe.id === m.path && probe.nCtx ? ` · ${Math.round(probe.nCtx / 1024)}K context` : ''}`,
        selectable: true,
        active: probe.ok && probe.id === m.path,
        favorite: favorites.has(m.path), recent: recent.includes(m.path),
        modelPath: m.path,
        projector: m.projector,
      });
    }
  } else {
    items.push({
      id: '__no_local__', label: 'No local model installed', provider: 'BotConnector Local', kind: 'local',
      status: 'Not installed', detail: 'Use Find more models… to search and download one', selectable: false,
    });
  }

  const o = await ollama.discoverOllama({ timeoutMs: 800 });
  if (o.ok) {
      for (const m of o.models) {
      items.push({
        id: m.id, label: m.name, provider: 'Ollama', kind: 'ollama', status: 'Ready',
        detail: ['Local', fmtBytes(m.bytes)].filter(Boolean).join(' · '),
        selectable: true, active: s.model.provider === 'Ollama' && s.modelId === m.id,
        favorite: favorites.has(m.id), recent: recent.includes(m.id),
      });
    }
  }

  let cloudDetail = 'Usage-based pricing · never auto-selected';
  try {
    const { CredentialManager, PROVIDERS } = require('../runtime/credentials.cjs');
    const cm = new CredentialManager({ store: s.store, env: process.env });
    const pub = cm.public();
    const rows = PROVIDERS.map((p) => `${p}: ${pub[p] && pub[p].configured ? 'configured' : 'not configured'}`);
    if (rows.length) cloudDetail = rows.join(' · ');
  } catch { /* credentials module unavailable — keep generic detail */ }
  items.push({
    id: '__cloud__', label: s.model.locality === 'Cloud' ? s.model.name : 'Cloud models', provider: 'Cloud',
    kind: 'cloud', status: 'Configure', detail: cloudDetail, selectable: true, active: s.model.locality === 'Cloud',
  });

  return { items, localReady: probe.ok && (!probe.id || chatInstalled.some((m) => m.path === probe.id)), ollamaAvailable: o.ok, hasInstalled: chatInstalled.length > 0 };
}

function isChatCapableModel(model) {
  const caps = model && model.capabilities;
  return !(caps && caps.embeddings === true && caps.chat !== true);
}

module.exports = { listModels, fmtBytes, isChatCapableModel };
