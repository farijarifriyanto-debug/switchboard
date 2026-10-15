// TUI session state — persists through canonical Store (runtime/store.cjs),
// the same settings.json the Electron Desktop app and CLI already use. No
// competing config file: new fields are simply new keys in that one file.
'use strict';
const path = require('path');
const os = require('os');
const { Store } = require('./runtime/store.cjs');

const APP = 'botconnector-ai-local-cloud';

function userDataDir() {
  return process.env.BOTCONNECTOR_USERDATA ||
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP);
}

const DEFAULT_MODEL = { name: 'BotConnector Local', locality: 'Local', backend: 'auto', provider: 'llama.cpp', cost: '$0.00' };

function load() {
  const store = new Store(userDataDir());
  store.load();
  const g = (k, d) => { const v = store.get(k); return v === undefined ? d : v; };
  return {
    store,
    mode: g('tuiMode', 'Plan'),
    approval: g('tuiApproval', 'ask'),
    model: g('tuiModel', DEFAULT_MODEL),
    modelId: g('tuiModelId', null),
    project: null,
    workspace: null,
    runtime: { backend: g('runtimeBackend', 'auto'), endpoint: null, nCtx: 4096 },
    usedTokens: 0,
    input: '',
    contextBumpAcked: g('tuiContextBumpAcked', {}),
    firstRunDone: g('tuiFirstRunDone', false),
    settings: {
      contextPreference: g('tuiContextPreference', 'auto'),
      approvalBehavior: g('tuiApproval', 'ask'),
      language: g('language', 'system'),
      theme: g('tuiTheme', 'auto'),
      debugMode: Boolean(g('tuiDebugMode', false)),
      showThinking: Boolean(g('tuiShowThinking', false)),
      showDetails: Boolean(g('tuiShowDetails', false)),
    },
  };
}

// Persists the TUI-owned fields. Runtime/project/usedTokens/input stay
// in-memory only — they're per-process, not user configuration.
async function save(s) {
  const writes = {
    tuiMode: s.mode,
    tuiApproval: s.approval,
    tuiModel: s.model,
    tuiModelId: s.modelId,
    tuiContextBumpAcked: s.contextBumpAcked,
    tuiFirstRunDone: s.firstRunDone,
    tuiContextPreference: s.settings.contextPreference,
    tuiTheme: s.settings.theme,
    tuiDebugMode: s.settings.debugMode,
    tuiShowThinking: Boolean(s.settings.showThinking),
    tuiShowDetails: Boolean(s.settings.showDetails),
    runtimeBackend: s.runtime.backend,
  };
  for (const [k, v] of Object.entries(writes)) await s.store.set(k, v);
}

module.exports = { load, save, userDataDir, DEFAULT_MODEL, APP };
