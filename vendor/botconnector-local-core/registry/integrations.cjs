'use strict';

// Canonical integration registry.  This module owns discovery, compatibility
// metadata, configuration adapters, and process launch.  CLI and TUI callers
// consume the same descriptors; renderers never maintain their own catalog.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const CATEGORIES = ['Coding Agents', 'Assistants', 'Editors', 'Automation', 'Other'];
const STATUS = {
  READY: 'Installed · Ready',
  NEEDS_CONFIG: 'Installed · Needs configuration',
  NOT_RUNNING: 'Configured · Not running',
  NOT_INSTALLED: 'Available · Not installed',
  UNSUPPORTED: 'Unsupported on this OS',
  BROKEN: 'Broken / executable not found',
  UNKNOWN: 'Unknown',
};

// Entries marked verified have a known executable/config mechanism.  Other
// entries are retained as honest discovery records so the registry can grow
// without pretending that an adapter exists when it does not.
const DEFINITIONS = [
  { id: 'claude-code', name: 'Claude Code', description: 'Anthropic-compatible coding agent', category: 'Coding Agents', aliases: ['claude'], executableCandidates: ['claude', 'claude-code'], platforms: ['win32', 'linux', 'darwin'], protocol: 'Anthropic-compatible', adapter: 'anthropic-env', verified: true, launchable: true, modelCompatibility: { chat: true, toolCalling: true, api: 'anthropic' }, iconKey: 'claude', docsUrl: 'https://docs.anthropic.com/en/docs/claude-code' },
  { id: 'codex', name: 'Codex CLI', description: 'OpenAI-compatible terminal coding agent', category: 'Coding Agents', aliases: ['codex-cli'], executableCandidates: ['codex'], platforms: ['win32', 'linux', 'darwin'], protocol: 'OpenAI-compatible', adapter: 'openai-env', verified: true, launchable: true, modelCompatibility: { chat: true, toolCalling: true, api: 'openai' }, iconKey: 'codex', docsUrl: 'https://github.com/openai/codex' },
  { id: 'opencode', name: 'OpenCode', description: 'Provider-configurable terminal coding agent', category: 'Coding Agents', aliases: ['open-code'], executableCandidates: ['opencode'], platforms: ['win32', 'linux', 'darwin'], protocol: 'OpenAI-compatible', adapter: 'opencode-json', verified: true, launchable: true, modelCompatibility: { chat: true, toolCalling: true, api: 'openai' }, iconKey: 'opencode', docsUrl: 'https://opencode.ai' },
  { id: 'cline-cli', name: 'Cline CLI', description: 'Cline command-line entrypoint, when installed', category: 'Coding Agents', aliases: ['cline'], executableCandidates: ['cline'], platforms: ['win32', 'linux', 'darwin'], protocol: 'OpenAI-compatible', adapter: null, verified: false, launchable: false, modelCompatibility: { chat: true }, iconKey: 'cline', docsUrl: 'https://github.com/cline/cline' },
  { id: 'droid', name: 'Droid', description: 'Factory Droid coding agent, when installed', category: 'Coding Agents', aliases: [], executableCandidates: ['droid'], platforms: ['win32', 'linux', 'darwin'], protocol: 'Provider-defined', adapter: null, verified: false, launchable: false, modelCompatibility: { chat: true }, iconKey: 'droid', docsUrl: 'https://factory.ai' },
  { id: 'copilot-cli', name: 'Copilot CLI', description: 'GitHub Copilot terminal assistant, when installed', category: 'Coding Agents', aliases: ['copilot'], executableCandidates: ['copilot', 'github-copilot'], platforms: ['win32', 'linux', 'darwin'], protocol: 'Provider-defined', adapter: null, verified: false, launchable: false, modelCompatibility: { chat: true }, iconKey: 'copilot', docsUrl: 'https://github.com/github/copilot-cli' },
  { id: 'pi', name: 'Pi', description: 'Pi coding agent, when installed', category: 'Coding Agents', aliases: [], executableCandidates: ['pi'], platforms: ['win32', 'linux', 'darwin'], protocol: 'Provider-defined', adapter: null, verified: false, launchable: false, modelCompatibility: { chat: true }, iconKey: 'pi', docsUrl: 'https://github.com/badlogic/pi-mono' },
  { id: 'oh-my-pi', name: 'Oh My Pi', description: 'Oh My Pi terminal agent, when installed', category: 'Coding Agents', aliases: ['omp'], executableCandidates: ['omp', 'oh-my-pi'], platforms: ['win32', 'linux', 'darwin'], protocol: 'Provider-defined', adapter: null, verified: false, launchable: false, modelCompatibility: { chat: true }, iconKey: 'oh-my-pi', docsUrl: 'https://github.com/can1357/oh-my-pi' },
  { id: 'goose', name: 'Goose', description: 'Block Goose coding agent, when installed', category: 'Coding Agents', aliases: [], executableCandidates: ['goose'], platforms: ['win32', 'linux', 'darwin'], protocol: 'Provider-defined', adapter: null, verified: false, launchable: false, modelCompatibility: { chat: true, toolCalling: true }, iconKey: 'goose', docsUrl: 'https://github.com/block/goose' },
  { id: 'openclaw', name: 'OpenClaw', description: 'OpenClaw assistant, when installed', category: 'Assistants', aliases: [], executableCandidates: ['openclaw'], platforms: ['win32', 'linux', 'darwin'], protocol: 'Provider-defined', adapter: null, verified: false, launchable: false, modelCompatibility: { chat: true }, iconKey: 'openclaw', docsUrl: 'https://github.com/openclaw' },
  { id: 'hermes-agent', name: 'Hermes Agent', description: 'Hermes terminal agent, when installed', category: 'Assistants', aliases: ['hermes'], executableCandidates: ['hermes'], platforms: ['win32', 'linux', 'darwin'], protocol: 'Provider-defined', adapter: null, verified: false, launchable: false, modelCompatibility: { chat: true }, iconKey: 'hermes', docsUrl: 'https://github.com/NousResearch/hermes-agent' },
  { id: 'hermes-desktop', name: 'Hermes Desktop', description: 'Hermes desktop assistant, when installed', category: 'Assistants', aliases: [], executableCandidates: ['hermes-desktop'], platforms: ['win32', 'darwin', 'linux'], protocol: 'Provider-defined', adapter: null, verified: false, launchable: false, modelCompatibility: { chat: true }, iconKey: 'hermes', docsUrl: 'https://github.com/NousResearch/hermes-agent' },
  { id: 'vscode', name: 'VS Code', description: 'Open the current workspace in Visual Studio Code', category: 'Editors', aliases: ['code', 'visual-studio-code'], executableCandidates: ['code'], platforms: ['win32', 'linux', 'darwin'], protocol: 'Editor CLI', adapter: 'editor', verified: true, launchable: true, modelCompatibility: {}, iconKey: 'vscode', docsUrl: 'https://code.visualstudio.com/docs/editor/command-line' },
  { id: 'cline', name: 'Cline', description: 'Cline VS Code extension (detected-only integration)', category: 'Editors', aliases: [], executableCandidates: [], platforms: ['win32', 'linux', 'darwin'], protocol: 'VS Code extension', adapter: null, verified: false, launchable: false, modelCompatibility: {}, iconKey: 'cline', docsUrl: 'https://github.com/cline/cline' },
  { id: 'jetbrains', name: 'JetBrains', description: 'Open the current workspace in a JetBrains IDE', category: 'Editors', aliases: ['idea'], executableCandidates: ['idea', 'idea64', 'webstorm', 'pycharm', 'goland', 'clion'], platforms: ['win32', 'linux', 'darwin'], protocol: 'Editor CLI', adapter: 'editor', verified: true, launchable: true, modelCompatibility: {}, iconKey: 'jetbrains', docsUrl: 'https://www.jetbrains.com/help/idea/working-with-the-ide-features-from-command-line.html' },
  { id: 'roo-code', name: 'Roo Code', description: 'Roo Code editor extension (detected-only integration)', category: 'Editors', aliases: ['roo'], executableCandidates: [], platforms: ['win32', 'linux', 'darwin'], protocol: 'VS Code extension', adapter: null, verified: false, launchable: false, modelCompatibility: {}, iconKey: 'roo-code', docsUrl: 'https://github.com/RooCodeInc/Roo-Code' },
  { id: 'zed', name: 'Zed', description: 'Open the current workspace in Zed', category: 'Editors', aliases: [], executableCandidates: ['zed'], platforms: ['win32', 'linux', 'darwin'], protocol: 'Editor CLI', adapter: 'editor', verified: true, launchable: true, modelCompatibility: {}, iconKey: 'zed', docsUrl: 'https://zed.dev/docs/cli' },
  { id: 'ollama', name: 'Ollama', description: 'Detected local model backend; BotConnector does not shell out to Ollama launch', category: 'Other', aliases: [], executableCandidates: ['ollama'], platforms: ['win32', 'linux', 'darwin'], protocol: 'Local backend', adapter: null, verified: true, launchable: false, modelCompatibility: { chat: true }, iconKey: 'ollama', docsUrl: 'https://ollama.com' },
  { id: 'terminal', name: 'BotConnector Terminal', description: 'Run a BotConnector model in the current terminal', category: 'Other', aliases: ['botconnector-terminal'], executableCandidates: [], platforms: ['win32', 'linux', 'darwin'], protocol: 'Native BotConnector', adapter: 'terminal', verified: true, launchable: true, modelCompatibility: { chat: true, toolCalling: true }, iconKey: 'terminal', docsUrl: '' },
];

const UNVERIFIED_CANDIDATES = ['Qwen Code', 'DeepSeek Harness', 'Pool', 'Codex App', 'Xcode', 'n8n', 'marimo', 'Onyx', 'NemoClaw'];

function cloneDefinition(def) {
  return { ...def, aliases: [...(def.aliases || [])], executableCandidates: [...(def.executableCandidates || [])], platforms: [...(def.platforms || [])], modelCompatibility: { ...(def.modelCompatibility || {}) } };
}

function defaultLookup(candidate, platform = process.platform) {
  try {
    const command = platform === 'win32' ? 'where.exe' : 'which';
    const result = execFileSync(command, [candidate], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    const paths = result.split(/\r?\n/).filter(Boolean);
    // npm and other Windows shims can appear as an extensionless Unix-style
    // file before the runnable .cmd/.exe entry. Node spawn needs the latter.
    return platform === 'win32'
      ? (paths.find((item) => /\.(?:cmd|exe|bat)$/i.test(item)) || paths[0] || null)
      : (paths[0] || null);
  } catch { return null; }
}

function jsonEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function configPathFor(def, cwd, env = process.env) {
  if (def.id === 'opencode') return path.join(cwd, 'opencode.json');
  if (def.id === 'claude-code') return path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude.json');
  if (def.id === 'codex') return path.join(env.CODEX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.codex'), 'config.toml');
  return null;
}

function readJsonIfPresent(file) {
  try { return { exists: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { exists: false, value: null }; }
}

function opencodeConfigured(file) {
  const cfg = readJsonIfPresent(file).value;
  return Boolean(cfg && cfg.provider && cfg.provider['botconnector-local'] && cfg.provider['botconnector-local'].options && cfg.provider['botconnector-local'].options.baseURL);
}

function detectDefinition(def, ctx = {}) {
  const platform = ctx.platform || process.platform;
  const cwd = ctx.cwd || process.cwd();
  const env = ctx.env || process.env;
  if (!def.platforms.includes(platform)) return { status: STATUS.UNSUPPORTED, executable: null, configured: false, supported: false, reason: 'This integration does not support the current OS.' };
  if (def.id === 'terminal') return { status: STATUS.READY, executable: process.execPath, configured: true, supported: true, reason: '' };
  const lookup = ctx.pathLookup || ((candidate) => defaultLookup(candidate, platform));
  const executable = (def.executableCandidates || []).map((candidate) => ({ candidate, resolved: lookup(candidate) })).find((row) => row.resolved);
  const configFile = configPathFor(def, cwd, env);
  const configured = def.id === 'opencode' ? opencodeConfigured(configFile) : false;
  if (executable && def.launchable) return { status: def.id === 'opencode' && !configured ? STATUS.NEEDS_CONFIG : STATUS.READY, executable: executable.resolved, candidate: executable.candidate, configured, configFile, supported: true, reason: '' };
  if (executable && !def.launchable) return { status: STATUS.UNKNOWN, executable: executable.resolved, candidate: executable.candidate, configured, configFile, supported: false, reason: 'Executable detected, but no safe BotConnector launch adapter is verified.' };
  if (configured) return { status: STATUS.BROKEN, executable: null, configured, configFile, supported: false, reason: 'Configuration exists but the integration executable was not found on PATH.' };
  if (def.launchable) return { status: STATUS.NOT_INSTALLED, executable: null, configured: false, configFile, supported: true, reason: 'Install the integration using its official instructions.' };
  return { status: STATUS.UNKNOWN, executable: null, configured: false, configFile, supported: false, reason: 'No verified executable or launch adapter is available.' };
}

function buildProviderConfig({ endpoint, modelId, modelName }) {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'BotConnector Local',
    options: { baseURL: `${endpoint}/v1`, apiKey: 'local' },
    models: { 'local-model': { name: modelName || `BotConnector (${modelId || 'Auto'})` } },
  };
}

async function configureOpenCode({ cwd, endpoint, modelId, modelName, env = process.env }) {
  const file = configPathFor({ id: 'opencode' }, cwd, env);
  const before = readJsonIfPresent(file);
  let current = before.exists ? before.value : {};
  if (!current || typeof current !== 'object' || Array.isArray(current)) current = {};
  const provider = buildProviderConfig({ endpoint, modelId, modelName });
  const next = { ...current, model: 'botconnector-local/local-model', provider: { ...(current.provider || {}), 'botconnector-local': provider } };
  const backupDir = path.join(cwd, '.botconnector', 'integration-backups', 'opencode');
  await fsp.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${stamp}.json`);
  await fsp.writeFile(backupPath, JSON.stringify({ integration: 'opencode', path: file, existed: before.exists, original: before.value }, null, 2), 'utf8');
  await fsp.writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  const statePath = path.join(cwd, '.botconnector', 'integration-config-state.json');
  const priorState = readJsonIfPresent(statePath).value || {};
  priorState.opencode = { path: file, backupPath, beforeExists: before.exists, beforeModel: before.value?.model, beforeProvider: before.value && before.value.provider ? before.value.provider['botconnector-local'] : undefined, afterModel: 'botconnector-local/local-model', afterProvider: provider, configuredByBotConnector: true, changedAt: new Date().toISOString() };
  await fsp.writeFile(statePath, JSON.stringify(priorState, null, 2) + '\n', 'utf8');
  return { ok: true, path: file, backupPath, changes: ['model', 'provider.botconnector-local'] };
}

async function restoreIntegration({ id, cwd, env = process.env }) {
  const statePath = path.join(cwd, '.botconnector', 'integration-config-state.json');
  const state = readJsonIfPresent(statePath).value || {};
  const saved = state[id];
  if (!saved || !saved.configuredByBotConnector) return { ok: false, reason: 'No BotConnector-managed configuration was recorded for this integration.' };
  const file = saved.path || configPathFor({ id }, cwd, env);
  const current = readJsonIfPresent(file);
  if (!current.exists) return { ok: false, reason: 'Configuration file no longer exists; nothing was restored.' };
  if (id === 'opencode') {
    const currentProvider = current.value?.provider?.['botconnector-local'];
    if (current.value?.model !== saved.afterModel || !jsonEqual(currentProvider, saved.afterProvider)) return { ok: false, reason: 'Configuration changed after BotConnector edited it; refusing to overwrite user changes.' };
    const next = { ...current.value, provider: { ...(current.value.provider || {}) } };
    if (saved.beforeModel === undefined) delete next.model;
    else next.model = saved.beforeModel;
    if (saved.beforeProvider === undefined) delete next.provider['botconnector-local'];
    else next.provider['botconnector-local'] = saved.beforeProvider;
    if (!Object.keys(next.provider).length) delete next.provider;
    await fsp.writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
    state[id] = { ...saved, restoredAt: new Date().toISOString(), configuredByBotConnector: false };
    await fsp.writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    return { ok: true, path: file, restored: ['model', 'provider.botconnector-local'] };
  }
  return { ok: false, reason: `Restore adapter for ${id} is not implemented; no configuration was changed.` };
}

function normalizeId(value) {
  const needle = String(value || '').toLowerCase();
  return DEFINITIONS.find((def) => def.id === needle || def.name.toLowerCase() === needle || (def.aliases || []).includes(needle))?.id || needle;
}

function createIntegrationRegistry(options = {}) {
  const ctx = { cwd: options.cwd || process.cwd(), env: options.env || process.env, platform: options.platform || process.platform, pathLookup: options.pathLookup };
  function list() {
    return DEFINITIONS.map((definition) => {
      const def = cloneDefinition(definition);
      const detected = detectDefinition(def, ctx);
      return { ...def, ...detected, status: detected.status, executable: detected.executable || null, available: detected.supported && detected.status !== STATUS.NOT_INSTALLED && detected.status !== STATUS.BROKEN, disabledReason: detected.reason || '' };
    });
  }
  function get(id) {
    const normalized = normalizeId(id);
    return list().find((entry) => entry.id === normalized) || null;
  }
  function compatibleModels(models = [], integration) {
    const entry = typeof integration === 'string' ? get(integration) : integration;
    if (!entry) return [];
    return models.filter((model) => {
      const caps = model.capabilities || {};
      if (entry.modelCompatibility.chat && caps.chat === false) return false;
      if (entry.modelCompatibility.toolCalling && caps.toolCalling === false) return false;
      return true;
    });
  }
  return { list, get, compatibleModels, categories: CATEGORIES.slice(), definitions: () => DEFINITIONS.map(cloneDefinition), unverifiedCandidates: () => UNVERIFIED_CANDIDATES.slice(), configureOpenCode, restoreIntegration, configPathFor: (entry) => configPathFor(entry, ctx.cwd, ctx.env), context: { ...ctx } };
}

function resolveAutoModel({ requested = 'auto', store = null, discovered = null } = {}) {
  if (requested && String(requested).toLowerCase() !== 'auto') return { requested, id: requested, mode: 'explicit' };
  const configured = store && (store.get('tuiModelId') || store.get('tuiModel')?.id);
  if (configured) return { requested: 'auto', id: configured, mode: 'auto', source: 'current BotConnector model' };
  if (discovered && discovered.id) return { requested: 'auto', id: discovered.id, mode: 'auto', source: 'active BotConnector runtime' };
  return { requested: 'auto', id: 'local-model', mode: 'auto', source: 'BotConnector router' };
}

async function launchIntegration(entry, options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = { ...(options.env || process.env) };
  if (!entry || !entry.id) return { ok: false, reason: 'Integration was not selected.' };
  if (entry.id === 'terminal') return { ok: true, internal: true, exitCode: 0, model: options.modelId || 'auto' };
  if (!entry.executable) return { ok: false, reason: entry.status || 'Integration executable not found.' };
  if (!entry.launchable) return { ok: false, reason: entry.disabledReason || 'No verified BotConnector launch adapter exists for this integration.' };
  const endpoint = options.endpoint || 'http://127.0.0.1:11435';
  const modelId = options.modelId || 'local-model';
  if (entry.id === 'opencode' && options.configure !== false && !entry.configured) {
    const configured = await configureOpenCode({ cwd, endpoint, modelId, modelName: options.modelName, env });
    if (!configured.ok) return configured;
  }
  const launchEnv = { ...env, BOTCONNECTOR_ENDPOINT: endpoint, BOTCONNECTOR_MODEL_ID: modelId };
  if (entry.adapter === 'anthropic-env') { launchEnv.ANTHROPIC_BASE_URL = `${endpoint}/v1`; launchEnv.ANTHROPIC_API_KEY = launchEnv.ANTHROPIC_API_KEY || 'local'; }
  if (entry.adapter === 'openai-env') { launchEnv.OPENAI_BASE_URL = `${endpoint}/v1`; launchEnv.OPENAI_API_KEY = launchEnv.OPENAI_API_KEY || 'local'; }
  let args = options.args || [];
  if (entry.id === 'opencode' && options.requestedModel && String(options.requestedModel).toLowerCase() !== 'auto') args = ['--model', 'local-model', ...args];
  if (entry.adapter === 'editor') args = [cwd, ...args];
  return await new Promise((resolve) => {
    let child;
    const windowsShim = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(entry.executable);
    try {
      if (windowsShim) {
        // A shim path can contain spaces (the default VS Code install does).
        // Calling it through an explicit cmd.exe keeps the executable quoted
        // while avoiding Node's shell-string concatenation/deprecation path.
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', entry.executable, ...args], { cwd, env: launchEnv, stdio: 'inherit', windowsHide: false, shell: false });
      } else {
        child = spawn(entry.executable, args, { cwd, env: launchEnv, stdio: 'inherit', windowsHide: false, shell: false });
      }
    }
    catch (error) { resolve({ ok: false, reason: `Could not launch ${entry.name}: ${error.message}` }); return; }
    child.once('error', (error) => resolve({ ok: false, reason: `Could not launch ${entry.name}: ${error.message}` }));
    child.once('exit', (code, signal) => resolve({ ok: code === 0, exitCode: code, signal: signal || null, reason: code === 0 ? '' : `${entry.name} exited with ${signal || code}` }));
  });
}

module.exports = { CATEGORIES, STATUS, DEFINITIONS, UNVERIFIED_CANDIDATES, createIntegrationRegistry, detectDefinition, resolveAutoModel, launchIntegration, configureOpenCode, restoreIntegration, configPathFor };
